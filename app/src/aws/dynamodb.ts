import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ApiError } from '../lib/errors';
import type { Spend, SpendKeys, SpendStore } from '../services/budget';
import { HISTORY_TURNS } from '../services/prompt';
import type { Turn } from '../services/prompt';
import type { ConversationStore } from '../services/stores';

/**
 * One table, keyed `pk`/`sk`, holds budget counters, conversation turns and the ingestion flag. Items expire through
 * `expiresAt` (seconds since the epoch).
 */

const DAY = 24 * 60 * 60;
const expiresIn = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;

/** Spend counters: one per month, one per day, one per caller per day. */
export class DynamoSpendStore implements SpendStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string
  ) {}

  private keys(keys: SpendKeys) {
    return {
      month: { pk: 'spend', sk: `month#${keys.month}` },
      day: { pk: 'spend', sk: `day#${keys.day}` },
      caller: { pk: 'spend', sk: `caller#${keys.caller}` },
    };
  }

  async spent(keys: SpendKeys): Promise<Spend> {
    const items = this.keys(keys);
    const result = await this.client.send(
      new BatchGetCommand({
        RequestItems: {
          [this.tableName]: { Keys: Object.values(items), ConsistentRead: true },
        },
      })
    );
    const found = result.Responses?.[this.tableName] ?? [];
    const usd = (key: { sk: string }) =>
      Number(found.find((item) => item['sk'] === key.sk)?.['usd'] ?? 0);
    return { month: usd(items.month), day: usd(items.day), caller: usd(items.caller) };
  }

  async add(keys: SpendKeys, usd: number): Promise<void> {
    const items = this.keys(keys);
    await Promise.all(
      [
        [items.month, 400 * DAY],
        [items.day, 40 * DAY],
        [items.caller, 40 * DAY],
      ].map(([key, ttl]) =>
        this.client.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: key as Record<string, string>,
            UpdateExpression: 'ADD #usd :usd SET #expiresAt = :expiresAt',
            ExpressionAttributeNames: { '#usd': 'usd', '#expiresAt': 'expiresAt' },
            ExpressionAttributeValues: { ':usd': usd, ':expiresAt': expiresIn(ttl as number) },
          })
        )
      )
    );
  }
}

/** Conversation turns, kept as long as the records: 30 days. */
export class DynamoConversationStore implements ConversationStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string
  ) {}

  async load(conversationId: string, ownerId: string): Promise<Turn[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `conversation#${conversationId}` },
        ScanIndexForward: false,
        Limit: HISTORY_TURNS,
      })
    );
    const items = result.Items ?? [];
    if (items.some((item) => item['owner'] !== ownerId)) {
      throw new ApiError(403, 'forbidden', 'That conversation belongs to someone else.');
    }
    return items
      .reverse()
      .map((item) => ({ question: String(item['question']), answer: String(item['answer']) }));
  }

  async append(conversationId: string, ownerId: string, turn: Turn): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `conversation#${conversationId}`,
          sk: `turn#${new Date().toISOString()}`,
          owner: ownerId,
          question: turn.question,
          answer: turn.answer,
          expiresAt: expiresIn(30 * DAY),
        },
      })
    );
  }
}

/** The "documents changed since the last ingestion" flag. */
export class DynamoIngestFlag {
  private static readonly key = { pk: 'ingest', sk: 'stale' };

  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string
  ) {}

  async mark(at: string): Promise<void> {
    await this.client.send(
      new PutCommand({ TableName: this.tableName, Item: { ...DynamoIngestFlag.key, at } })
    );
  }

  async current(): Promise<string | null> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: DynamoIngestFlag.key, ConsistentRead: true })
    );
    return typeof result.Item?.['at'] === 'string' ? result.Item['at'] : null;
  }

  /** Clear the flag, unless a newer change marked it again meanwhile. */
  async clear(at: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: DynamoIngestFlag.key,
          ConditionExpression: '#at = :at',
          ExpressionAttributeNames: { '#at': 'at' },
          ExpressionAttributeValues: { ':at': at },
        })
      );
    } catch (error) {
      if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') {
        throw error;
      }
    }
  }
}
