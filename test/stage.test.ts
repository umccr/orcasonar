import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { StageName } from '@orcabus/platform-cdk-constructs/shared-config/accounts';
import { STAGE_ENVIRONMENTS } from '../infrastructure/environments';
import {
  DOCS_ORIGINS,
  getOrcaSonarStatefulStackProps,
  getOrcaSonarStatelessStackProps,
} from '../infrastructure/stage/config';
import { SSM_PARAMETERS } from '../infrastructure/stage/constants';
import { OrcaSonarStatefulStack } from '../infrastructure/stage/stateful-stack';
import { OrcaSonarStatelessStack } from '../infrastructure/stage/stateless-stack';
import {
  acknowledgeFindings,
  addAwsSolutionsChecks,
  expectNoUnacknowledgedFindings,
} from './cdk-nag-helpers';

const STAGES: StageName[] = ['BETA', 'GAMMA', 'PROD'];
const ENVIRONMENTS = {
  BETA: STAGE_ENVIRONMENTS.beta,
  GAMMA: STAGE_ENVIRONMENTS.gamma,
  PROD: STAGE_ENVIRONMENTS.prod,
};

// AwsSolutions findings accepted for OrcaSonar, with the reason each is acceptable.
const ACCEPTED_RULES = [
  // Lambda basic execution and the CDK-managed log retention roles.
  'AwsSolutions-IAM4',
  // Wildcards scoped to one prefix (docs/*, records/*, feedback/*), the stage's API routes, and the models behind
  // the inference profiles in the profiles' regions.
  'AwsSolutions-IAM5',
  // The buckets hold exported documents and records; S3 server access logs would only log the publish and the API.
  'AwsSolutions-S1',
  // API Gateway access and execution logs need the account-level CloudWatch role; enabled per stage once it is
  // confirmed. The functions log every outcome meanwhile.
  'AwsSolutions-APIG1',
  'AwsSolutions-APIG6',
  // Request validation happens in the functions (zod), with the same error shape as every other error.
  'AwsSolutions-APIG2',
  // The API is authorized by the Lambda authorizer (Cognito ID tokens), not by a Cognito user pool authorizer.
  'AwsSolutions-COG4',
  // OPTIONS (CORS preflight), /health and the API docs are deliberately open; API Gateway answers them itself, so no
  // function is reachable without a token.
  'AwsSolutions-APIG4',
];

const statefulStack = (stage: StageName) => {
  const app = new App();
  const stack = new OrcaSonarStatefulStack(app, `${stage}Stateful`, {
    env: ENVIRONMENTS[stage],
    ...getOrcaSonarStatefulStackProps(stage),
  });
  return { app, stack };
};

const statelessStack = (stage: StageName) => {
  const app = new App();
  const stack = new OrcaSonarStatelessStack(app, `${stage}Stateless`, {
    env: ENVIRONMENTS[stage],
    ...getOrcaSonarStatelessStackProps(stage),
  });
  return { app, stack };
};

/**
 * Checks must be attached before anything synthesizes the app: a later synth reuses the cached assembly and runs no
 * validation.
 */
const nagFindings = ({ app, stack }: { app: App; stack: Stack }) => {
  addAwsSolutionsChecks(stack);
  acknowledgeFindings(stack, ACCEPTED_RULES, 'Accepted for OrcaSonar; see test/stage.test.ts');
  return () => expectNoUnacknowledgedFindings(app);
};

describe('cdk-nag', () => {
  test.each(STAGES)('%s stateful stack reports no unacknowledged findings', (stage) => {
    expect(nagFindings(statefulStack(stage))).not.toThrow();
  });

  test.each(STAGES)('%s stateless stack reports no unacknowledged findings', (stage) => {
    expect(nagFindings(statelessStack(stage))).not.toThrow();
  });
});

describe('stateful stack', () => {
  const template = Template.fromStack(statefulStack('PROD').stack);

  test('creates a managed knowledge base, encrypted with the Sonar key', () => {
    template.hasResourceProperties('AWS::Bedrock::KnowledgeBase', {
      KnowledgeBaseConfiguration: {
        Type: 'MANAGED',
        ManagedKnowledgeBaseConfiguration: {
          EmbeddingModelType: 'MANAGED',
          ServerSideEncryptionConfiguration: { KmsKeyArn: Match.anyValue() },
        },
      },
    });
  });

  test('indexes the docs/ prefix of the ingest bucket through the managed S3 connector', () => {
    template.hasResourceProperties('AWS::Bedrock::DataSource', {
      Name: 'docs',
      DataDeletionPolicy: 'DELETE',
      DataSourceConfiguration: {
        Type: 'MANAGED_KNOWLEDGE_BASE_CONNECTOR',
        ManagedKnowledgeBaseConnectorConfiguration: {
          ConnectorParameters: Match.objectLike({
            type: 'S3',
            // Required by the service even for a bucket in the same account.
            connectionConfiguration: {
              bucketName: Match.anyValue(),
              bucketOwnerAccountId: ENVIRONMENTS.PROD.account,
            },
            filterConfiguration: { inclusionPrefixes: ['docs/'] },
          }),
        },
      },
    });
  });

  test("lets only the docs platform's publisher write docs/, matched by condition", () => {
    const policy = JSON.stringify(template.findResources('AWS::S3::BucketPolicy'));
    expect(policy).toContain(':role/docs/docs-publisher');
    expect(policy).toContain('aws:PrincipalArn');
    expect(policy).toContain('/docs/*');
  });

  test('expires records and feedback after 30 days, and keeps eval-set/', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Prefix: 'records/', ExpirationInDays: 30, Status: 'Enabled' }),
          Match.objectLike({ Prefix: 'feedback/', ExpirationInDays: 30, Status: 'Enabled' }),
        ]),
      },
    });
    expect(JSON.stringify(template.findResources('AWS::S3::Bucket'))).not.toContain('eval-set/');
  });

  test('publishes the ingest bucket name for the docs platform', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: SSM_PARAMETERS.ingestBucketName,
    });
  });

  test('protects the table and keeps data in prod', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      DeletionProtectionEnabled: true,
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
    for (const type of ['AWS::S3::Bucket', 'AWS::DynamoDB::Table', 'AWS::KMS::Key']) {
      template.hasResource(type, {
        DeletionPolicy: 'RetainExceptOnCreate',
        UpdateReplacePolicy: 'Retain',
      });
    }
  });

  // A failed first create must not leave orphans; the fixed table name and key alias would block the retry.
  test('retains nothing when its first create rolls back', () => {
    const resources = template.toJSON().Resources as Record<string, { DeletionPolicy?: string }>;
    const retained = Object.entries(resources)
      .filter(([, resource]) => resource.DeletionPolicy === 'Retain')
      .map(([logicalId]) => logicalId);
    expect(retained).toEqual([]);
  });
});

describe('stateless stack', () => {
  const template = Template.fromStack(statelessStack('PROD').stack);

  type CfnResource = { Type: string; Properties: Record<string, unknown> };
  type Integration = {
    Type: string;
    IntegrationResponses?: { ResponseTemplates?: Record<string, string> }[];
  };
  const resources = template.toJSON().Resources as Record<string, CfnResource>;
  /** A method's path, from its resource up to the API's root, which is not a `Ref`. */
  const pathOf = (resourceId: unknown): string => {
    const id = (resourceId as { Ref?: string }).Ref;
    if (!id) {
      return '';
    }
    const { ParentId, PathPart } = resources[id]!.Properties;
    return `${pathOf(ParentId)}/${String(PathPart)}`;
  };
  const methods = Object.values(resources)
    .filter((resource) => resource.Type === 'AWS::ApiGateway::Method')
    .map(({ Properties: method }) => ({
      route: `${String(method.HttpMethod)} ${pathOf(method.ResourceId)}`,
      authorization: method.AuthorizationType as string,
      integration: method.Integration as Integration,
    }));
  /** The body API Gateway answers a mock route with, decoded from its response template. */
  const staticBody = (route: string): string => {
    const integration = methods.find((method) => method.route === route)?.integration;
    const responseTemplate =
      integration?.IntegrationResponses?.[0]?.ResponseTemplates?.['text/html'];
    const encoded = /^\$util\.base64Decode\("([A-Za-z0-9+/=]+)"\)$/.exec(
      responseTemplate ?? ''
    )?.[1];
    if (!encoded) {
      throw new Error(`${route} has no static body`);
    }
    return Buffer.from(encoded, 'base64').toString('utf8');
  };

  test('streams /chat through the Lambda authorizer', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'CUSTOM',
      Integration: Match.objectLike({ ResponseTransferMode: 'STREAM' }),
    });
  });

  test('leaves only /health, the API docs and CORS preflight open', () => {
    const open = methods
      .filter((method) => method.authorization === 'NONE')
      .map((method) => method.route)
      .filter((route) => !route.startsWith('OPTIONS '));
    expect(open.sort()).toEqual([
      'GET /api/v1/health',
      'GET /schema/openapi.json',
      'GET /schema/swagger-ui',
    ]);
  });

  // Security Hub flags a Lambda that an API Gateway method reaches without authorization.
  test('reaches a function only through the authorizer; open routes are answered by API Gateway', () => {
    for (const method of methods) {
      if (method.authorization === 'NONE') {
        expect({ route: method.route, type: method.integration.Type }).toEqual({
          route: method.route,
          type: 'MOCK',
        });
      } else {
        expect({ route: method.route, authorization: method.authorization }).toEqual({
          route: method.route,
          authorization: 'CUSTOM',
        });
      }
    }
    expect(methods.filter((method) => method.integration.Type === 'AWS_PROXY')).toHaveLength(4);
  });

  test('answers /health with the stage, without a function', () => {
    expect(JSON.parse(staticBody('GET /api/v1/health'))).toMatchObject({
      status: 'ok',
      stage: 'prod',
    });
  });

  test("serves the OpenAPI contract with this stage's API as its server", () => {
    const document = JSON.parse(staticBody('GET /schema/openapi.json')) as {
      servers: unknown;
      paths: Record<string, unknown>;
    };
    expect(document.servers).toEqual([{ url: '/api/v1', description: 'This stage' }]);
    expect(Object.keys(document.paths)).toContain('/chat');
  });

  test('serves Swagger UI pinned, checked by hash and under a content security policy', () => {
    const page = staticBody('GET /schema/swagger-ui');
    expect(page).toContain('http-equiv="Content-Security-Policy"');
    expect(page).toContain("default-src 'none'");
    expect(page).toContain("url: '/schema/openapi.json'");
    expect(page).toMatch(
      /swagger-ui-dist@\d+\.\d+\.\d+\/swagger-ui-bundle\.js" integrity="sha384-/
    );
  });

  test('accepts ID tokens through a token authorizer cached for five minutes', () => {
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'TOKEN',
      IdentitySource: 'method.request.header.Authorization',
      AuthorizerResultTtlInSeconds: 300,
    });
  });

  test('allows CORS from the prod docs hosts only', () => {
    const cors = JSON.stringify(template.findResources('AWS::ApiGateway::Method'));
    for (const origin of DOCS_ORIGINS.PROD) {
      expect(cors).toContain(origin);
    }
    expect(cors).not.toContain('docs.dev.umccr.org');
  });

  test('puts WAF in front of the API', () => {
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
  });

  test('lets the chat function call only the Australian profiles and their models', () => {
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('inference-profile/au.anthropic.claude-sonnet-5');
    expect(policies).toContain('ap-southeast-4::foundation-model/anthropic.claude-sonnet-5');
    expect(policies).not.toMatch(/foundation-model\/\*"/);
  });

  test('backs the budget with an AWS Budgets action that denies Bedrock', () => {
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 50, Unit: 'USD' } }),
    });
    template.hasResourceProperties('AWS::Budgets::BudgetsAction', {
      ActionType: 'APPLY_IAM_POLICY',
      ApprovalModel: 'AUTOMATIC',
    });
  });

  test('checks for changed documents every 15 minutes', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(15 minutes)',
    });
  });
});
