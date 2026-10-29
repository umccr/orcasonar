import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AppDeps } from '../app';
import type { Env } from '../config/env';
import { corsOrigins } from '../config/env';
import { Budget } from '../services/budget';
import type { Guardrail } from './bedrock';
import { BedrockAnswerer, KnowledgeBaseRetriever } from './bedrock';
import { DynamoAuditStore, DynamoConversationStore, DynamoSpendStore } from './dynamodb';
import { S3DocumentStore, S3RecordStore } from './s3';
import { cachedParameter } from './ssm';

/** Log lines are JSON, and never carry a question or an answer. */
export const log = (entry: Record<string, unknown>) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));

export const documentClient = () =>
  DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });

/**
 * The guardrail answers apply. Its version is read from SSM every few minutes rather than fixed at deploy: the
 * stateful stack publishes a new version there whenever the policies change, and keeps the one it replaces, so a
 * running function moves to the new version within minutes, and uses the deployed one while SSM cannot be read.
 */
const guardrail = (env: Env): (() => Promise<Guardrail>) | undefined => {
  const { GUARDRAIL_ID: id, GUARDRAIL_VERSION: deployed } = env;
  if (!id || !deployed) {
    return undefined;
  }
  const version = env.GUARDRAIL_VERSION_PARAMETER
    ? cachedParameter(new SSMClient({}), env.GUARDRAIL_VERSION_PARAMETER, {
        fallback: deployed,
        log,
      })
    : async () => deployed;
  return async () => ({ id, version: await version() });
};

/** The API's dependencies on AWS, from the function's environment. */
export const awsDeps = (env: Env): AppDeps => {
  const dynamodb = documentClient();
  const s3 = new S3Client({});
  let answerer: BedrockAnswerer | undefined;

  return {
    stage: env.STAGE,
    corsAllowOrigins: corsOrigins(env),
    minScore: env.MIN_SCORE,
    budget: new Budget(new DynamoSpendStore(dynamodb, env.TABLE_NAME), {
      monthlyUsd: env.MONTHLY_BUDGET_USD,
      callerDailyUsd: env.CALLER_DAILY_USD,
    }),
    conversations: new DynamoConversationStore(dynamodb, env.TABLE_NAME),
    retriever: new KnowledgeBaseRetriever(new BedrockAgentRuntimeClient({}), env.KNOWLEDGE_BASE_ID),
    records: new S3RecordStore(s3, env.RECORDS_BUCKET),
    audit: new DynamoAuditStore(dynamodb, env.TABLE_NAME),
    auditGroup: env.AUDIT_GROUP,
    documents: new S3DocumentStore(s3, env.INGEST_BUCKET ?? ''),
    answerer: () => {
      if (!env.ANSWER_MODEL_ID) {
        throw new Error('ANSWER_MODEL_ID is not set: only the chat function answers');
      }
      answerer ??= new BedrockAnswerer(
        new BedrockRuntimeClient({}),
        env.ANSWER_MODEL_ID,
        guardrail(env)
      );
      return answerer;
    },
    clock: () => new Date(),
    log,
  };
};
