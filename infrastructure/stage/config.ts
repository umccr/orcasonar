import { RemovalPolicy } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { StageName } from '@orcabus/platform-cdk-constructs/shared-config/accounts';
import { DOCS_APP_CLIENT_ID_PARAMETER } from './constants';
import { OrcaSonarStatefulStackProps } from './stateful-stack';
import { OrcaSonarStatelessStackProps } from './stateless-stack';

/** The stages OrcaSonar runs in: dev (beta) and prod. The stg account has none. */
export type OrcaSonarStage = Exclude<StageName, 'GAMMA'>;

const STAGE_SLUG: Record<OrcaSonarStage, string> = { BETA: 'beta', PROD: 'prod' };

/** The docs hosts whose chat panel calls the API. Keep in step with `DOCS_DOMAIN_NAMES` in umccr/docs-platform. */
export const DOCS_ORIGINS: Record<OrcaSonarStage, string[]> = {
  BETA: ['https://docs.dev.umccr.org'],
  PROD: ['https://docs.umccr.org', 'https://docs.prod.umccr.org'],
};

/**
 * Claude through the Australian cross-Region inference profiles, which run in Sydney and Melbourne only. Confirm the
 * exact profile IDs in each account with `aws bedrock list-inference-profiles` before the first deploy.
 */
export const ANSWER_MODEL_ID = 'au.anthropic.claude-sonnet-5';
export const ALLOWED_MODEL_IDS = [ANSWER_MODEL_ID, 'au.anthropic.claude-haiku-4-5-20251001-v1:0'];
export const MODEL_REGIONS = ['ap-southeast-2', 'ap-southeast-4'];

/** $50 a month in prod; dev is for testing and gets less. */
const MONTHLY_BUDGET_USD: Record<OrcaSonarStage, number> = { BETA: 10, PROD: 50 };

/** What one reader may spend in a day: about 20 answers, so it takes four readers at their cap to use up a day. */
const CALLER_DAILY_USD = 0.4;

/**
 * API Gateway access logs need the account's API Gateway CloudWatch role, which another stack sets: dev has it
 * (2026-10-12), and prod (2026-10-21). Without the role, the deploy fails, so check a new account with
 * `aws apigateway get-account --query cloudwatchRoleArn` before turning them on there.
 */
const ACCESS_LOGS: Record<OrcaSonarStage, boolean> = { BETA: true, PROD: true };

/**
 * Who hears the alarms and the budget's notices by email: a team address rather than a person's, since this file is
 * in the repository. Each address confirms its subscription once. For Slack instead, add the stage's alerts topic
 * (the stateless stack's `AlertsTopicArn` output) to the account's AWS Chatbot channel; see docs/deploy.md.
 */
const ALERT_EMAILS: Record<OrcaSonarStage, string[]> = { BETA: [], PROD: [] };

export const getOrcaSonarStatefulStackProps = (
  stage: OrcaSonarStage
): OrcaSonarStatefulStackProps => {
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
  stage: OrcaSonarStage
): OrcaSonarStatelessStackProps => ({
  stageSlug: STAGE_SLUG[stage],
  corsAllowOrigins: DOCS_ORIGINS[stage],
  // Release 1: the docs chat panel only. Portal apps and a machine client join this list when they start calling.
  allowedClientIdParameters: [DOCS_APP_CLIENT_ID_PARAMETER],
  answerModelId: ANSWER_MODEL_ID,
  allowedModelIds: ALLOWED_MODEL_IDS,
  modelRegions: MODEL_REGIONS,
  budget: { monthlyUsd: MONTHLY_BUDGET_USD[stage], callerDailyUsd: CALLER_DAILY_USD },
  accessLogs: ACCESS_LOGS[stage],
  logRetention: stage === 'PROD' ? RetentionDays.THREE_MONTHS : RetentionDays.ONE_MONTH,
  alertEmails: ALERT_EMAILS[stage],
});
