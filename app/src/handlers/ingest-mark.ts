import type { EventBridgeEvent } from 'aws-lambda';
import { documentClient } from '../aws/deps';
import { DynamoIngestFlag } from '../aws/dynamodb';

const flag = new DynamoIngestFlag(documentClient(), process.env.TABLE_NAME ?? '');

/** An object under docs/ was created or deleted: the index is stale from now. */
export const handler = async (event: EventBridgeEvent<string, unknown>): Promise<void> => {
  await flag.mark(event.time ?? new Date().toISOString());
};
