import * as path from 'path';
import { Aws, CfnOutput, Duration, Fn, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import {
  AccessLogFormat,
  AuthorizationType,
  DomainName,
  EndpointType,
  IdentitySource,
  LambdaIntegration,
  LogGroupLogDestination,
  MethodOptions,
  MockIntegration,
  PassthroughBehavior,
  Resource,
  ResponseTransferMode,
  ResponseType,
  RestApi,
  SecurityPolicy,
  TokenAuthorizer,
} from 'aws-cdk-lib/aws-apigateway';
import { CfnBudget, CfnBudgetsAction } from 'aws-cdk-lib/aws-budgets';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import {
  Effect,
  ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { ApiGatewayDomain } from 'aws-cdk-lib/aws-route53-targets';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import {
  CERTIFICATE_ARN_PARAMETER_NAME,
  DEFAULT_COGNITO_USER_POOL_ID_PARAMETER_NAME,
  HOSTED_ZONE_DOMAIN_PARAMETER_NAME,
  HOSTED_ZONE_ID_PARAMETER_NAME,
} from '@orcabus/platform-cdk-constructs/api-gateway';
import { addGitCommitIdOutput, resolveGitCommitId } from '@orcabus/platform-cdk-constructs/utils';
import { openApiDocument, SCHEMA_PATH, swaggerUiPage } from './api-docs';
import {
  API_BASE_PATH,
  API_DOMAIN_PREFIX,
  APP_ROOT,
  DOCS_PREFIX,
  REPO_ROOT,
  SSM_PARAMETERS,
} from './constants';

export interface OrcaSonarBudget {
  /** The month's budget for model calls and retrieval, in US dollars. */
  readonly monthlyUsd: number;
  /** What one caller may spend in a day, in US dollars. */
  readonly callerDailyUsd: number;
}

export interface OrcaSonarStatelessStackProps extends StackProps {
  /** `beta`, `gamma` or `prod`, for names and logs. */
  readonly stageSlug: string;
  /** Origins whose pages may call the API from the browser: the docs hosts. */
  readonly corsAllowOrigins: string[];
  /** SSM parameters holding the Cognito app client IDs whose ID tokens the authorizer accepts. */
  readonly allowedClientIdParameters: string[];
  /** The inference profile answers use, e.g. `au.anthropic.claude-sonnet-5`. */
  readonly answerModelId: string;
  /** Every inference profile the chat Lambda may call; the answer model must be one of them. */
  readonly allowedModelIds: string[];
  /** Regions the `au.` profiles route to. The chat role may invoke the models there and nowhere else. */
  readonly modelRegions: string[];
  readonly budget: OrcaSonarBudget;
  /** REST API access logs need API Gateway's account-level CloudWatch role; turn them on where it exists. */
  readonly accessLogs: boolean;
  readonly logRetention: RetentionDays;
}

const NODE_RUNTIME = Runtime.NODEJS_24_X;

/** API Gateway's limit on one mapping template. */
const MAX_TEMPLATE_BYTES = 300 * 1024;

/**
 * A GET that API Gateway answers itself, from a mock integration, with a fixed body and no token. The body goes through
 * `$util.base64Decode` so that `$` and `#` in it, such as an OpenAPI `$ref`, are never read as template syntax. It is
 * filed under both JSON and HTML because API Gateway picks the template by the request's first `Accept` type.
 */
const staticGet = (
  body: string,
  headers: Record<string, string>
): [MockIntegration, MethodOptions] => {
  const template = `$util.base64Decode("${Buffer.from(body, 'utf8').toString('base64')}")`;
  if (Buffer.byteLength(template) > MAX_TEMPLATE_BYTES) {
    throw new Error(
      `A static response is over API Gateway's ${MAX_TEMPLATE_BYTES}-byte template limit`
    );
  }
  const all = { 'X-Content-Type-Options': 'nosniff', ...headers };
  const header = (name: string) => `method.response.header.${name}`;
  return [
    new MockIntegration({
      requestTemplates: { 'application/json': '{"statusCode": 200}' },
      passthroughBehavior: PassthroughBehavior.NEVER,
      integrationResponses: [
        {
          statusCode: '200',
          responseTemplates: { 'application/json': template, 'text/html': template },
          responseParameters: Object.fromEntries(
            Object.entries(all).map(([name, value]) => [header(name), `'${value}'`])
          ),
        },
      ],
    }),
    {
      authorizationType: AuthorizationType.NONE,
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: Object.fromEntries(
            Object.keys(all).map((name) => [header(name), true])
          ),
        },
      ],
    },
  ];
};

/**
 * OrcaSonar's API and functions: a regional REST API at `sonar.<stage zone>`, behind AWS WAF, with a Lambda
 * authorizer that accepts Cognito ID tokens from allowed clients only.
 *
 *   POST /api/v1/chat           chat Lambda, streamed (server-sent events)
 *   POST /api/v1/search         query Lambda
 *   GET  /api/v1/documents/{id} query Lambda
 *   POST /api/v1/feedback       query Lambda
 *   GET  /api/v1/health         API Gateway itself, no token
 *   GET  /schema/swagger-ui/    API Gateway itself, no token: the API's documentation
 *   GET  /schema/openapi.json   API Gateway itself, no token: the OpenAPI contract
 *
 * Only routes that need a token reach a function: the open ones are answered by API Gateway from mock integrations.
 * A REST API rather than the HTTP API OrcaBus services use, because HTTP APIs cannot stream and stop at 30 seconds.
 * The functions run outside the VPC: they call nothing but AWS APIs.
 */
export class OrcaSonarStatelessStack extends Stack {
  constructor(scope: Construct, id: string, props: OrcaSonarStatelessStackProps) {
    super(scope, id, props);
    // Which commit is deployed, as a stack output.
    addGitCommitIdOutput(this);

    if (!props.allowedModelIds.includes(props.answerModelId)) {
      throw new Error(`answerModelId ${props.answerModelId} is not in allowedModelIds`);
    }

    const parameter = (name: string) => StringParameter.valueForStringParameter(this, name);
    const key = Key.fromKeyArn(this, 'SonarKey', parameter(SSM_PARAMETERS.keyArn));
    const table = Table.fromTableAttributes(this, 'Table', {
      tableName: parameter(SSM_PARAMETERS.tableName),
      encryptionKey: key,
    });
    const recordsBucket = Bucket.fromBucketAttributes(this, 'RecordsBucket', {
      bucketName: parameter(SSM_PARAMETERS.recordsBucketName),
      encryptionKey: key,
    });
    const ingestBucket = Bucket.fromBucketAttributes(this, 'IngestBucket', {
      bucketName: parameter(SSM_PARAMETERS.ingestBucketName),
      encryptionKey: key,
    });
    const knowledgeBaseId = parameter(SSM_PARAMETERS.knowledgeBaseId);
    const knowledgeBaseArn = `arn:${Aws.PARTITION}:bedrock:${this.region}:${this.account}:knowledge-base/${knowledgeBaseId}`;
    const guardrailId = parameter(SSM_PARAMETERS.guardrailId);

    const zoneName = parameter(HOSTED_ZONE_DOMAIN_PARAMETER_NAME);
    const domainName = `${API_DOMAIN_PREFIX}.${zoneName}`;
    const apiUrl = `https://${domainName}/${API_BASE_PATH}`;

    const common = {
      STAGE: props.stageSlug,
      TABLE_NAME: table.tableName,
      RECORDS_BUCKET: recordsBucket.bucketName,
      KNOWLEDGE_BASE_ID: knowledgeBaseId,
      CORS_ALLOW_ORIGINS: props.corsAllowOrigins.join(','),
    };

    const chat = this.function('ChatFunction', 'chat.ts', props, {
      timeout: Duration.minutes(5),
      memorySize: 1024,
      environment: {
        ...common,
        GUARDRAIL_ID: guardrailId,
        GUARDRAIL_VERSION: parameter(SSM_PARAMETERS.guardrailVersion),
        ANSWER_MODEL_ID: props.answerModelId,
        MONTHLY_BUDGET_USD: String(props.budget.monthlyUsd),
        CALLER_DAILY_USD: String(props.budget.callerDailyUsd),
      },
    });
    table.grantReadWriteData(chat);
    recordsBucket.grantPut(chat, 'records/*');
    chat.addToRolePolicy(
      new PolicyStatement({ actions: ['bedrock:Retrieve'], resources: [knowledgeBaseArn] })
    );
    chat.addToRolePolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModelWithResponseStream', 'bedrock:InvokeModel'],
        resources: this.modelArns(props),
      })
    );
    chat.addToRolePolicy(
      new PolicyStatement({
        actions: ['bedrock:ApplyGuardrail'],
        resources: [
          `arn:${Aws.PARTITION}:bedrock:${this.region}:${this.account}:guardrail/${guardrailId}`,
        ],
      })
    );

    const query = this.function('QueryFunction', 'query.ts', props, {
      timeout: Duration.seconds(29),
      memorySize: 512,
      environment: { ...common, INGEST_BUCKET: ingestBucket.bucketName },
    });
    table.grantReadData(query);
    ingestBucket.grantRead(query, `${DOCS_PREFIX}*`);
    recordsBucket.grantPut(query, 'feedback/*');
    query.addToRolePolicy(
      new PolicyStatement({ actions: ['bedrock:Retrieve'], resources: [knowledgeBaseArn] })
    );

    const authorizerFunction = this.function('AuthorizerFunction', 'authorizer.ts', props, {
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        USER_POOL_ID: parameter(DEFAULT_COGNITO_USER_POOL_ID_PARAMETER_NAME),
        CLIENT_IDS: Fn.join(',', props.allowedClientIdParameters.map(parameter)),
      },
    });

    const api = this.api(props, { chat, query, authorizerFunction, domainName });
    this.firewall(api);
    this.ingestion(props, { table, ingestBucket, knowledgeBaseArn, knowledgeBaseId });
    this.budget(props, chat.role as Role);

    for (const [name, fn] of Object.entries({ Chat: chat, Query: query })) {
      new Alarm(this, `${name}ErrorsAlarm`, {
        alarmDescription: `OrcaSonar ${name.toLowerCase()} Lambda errors`,
        metric: fn.metricErrors({ period: Duration.minutes(5) }),
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
    }

    new StringParameter(this, 'ApiUrlParameter', {
      parameterName: SSM_PARAMETERS.apiUrl,
      stringValue: apiUrl,
      description: 'OrcaSonar API base URL',
    });
    new CfnOutput(this, 'ApiUrl', { value: apiUrl });
  }

  private function(
    id: string,
    entry: string,
    props: OrcaSonarStatelessStackProps,
    options: { timeout: Duration; memorySize: number; environment: Record<string, string> }
  ): NodejsFunction {
    const logGroup = new LogGroup(this, `${id}LogGroup`, {
      retention: props.logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    return new NodejsFunction(this, id, {
      entry: path.join(APP_ROOT, 'src', 'handlers', entry),
      handler: 'handler',
      depsLockFilePath: path.join(REPO_ROOT, 'pnpm-lock.yaml'),
      projectRoot: REPO_ROOT,
      runtime: NODE_RUNTIME,
      architecture: Architecture.ARM_64,
      logGroup,
      ...options,
      bundling: {
        tsconfig: path.join(APP_ROOT, 'tsconfig.json'),
        target: 'node24',
        format: OutputFormat.CJS,
        // Bundle every dependency, AWS SDK included, so the functions run the versions the tests ran.
        externalModules: [],
        minify: true,
        sourceMap: true,
      },
    });
  }

  /** The inference profiles, and the models behind them in the profiles' regions only. */
  private modelArns(props: OrcaSonarStatelessStackProps): string[] {
    return props.allowedModelIds.flatMap((profileId) => {
      const modelId = profileId.replace(/^[a-z]{2}\./, '');
      return [
        `arn:${Aws.PARTITION}:bedrock:${this.region}:${this.account}:inference-profile/${profileId}`,
        ...props.modelRegions.map(
          (region) => `arn:${Aws.PARTITION}:bedrock:${region}::foundation-model/${modelId}`
        ),
      ];
    });
  }

  private api(
    props: OrcaSonarStatelessStackProps,
    parts: {
      chat: NodejsFunction;
      query: NodejsFunction;
      authorizerFunction: NodejsFunction;
      domainName: string;
    }
  ): RestApi {
    const accessLogs = props.accessLogs
      ? new LogGroup(this, 'ApiAccessLogs', {
          retention: props.logRetention,
          removalPolicy: RemovalPolicy.DESTROY,
        })
      : undefined;

    const api = new RestApi(this, 'Api', {
      restApiName: 'OrcaSonarApi',
      description: 'OrcaSonar: answers and search over UMCCR documentation',
      endpointConfiguration: { types: [EndpointType.REGIONAL] },
      disableExecuteApiEndpoint: true,
      cloudWatchRole: false,
      deployOptions: {
        stageName: 'live',
        throttlingRateLimit: 20,
        throttlingBurstLimit: 40,
        metricsEnabled: true,
        ...(accessLogs
          ? {
              accessLogDestination: new LogGroupLogDestination(accessLogs),
              accessLogFormat: AccessLogFormat.jsonWithStandardFields(),
            }
          : {}),
      },
      defaultCorsPreflightOptions: {
        allowOrigins: props.corsAllowOrigins,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type', 'Accept'],
        maxAge: Duration.hours(1),
      },
    });

    // API Gateway's own errors (401 from the authorizer, 403 from WAF, 429 throttling) need CORS headers too, or the
    // browser hides them from the chat panel. They carry no data, so reflecting the origin is safe.
    for (const type of [ResponseType.DEFAULT_4XX, ResponseType.DEFAULT_5XX]) {
      api.addGatewayResponse(`${type.responseType}Cors`, {
        type,
        responseHeaders: {
          'Access-Control-Allow-Origin': 'method.request.header.Origin',
          Vary: "'Origin'",
        },
      });
    }

    const authorizer = new TokenAuthorizer(this, 'Authorizer', {
      handler: parts.authorizerFunction,
      identitySource: IdentitySource.header('Authorization'),
      validationRegex: '^Bearer [A-Za-z0-9_=.-]+$',
      resultsCacheTtl: Duration.minutes(5),
    });
    const secured = { authorizer, authorizationType: AuthorizationType.CUSTOM };

    let base: Resource = api.root.addResource('api');
    base = base.addResource('v1');

    base.addResource('chat').addMethod(
      'POST',
      new LambdaIntegration(parts.chat, {
        proxy: true,
        responseTransferMode: ResponseTransferMode.STREAM,
        timeout: Duration.minutes(5),
      }),
      secured
    );
    const query = new LambdaIntegration(parts.query, { proxy: true });
    base.addResource('search').addMethod('POST', query, secured);
    base.addResource('documents').addResource('{id}').addMethod('GET', query, secured);
    base.addResource('feedback').addMethod('POST', query, secured);

    // The open routes never reach a function, so nothing without a token can run code that reads data or calls Bedrock.
    const health = { status: 'ok', version: resolveGitCommitId(), stage: props.stageSlug };
    base.addResource('health').addMethod(
      'GET',
      ...staticGet(JSON.stringify(health), {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      })
    );
    const schema = api.root.addResource(SCHEMA_PATH);
    schema.addResource('openapi.json').addMethod(
      'GET',
      ...staticGet(openApiDocument(), {
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=300',
      })
    );
    schema.addResource('swagger-ui').addMethod(
      'GET',
      ...staticGet(swaggerUiPage(), {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'max-age=300',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
      })
    );

    const domain = new DomainName(this, 'ApiDomain', {
      domainName: parts.domainName,
      certificate: Certificate.fromCertificateArn(
        this,
        'Certificate',
        StringParameter.valueForStringParameter(this, CERTIFICATE_ARN_PARAMETER_NAME)
      ),
      endpointType: EndpointType.REGIONAL,
      securityPolicy: SecurityPolicy.TLS_1_2,
    });
    domain.addBasePathMapping(api, { stage: api.deploymentStage });

    new ARecord(this, 'ApiAlias', {
      zone: HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: StringParameter.valueForStringParameter(this, HOSTED_ZONE_ID_PARAMETER_NAME),
        zoneName: StringParameter.valueForStringParameter(this, HOSTED_ZONE_DOMAIN_PARAMETER_NAME),
      }),
      recordName: API_DOMAIN_PREFIX,
      target: RecordTarget.fromAlias(new ApiGatewayDomain(domain)),
    });

    return api;
  }

  /** AWS managed rules and a per-address rate limit, in front of the whole API. */
  private firewall(api: RestApi): void {
    const managed = (name: string, priority: number) => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: name,
        sampledRequestsEnabled: true,
      },
    });
    const acl = new CfnWebACL(this, 'WebAcl', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'OrcaSonarApi',
        sampledRequestsEnabled: true,
      },
      rules: [
        managed('AWSManagedRulesAmazonIpReputationList', 0),
        managed('AWSManagedRulesCommonRuleSet', 1),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 2),
        {
          name: 'RateLimitPerAddress',
          priority: 3,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 300, aggregateKeyType: 'IP' } },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimitPerAddress',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });
    new CfnWebACLAssociation(this, 'WebAclAssociation', {
      resourceArn: api.deploymentStage.stageArn,
      webAclArn: acl.attrArn,
    });
  }

  /**
   * Keep the index current without overlapping jobs. Every change under docs/ marks the index stale; every 15
   * minutes, if it is stale and no job is running, one ingestion job starts. Many sites can publish at once, and jobs
   * on one data source cannot overlap.
   */
  private ingestion(
    props: OrcaSonarStatelessStackProps,
    parts: {
      table: ReturnType<typeof Table.fromTableAttributes>;
      ingestBucket: ReturnType<typeof Bucket.fromBucketAttributes>;
      knowledgeBaseArn: string;
      knowledgeBaseId: string;
    }
  ): void {
    const environment = {
      TABLE_NAME: parts.table.tableName,
      KNOWLEDGE_BASE_ID: parts.knowledgeBaseId,
      DATA_SOURCE_ID: StringParameter.valueForStringParameter(this, SSM_PARAMETERS.dataSourceId),
    };
    const mark = this.function('IngestMarkFunction', 'ingest-mark.ts', props, {
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment,
    });
    parts.table.grantWriteData(mark);
    new Rule(this, 'DocsChangedRule', {
      description: 'OrcaSonar: a document under docs/ changed',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created', 'Object Deleted'],
        detail: {
          bucket: { name: [parts.ingestBucket.bucketName] },
          object: { key: [{ prefix: DOCS_PREFIX }] },
        },
      },
      targets: [new LambdaFunction(mark)],
    });

    const run = this.function('IngestRunFunction', 'ingest-run.ts', props, {
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment,
    });
    parts.table.grantReadWriteData(run);
    run.addToRolePolicy(
      new PolicyStatement({
        actions: ['bedrock:StartIngestionJob', 'bedrock:ListIngestionJobs'],
        resources: [parts.knowledgeBaseArn],
      })
    );
    new Rule(this, 'IngestScheduleRule', {
      description: 'OrcaSonar: start an ingestion job when documents changed',
      schedule: Schedule.rate(Duration.minutes(15)),
      targets: [new LambdaFunction(run)],
    });
    new Alarm(this, 'IngestErrorsAlarm', {
      alarmDescription: 'OrcaSonar ingestion scheduling errors: the index may be going stale',
      metric: run.metricErrors({ period: Duration.hours(1) }),
      threshold: 2,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }

  /**
   * The backstop behind the budget the chat Lambda enforces itself: an AWS Budgets limit on Bedrock spend that, when
   * actual spend passes it, attaches a policy denying Bedrock to the chat role. Budgets data updates only a few times
   * a day, so the Lambda's own ledger is the real control.
   */
  private budget(props: OrcaSonarStatelessStackProps, chatRole: Role): void {
    const topic = new Topic(this, 'BudgetTopic', {
      displayName: 'OrcaSonar budget',
      enforceSSL: true,
    });
    topic.addToResourcePolicy(
      new PolicyStatement({
        actions: ['sns:Publish'],
        principals: [new ServicePrincipal('budgets.amazonaws.com')],
        resources: [topic.topicArn],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      })
    );

    const budgetName = `orcasonar-bedrock-${props.stageSlug}`;
    new CfnBudget(this, 'Budget', {
      budget: {
        budgetName,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: props.budget.monthlyUsd, unit: 'USD' },
        costFilters: { Service: ['Amazon Bedrock'] },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'SNS', address: topic.topicArn }],
        },
      ],
    });

    const deny = new ManagedPolicy(this, 'BudgetDenyPolicy', {
      description: 'OrcaSonar: attached to the chat role when the Bedrock budget is spent',
      document: new PolicyDocument({
        statements: [
          new PolicyStatement({
            effect: Effect.DENY,
            actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            resources: ['*'],
          }),
        ],
      }),
    });
    const actionRole = new Role(this, 'BudgetActionRole', {
      assumedBy: new ServicePrincipal('budgets.amazonaws.com'),
      description: 'OrcaSonar: lets AWS Budgets attach the deny policy to the chat role',
    });
    actionRole.addToPolicy(
      new PolicyStatement({
        actions: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
        resources: [chatRole.roleArn],
        conditions: { ArnEquals: { 'iam:PolicyARN': deny.managedPolicyArn } },
      })
    );
    new CfnBudgetsAction(this, 'BudgetAction', {
      budgetName,
      actionType: 'APPLY_IAM_POLICY',
      actionThreshold: { type: 'PERCENTAGE', value: 100 },
      notificationType: 'ACTUAL',
      approvalModel: 'AUTOMATIC',
      executionRoleArn: actionRole.roleArn,
      definition: {
        iamActionDefinition: { policyArn: deny.managedPolicyArn, roles: [chatRole.roleName] },
      },
      subscribers: [{ type: 'SNS', address: topic.topicArn }],
    });
  }
}
