import type { DynamoDBDocumentClient, QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { ApiError, invalidRequest } from '../lib/errors';
import type { OverBudget, Spend, SpendKeys, SpendStore } from '../services/budget';
import type { IngestState, StaleMark, StartedJob } from '../services/ingestion';
import { HISTORY_TURNS } from '../services/prompt';
import type { Turn } from '../services/prompt';
import type {
  AuditEntry,
  AuditOutcome,
  AuditQuery,
  AuditStore,
  CallerExchange,
  ConversationStore,
} from '../services/stores';

/**
 * One table, keyed `pk`/`sk`, holds budget counters, conversation turns, the audit log and the ingestion state. Items
 * expire through `expiresAt` (seconds since the epoch).
 */

const DAY = 24 * 60 * 60;
const expiresIn = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;

/** A transaction that another on the same items cancelled is tried this many times in all. */
const TRANSACTION_ATTEMPTS = 4;

/** Cancellation reasons worth another attempt: the items were busy, not refused. */
const TRANSIENT_CANCELLATIONS = [
  'TransactionConflict',
  'ThrottlingError',
  'ProvisionedThroughputExceeded',
];

/** A cancelled transaction's reason codes, in the order of its items; undefined for any other error. */
const cancellationReasons = (error: unknown): (string | undefined)[] | undefined => {
  const cancelled = error as {
    name?: string;
    CancellationReasons?: ReadonlyArray<{ Code?: string }>;
  };
  return cancelled.name === 'TransactionCanceledException'
    ? (cancelled.CancellationReasons ?? []).map((reason) => reason.Code)
    : undefined;
};

/** Up to 50 ms, 100 ms, 200 ms…: full jitter, so transactions that collided do not collide again. */
const backoff = (attempt: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.random() * 25 * 2 ** attempt));

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

  /**
   * Three strongly consistent reads. One batch read would do, but a throttled batch can come back without some of the
   * counters, which would read as nothing spent; a read that fails throws instead, and the request is refused.
   */
  async spent(keys: SpendKeys): Promise<Spend> {
    const items = this.keys(keys);
    const usd = async (key: Record<string, string>) => {
      const result = await this.client.send(
        new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true })
      );
      return Number(result.Item?.['usd'] ?? 0);
    };
    const [month, day, caller] = await Promise.all([
      usd(items.month),
      usd(items.day),
      usd(items.caller),
    ]);
    return { month, day, caller };
  }

  async add(keys: SpendKeys, usd: number): Promise<void> {
    await this.write(keys, usd);
  }

  hold(
    keys: SpendKeys,
    usd: number,
    limits: { readonly caller: number; readonly day: number }
  ): Promise<OverBudget | null> {
    return this.write(keys, usd, limits);
  }

  /**
   * One transaction, so the month's, the day's and the caller's spend never disagree. With limits, the caller's and
   * the day's counters change only while under them. The SDK gives each attempt a client request token, so its own
   * retries never add twice; a transaction cancelled by another on the same counters, as when answers settle at the
   * same moment, is tried again here.
   */
  private async write(
    keys: SpendKeys,
    usd: number,
    limits?: { readonly caller: number; readonly day: number }
  ): Promise<OverBudget | null> {
    const items = this.keys(keys);
    const update = (key: Record<string, string>, days: number, under?: number) => ({
      Update: {
        TableName: this.tableName,
        Key: key,
        UpdateExpression: 'ADD #usd :usd SET #expiresAt = :expiresAt',
        ...(under === undefined
          ? {}
          : { ConditionExpression: 'attribute_not_exists(#usd) OR #usd < :under' }),
        ExpressionAttributeNames: { '#usd': 'usd', '#expiresAt': 'expiresAt' },
        ExpressionAttributeValues: {
          ':usd': usd,
          ':expiresAt': expiresIn(days * DAY),
          ...(under === undefined ? {} : { ':under': under }),
        },
      },
    });
    for (let attempt = 1; ; attempt++) {
      try {
        await this.client.send(
          new TransactWriteCommand({
            // In this order: a cancellation's reasons come back in the order of the items.
            TransactItems: [
              update(items.caller, 40, limits?.caller),
              update(items.day, 40, limits?.day),
              update(items.month, 400),
            ],
          })
        );
        return null;
      } catch (error) {
        const reasons = cancellationReasons(error);
        if (reasons?.[0] === 'ConditionalCheckFailed') {
          return 'caller';
        }
        if (reasons?.[1] === 'ConditionalCheckFailed') {
          return 'team';
        }
        if (!reasons?.some((code) => TRANSIENT_CANCELLATIONS.includes(code ?? ''))) {
          throw error;
        }
        if (attempt === TRANSACTION_ATTEMPTS) {
          throw new ApiError(503, 'unavailable', 'Too many answers at once. Try again shortly.');
        }
        await backoff(attempt);
      }
    }
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

/** The index that lists the audit log by time: `auditPk`, the same for every entry, and `at`. */
export const AUDIT_INDEX = 'audit-by-time';
const AUDIT_PARTITION = 'exchange';

/** The index that lists one caller's exchanges by time, for their history: `callerId` and `at`. */
export const AUDIT_CALLER_INDEX = 'audit-by-caller';

/** Where a page of the audit log stopped: the last entry's keys in the table and in the index. */
const AuditCursor = z.object({
  pk: z.string().regex(/^audit#c_[0-9a-f]{32}$/),
  sk: z.string().min(1).max(100),
  at: z.string().min(1).max(40),
});

const cursorFor = (item: Record<string, unknown>) =>
  Buffer.from(JSON.stringify({ pk: item['pk'], sk: item['sk'], at: item['at'] })).toString(
    'base64url'
  );

const startAfter = (cursor: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    parsed = undefined;
  }
  const keys = AuditCursor.safeParse(parsed);
  if (!keys.success) {
    throw invalidRequest('cursor must be one a previous page returned.');
  }
  return { ...keys.data, auditPk: AUDIT_PARTITION };
};

/** The table's own attributes on an audit item, which are not part of the entry. */
const AUDIT_KEYS = new Set(['pk', 'sk', 'auditPk', 'expiresAt']);

const toEntry = (item: Record<string, unknown>): AuditEntry =>
  Object.fromEntries(
    Object.entries(item).filter(([name]) => !AUDIT_KEYS.has(name))
  ) as unknown as AuditEntry;

/**
 * An item of the index by caller, which holds only these besides the keys. Named one by one, so the list of
 * conversations never sees more, whatever the index holds. Keep in step with `AUDIT_CALLER_ATTRIBUTES` in
 * `infrastructure/stage/constants.ts`.
 */
const toCallerExchange = (item: Record<string, unknown>): CallerExchange => ({
  callerId: String(item['callerId']),
  at: String(item['at']),
  conversationId: String(item['conversationId']),
  question: String(item['question']),
  outcome: item['outcome'] as AuditOutcome,
});

/**
 * The audit log: one item per exchange, `audit#<conversation>` and `<at>#<exchange>`, kept 30 days. One index lists
 * them by time, and for the audit routes a caller or an outcome is filtered as the entries are read. That reads every
 * entry in the window, which the budget keeps to about a hundred a day. A second index lists one caller's exchanges by
 * time, with only what a list of conversations needs, so a reader's own history never reads anyone else's.
 */
export class DynamoAuditStore implements AuditStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string
  ) {}

  async put(entry: AuditEntry): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `audit#${entry.conversationId}`,
          sk: `${entry.at}#${entry.exchangeId}`,
          auditPk: AUDIT_PARTITION,
          ...entry,
          expiresAt: expiresIn(30 * DAY),
        },
      })
    );
  }

  async list(query: AuditQuery): Promise<{ items: AuditEntry[]; cursor?: string }> {
    const filters: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    if (query.caller) {
      filters.push('(#callerId = :caller OR #email = :caller)');
      Object.assign(names, { '#callerId': 'callerId', '#email': 'email' });
      values[':caller'] = query.caller;
    }
    if (query.outcome) {
      filters.push('#outcome = :outcome');
      names['#outcome'] = 'outcome';
      values[':outcome'] = query.outcome;
    }
    const items: AuditEntry[] = [];
    const pages = this.byTime(query.from, query.to, {
      filter: filters.length ? filters.join(' AND ') : undefined,
      names,
      values,
      startKey: query.cursor ? startAfter(query.cursor) : undefined,
    });
    // A filter can leave a page short, so pages are read until the limit is reached. The cursor is the last entry
    // returned rather than the last read, since the page it came from may have more.
    for await (const item of pages) {
      items.push(toEntry(item));
      if (items.length === query.limit) {
        return { items, cursor: cursorFor(item) };
      }
    }
    return { items };
  }

  async between(from: string, to: string): Promise<AuditEntry[]> {
    return this.all(this.byTime(from, to, { names: {}, values: {} }), toEntry);
  }

  async byCaller(callerId: string, from: string, to: string): Promise<CallerExchange[]> {
    return this.all(
      this.pages({
        IndexName: AUDIT_CALLER_INDEX,
        KeyConditionExpression: '#callerId = :caller AND #at BETWEEN :from AND :to',
        ExpressionAttributeNames: { '#callerId': 'callerId', '#at': 'at' },
        ExpressionAttributeValues: { ':caller': callerId, ':from': from, ':to': to },
        ScanIndexForward: false,
      }),
      toCallerExchange
    );
  }

  async conversation(conversationId: string): Promise<AuditEntry[]> {
    return this.all(
      this.pages({
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `audit#${conversationId}` },
      }),
      toEntry
    );
  }

  private async all<T>(
    items: AsyncIterable<Record<string, unknown>>,
    map: (item: Record<string, unknown>) => T
  ): Promise<T[]> {
    const all: T[] = [];
    for await (const item of items) {
      all.push(map(item));
    }
    return all;
  }

  /** The entries between two ISO times, newest first, a page of the index at a time. */
  private byTime(
    from: string,
    to: string,
    options: {
      filter?: string;
      names: Record<string, string>;
      values: Record<string, unknown>;
      startKey?: Record<string, unknown>;
    }
  ): AsyncGenerator<Record<string, unknown>> {
    return this.pages(
      {
        IndexName: AUDIT_INDEX,
        KeyConditionExpression: '#auditPk = :partition AND #at BETWEEN :from AND :to',
        FilterExpression: options.filter,
        ExpressionAttributeNames: { '#auditPk': 'auditPk', '#at': 'at', ...options.names },
        ExpressionAttributeValues: {
          ':partition': AUDIT_PARTITION,
          ':from': from,
          ':to': to,
          ...options.values,
        },
        ScanIndexForward: false,
      },
      options.startKey
    );
  }

  /** Every item a query matches, a page at a time, from `startKey` when given. */
  private async *pages(
    query: Omit<QueryCommandInput, 'TableName' | 'ExclusiveStartKey'>,
    startKey?: Record<string, unknown>
  ): AsyncGenerator<Record<string, unknown>> {
    let next = startKey;
    do {
      const result = await this.client.send(
        new QueryCommand({ TableName: this.tableName, ...query, ExclusiveStartKey: next })
      );
      yield* result.Items ?? [];
      next = result.LastEvaluatedKey;
    } while (next);
  }
}

/** Ingestion: the mark that documents changed since the index was brought up to date, and the job started for it. */
export class DynamoIngestState implements IngestState {
  private static readonly staleKey = { pk: 'ingest', sk: 'stale' };
  private static readonly jobKey = { pk: 'ingest', sk: 'job' };

  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string
  ) {}

  async mark(mark: StaleMark): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...DynamoIngestState.staleKey, at: mark.at, revision: mark.revision },
      })
    );
  }

  async stale(): Promise<StaleMark | null> {
    const item = await this.get(DynamoIngestState.staleKey);
    const at = item?.['at'];
    const revision = item?.['revision'];
    return typeof at === 'string' && typeof revision === 'string' ? { at, revision } : null;
  }

  async clear(revision: string): Promise<void> {
    await this.deleteIf(DynamoIngestState.staleKey, 'revision', revision);
  }

  async job(): Promise<StartedJob | null> {
    const item = await this.get(DynamoIngestState.jobKey);
    const jobId = item?.['jobId'];
    const revision = item?.['revision'];
    return typeof jobId === 'string' && typeof revision === 'string' ? { jobId, revision } : null;
  }

  async started(job: StartedJob): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...DynamoIngestState.jobKey, jobId: job.jobId, revision: job.revision },
      })
    );
  }

  async finished(jobId: string): Promise<void> {
    await this.deleteIf(DynamoIngestState.jobKey, 'jobId', jobId);
  }

  private async get(key: Record<string, string>) {
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true })
    );
    return result.Item;
  }

  /** Deletes the item while `name` still holds `value`; a newer value is a newer change or job, which stays. */
  private async deleteIf(key: Record<string, string>, name: string, value: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: key,
          ConditionExpression: '#name = :value',
          ExpressionAttributeNames: { '#name': name },
          ExpressionAttributeValues: { ':value': value },
        })
      );
    } catch (error) {
      if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') {
        throw error;
      }
    }
  }
}
