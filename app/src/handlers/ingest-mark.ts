import { randomUUID } from 'node:crypto';
import type { EventBridgeEvent } from 'aws-lambda';
import { documentClient } from '../aws/deps';
import { DynamoIngestState } from '../aws/dynamodb';

const state = new DynamoIngestState(documentClient(), process.env.TABLE_NAME ?? '');

/**
 * An object under docs/ was created or deleted: the index is stale from now. The event's ID is the change's revision:
 * unlike its time, which has whole seconds only, no other change shares it.
 */
export const handler = async (event: EventBridgeEvent<string, unknown>): Promise<void> => {
  await state.mark({
    at: event.time ?? new Date().toISOString(),
    revision: event.id ?? randomUUID(),
  });
};
