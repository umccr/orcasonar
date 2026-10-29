import type { Environment } from 'aws-cdk-lib';

/**
 * What OrcaSonar needs to know about the UMCCR platform it runs on: its accounts, the SSM parameters that other stacks
 * write in each stage account, and OrcaUI's hosts. Copied from `@orcabus/platform-cdk-constructs` 1.9.11
 * (https://github.com/OrcaBus/platform-cdk-constructs), which OrcaSonar no longer depends on. When UMCCR moves an
 * account, a parameter or a host, OrcaBus changes it there and OrcaSonar here.
 */

export const REGION = 'ap-southeast-2';

/** UMCCR's AWS accounts that OrcaSonar uses. The stg account runs no OrcaSonar stage. */
export const ACCOUNTS = {
  /** Where the pipelines run. */
  toolchain: { account: '383856791668', region: REGION },
  dev: { account: '843407916570', region: REGION },
  prod: { account: '472057503814', region: REGION },
} satisfies Record<string, Environment>;

/** A regional certificate covering `*.<stage zone>`, from the account's shared setup. */
export const CERTIFICATE_ARN_PARAMETER = '/umccr/certificate_arn';

/** The stage's hosted zone, such as `dev.umccr.org`, from the account's shared setup. */
export const HOSTED_ZONE_ID_PARAMETER = '/hosted_zone/umccr/id';
export const HOSTED_ZONE_NAME_PARAMETER = '/hosted_zone/umccr/name';

/** The `data-portal-<stage>` Cognito user pool, from `umccr/infrastructure` `cognito_aai`. */
export const USER_POOL_ID_PARAMETER = '/data_portal/client/cog_user_pool_id';

/** OrcaUI's Cognito app client, from `umccr/infrastructure` `cognito_aai/app_orcaui.tf`. */
export const ORCAUI_CLIENT_ID_PARAMETER = '/orcaui/cog_app_client_id_stage';

/**
 * OrcaUI's hosts, by OrcaBus's stage names: it serves on `portal.<stage>` and `orcaui.<stage>`. OrcaBus also allows
 * `http://localhost:3000` in beta, for its local app client, which OrcaSonar does not accept.
 */
export const ORCAUI_ORIGINS: Record<'BETA' | 'PROD', string[]> = {
  BETA: ['https://orcaui.dev.umccr.org', 'https://portal.dev.umccr.org'],
  PROD: ['https://orcaui.umccr.org', 'https://portal.umccr.org'],
};
