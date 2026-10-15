import { BedrockAgentClient } from '@aws-sdk/client-bedrock-agent';
import { KnowledgeBaseIngestion } from '../aws/bedrock';
import { documentClient, log } from '../aws/deps';
import { DynamoIngestFlag } from '../aws/dynamodb';
import { runIngestion } from '../services/ingestion';

const flag = new DynamoIngestFlag(documentClient(), process.env.TABLE_NAME ?? '');
const ingestion = new KnowledgeBaseIngestion(
  new BedrockAgentClient({}),
  process.env.KNOWLEDGE_BASE_ID ?? '',
  process.env.DATA_SOURCE_ID ?? ''
);

/** Every 15 minutes: start one ingestion job if documents changed and none is running. */
export const handler = async (): Promise<string> => runIngestion(flag, ingestion, log);
