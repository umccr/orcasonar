import type { Environment } from 'aws-cdk-lib';
// The package's environments only: its pipeline construct is replaced by ./toolchain/deployment-pipeline.ts.
import {
  BETA_ENVIRONMENT,
  GAMMA_ENVIRONMENT,
  PROD_ENVIRONMENT,
  TOOLCHAIN_ENVIRONMENT,
} from '@orcabus/platform-cdk-constructs/deployment-stack-pipeline/config';
import type { DeploymentStage } from './toolchain/deployment-pipeline';

/**
 * Account and region of each stage: beta in the dev account, gamma in stg, prod in prod. The pipelines run in the
 * toolchain account. Account IDs come from `@orcabus/platform-cdk-constructs`, UMCCR's shared account list.
 */
export const STAGE_ENVIRONMENTS: Record<DeploymentStage, Environment> = {
  beta: BETA_ENVIRONMENT,
  gamma: GAMMA_ENVIRONMENT,
  prod: PROD_ENVIRONMENT,
};

export { TOOLCHAIN_ENVIRONMENT };
