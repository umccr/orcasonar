import { createHash } from 'crypto';
import { Aws, CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import {
  CfnDataSource,
  CfnGuardrail,
  CfnGuardrailVersion,
  CfnKnowledgeBase,
} from 'aws-cdk-lib/aws-bedrock';
import { AttributeType, BillingMode, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import { AccountRootPrincipal, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { addGitCommitIdOutput } from '@orcabus/platform-cdk-constructs/utils';
import {
  DOCS_PREFIX,
  DOCS_PUBLISHER_ROLE_NAME,
  DOCS_PUBLISHER_ROLE_PATH,
  RECORD_RETENTION_DAYS,
  SSM_PARAMETERS,
} from './constants';

export interface OrcaSonarStatefulStackProps extends StackProps {
  /** `beta`, `gamma` or `prod`, for names. */
  readonly stageSlug: string;
  /** RETAIN in prod, so data and the index survive a stack deletion there. */
  readonly removalPolicy: RemovalPolicy;
  readonly deletionProtection: boolean;
}

/**
 * Everything OrcaSonar keeps: the Sonar KMS key, the ingest bucket the docs platform writes into, the managed
 * knowledge base that indexes it, the guardrail, the records bucket and the DynamoDB table.
 *
 * Separate from the API (the stateless stack) so that API changes, which are frequent, never touch the data or the
 * index. The stateless stack finds these resources through SSM.
 */
export class OrcaSonarStatefulStack extends Stack {
  constructor(scope: Construct, id: string, props: OrcaSonarStatefulStackProps) {
    super(scope, id, props);
    // Which commit is deployed, as a stack output.
    addGitCommitIdOutput(this);

    const docsPublisherArn = `arn:${Aws.PARTITION}:iam::${this.account}:role${DOCS_PUBLISHER_ROLE_PATH}${DOCS_PUBLISHER_ROLE_NAME}`;

    // One key for everything OrcaSonar stores, including the managed knowledge base's index.
    const key = new Key(this, 'SonarKey', {
      alias: 'alias/orcasonar',
      description: 'OrcaSonar: ingest and records buckets, table, knowledge base index',
      enableKeyRotation: true,
      removalPolicy: props.removalPolicy,
    });

    const ingestBucket = new Bucket(this, 'IngestBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.KMS,
      encryptionKey: key,
      bucketKeyEnabled: true,
      enforceSSL: true,
      versioned: true,
      // S3 events reach EventBridge, where the stateless stack marks the index as stale.
      eventBridgeEnabled: true,
      lifecycleRules: [
        { noncurrentVersionExpiration: Duration.days(30) },
        { abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
      removalPolicy: props.removalPolicy,
    });

    // The docs platform's publish role writes docs/<slug>/; each publish narrows itself to one site. Matched by
    // condition rather than as the principal, so this policy is valid before the role exists.
    const publisherCondition = { ArnEquals: { 'aws:PrincipalArn': docsPublisherArn } };
    ingestBucket.addToResourcePolicy(
      new PolicyStatement({
        sid: 'DocsPublisherList',
        principals: [new AccountRootPrincipal()],
        actions: ['s3:ListBucket'],
        resources: [ingestBucket.bucketArn],
        conditions: {
          ...publisherCondition,
          StringLike: { 's3:prefix': [`${DOCS_PREFIX}*`] },
        },
      })
    );
    ingestBucket.addToResourcePolicy(
      new PolicyStatement({
        sid: 'DocsPublisherWrite',
        principals: [new AccountRootPrincipal()],
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [ingestBucket.arnForObjects(`${DOCS_PREFIX}*`)],
        conditions: publisherCondition,
      })
    );
    key.addToResourcePolicy(
      new PolicyStatement({
        sid: 'DocsPublisherThroughS3',
        principals: [new AccountRootPrincipal()],
        actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
        resources: ['*'],
        conditions: {
          ...publisherCondition,
          StringEquals: { 'kms:ViaService': `s3.${this.region}.amazonaws.com` },
        },
      })
    );

    // Questions and answers, and feedback, kept 30 days for evaluation; curated examples under eval-set/ are kept.
    const recordsBucket = new Bucket(this, 'RecordsBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.KMS,
      encryptionKey: key,
      bucketKeyEnabled: true,
      enforceSSL: true,
      lifecycleRules: [
        { prefix: 'records/', expiration: Duration.days(RECORD_RETENTION_DAYS) },
        { prefix: 'feedback/', expiration: Duration.days(RECORD_RETENTION_DAYS) },
        { abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
      removalPolicy: props.removalPolicy,
    });

    // Budget counters, conversation turns and the ingestion flag. Items expire through `expiresAt`.
    const table = new Table(this, 'Table', {
      tableName: `OrcaSonarTable-${props.stageSlug}`,
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: key,
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: props.deletionProtection,
      removalPolicy: props.removalPolicy,
    });

    const knowledgeBase = this.knowledgeBase(props, key, ingestBucket);
    const guardrail = this.guardrail(props, key);

    const parameters: Record<keyof typeof SSM_PARAMETERS, string | undefined> = {
      ingestBucketName: ingestBucket.bucketName,
      keyArn: key.keyArn,
      tableName: table.tableName,
      recordsBucketName: recordsBucket.bucketName,
      knowledgeBaseId: knowledgeBase.knowledgeBaseId,
      dataSourceId: knowledgeBase.dataSourceId,
      guardrailId: guardrail.guardrailId,
      guardrailVersion: guardrail.version,
      apiUrl: undefined, // written by the stateless stack
    };
    for (const [name, value] of Object.entries(parameters)) {
      if (value === undefined) continue;
      new StringParameter(this, `${name.charAt(0).toUpperCase()}${name.slice(1)}Parameter`, {
        parameterName: SSM_PARAMETERS[name as keyof typeof SSM_PARAMETERS],
        stringValue: value,
      });
    }

    new CfnOutput(this, 'IngestBucketName', { value: ingestBucket.bucketName });
    new CfnOutput(this, 'KnowledgeBaseId', { value: knowledgeBase.knowledgeBaseId });
  }

  /**
   * The managed knowledge base: AWS-managed vector store encrypted with the Sonar key, managed embeddings, hybrid
   * search and the managed reranker. One data source, `docs`, on the ingest bucket's `docs/` prefix; later sources
   * get their own data sources.
   */
  private knowledgeBase(props: OrcaSonarStatefulStackProps, key: Key, ingestBucket: Bucket) {
    const role = new Role(this, 'KnowledgeBaseRole', {
      description: 'OrcaSonar knowledge base: reads the ingest bucket and uses the Sonar key',
      assumedBy: new ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: {
            'aws:SourceArn': `arn:${Aws.PARTITION}:bedrock:${this.region}:${this.account}:knowledge-base/*`,
          },
        },
      }),
    });
    role.addToPolicy(
      new PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [ingestBucket.bucketArn],
        conditions: { StringEquals: { 'aws:ResourceAccount': this.account } },
      })
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [ingestBucket.arnForObjects(`${DOCS_PREFIX}*`)],
        conditions: { StringEquals: { 'aws:ResourceAccount': this.account } },
      })
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: [key.keyArn],
        conditions: { StringEquals: { 'kms:ViaService': `s3.${this.region}.amazonaws.com` } },
      })
    );
    // The managed vector store and transient ingestion data are encrypted with the same key.
    role.addToPolicy(
      new PolicyStatement({
        actions: ['kms:GenerateDataKey', 'kms:Decrypt', 'kms:DescribeKey', 'kms:CreateGrant'],
        resources: [key.keyArn],
        conditions: { StringEquals: { 'kms:ViaService': `bedrock.${this.region}.amazonaws.com` } },
      })
    );

    const knowledgeBase = new CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: `orcasonar-${props.stageSlug}`,
      description: 'UMCCR documentation, exported by docs.umccr.org',
      roleArn: role.roleArn,
      knowledgeBaseConfiguration: {
        type: 'MANAGED',
        managedKnowledgeBaseConfiguration: {
          embeddingModelType: 'MANAGED',
          serverSideEncryptionConfiguration: { kmsKeyArn: key.keyArn },
        },
      },
    });
    knowledgeBase.node.addDependency(role);

    const dataSource = new CfnDataSource(this, 'DocsDataSource', {
      name: 'docs',
      description: 'docs.umccr.org pages, one prefix per site under docs/',
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      // Pages removed from a site are removed from the index at the next ingestion.
      dataDeletionPolicy: 'DELETE',
      dataSourceConfiguration: {
        type: 'MANAGED_KNOWLEDGE_BASE_CONNECTOR',
        managedKnowledgeBaseConnectorConfiguration: {
          connectorParameters: {
            type: 'S3',
            version: '1',
            // The connector refuses a null bucketOwnerAccountId, although its documentation says it is needed only
            // for a bucket in another account.
            connectionConfiguration: {
              bucketName: ingestBucket.bucketName,
              bucketOwnerAccountId: this.account,
            },
            filterConfiguration: { inclusionPrefixes: [DOCS_PREFIX] },
            metadataFilesPrefix: DOCS_PREFIX,
          },
        },
      },
    });

    return {
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      dataSourceId: dataSource.attrDataSourceId,
    };
  }

  /**
   * Applied to every model call: topics to refuse, masking of personal data in answers, and a grounding check that
   * flags answers the retrieved passages do not support.
   */
  private guardrail(props: OrcaSonarStatefulStackProps, key: Key) {
    const policies = {
      description: 'OrcaSonar answers: UMCCR documentation only',
      blockedInputMessaging:
        'OrcaSonar answers questions about UMCCR documentation, and cannot help with that request.',
      blockedOutputsMessaging:
        'OrcaSonar could not answer that from UMCCR documentation. Try rephrasing, or use Search.',
      topicPolicyConfig: {
        topicsConfig: [
          {
            name: 'MedicalAdvice',
            type: 'DENY',
            definition:
              'Advice about the diagnosis, treatment or care of a specific person, including a patient or the user.',
            examples: ['Which treatment should this patient get?', 'Is my mole cancerous?'],
          },
          {
            name: 'PersonalData',
            type: 'DENY',
            definition:
              'Requests to find, list or reveal information about identifiable patients, donors or study participants.',
            examples: ['Which samples belong to patient John Smith?'],
          },
        ],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          { type: 'EMAIL', action: 'ANONYMIZE' },
          { type: 'PHONE', action: 'ANONYMIZE' },
          { type: 'AWS_ACCESS_KEY', action: 'BLOCK' },
          { type: 'AWS_SECRET_KEY', action: 'BLOCK' },
          { type: 'PASSWORD', action: 'BLOCK' },
        ],
      },
      contextualGroundingPolicyConfig: {
        filtersConfig: [
          { type: 'GROUNDING', threshold: 0.6 },
          { type: 'RELEVANCE', threshold: 0.5 },
        ],
      },
    };
    const guardrail = new CfnGuardrail(this, 'Guardrail', {
      name: `orcasonar-${props.stageSlug}`,
      kmsKeyArn: key.keyArn,
      ...policies,
    });
    // A guardrail version is immutable. Naming the policies' hash in its description makes CloudFormation publish a
    // new version whenever the policies change, which the stateless stack then picks up through SSM.
    const hash = createHash('sha256').update(JSON.stringify(policies)).digest('hex').slice(0, 12);
    const version = new CfnGuardrailVersion(this, 'GuardrailVersion', {
      guardrailIdentifier: guardrail.attrGuardrailId,
      description: `OrcaSonar guardrail policies ${hash}`,
    });
    return { guardrailId: guardrail.attrGuardrailId, version: version.attrVersion };
  }
}
