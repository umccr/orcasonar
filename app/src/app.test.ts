import { createApp } from './app';
import { errorDetail } from './lib/errors';
import type { AnswerEvent } from './services/answer';
import { ANSWER_HOLD_USD, spendKeys } from './services/budget';
import { RETRIEVAL_USD } from './services/pricing';
import type { AuditEntry } from './services/stores';
import type { FakeDeps } from './testing/fakes';
import { fakeDeps, ScriptedAnswerer } from './testing/fakes';

const READER = { requestContext: { authorizer: { sub: 'reader-1', clientId: 'docs-app' } } };
const ADMIN = {
  requestContext: {
    authorizer: {
      sub: 'admin-1',
      clientId: 'docs-app',
      email: 'Admin@UMCCR.org',
      groups: 'bioinfo admin',
    },
  },
};
const ORIGIN = 'https://docs.dev.umccr.org';

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://sonar.dev.umccr.org/api/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const get = (path: string) =>
  new Request(`https://sonar.dev.umccr.org/api/v1${path}`, { headers: { Origin: ORIGIN } });

/** Server-sent events as `{event, data}` pairs, data parsed from JSON. */
const parseEvents = (text: string) =>
  text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split('\n');
      const event = lines
        .find((line) => line.startsWith('event:'))
        ?.slice(6)
        .trim();
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      return { event, data: JSON.parse(data) as unknown };
    });

const events = async (response: Response) => parseEvents(await response.text());

/** Refuses the model call the way Bedrock does: an AWS error that names the account, the role and the policy. */
class RefusedAnswerer extends ScriptedAnswerer {
  override async *stream(): AsyncIterable<AnswerEvent> {
    const refusal = new Error(
      'User: arn:aws:sts::000000000000:assumed-role/ChatRole/ChatFunction is not authorized to perform: ' +
        'bedrock:InvokeModelWithResponseStream on resource: ' +
        'arn:aws:bedrock:ap-southeast-4::foundation-model/anthropic.claude-sonnet-5 ' +
        'with an explicit deny in a service control policy'
    );
    refusal.name = 'AccessDeniedException';
    if (refusal) {
      throw refusal;
    }
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

/** Fails part way through an answer, after Bedrock accepted the request, as a model stream error does. */
class BrokenAnswerer extends ScriptedAnswerer {
  override async *stream(): AsyncIterable<AnswerEvent> {
    yield { type: 'started' };
    yield { type: 'delta', text: 'Add one entry' };
    throw Object.assign(new Error('The model stream failed'), {
      name: 'ModelStreamErrorException',
    });
  }
}

const setup = (options: Parameters<typeof fakeDeps>[0] = {}) => {
  const deps: FakeDeps = fakeDeps(options);
  return { deps, app: createApp(deps) };
};

/** What a caller has spent today, with what is still held for answers in flight. */
const callerSpend = async (deps: FakeDeps, callerId = 'reader-1') =>
  (await deps.spend.spent(spendKeys(callerId, deps.clock()))).caller;

describe('POST /chat, streamed', () => {
  test('streams meta, the answer, the cited sources and usage, in that order', async () => {
    const { app } = setup();
    const response = await app.request(
      post('/chat', { query: 'How do I add a site?' }, { Accept: 'text/event-stream' }),
      undefined,
      READER
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);

    const stream = await events(response);
    expect(stream[0]).toMatchObject({ event: 'meta' });
    const meta = stream[0]!.data as { exchangeId: string; conversationId: string };
    expect(meta.exchangeId).toMatch(/^x_[0-9a-f]{32}$/);
    expect(meta.conversationId).toMatch(/^c_[0-9a-f]{32}$/);

    const answer = stream
      .filter((item) => item.event === 'delta')
      .map((item) => (item.data as { text: string }).text)
      .join('');
    expect(answer).toBe('Add one entry to the site registry [1], then push your docs [2].');

    const citations = stream.find((item) => item.event === 'citations')!.data as Array<{
      id: string;
    }>;
    expect(citations.map((citation) => citation.id)).toEqual([
      'platform:onboarding',
      'platform:publishing',
    ]);
    expect(stream.at(-1)).toEqual({
      event: 'done',
      data: { usage: { inputTokens: 4920, outputTokens: 388 } },
    });
  });

  test('numbers each citation as the answer cites it, not by its place in the list', async () => {
    const { app } = setup({
      answerer: new ScriptedAnswerer('Push your docs [2] once the site is registered [1][2].'),
    });
    const response = await app.request(
      post('/chat', { query: 'How do I publish?' }, { Accept: 'text/event-stream' }),
      undefined,
      READER
    );
    const citations = (await events(response)).find((item) => item.event === 'citations')!
      .data as Array<{ id: string; ref: number }>;
    expect(citations.map(({ id, ref }) => ({ id, ref }))).toEqual([
      { id: 'platform:publishing', ref: 2 },
      { id: 'platform:onboarding', ref: 1 },
    ]);
  });

  test('records the exchange and its cost, and logs no question text', async () => {
    const { app, deps } = setup();
    const response = await app.request(
      post('/chat', { query: 'How do I add a site?' }, { Accept: 'text/event-stream' }),
      undefined,
      READER
    );
    await response.text(); // the stream finishes, and the exchange is accounted for, before it closes
    expect(deps.recordStore.exchanges).toHaveLength(1);
    const record = deps.recordStore.exchanges[0]!;
    expect(record).toMatchObject({
      callerId: 'reader-1',
      clientId: 'docs-app',
      question: 'How do I add a site?',
      guardrail: 'none',
    });
    expect(record.costUsd).toBeGreaterThan(0);
    expect([...deps.spend.values.values()].every((usd) => usd === record.costUsd)).toBe(true);
    expect(JSON.stringify(deps.logs)).not.toContain('add a site');
  });

  test('reports a failed model call once, without the AWS error, and logs what failed', async () => {
    const { app, deps } = setup({ answerer: new RefusedAnswerer() });
    const response = await app.request(
      post('/chat', { query: 'How do I add a site?' }, { Accept: 'text/event-stream' }),
      undefined,
      READER
    );
    const text = await response.text();
    expect(text).not.toContain('arn:aws');
    expect(text).not.toContain('service control policy');

    const stream = parseEvents(text);
    expect(stream.map((item) => item.event)).toEqual(['meta', 'error']);
    expect(stream[1]!.data).toEqual({
      code: 'unavailable',
      message: 'The answer stopped early. Try again shortly.',
    });

    expect(deps.logs).toContainEqual(
      expect.objectContaining({
        outcome: 'stream-error',
        code: 'unavailable',
        error: 'AccessDeniedException',
        detail: expect.stringContaining('explicit deny in a service control policy') as unknown,
      })
    );
    expect(JSON.stringify(deps.logs)).not.toContain('add a site');
    // Bedrock refused the request before answering, which bills nothing: only the retrieval is spent.
    expect(await callerSpend(deps)).toBe(RETRIEVAL_USD);
  });

  test('continues a conversation with its history, for its owner only', async () => {
    const { app, deps } = setup();
    const first = await app.request(
      post('/chat', { query: 'How do I add a site?' }),
      undefined,
      READER
    );
    const { conversationId } = (await first.json()) as { conversationId: string };

    await app.request(post('/chat', { query: 'And then?', conversationId }), undefined, READER);
    const messages = deps.scriptedAnswerer.requests[1]!.messages;
    expect(messages[0]).toEqual({ role: 'user', content: [{ text: 'How do I add a site?' }] });
    // A follow-up names little to search for, so it is searched for with the question it follows.
    expect(deps.staticRetriever.calls[1]!.query).toBe('How do I add a site?\nAnd then?');

    const other = { requestContext: { authorizer: { sub: 'reader-2', clientId: 'docs-app' } } };
    const stolen = await app.request(
      post('/chat', { query: 'Mine now?', conversationId }),
      undefined,
      other
    );
    expect(stolen.status).toBe(403);
  });

  test('says the documentation does not cover it, without calling the model, when nothing is found', async () => {
    const { app, deps } = setup({ passages: [] });
    const response = await app.request(
      post('/chat', { query: 'Who won the cup?' }),
      undefined,
      READER
    );
    const body = (await response.json()) as { answer: string; citations: unknown[] };
    expect(body.answer).toContain("couldn't find this in UMCCR's documentation");
    expect(body.citations).toEqual([]);
    expect(deps.scriptedAnswerer.requests).toHaveLength(0);
  });

  test('lists no sources when the guardrail intervenes', async () => {
    const answerer = new ScriptedAnswerer('That request is not supported.', undefined, true);
    const { app, deps } = setup({ answerer });
    const response = await app.request(post('/chat', { query: 'Diagnose me' }), undefined, READER);
    expect(((await response.json()) as { citations: unknown[] }).citations).toEqual([]);
    expect(deps.recordStore.exchanges[0]!.guardrail).toBe('intervened');
  });

  test('limits retrieval to the sites asked for', async () => {
    const { app, deps } = setup();
    await app.request(
      post('/chat', { query: 'OrcaHouse UI?', sites: ['management-knowledgebase'] }),
      undefined,
      READER
    );
    expect(deps.staticRetriever.calls[0]!.options).toEqual({
      sites: ['management-knowledgebase'],
      topK: 8,
    });
  });
});

describe('POST /chat, accounting', () => {
  test('a failed model call answers 503 as the stream does, and logs no question text', async () => {
    const { app, deps } = setup({ answerer: new RefusedAnswerer() });
    const response = await app.request(
      post('/chat', { query: 'How do I add a site?' }),
      undefined,
      READER
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: 'unavailable', message: 'The answer stopped early. Try again shortly.' },
    });
    expect(deps.logs).toContainEqual(
      expect.objectContaining({
        outcome: 'answer-error',
        code: 'unavailable',
        error: 'AccessDeniedException',
      })
    );
    expect(JSON.stringify(deps.logs)).not.toContain('add a site');
    expect(await callerSpend(deps)).toBe(RETRIEVAL_USD);
  });

  test('keeps the whole hold when the answer fails after the model accepted the request', async () => {
    const { app, deps } = setup({ answerer: new BrokenAnswerer() });
    const response = await app.request(
      post('/chat', { query: 'How do I add a site?' }, { Accept: 'text/event-stream' }),
      undefined,
      READER
    );
    expect((await events(response)).map((item) => item.event)).toEqual(['meta', 'delta', 'error']);
    // A stream that fails can still bill tokens it never reports.
    expect(await callerSpend(deps)).toBe(ANSWER_HOLD_USD);
  });

  test('finishes the answer, settled, when the turn and the record cannot be saved', async () => {
    const { app, deps } = setup();
    deps.conversationStore.append = async () => {
      throw new Error('table unavailable');
    };
    // An error that echoes what it was given, which the logs must not.
    deps.recordStore.putExchange = async (record) => {
      throw new Error(`Cannot write "${record.question}": ${record.answer}`);
    };
    const response = await app.request(
      post('/chat', { query: 'How do I add a site?' }, { Accept: 'text/event-stream' }),
      undefined,
      READER
    );
    const stream = await events(response);
    expect(stream.map((item) => item.event)).not.toContain('error');
    expect(stream.at(-1)).toMatchObject({ event: 'done' });
    // Settled before saving, so the answer's cost is spent rather than the hold.
    const spent = await callerSpend(deps);
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThan(ANSWER_HOLD_USD);
    expect(deps.logs).toContainEqual(
      expect.objectContaining({
        outcome: 'write-error',
        write: 'turn',
        detail: 'table unavailable',
      })
    );
    expect(deps.logs).toContainEqual(
      expect.objectContaining({
        outcome: 'write-error',
        write: 'record',
        detail: 'Cannot write "[removed]": [removed]',
      })
    );
    expect(JSON.stringify(deps.logs)).not.toContain('add a site');
    expect(JSON.stringify(deps.logs)).not.toContain('site registry');
  });

  test('releases the hold when no answer started', async () => {
    const { app, deps } = setup();
    const first = await app.request(post('/chat', { query: 'Mine?' }), undefined, READER);
    const { conversationId } = (await first.json()) as { conversationId: string };
    const other = { requestContext: { authorizer: { sub: 'reader-2', clientId: 'docs-app' } } };
    const stolen = await app.request(
      post('/chat', { query: 'Yours?', conversationId }),
      undefined,
      other
    );
    expect(stolen.status).toBe(403);
    expect(await callerSpend(deps, 'reader-2')).toBe(0);
  });

  test('lets only one of several answers asked at once through at the edge of the cap', async () => {
    const { app, deps } = setup();
    await deps.spend.add(spendKeys('reader-1', deps.clock()), 0.35);
    const responses = await Promise.all(
      [1, 2, 3, 4].map(() =>
        app.request(post('/chat', { query: 'How do I add a site?' }), undefined, READER)
      )
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 429, 429, 429]);
    // Over the cap by at most the one answer that crossed it.
    expect(await callerSpend(deps)).toBeLessThan(0.4 + ANSWER_HOLD_USD);
  });
});

describe('POST /chat, refused', () => {
  test('429 with Retry-After once the reader used today’s allowance', async () => {
    const { app, deps } = setup();
    await deps.spend.add(spendKeys('reader-1', deps.clock()), 0.5);
    const response = await app.request(post('/chat', { query: 'Hello?' }), undefined, READER);
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await response.json()).toMatchObject({ error: { code: 'over-budget' } });
  });

  test.each([
    ['an empty query', { query: '   ' }],
    ['a query over 2,000 characters', { query: 'x'.repeat(2001) }],
    ['a malformed conversation ID', { query: 'Hi', conversationId: 'abc' }],
    ['an invalid site', { query: 'Hi', sites: ['Not A Slug'] }],
    ['an unknown mode', { query: 'Hi', mode: 'plan' }],
  ])('400 for %s', async (_label, body) => {
    const { app } = setup();
    const response = await app.request(post('/chat', body), undefined, READER);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid-request' } });
  });

  test('400 for a body that is not JSON', async () => {
    const { app } = setup();
    const response = await app.request(post('/chat', 'not json'), undefined, READER);
    expect(response.status).toBe(400);
  });

  test('401 when no authorizer identified the caller', async () => {
    const { app } = setup();
    const response = await app.request(post('/chat', { query: 'Hi' }), undefined, {});
    expect(response.status).toBe(401);
  });
});

describe('other routes', () => {
  test('POST /search returns passages with snippets, without calling the model', async () => {
    const { app, deps } = setup();
    const response = await app.request(
      post('/search', { query: 'registry', topK: 2 }),
      undefined,
      READER
    );
    const body = (await response.json()) as { results: Array<{ id: string; snippet: string }> };
    expect(body.results.map((result) => result.id)).toEqual([
      'platform:onboarding',
      'platform:publishing',
    ]);
    expect(body.results[0]!.snippet).toContain('Register the site');
    expect(deps.scriptedAnswerer.requests).toHaveLength(0);
  });

  test('GET /documents/{id} returns a document, 404 for a missing one, 400 for a bad ID', async () => {
    const document = {
      id: 'platform:onboarding',
      site: 'platform',
      title: 'Onboarding a repository',
      url: 'https://docs.umccr.org/platform/onboarding/',
      updated: '2026-10-12',
      markdown: '# Onboarding',
    };
    const { app } = setup({ documents: [document] });
    const found = await app.request(get('/documents/platform%3Aonboarding'), undefined, READER);
    expect(await found.json()).toEqual(document);
    const missing = await app.request(get('/documents/platform%3Anothing'), undefined, READER);
    expect(missing.status).toBe(404);
    const bad = await app.request(get('/documents/platform%3A..%2Fsecret'), undefined, READER);
    expect(bad.status).toBe(400);
  });

  test('GET /documents/{id} decodes the ID once, so IDs with % are found as they are', async () => {
    const document = (id: string) => ({
      id,
      site: 'platform',
      title: id,
      url: 'https://docs.umccr.org/platform/',
      updated: '2026-10-12',
      markdown: '# Notes',
    });
    const { app } = setup({
      documents: [document('platform:notes/100% complete'), document('platform:a%41b')],
    });
    const percent = await app.request(
      get(`/documents/${encodeURIComponent('platform:notes/100% complete')}`),
      undefined,
      READER
    );
    expect(percent.status).toBe(200);
    expect(await percent.json()).toMatchObject({ id: 'platform:notes/100% complete' });
    // `%41` is part of this ID, not an encoded `A`.
    const literal = await app.request(
      get(`/documents/${encodeURIComponent('platform:a%41b')}`),
      undefined,
      READER
    );
    expect(await literal.json()).toMatchObject({ id: 'platform:a%41b' });
  });

  test('POST /feedback records the rating for the exchange', async () => {
    const { app, deps } = setup();
    const exchangeId = `x_${'a'.repeat(32)}`;
    const response = await app.request(
      post('/feedback', { exchangeId, rating: 'down', comment: 'Wrong page' }),
      undefined,
      READER
    );
    expect(response.status).toBe(204);
    expect(deps.recordStore.feedback[0]).toMatchObject({
      exchangeId,
      rating: 'down',
      callerId: 'reader-1',
    });
  });

  test('answers CORS preflight for the docs host only', async () => {
    const { app } = setup();
    const preflight = (origin: string) =>
      app.request(
        new Request('https://sonar.dev.umccr.org/api/v1/chat', {
          method: 'OPTIONS',
          headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'authorization,content-type',
          },
        }),
        undefined,
        {}
      );
    expect((await preflight(ORIGIN)).headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(
      (await preflight('https://evil.example')).headers.get('access-control-allow-origin')
    ).toBeNull();
  });

  test('unknown paths are a JSON 404', async () => {
    const { app } = setup();
    const response = await app.request(get('/nothing'), undefined, READER);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'not-found' } });
  });
});

describe('audit log, written', () => {
  const ASKER = {
    requestContext: {
      authorizer: { sub: 'reader-1', clientId: 'docs-app', email: 'Reader@UMCCR.org', groups: '' },
    },
  };

  test("keeps each answer with the reader's email, and logs neither", async () => {
    const { app, deps } = setup();
    const response = await app.request(
      post('/chat', { query: 'How do I add a site?' }, { Accept: 'text/event-stream' }),
      undefined,
      ASKER
    );
    await response.text();
    expect(deps.auditStore.entries).toHaveLength(1);
    const [entry] = deps.auditStore.entries;
    const record = deps.recordStore.exchanges[0]!;
    expect(entry).toMatchObject({
      exchangeId: record.exchangeId,
      conversationId: record.conversationId,
      at: record.at,
      callerId: 'reader-1',
      email: 'reader@umccr.org',
      clientId: 'docs-app',
      outcome: 'answered',
      question: 'How do I add a site?',
      answer: record.answer,
      sources: record.sources,
      costUsd: record.costUsd,
    });
    expect(entry).not.toHaveProperty('stage');
    expect(JSON.stringify(deps.logs)).not.toContain('umccr.org');
    expect(JSON.stringify(deps.logs)).not.toContain('add a site');
  });

  test('keeps a question the documentation does not cover', async () => {
    const { app, deps } = setup({ passages: [] });
    await app.request(post('/chat', { query: 'What is for lunch?' }), undefined, ASKER);
    expect(deps.auditStore.entries[0]).toMatchObject({
      outcome: 'not-covered',
      modelId: undefined,
    });
  });

  test('keeps a failed answer with its code, streamed or not', async () => {
    const { app, deps } = setup({ answerer: new BrokenAnswerer() });
    const streamed = await app.request(
      post('/chat', { query: 'How do I add a site?' }, { Accept: 'text/event-stream' }),
      undefined,
      ASKER
    );
    await streamed.text();
    deps.scriptedAnswerer.stream = new RefusedAnswerer().stream;
    await app.request(post('/chat', { query: 'And publish it?' }), undefined, ASKER);
    expect(deps.auditStore.entries).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        errorCode: 'unavailable',
        question: 'How do I add a site?',
        email: 'reader@umccr.org',
      }),
      expect.objectContaining({ outcome: 'failed', question: 'And publish it?' }),
    ]);
    expect(deps.auditStore.entries[0]).not.toHaveProperty('answer');
  });

  test('answers as it would when the audit entry cannot be saved, and logs that', async () => {
    const { app, deps } = setup({ answerer: new RefusedAnswerer() });
    deps.auditStore.put = async (entry) => {
      throw new Error(`Cannot write "${entry.question}"`);
    };
    const failed = await app.request(
      post('/chat', { query: 'How do I add a site?' }),
      undefined,
      ASKER
    );
    expect(failed.status).toBe(503);

    const answered = setup();
    answered.deps.auditStore.put = deps.auditStore.put;
    const stream = await events(
      await answered.app.request(
        post('/chat', { query: 'How do I add a site?' }, { Accept: 'text/event-stream' }),
        undefined,
        ASKER
      )
    );
    expect(stream.at(-1)).toMatchObject({ event: 'done' });
    for (const logs of [deps.logs, answered.deps.logs]) {
      expect(logs).toContainEqual(
        expect.objectContaining({ outcome: 'write-error', write: 'audit' })
      );
      expect(JSON.stringify(logs)).not.toContain('add a site');
    }
  });
});

describe('audit log, read', () => {
  const conversation = `c_${'a'.repeat(32)}`;
  let next = 0;
  const entry = (fields: Partial<AuditEntry> & Pick<AuditEntry, 'at'>): AuditEntry => ({
    exchangeId: `x_${String((next += 1)).padStart(32, '0')}`,
    conversationId: conversation,
    callerId: 'reader-1',
    email: 'reader@umccr.org',
    clientId: 'docs-app',
    outcome: 'answered',
    question: 'How do I add a site?',
    answer: 'Add one entry to the site registry [1]. '.repeat(10),
    sources: [
      { id: 'platform:onboarding', url: 'https://docs.umccr.org/platform/onboarding/', score: 0.9 },
    ],
    modelId: 'au.anthropic.claude-sonnet-5',
    usage: { inputTokens: 5000, outputTokens: 400 },
    costUsd: 0.02,
    guardrail: 'none',
    latencyMs: 4000,
    ...fields,
  });

  /** Three in the default week before the fake clock's 2026-10-12T03:00Z, and one long before it. */
  const seeded = () => {
    const { app, deps } = setup();
    deps.auditStore.entries.push(
      entry({ at: '2026-10-10T01:00:00.000Z' }),
      entry({
        at: '2026-10-11T01:00:00.000Z',
        conversationId: `c_${'b'.repeat(32)}`,
        callerId: 'reader-2',
        email: 'other@umccr.org',
        outcome: 'not-covered',
        answer: 'The documentation does not cover that.',
        sources: [],
        modelId: undefined,
        usage: undefined,
        costUsd: 0.001,
      }),
      entry({
        at: '2026-10-11T02:00:00.000Z',
        outcome: 'failed',
        errorCode: 'unavailable',
        question: 'And publish it?',
        answer: undefined,
        sources: undefined,
        modelId: undefined,
        usage: undefined,
        costUsd: undefined,
        guardrail: undefined,
        latencyMs: undefined,
      }),
      entry({ at: '2026-09-01T00:00:00.000Z' })
    );
    return { app, deps };
  };

  test.each(['/audit/exchanges', `/audit/conversations/${conversation}`, '/audit/usage'])(
    '%s is for the audit group only',
    async (path) => {
      const { app, deps } = seeded();
      const reader = await app.request(get(path), undefined, READER);
      expect(reader.status).toBe(403);
      expect(await reader.json()).toMatchObject({ error: { code: 'forbidden' } });

      const unconfigured = createApp({ ...deps, auditGroup: undefined });
      expect((await unconfigured.request(get(path), undefined, ADMIN)).status).toBe(403);
      expect((await app.request(get(path), undefined, ADMIN)).status).toBe(200);
    }
  );

  test.each(['/audit/exchanges', `/audit/conversations/${conversation}`, '/audit/usage'])(
    '%s is open to every signed-in caller where the group is *',
    async (path) => {
      const { deps } = seeded();
      const open = createApp({ ...deps, auditGroup: '*' });
      expect((await open.request(get(path), undefined, READER)).status).toBe(200);
      expect((await open.request(get(path), undefined, {})).status).toBe(401);
    }
  );

  test('lists the last week newest first, with the question and the start of the answer', async () => {
    const { app, deps } = seeded();
    const response = await app.request(get('/audit/exchanges'), undefined, ADMIN);
    const body = (await response.json()) as {
      from: string;
      to: string;
      items: Array<Record<string, unknown>>;
      nextCursor?: string;
    };
    expect(body.from).toBe('2026-10-05T03:00:00.000Z');
    expect(body.to).toBe('2026-10-12T03:00:00.000Z');
    expect(body.items.map((item) => item.at)).toEqual([
      '2026-10-11T02:00:00.000Z',
      '2026-10-11T01:00:00.000Z',
      '2026-10-10T01:00:00.000Z',
    ]);
    expect(body.nextCursor).toBeUndefined();
    const answered = body.items[2]!;
    expect(answered).toMatchObject({
      caller: { id: 'reader-1', email: 'reader@umccr.org', clientId: 'docs-app' },
      outcome: 'answered',
      question: 'How do I add a site?',
      citations: 1,
      costUsd: 0.02,
    });
    expect(answered.answerPreview).toHaveLength(280);
    expect(answered.answerPreview).toMatch(/…$/);
    expect(body.items[0]).toMatchObject({ outcome: 'failed', errorCode: 'unavailable' });
    expect(body.items[0]).not.toHaveProperty('answerPreview');
    expect(deps.logs).toContainEqual({
      outcome: 'audit-read',
      viewer: 'admin-1',
      route: 'exchanges',
      filtered: false,
      count: 3,
    });
    expect(JSON.stringify(deps.logs)).not.toContain('add a site');
  });

  test('filters by caller, by sub or by email in any case, and by outcome', async () => {
    const { app } = seeded();
    const ats = async (query: string) =>
      (
        (await (await app.request(get(`/audit/exchanges?${query}`), undefined, ADMIN)).json()) as {
          items: Array<{ at: string }>;
        }
      ).items.map((item) => item.at);
    expect(await ats('caller=reader-2')).toEqual(['2026-10-11T01:00:00.000Z']);
    expect(await ats('caller=Reader%40UMCCR.org')).toEqual([
      '2026-10-11T02:00:00.000Z',
      '2026-10-10T01:00:00.000Z',
    ]);
    expect(await ats('caller=reader%40umccr.org&outcome=answered')).toEqual([
      '2026-10-10T01:00:00.000Z',
    ]);
    expect(await ats('from=2026-09-01&to=2026-09-01')).toEqual(['2026-09-01T00:00:00.000Z']);
  });

  test('pages through with the cursor, which keeps the window', async () => {
    const { app, deps } = seeded();
    // A week later, a default window would hold none of these; the cursor's window has not moved.
    const later = createApp({ ...deps, clock: () => new Date('2026-10-20T00:00:00Z') });
    const page = async (query: string, from = app) =>
      (await (await from.request(get(`/audit/exchanges?${query}`), undefined, ADMIN)).json()) as {
        from: string;
        items: Array<{ at: string }>;
        nextCursor?: string;
      };
    const first = await page('limit=2&from=2026-09-15');
    expect(first.items.map((item) => item.at)).toEqual([
      '2026-10-11T02:00:00.000Z',
      '2026-10-11T01:00:00.000Z',
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await page(`limit=2&cursor=${first.nextCursor}`, later);
    expect(second.from).toBe(first.from);
    expect(second.items.map((item) => item.at)).toEqual(['2026-10-10T01:00:00.000Z']);
    expect(second.nextCursor).toBeUndefined();
  });

  test.each([
    ['from=2026-10-12&to=2026-10-01', 'from must not be after to.'],
    ['from=2026-08-01&to=2026-10-01', 'from and to can be at most 31 days apart.'],
    ['from=yesterday', 'from'],
    ['limit=500', 'limit'],
    ['outcome=refused', 'outcome'],
    ['cursor=not-a-cursor', 'cursor must be one a previous page returned.'],
  ])('refuses %s', async (query, message) => {
    const { app } = seeded();
    const response = await app.request(get(`/audit/exchanges?${query}`), undefined, ADMIN);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid-request', message: expect.stringContaining(message) },
    });
  });

  test('shows a whole conversation, oldest first, with full answers and sources', async () => {
    const { app } = seeded();
    const response = await app.request(
      get(`/audit/conversations/${conversation}`),
      undefined,
      ADMIN
    );
    const body = (await response.json()) as {
      conversationId: string;
      exchanges: Array<Record<string, unknown>>;
    };
    expect(body.conversationId).toBe(conversation);
    expect(body.exchanges.map((exchange) => exchange.at)).toEqual([
      '2026-09-01T00:00:00.000Z',
      '2026-10-10T01:00:00.000Z',
      '2026-10-11T02:00:00.000Z',
    ]);
    expect(body.exchanges[1]).toMatchObject({
      caller: { id: 'reader-1', email: 'reader@umccr.org' },
      answer: 'Add one entry to the site registry [1]. '.repeat(10),
      sources: [{ id: 'platform:onboarding' }],
      usage: { inputTokens: 5000, outputTokens: 400 },
    });
  });

  test('404 for a conversation it does not hold, 400 for one that is not an ID', async () => {
    const { app } = seeded();
    const missing = await app.request(
      get(`/audit/conversations/c_${'f'.repeat(32)}`),
      undefined,
      ADMIN
    );
    expect(missing.status).toBe(404);
    const bad = await app.request(get('/audit/conversations/nope'), undefined, ADMIN);
    expect(bad.status).toBe(400);
  });

  test('sums questions and spend per reader, most questions first', async () => {
    const { app } = seeded();
    const response = await app.request(get('/audit/usage'), undefined, ADMIN);
    expect(await response.json()).toEqual({
      from: '2026-10-05T03:00:00.000Z',
      to: '2026-10-12T03:00:00.000Z',
      totals: { people: 2, questions: 3, costUsd: 0.021 },
      callers: [
        {
          id: 'reader-1',
          email: 'reader@umccr.org',
          questions: 2,
          answered: 1,
          notCovered: 0,
          failed: 1,
          costUsd: 0.02,
          inputTokens: 5000,
          outputTokens: 400,
          lastAt: '2026-10-11T02:00:00.000Z',
        },
        {
          id: 'reader-2',
          email: 'other@umccr.org',
          questions: 1,
          answered: 0,
          notCovered: 1,
          failed: 0,
          costUsd: 0.001,
          inputTokens: 0,
          outputTokens: 0,
          lastAt: '2026-10-11T01:00:00.000Z',
        },
      ],
    });
  });
});

describe('errorDetail', () => {
  test('keeps the name and the start of the message, without the text it is told to remove', () => {
    const error = new Error(`Cannot answer "How do I add a site?": ${'x'.repeat(600)}`);
    error.name = 'ValidationException';
    const detail = errorDetail(error, ['How do I add a site?']);
    expect(detail.error).toBe('ValidationException');
    expect(detail.detail).toContain('Cannot answer "[removed]"');
    expect(detail.detail).not.toContain('add a site');
    expect(detail.detail!.length).toBeLessThanOrEqual(500);
  });

  test('cuts out a long question before shortening, so none of it is left', () => {
    const question = `How do I ${'really '.repeat(100)}add a site?`;
    const error = new Error(`Cannot answer "${question}"`);
    const detail = errorDetail(error, [question]);
    expect(detail.detail).toBe('Cannot answer "[removed]"');
  });

  test('says unknown for a thrown value that is not an error', () => {
    expect(errorDetail('a string')).toEqual({ error: 'unknown' });
  });
});
