import { BedrockAgentClient, GetIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import { BedrockAgentRuntimeClient, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { ApiError } from '../lib/errors';
import type { AnswerEvent } from '../services/answer';
import type { AuditEntry } from '../services/stores';
import { BedrockAnswerer, KnowledgeBaseIngestion, KnowledgeBaseRetriever } from './bedrock';
import { AUDIT_INDEX, DynamoAuditStore, DynamoIngestState, DynamoSpendStore } from './dynamodb';
import { metadataValues, S3DocumentStore } from './s3';
import { cachedParameter } from './ssm';

describe('KnowledgeBaseRetriever', () => {
  const bedrock = mockClient(BedrockAgentRuntimeClient);
  beforeEach(() => bedrock.reset());

  test('uses managed search, filtered by site, and maps the export metadata', async () => {
    bedrock.on(RetrieveCommand).resolves({
      retrievalResults: [
        {
          content: { type: 'TEXT', text: 'Register the site.' },
          score: 0.9,
          metadata: {
            doc_id: 'platform:onboarding',
            title: 'Onboarding',
            url: 'https://docs.umccr.org/platform/onboarding/',
            site: 'platform',
          },
        },
        { content: { type: 'IMAGE' }, score: 0.5 },
      ],
    });
    const retriever = new KnowledgeBaseRetriever(new BedrockAgentRuntimeClient({}), 'KB123');

    const passages = await retriever.retrieve('add a site', { sites: ['platform'], topK: 8 });
    expect(passages).toEqual([
      {
        id: 'platform:onboarding',
        title: 'Onboarding',
        url: 'https://docs.umccr.org/platform/onboarding/',
        site: 'platform',
        text: 'Register the site.',
        score: 0.9,
      },
    ]);
    expect(bedrock.commandCalls(RetrieveCommand)[0]!.args[0].input).toEqual({
      knowledgeBaseId: 'KB123',
      retrievalQuery: { text: 'add a site' },
      retrievalConfiguration: {
        managedSearchConfiguration: {
          numberOfResults: 8,
          filter: { equals: { key: 'site', value: 'platform' } },
        },
      },
    });

    await retriever.retrieve('q', { sites: ['a', 'b'], topK: 3 });
    await retriever.retrieve('q', { topK: 3 });
    const filters = bedrock
      .commandCalls(RetrieveCommand)
      .map((call) => call.args[0].input.retrievalConfiguration?.managedSearchConfiguration?.filter);
    expect(filters.slice(1)).toEqual([{ in: { key: 'site', value: ['a', 'b'] } }, undefined]);
  });
});

describe('BedrockAnswerer', () => {
  const bedrock = mockClient(BedrockRuntimeClient);
  beforeEach(() => bedrock.reset());

  test('streams text and usage, with the guardrail on every call', async () => {
    async function* stream() {
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello ' } } };
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'there [1].' } } };
      yield { messageStop: { stopReason: 'end_turn' as const } };
      yield {
        metadata: {
          usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 },
          metrics: { latencyMs: 1 },
        },
      };
    }
    bedrock.on(ConverseStreamCommand).resolves({ stream: stream() } as never);
    const answerer = new BedrockAnswerer(
      new BedrockRuntimeClient({}),
      'au.anthropic.claude-sonnet-5',
      async () => ({ id: 'g-1', version: '3' })
    );

    const events = [];
    for await (const event of answerer.stream({ system: 'sys', messages: [], maxTokens: 1000 })) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'started' },
      { type: 'delta', text: 'Hello ' },
      { type: 'delta', text: 'there [1].' },
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 5 } },
    ]);
    const input = bedrock.commandCalls(ConverseStreamCommand)[0]!.args[0].input;
    expect(input.modelId).toBe('au.anthropic.claude-sonnet-5');
    // Sonnet 5 refuses a request with `temperature`, so the config holds the token limit only.
    expect(input.inferenceConfig).toEqual({ maxTokens: 1000 });
    expect(input.guardrailConfig).toEqual({
      guardrailIdentifier: 'g-1',
      guardrailVersion: '3',
      streamProcessingMode: 'sync',
    });
  });

  test('reports a guardrail intervention', async () => {
    async function* stream() {
      yield { messageStop: { stopReason: 'guardrail_intervened' as const } };
    }
    bedrock.on(ConverseStreamCommand).resolves({ stream: stream() } as never);
    const answerer = new BedrockAnswerer(new BedrockRuntimeClient({}), 'm');
    const events = [];
    for await (const event of answerer.stream({ system: 's', messages: [], maxTokens: 10 })) {
      events.push(event);
    }
    expect(events).toEqual([{ type: 'started' }, { type: 'guardrail' }]);
  });

  // A refused request bills nothing, so the chat must not hold it against the reader as a started answer.
  test('reports nothing as started when Bedrock refuses the request', async () => {
    bedrock
      .on(ConverseStreamCommand)
      .rejects(Object.assign(new Error('Too many requests'), { name: 'ThrottlingException' }));
    const answerer = new BedrockAnswerer(new BedrockRuntimeClient({}), 'm');
    const events: AnswerEvent[] = [];
    const streamed = (async () => {
      for await (const event of answerer.stream({ system: 's', messages: [], maxTokens: 10 })) {
        events.push(event);
      }
    })();
    await expect(streamed).rejects.toThrow('Too many requests');
    expect(events).toEqual([]);
  });
});

describe('S3DocumentStore', () => {
  const s3 = mockClient(S3Client);
  beforeEach(() => s3.reset());

  const body = (text: string) => ({ transformToString: async () => text }) as never;

  test('reads the document and its typed metadata', async () => {
    s3.on(GetObjectCommand, { Key: 'docs/platform/onboarding.md' }).resolves({
      Body: body('# Onboarding'),
    });
    s3.on(GetObjectCommand, { Key: 'docs/platform/onboarding.md.metadata.json' }).resolves({
      Body: body(
        JSON.stringify({
          metadataAttributes: {
            doc_id: { value: { type: 'STRING', stringValue: 'platform:onboarding' } },
            title: { value: { type: 'STRING', stringValue: 'Onboarding a repository' } },
            url: {
              value: { type: 'STRING', stringValue: 'https://docs.umccr.org/platform/onboarding/' },
            },
            updated: { value: { type: 'STRING', stringValue: '2026-10-12' } },
          },
        })
      ),
    });
    const store = new S3DocumentStore(new S3Client({}), 'ingest');
    expect(await store.get('platform', 'onboarding')).toEqual({
      id: 'platform:onboarding',
      site: 'platform',
      title: 'Onboarding a repository',
      url: 'https://docs.umccr.org/platform/onboarding/',
      updated: '2026-10-12',
      markdown: '# Onboarding',
    });
  });

  test('returns null for a missing document', async () => {
    s3.on(GetObjectCommand).rejects(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
    const store = new S3DocumentStore(new S3Client({}), 'ingest');
    expect(await store.get('platform', 'nothing')).toBeNull();
  });

  test('reads plain metadata values too', () => {
    expect(metadataValues({ metadataAttributes: { site: 'platform' } })).toEqual({
      site: 'platform',
    });
  });
});

const cancelled = (...codes: string[]) =>
  new TransactionCanceledException({
    message: 'Transaction cancelled',
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

describe('DynamoSpendStore', () => {
  const dynamodb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => dynamodb.reset());

  const store = () =>
    new DynamoSpendStore(DynamoDBDocumentClient.from(new DynamoDBClient({})), 'table');
  const keys = { month: '2026-10', day: '2026-10-12', caller: 'reader-1#2026-10-12' };

  test('reads each counter with a consistent read', async () => {
    dynamodb.on(GetCommand, { Key: { pk: 'spend', sk: 'month#2026-10' } }).resolves({
      Item: { usd: 12.5 },
    });
    dynamodb.on(GetCommand, { Key: { pk: 'spend', sk: 'day#2026-10-12' } }).resolves({
      Item: { usd: 1.25 },
    });
    dynamodb
      .on(GetCommand, { Key: { pk: 'spend', sk: 'caller#reader-1#2026-10-12' } })
      .resolves({});
    expect(await store().spent(keys)).toEqual({ month: 12.5, day: 1.25, caller: 0 });
    const calls = dynamodb.commandCalls(GetCommand);
    expect(calls.every((call) => call.args[0].input.ConsistentRead)).toBe(true);
  });

  test('refuses, rather than reading no spend, when a counter cannot be read', async () => {
    dynamodb.on(GetCommand).resolves({ Item: { usd: 1 } });
    dynamodb
      .on(GetCommand, { Key: { pk: 'spend', sk: 'month#2026-10' } })
      .rejects(
        Object.assign(new Error('Throughput exceeds the limit'), { name: 'ThrottlingException' })
      );
    await expect(store().spent(keys)).rejects.toThrow('Throughput exceeds the limit');
  });

  test('adds to the three counters in one transaction', async () => {
    dynamodb.on(TransactWriteCommand).resolves({});
    await store().add(keys, -0.05);
    const items = dynamodb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items.map((item) => item.Update?.Key)).toEqual([
      { pk: 'spend', sk: 'caller#reader-1#2026-10-12' },
      { pk: 'spend', sk: 'day#2026-10-12' },
      { pk: 'spend', sk: 'month#2026-10' },
    ]);
    expect(items.every((item) => item.Update?.ExpressionAttributeValues?.[':usd'] === -0.05)).toBe(
      true
    );
    expect(items.some((item) => item.Update?.ConditionExpression)).toBe(false);
  });

  test("holds only while the caller's and the day's spend are under their limits", async () => {
    dynamodb.on(TransactWriteCommand).resolves({});
    expect(await store().hold(keys, 0.1, { caller: 0.4, day: 2.5 })).toBeNull();
    const [caller, day, month] =
      dynamodb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(caller!.Update).toMatchObject({
      ConditionExpression: 'attribute_not_exists(#usd) OR #usd < :under',
      ExpressionAttributeValues: { ':usd': 0.1, ':under': 0.4 },
    });
    expect(day!.Update).toMatchObject({ ExpressionAttributeValues: { ':under': 2.5 } });
    expect(month!.Update?.ConditionExpression).toBeUndefined();
  });

  test('names the limit that refused a hold', async () => {
    dynamodb
      .on(TransactWriteCommand)
      .rejectsOnce(cancelled('ConditionalCheckFailed', 'None', 'None'))
      .rejectsOnce(cancelled('None', 'ConditionalCheckFailed', 'None'));
    const spend = store();
    expect(await spend.hold(keys, 0.1, { caller: 0.4, day: 2.5 })).toBe('caller');
    expect(await spend.hold(keys, 0.1, { caller: 0.4, day: 2.5 })).toBe('team');
  });

  test('tries a transaction again when another on the same counters cancelled it', async () => {
    dynamodb
      .on(TransactWriteCommand)
      .rejectsOnce(cancelled('None', 'TransactionConflict', 'None'))
      .resolves({});
    expect(await store().hold(keys, 0.1, { caller: 0.4, day: 2.5 })).toBeNull();
    expect(dynamodb.commandCalls(TransactWriteCommand)).toHaveLength(2);
  });

  test('gives up with 503 when the counters stay busy', async () => {
    dynamodb.on(TransactWriteCommand).rejects(cancelled('None', 'TransactionConflict', 'None'));
    const error = await store()
      .add(keys, 0.1)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503, code: 'unavailable' });
    expect(dynamodb.commandCalls(TransactWriteCommand)).toHaveLength(4);
  });
});

describe('DynamoIngestState', () => {
  const dynamodb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => dynamodb.reset());

  const state = () =>
    new DynamoIngestState(DynamoDBDocumentClient.from(new DynamoDBClient({})), 'table');

  test('marks the index stale with the change and reads it back', async () => {
    dynamodb.on(PutCommand).resolves({});
    dynamodb.on(GetCommand).resolves({
      Item: { pk: 'ingest', sk: 'stale', at: '2026-10-12T00:00:00Z', revision: 'event-1' },
    });
    await state().mark({ at: '2026-10-12T00:00:00Z', revision: 'event-1' });
    expect(dynamodb.commandCalls(PutCommand)[0]!.args[0].input.Item).toEqual({
      pk: 'ingest',
      sk: 'stale',
      at: '2026-10-12T00:00:00Z',
      revision: 'event-1',
    });
    expect(await state().stale()).toEqual({ at: '2026-10-12T00:00:00Z', revision: 'event-1' });
  });

  test('clears the mark only while it is the same change', async () => {
    dynamodb.on(DeleteCommand).rejects(
      Object.assign(new Error('The conditional request failed'), {
        name: 'ConditionalCheckFailedException',
      })
    );
    await state().clear('event-1');
    expect(dynamodb.commandCalls(DeleteCommand)[0]!.args[0].input).toMatchObject({
      Key: { pk: 'ingest', sk: 'stale' },
      ConditionExpression: '#name = :value',
      ExpressionAttributeNames: { '#name': 'revision' },
      ExpressionAttributeValues: { ':value': 'event-1' },
    });
  });

  test('keeps the job started for a revision until it is finished', async () => {
    dynamodb.on(PutCommand).resolves({});
    dynamodb.on(DeleteCommand).resolves({});
    await state().started({ jobId: 'job-1', revision: 'event-1' });
    await state().finished('job-1');
    expect(dynamodb.commandCalls(PutCommand)[0]!.args[0].input.Item).toEqual({
      pk: 'ingest',
      sk: 'job',
      jobId: 'job-1',
      revision: 'event-1',
    });
    expect(dynamodb.commandCalls(DeleteCommand)[0]!.args[0].input).toMatchObject({
      Key: { pk: 'ingest', sk: 'job' },
      ExpressionAttributeValues: { ':value': 'job-1' },
    });
  });
});

describe('DynamoAuditStore', () => {
  const dynamodb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => dynamodb.reset());

  const store = () =>
    new DynamoAuditStore(DynamoDBDocumentClient.from(new DynamoDBClient({})), 'table');
  const conversation = `c_${'a'.repeat(32)}`;
  const window = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' };
  const entry = (day: number): AuditEntry => ({
    exchangeId: `x_${String(day).padStart(32, '0')}`,
    conversationId: conversation,
    at: `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`,
    callerId: 'reader-1',
    email: 'reader@umccr.org',
    clientId: 'docs-app',
    outcome: 'answered',
    question: 'How do I add a site?',
    answer: 'Add one entry.',
    costUsd: 0.02,
  });
  const item = (day: number) => ({
    pk: `audit#${conversation}`,
    sk: `${entry(day).at}#${entry(day).exchangeId}`,
    auditPk: 'exchange',
    expiresAt: 1_800_000_000,
    ...entry(day),
  });
  const queries = () => dynamodb.commandCalls(QueryCommand).map((call) => call.args[0].input);

  test('keeps each exchange under its conversation, in the audit index, for 30 days', async () => {
    dynamodb.on(PutCommand).resolves({});
    const now = Math.floor(Date.now() / 1000);
    await store().put(entry(11));
    const stored = dynamodb.commandCalls(PutCommand)[0]!.args[0].input.Item!;
    expect(stored).toEqual({
      pk: `audit#${conversation}`,
      sk: `2026-10-11T00:00:00.000Z#x_${'0'.repeat(30)}11`,
      auditPk: 'exchange',
      ...entry(11),
      expiresAt: expect.any(Number),
    });
    expect(stored['expiresAt']).toBeGreaterThanOrEqual(now + 30 * 24 * 60 * 60);
    expect(stored['expiresAt']).toBeLessThan(now + 30 * 24 * 60 * 60 + 60);
  });

  test('lists through the index, newest first, filtering as it reads', async () => {
    dynamodb.on(QueryCommand).resolves({ Items: [item(12), item(11)] });
    const page = await store().list({
      ...window,
      caller: 'reader@umccr.org',
      outcome: 'answered',
      limit: 10,
    });
    expect(page).toEqual({ items: [entry(12), entry(11)] });
    expect(queries()[0]).toMatchObject({
      IndexName: AUDIT_INDEX,
      KeyConditionExpression: '#auditPk = :partition AND #at BETWEEN :from AND :to',
      FilterExpression: '(#callerId = :caller OR #email = :caller) AND #outcome = :outcome',
      ExpressionAttributeValues: {
        ':partition': 'exchange',
        ':from': window.from,
        ':to': window.to,
        ':caller': 'reader@umccr.org',
        ':outcome': 'answered',
      },
      ScanIndexForward: false,
    });
  });

  test('reads on past short pages, and continues after the last entry it returned', async () => {
    dynamodb
      .on(QueryCommand)
      .resolvesOnce({ Items: [item(15)], LastEvaluatedKey: { page: 1 } })
      .resolvesOnce({ Items: [item(14), item(13)], LastEvaluatedKey: { page: 2 } });
    const page = await store().list({ ...window, limit: 2 });
    expect(page.items).toEqual([entry(15), entry(14)]);
    expect(queries().map((query) => query.ExclusiveStartKey)).toEqual([undefined, { page: 1 }]);

    dynamodb.reset();
    dynamodb.on(QueryCommand).resolves({ Items: [item(13)] });
    expect(await store().list({ ...window, limit: 2, cursor: page.cursor })).toEqual({
      items: [entry(13)],
    });
    expect(queries()[0]!.ExclusiveStartKey).toEqual({
      pk: item(14).pk,
      sk: item(14).sk,
      at: item(14).at,
      auditPk: 'exchange',
    });
  });

  test.each([
    'not-a-cursor',
    Buffer.from(JSON.stringify({ pk: 'spend', sk: 'month#2026-10', at: 'x' })).toString(
      'base64url'
    ),
  ])('refuses a cursor it did not make: %s', async (cursor) => {
    await expect(store().list({ ...window, limit: 2, cursor })).rejects.toMatchObject({
      status: 400,
      code: 'invalid-request',
    });
    expect(queries()).toHaveLength(0);
  });

  test('reads every entry in a window, every page', async () => {
    dynamodb
      .on(QueryCommand)
      .resolvesOnce({ Items: [item(12)], LastEvaluatedKey: { page: 1 } })
      .resolvesOnce({ Items: [item(11)] });
    expect(await store().between(window.from, window.to)).toEqual([entry(12), entry(11)]);
    expect(queries()[0]!.FilterExpression).toBeUndefined();
  });

  test("reads a conversation's exchanges from the table, oldest first, every page", async () => {
    dynamodb
      .on(QueryCommand)
      .resolvesOnce({ Items: [item(11)], LastEvaluatedKey: { page: 1 } })
      .resolvesOnce({ Items: [item(12)] });
    expect(await store().conversation(conversation)).toEqual([entry(11), entry(12)]);
    expect(queries()[0]).toEqual({
      TableName: 'table',
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `audit#${conversation}` },
      ExclusiveStartKey: undefined,
    });
  });
});

describe('KnowledgeBaseIngestion', () => {
  const bedrock = mockClient(BedrockAgentClient);
  beforeEach(() => bedrock.reset());

  const ingestion = () => new KnowledgeBaseIngestion(new BedrockAgentClient({}), 'KB123', 'DS123');

  test.each([
    ['STARTING', { state: 'running' }],
    ['IN_PROGRESS', { state: 'running' }],
    ['STOPPING', { state: 'running' }],
    ['COMPLETE', { state: 'complete', detail: { documentsFailed: 2 } }],
    ['FAILED', { state: 'failed', detail: { status: 'FAILED', reasons: ['Access denied'] } }],
    ['STOPPED', { state: 'failed', detail: { status: 'STOPPED', reasons: ['Access denied'] } }],
  ] as const)('reads a %s job as %j', async (status, expected) => {
    bedrock.on(GetIngestionJobCommand).resolves({
      ingestionJob: {
        status,
        statistics: { numberOfDocumentsFailed: 2 },
        failureReasons: ['Access denied'],
      } as never,
    });
    expect(await ingestion().status('job-1')).toEqual(expected);
    expect(bedrock.commandCalls(GetIngestionJobCommand)[0]!.args[0].input).toEqual({
      knowledgeBaseId: 'KB123',
      dataSourceId: 'DS123',
      ingestionJobId: 'job-1',
    });
  });

  test('reads a job the service no longer knows as failed, so it is not waited on forever', async () => {
    bedrock
      .on(GetIngestionJobCommand)
      .rejects(Object.assign(new Error('Not found'), { name: 'ResourceNotFoundException' }));
    expect(await ingestion().status('job-1')).toEqual({
      state: 'failed',
      detail: { status: 'NOT_FOUND' },
    });
  });
});

describe('cachedParameter', () => {
  const ssm = mockClient(SSMClient);
  beforeEach(() => ssm.reset());

  test('reads the parameter again only once its time is up', async () => {
    ssm
      .on(GetParameterCommand)
      .resolvesOnce({ Parameter: { Value: '3' } })
      .resolvesOnce({ Parameter: { Value: '4' } });
    let now = 0;
    const version = cachedParameter(new SSMClient({}), '/orcasonar/guardrail-version', {
      fallback: '2',
      log: () => undefined,
      ttlMs: 1000,
      now: () => now,
    });
    expect(await version()).toBe('3');
    now = 999;
    expect(await version()).toBe('3');
    now = 1000;
    expect(await version()).toBe('4');
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(2);
  });

  test('keeps the last value, or the fallback, while SSM cannot be read', async () => {
    ssm.on(GetParameterCommand).rejects(new Error('SSM unavailable'));
    const logs: Record<string, unknown>[] = [];
    const version = cachedParameter(new SSMClient({}), '/orcasonar/guardrail-version', {
      fallback: '2',
      log: (entry) => logs.push(entry),
    });
    expect(await version()).toBe('2');
    expect(logs).toContainEqual(
      expect.objectContaining({
        outcome: 'parameter-error',
        parameter: '/orcasonar/guardrail-version',
      })
    );
  });
});
