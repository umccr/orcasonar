import { RemovalPolicy } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { StageName } from '@orcabus/platform-cdk-constructs/shared-config/accounts';
import { DOCS_APP_CLIENT_ID_PARAMETER } from './constants';
import { OrcaSonarStatefulStackProps } from './stateful-stack';
import { OrcaSonarStatelessStackProps } from './stateless-stack';

const STAGE_SLUG: Record<StageName, string> = { BETA: 'beta', GAMMA: 'gamma', PROD: 'prod' };

/** The docs hosts whose chat panel calls the API. Keep in step with `DOCS_DOMAIN_NAMES` in umccr/docs-platform. */
export const DOCS_ORIGINS: Record<StageName, string[]> = {
  BETA: ['https://docs.dev.umccr.org'],
  GAMMA: ['https://docs.stg.umccr.org'],
  PROD: ['https://docs.umccr.org', 'https://docs.prod.umccr.org'],
};

/**
 * Claude through the Australian cross-Region inference profiles, which run in Sydney and Melbourne only. Confirm the
 * exact profile IDs in each account with `aws bedrock list-inference-profiles` before the first deploy.
 */
export const ANSWER_MODEL_ID = 'au.anthropic.claude-sonnet-5';
export const ALLOWED_MODEL_IDS = [ANSWER_MODEL_ID, 'au.anthropic.claude-haiku-4-5-20251001-v1:0'];
export const MODEL_REGIONS = ['ap-southeast-2', 'ap-southeast-4'];

/** $50 a month in prod; dev and stg are for testing and get less. */
const MONTHLY_BUDGET_USD: Record<StageName, number> = { BETA: 10, GAMMA: 10, PROD: 50 };

/** What one reader may spend in a day: about 20 answers, so it takes four readers at their cap to use up a day. */
const CALLER_DAILY_USD = 0.4;

export const getOrcaSonarStatefulStackProps = (stage: StageName): OrcaSonarStatefulStackProps => {
  const isProd = stage === 'PROD';
  return {
    stageSlug: STAGE_SLUG[stage],
    // Prod keeps its data on update and delete, but not after a failed first create, where a kept resource would be
    // an orphan, and the fixed table name and key alias would block the retry.
    removalPolicy: isProd ? RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE : RemovalPolicy.DESTROY,
    deletionProtection: isProd,
  };
};

export const getOrcaSonarStatelessStackProps = (
  stage: StageName
): OrcaSonarStatelessStackProps => ({
  stageSlug: STAGE_SLUG[stage],
  corsAllowOrigins: DOCS_ORIGINS[stage],
  // Release 1: the docs chat panel only. Portal apps and a machine client join this list when they start calling.
  allowedClientIdParameters: [DOCS_APP_CLIENT_ID_PARAMETER],
  answerModelId: ANSWER_MODEL_ID,
  allowedModelIds: ALLOWED_MODEL_IDS,
  modelRegions: MODEL_REGIONS,
  budget: { monthlyUsd: MONTHLY_BUDGET_USD[stage], callerDailyUsd: CALLER_DAILY_USD },
  // Needs API Gateway's account-level CloudWatch role in each account; turn on once it is confirmed there.
  accessLogs: false,
  logRetention: stage === 'PROD' ? RetentionDays.THREE_MONTHS : RetentionDays.ONE_MONTH,
});
