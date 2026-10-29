import { RemovalPolicy } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ORCAUI_CLIENT_ID_PARAMETER, ORCAUI_ORIGINS } from '../shared/platform';
import { DOCS_APP_CLIENT_ID_PARAMETER } from './constants';
import { OrcaSonarStatefulStackProps } from './stateful-stack';
import { OrcaSonarStatelessStackProps } from './stateless-stack';

/** The stages OrcaSonar runs in: dev (beta) and prod. The stg account has none. */
export type OrcaSonarStage = 'BETA' | 'PROD';

const STAGE_SLUG: Record<OrcaSonarStage, string> = { BETA: 'beta', PROD: 'prod' };

/** The docs hosts whose chat panel calls the API. Keep in step with `DOCS_DOMAIN_NAMES` in umccr/docs-platform. */
export const DOCS_ORIGINS: Record<OrcaSonarStage, string[]> = {
  BETA: ['https://docs.dev.umccr.org'],
  PROD: ['https://docs.umccr.org', 'https://docs.prod.umccr.org'],
};

/**
 * The Cognito app clients whose ID tokens the authorizer accepts, by the SSM parameters that hold their IDs: the docs
 * chat panel and OrcaUI. Each caller is added by name rather than taking OrcaBus's whole list, which also holds the
 * token service's client for machines and, in beta, a local client. Machine callers wait for caps of their own.
 */
export const ALLOWED_CLIENT_ID_PARAMETERS = [
  DOCS_APP_CLIENT_ID_PARAMETER,
  ORCAUI_CLIENT_ID_PARAMETER,
];

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

/**
 * Who may read the audit log, everyone's questions with their emails: the data-portal Cognito group whose members may,
 * or `*` for every reader with a token the authorizer accepts. Beta is open for now, while the audit log is tried out
 * with the same tokens as chat and search; prod is for the portal's administrators. A group of OrcaSonar's own can
 * replace `admin` here, with no change to the code.
 */
const AUDIT_GROUP: Record<OrcaSonarStage, string> = { BETA: '*', PROD: 'admin' };

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
  corsAllowOrigins: [...DOCS_ORIGINS[stage], ...ORCAUI_ORIGINS[stage]],
  allowedClientIdParameters: ALLOWED_CLIENT_ID_PARAMETERS,
  answerModelId: ANSWER_MODEL_ID,
  allowedModelIds: ALLOWED_MODEL_IDS,
  modelRegions: MODEL_REGIONS,
  budget: { monthlyUsd: MONTHLY_BUDGET_USD[stage], callerDailyUsd: CALLER_DAILY_USD },
  accessLogs: ACCESS_LOGS[stage],
  logRetention: stage === 'PROD' ? RetentionDays.THREE_MONTHS : RetentionDays.ONE_MONTH,
  alertEmails: ALERT_EMAILS[stage],
  auditGroup: AUDIT_GROUP[stage],
});
