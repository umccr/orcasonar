import { BedrockAgentClient } from '@aws-sdk/client-bedrock-agent';
import { KnowledgeBaseIngestion } from '../aws/bedrock';
import { documentClient, log } from '../aws/deps';
import { DynamoIngestState } from '../aws/dynamodb';
import { runIngestion } from '../services/ingestion';

const state = new DynamoIngestState(documentClient(), process.env.TABLE_NAME ?? '');
const ingestion = new KnowledgeBaseIngestion(
  new BedrockAgentClient({}),
  process.env.KNOWLEDGE_BASE_ID ?? '',
  process.env.DATA_SOURCE_ID ?? ''
);

/** Every 15 minutes: follow the job started last, and start one if documents changed and none is running. */
export const handler = async (): Promise<string> => runIngestion(state, ingestion, log);
