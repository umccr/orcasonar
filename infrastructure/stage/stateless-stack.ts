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
import { Alarm, ComparisonOperator, Stats, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
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
import {
  FilterPattern,
  IFilterPattern,
  LogGroup,
  MetricFilter,
  RetentionDays,
} from 'aws-cdk-lib/aws-logs';
import { ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { ApiGatewayDomain } from 'aws-cdk-lib/aws-route53-targets';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { addGitCommitIdOutput, resolveGitCommitId } from '../shared/git-commit';
import {
  CERTIFICATE_ARN_PARAMETER,
  HOSTED_ZONE_ID_PARAMETER,
  HOSTED_ZONE_NAME_PARAMETER,
  USER_POOL_ID_PARAMETER,
} from '../shared/platform';
import { openApiDocument, SCHEMA_PATH, swaggerUiPage } from './api-docs';
import {
  API_BASE_PATH,
  API_DOMAIN_PREFIX,
  APP_ROOT,
  AUDIT_INDEX,
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
  /** `beta` or `prod`, for names and logs. */
  readonly stageSlug: string;
  /** Origins whose pages may call the API from the browser: the docs hosts and OrcaUI's. */
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
  /** Addresses that hear the alarms and the budget's notices by email; each confirms its subscription once. */
  readonly alertEmails: string[];
  /** The Cognito group whose members may read the audit log, or `*` for every caller the authorizer accepts. */
  readonly auditGroup: string;
}

const NODE_RUNTIME = Runtime.NODEJS_24_X;

/** API Gateway's limit on one mapping template. */
const MAX_TEMPLATE_BYTES = 300 * 1024;

const quoted = (text: string) => JSON.stringify(text);

/**
 * API Gateway's own errors, in the API's error shape, so that clients read their codes as they read the functions':
 * a missing, expired or foreign token, WAF, throttling, and a route that does not exist (404, rather than API
 * Gateway's 403 "Missing Authentication Token"). Messages are JSON; any other 4XX keeps API Gateway's own message,
 * which `$context.error.messageString` gives already quoted.
 */
const GATEWAY_ERRORS: { type: ResponseType; code: string; message: string; status?: string }[] = [
  {
    type: ResponseType.UNAUTHORIZED,
    code: 'unauthorized',
    message: quoted('Sign in again to use OrcaSonar.'),
  },
  {
    type: ResponseType.ACCESS_DENIED,
    code: 'forbidden',
    message: quoted('That sign-in cannot use OrcaSonar.'),
  },
  {
    type: ResponseType.WAF_FILTERED,
    code: 'forbidden',
    message: quoted('The request was blocked.'),
  },
  {
    type: ResponseType.THROTTLED,
    code: 'throttled',
    message: quoted('Too many requests. Try again shortly.'),
  },
  {
    type: ResponseType.MISSING_AUTHENTICATION_TOKEN,
    code: 'not-found',
    message: quoted('No such endpoint.'),
    status: '404',
  },
  {
    type: ResponseType.DEFAULT_4XX,
    code: 'invalid-request',
    message: '$context.error.messageString',
  },
  {
    type: ResponseType.DEFAULT_5XX,
    code: 'internal',
    message: quoted('Something went wrong. Try again.'),
  },
];

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
 *   GET  /api/v1/audit/…        audit Lambda: the audit log, for members of the audit group only
 *   GET  /api/v1/health         API Gateway itself, no token
 *   GET  /schema/swagger-ui/    API Gateway itself, no token: the API's documentation
 *   GET  /schema/openapi.json   API Gateway itself, no token: the OpenAPI contract
 *
 * Only routes that need a token reach a function: the open ones are answered by API Gateway from mock integrations.
 * A REST API rather than the HTTP API OrcaBus services use, because HTTP APIs cannot stream and stop at 30 seconds.
 * The functions run outside the VPC: they call nothing but AWS APIs. Every alarm, and the budget's notices, go to one
 * alerts topic.
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

    const zoneName = parameter(HOSTED_ZONE_NAME_PARAMETER);
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
        GUARDRAIL_VERSION_PARAMETER: SSM_PARAMETERS.guardrailVersion,
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
    // The guardrail's current version, read again every few minutes: a new version needs no deploy of this stack.
    StringParameter.fromStringParameterName(
      this,
      'GuardrailVersionParameter',
      SSM_PARAMETERS.guardrailVersion
    ).grantRead(chat);

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

    // The audit log: everyone's questions and answers, for the audit group, which only this function knows. It reads
    // the table and its audit index, which the grants of a table imported by name do not cover, and nothing else.
    const audit = this.function('AuditFunction', 'audit.ts', props, {
      timeout: Duration.seconds(29),
      memorySize: 512,
      environment: { ...common, AUDIT_GROUP: props.auditGroup },
    });
    table.grantReadData(audit);
    audit.addToRolePolicy(
      new PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [`${table.tableArn}/index/${AUDIT_INDEX}`],
      })
    );

    const authorizerFunction = this.function('AuthorizerFunction', 'authorizer.ts', props, {
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        USER_POOL_ID: parameter(USER_POOL_ID_PARAMETER),
        CLIENT_IDS: Fn.join(',', props.allowedClientIdParameters.map(parameter)),
      },
    });

    const alerts = this.alertsTopic(props);
    const api = this.api(props, { chat, query, audit, authorizerFunction, domainName });
    this.firewall(api);
    this.ingestion(props, { table, ingestBucket, knowledgeBaseArn, knowledgeBaseId });
    this.budget(props, chat.role as Role, alerts);
    this.alarms(api, { chat, query, audit });

    // Every alarm tells the alerts topic when it fires and when it clears.
    const notify = new SnsAction(alerts);
    for (const alarm of this.node.findAll().filter((child) => child instanceof Alarm)) {
      alarm.addAlarmAction(notify);
      alarm.addOkAction(notify);
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
      audit: NodejsFunction;
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

    // API Gateway's own errors need CORS headers too, or the browser hides them from the chat panel. They carry no
    // data, so reflecting the origin is safe. The construct IDs of the two defaults are kept from before they had
    // bodies, so that CloudFormation updates them in place: replacing one would reset it to API Gateway's default.
    for (const { type, code, message, status } of GATEWAY_ERRORS) {
      api.addGatewayResponse(`${type.responseType}Cors`, {
        type,
        statusCode: status,
        responseHeaders: {
          'Access-Control-Allow-Origin': 'method.request.header.Origin',
          Vary: "'Origin'",
        },
        templates: { 'application/json': `{"error":{"code":"${code}","message":${message}}}` },
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
    const audit = new LambdaIntegration(parts.audit, { proxy: true });
    const auditBase = base.addResource('audit');
    auditBase.addResource('exchanges').addMethod('GET', audit, secured);
    auditBase
      .addResource('conversations')
      .addResource('{conversationId}')
      .addMethod('GET', audit, secured);
    auditBase.addResource('usage').addMethod('GET', audit, secured);

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
        StringParameter.valueForStringParameter(this, CERTIFICATE_ARN_PARAMETER)
      ),
      endpointType: EndpointType.REGIONAL,
      securityPolicy: SecurityPolicy.TLS_1_2,
    });
    domain.addBasePathMapping(api, { stage: api.deploymentStage });

    new ARecord(this, 'ApiAlias', {
      zone: HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: StringParameter.valueForStringParameter(this, HOSTED_ZONE_ID_PARAMETER),
        zoneName: StringParameter.valueForStringParameter(this, HOSTED_ZONE_NAME_PARAMETER),
      }),
      recordName: API_DOMAIN_PREFIX,
      target: RecordTarget.fromAlias(new ApiGatewayDomain(domain)),
    });

    return api;
  }

  /** AWS managed rules and a per-address rate limit, in front of the whole API. */
  private firewall(api: RestApi): void {
    const managed = (name: string, priority: number, countOnly: string[] = []) => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name,
          ruleActionOverrides: countOnly.length
            ? countOnly.map((rule) => ({ name: rule, actionToUse: { count: {} } }))
            : undefined,
        },
      },
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
        // Questions are text for the model, never paths, pages or addresses this API opens. These rules would block
        // readers asking about `../` links, HTML or internal addresses, so they only count.
        managed('AWSManagedRulesCommonRuleSet', 1, [
          'GenericLFI_BODY',
          'GenericRFI_BODY',
          'CrossSiteScripting_BODY',
          'EC2MetaDataSSRF_BODY',
        ]),
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
   * The API's alarms. The functions answer their own errors, a streamed answer's after its 200 has gone, so Lambda
   * errors count only crashes and timeouts. Failed answers are counted from the outcomes the chat function logs, and
   * failed searches, documents and feedback from the API's 5XX responses.
   */
  private alarms(
    api: RestApi,
    fns: { chat: NodejsFunction; query: NodejsFunction; audit: NodejsFunction }
  ): void {
    for (const [name, fn] of Object.entries({
      Chat: fns.chat,
      Query: fns.query,
      Audit: fns.audit,
    })) {
      new Alarm(this, `${name}ErrorsAlarm`, {
        alarmDescription: `OrcaSonar ${name.toLowerCase()} Lambda errors: crashes and timeouts`,
        metric: fn.metricErrors({ period: Duration.minutes(5) }),
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
    }

    const outcome = (value: string) => FilterPattern.stringValue('$.outcome', '=', value);
    this.outcomeAlarm('AnswersFailed', fns.chat, {
      description:
        'OrcaSonar answers failed: readers saw an error instead of an answer. ' +
        'The chat function logs why, as outcome stream-error, answer-error or error.',
      pattern: FilterPattern.any(
        FilterPattern.all(
          FilterPattern.any(outcome('stream-error'), outcome('answer-error')),
          // A failure of ours, not a reader's own mistake such as asking in someone else's conversation.
          FilterPattern.stringValue('$.code', '=', 'unavailable')
        ),
        outcome('error')
      ),
      threshold: 3,
      period: Duration.minutes(15),
    });
    this.outcomeAlarm('WritesFailed', fns.chat, {
      description:
        "OrcaSonar could not settle an answer's cost, or save its turn or record. " +
        'The chat function logs which, as outcome settle-error or write-error.',
      pattern: FilterPattern.any(outcome('settle-error'), outcome('write-error')),
      threshold: 1,
      period: Duration.hours(1),
    });

    new Alarm(this, 'ApiServerErrorsAlarm', {
      alarmDescription:
        'OrcaSonar API 5XX responses: searches, documents, feedback or audit reads that failed, ' +
        'or answers that failed before they started streaming',
      metric: api.metricServerError({ period: Duration.minutes(15), statistic: Stats.SUM }),
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }

  /** An alarm on an outcome a function logs itself, counted as a metric in the `OrcaSonar` namespace. */
  private outcomeAlarm(
    name: string,
    fn: NodejsFunction,
    options: { description: string; pattern: IFilterPattern; threshold: number; period: Duration }
  ): void {
    const logged = new MetricFilter(this, `${name}Metric`, {
      logGroup: fn.logGroup,
      metricNamespace: 'OrcaSonar',
      metricName: name,
      filterPattern: options.pattern,
      metricValue: '1',
    });
    new Alarm(this, `${name}Alarm`, {
      alarmDescription: options.description,
      metric: logged.metric({ period: options.period, statistic: Stats.SUM }),
      threshold: options.threshold,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
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
    // EventBridge invokes it asynchronously: up to three attempts for one change.
    new Alarm(this, 'IngestMarkErrorsAlarm', {
      alarmDescription:
        'OrcaSonar could not mark the index stale: a document change waits for the next one',
      metric: mark.metricErrors({ period: Duration.hours(1) }),
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    const run = this.function('IngestRunFunction', 'ingest-run.ts', props, {
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment,
    });
    parts.table.grantReadWriteData(run);
    run.addToRolePolicy(
      new PolicyStatement({
        actions: [
          'bedrock:StartIngestionJob',
          'bedrock:ListIngestionJobs',
          'bedrock:GetIngestionJob',
        ],
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
    // A job that fails leaves the index stale; the run function logs it as job-failed and starts another next time.
    const jobsFailed = new MetricFilter(this, 'IngestJobsFailedMetric', {
      logGroup: run.logGroup,
      metricNamespace: 'OrcaSonar',
      metricName: 'IngestionJobsFailed',
      filterPattern: FilterPattern.stringValue('$.outcome', '=', 'job-failed'),
      metricValue: '1',
    });
    new Alarm(this, 'IngestJobsFailedAlarm', {
      alarmDescription:
        'OrcaSonar ingestion jobs failed: the index stays stale until one completes',
      metric: jobsFailed.metric({ period: Duration.hours(1), statistic: Stats.SUM }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }

  /**
   * Where every alarm, and the budget's notices, go. Subscribe a team address by email (`alertEmails` in config.ts), or
   * add the topic to the account's AWS Chatbot channel for Slack (docs/deploy.md). The construct ID is kept from when
   * the topic carried only the budget's notices, so that neither it nor the budget and action naming it are replaced.
   */
  private alertsTopic(props: OrcaSonarStatelessStackProps): Topic {
    const topic = new Topic(this, 'BudgetTopic', {
      displayName: 'OrcaSonar alerts',
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
    // The topic's own policy replaces SNS's default one, which let the account's alarms publish.
    const alarms = `arn:${Aws.PARTITION}:cloudwatch:${this.region}:${this.account}:alarm:*`;
    topic.addToResourcePolicy(
      new PolicyStatement({
        actions: ['sns:Publish'],
        principals: [new ServicePrincipal('cloudwatch.amazonaws.com')],
        resources: [topic.topicArn],
        conditions: { ArnLike: { 'aws:SourceArn': alarms } },
      })
    );
    for (const address of props.alertEmails) {
      topic.addSubscription(new EmailSubscription(address));
    }
    new CfnOutput(this, 'AlertsTopicArn', { value: topic.topicArn });
    return topic;
  }

  /**
   * The backstop behind the budget the chat Lambda enforces itself: an AWS Budgets limit on Bedrock spend that, when
   * actual spend passes it, attaches a policy denying Bedrock to the chat role. Budgets data updates only a few times
   * a day, so the Lambda's own ledger is the real control. Its notices go to the alerts topic.
   */
  private budget(props: OrcaSonarStatelessStackProps, chatRole: Role, topic: Topic): void {
    const budget = new CfnBudget(this, 'Budget', {
      budget: {
        budgetName: `orcasonar-bedrock-${props.stageSlug}`,
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
    const action = new CfnBudgetsAction(this, 'BudgetAction', {
      // The budget's Ref is its name, and orders the action after the budget it acts on.
      budgetName: budget.ref,
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
    // The role's policy too, not only the role, exists before the action that runs as it.
    action.node.addDependency(actionRole);
  }
}
