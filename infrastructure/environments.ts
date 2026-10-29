import type { Environment } from 'aws-cdk-lib';
import { ACCOUNTS } from './shared/platform';
import type { DeploymentStage } from './toolchain/deployment-pipeline';

/**
 * Account and region of each stage: beta in the dev account and prod in prod; the stg account runs no OrcaSonar
 * stage. The pipelines run in the toolchain account. Account IDs are UMCCR's, in `./shared/platform.ts`.
 */
export const STAGE_ENVIRONMENTS: Record<DeploymentStage, Environment> = {
  beta: ACCOUNTS.dev,
  prod: ACCOUNTS.prod,
};

export const TOOLCHAIN_ENVIRONMENT: Environment = ACCOUNTS.toolchain;
