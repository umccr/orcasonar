import * as path from 'path';

export const REPO_ROOT = path.join(__dirname, '..', '..');
export const APP_ROOT = path.join(REPO_ROOT, 'app');

/** The API's custom domain is `sonar.<stage zone>`: `sonar.dev.umccr.org`, `sonar.stg.umccr.org`, `sonar.prod.umccr.org`. */
export const API_DOMAIN_PREFIX = 'sonar';

/** Every API path lives under this base path, so `/api/v2` can sit beside it later. */
export const API_BASE_PATH = 'api/v1';

/** Where the docs platform writes documents in the ingest bucket: `docs/<slug>/<path>.md` and their metadata files. */
export const DOCS_PREFIX = 'docs/';

/**
 * The docs platform's publish role in each stage account (`umccr/docs-platform`, `infrastructure/config.ts`). The
 * ingest bucket and the key grant it access by name. Policies match it with an `aws:PrincipalArn` condition on the
 * account principal, so this stack deploys whether or not the role exists yet.
 */
export const DOCS_PUBLISHER_ROLE_PATH = '/docs/';
export const DOCS_PUBLISHER_ROLE_NAME = 'docs-publisher';

/** SSM parameters OrcaSonar writes. The first two are read by the docs platform; the rest by the stateless stack. */
export const SSM_PARAMETERS = {
  ingestBucketName: '/orcasonar/ingest-bucket-name',
  apiUrl: '/orcasonar/api-url',
  keyArn: '/orcasonar/key-arn',
  tableName: '/orcasonar/table-name',
  recordsBucketName: '/orcasonar/records-bucket-name',
  knowledgeBaseId: '/orcasonar/knowledge-base-id',
  dataSourceId: '/orcasonar/data-source-id',
  guardrailId: '/orcasonar/guardrail-id',
  guardrailVersion: '/orcasonar/guardrail-version',
} as const;

/** The docs platform's public Cognito client, written by `umccr/infrastructure` `cognito_aai/app_docs.tf`. */
export const DOCS_APP_CLIENT_ID_PARAMETER = '/cognito/docs-app/app-client-id';

/** Questions, answers and feedback are kept this long, for evaluation, then deleted. */
export const RECORD_RETENTION_DAYS = 30;
