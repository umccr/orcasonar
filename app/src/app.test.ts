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

/** A page's cursor with its window changed, as someone could make one by hand. */
const withCursorWindow = (cursor: string, window: { from?: string; to?: string }) =>
  Buffer.from(
    JSON.stringify({
      ...(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as object),
      ...window,
    })
  ).toString('base64url');

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
      data: { usage: { inputTokens: 4920, outputTokens: 388 }, costUsd: expect.any(Number) },
    });
  });

  test('ends with what the answer cost, as the budget and the record count it, streamed or not', async () => {
    const { app, deps } = setup();
    const streamed = await events(
      await app.request(
        post('/chat', { query: 'How do I add a site?' }, { Accept: 'text/event-stream' }),
        undefined,
        READER
      )
    );
    const done = streamed.at(-1)!.data as { costUsd: number };
    expect(done.costUsd).toBeGreaterThan(0);
    expect(done.costUsd).toBe(deps.recordStore.exchanges[0]!.costUsd);

    const plain = await app.request(post('/chat', { query: 'And publish it?' }), undefined, READER);
    expect(await plain.json()).toMatchObject({ costUsd: deps.recordStore.exchanges[1]!.costUsd });
  });

  test('keeps each citation as the reader was shown it, with the number the answer cites it by', async () => {
    const { app, deps } = setup({
      answerer: new ScriptedAnswerer('Push your docs [2] once the site is registered [1][2].'),
    });
    const { citations } = (await (
      await app.request(post('/chat', { query: 'How do I publish?' }), undefined, READER)
    ).json()) as { citations: unknown[] };
    expect(deps.recordStore.exchanges[0]!.sources).toEqual(citations);
    expect(citations).toEqual([
      {
        ref: 2,
        id: 'platform:publishing',
        title: 'Publishing contract',
        url: 'https://docs.umccr.org/platform/publishing/',
        site: 'platform',
        snippet: expect.any(String),
        score: 0.71,
      },
      {
        ref: 1,
        id: 'platform:onboarding',
        title: 'Onboarding a repository',
        url: 'https://docs.umccr.org/platform/onboarding/',
        site: 'platform',
        snippet: expect.any(String),
        score: 0.82,
      },
    ]);
    expect(deps.auditStore.entries[0]!.sources).toEqual(citations);
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

  const AUDIT_PATHS = [
    '/audit/exchanges',
    '/audit/conversations',
    `/audit/conversations/${conversation}`,
    '/audit/usage',
  ];

  test.each(AUDIT_PATHS)('%s is for the audit group only', async (path) => {
    const { app, deps } = seeded();
    const reader = await app.request(get(path), undefined, READER);
    expect(reader.status).toBe(403);
    expect(await reader.json()).toMatchObject({ error: { code: 'forbidden' } });

    const unconfigured = createApp({ ...deps, auditGroup: undefined });
    expect((await unconfigured.request(get(path), undefined, ADMIN)).status).toBe(403);
    expect((await app.request(get(path), undefined, ADMIN)).status).toBe(200);
  });

  test.each(AUDIT_PATHS)('%s is never stored by the browser', async (path) => {
    const { app } = seeded();
    const response = await app.request(get(path), undefined, ADMIN);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test.each(AUDIT_PATHS)(
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

  test('groups the window by conversation, most recently active first, with what each adds up to', async () => {
    const { app, deps } = seeded();
    deps.auditStore.entries.push(
      entry({
        at: '2026-10-10T05:00:00.000Z',
        question: 'Which branch?',
        sites: ['platform'],
        guardrail: 'intervened',
        usage: { inputTokens: 100, outputTokens: 10 },
        costUsd: 0.01,
      })
    );
    const response = await app.request(get('/audit/conversations'), undefined, ADMIN);
    expect(await response.json()).toEqual({
      from: '2026-10-05T03:00:00.000Z',
      to: '2026-10-12T03:00:00.000Z',
      total: 2,
      items: [
        {
          conversationId: conversation,
          caller: { id: 'reader-1', email: 'reader@umccr.org', clientId: 'docs-app' },
          // The exchange of 2026-09-01 is outside the window, so it is neither first nor counted.
          startedAt: '2026-10-10T01:00:00.000Z',
          lastAt: '2026-10-11T02:00:00.000Z',
          firstQuestion: 'How do I add a site?',
          questions: 3,
          answered: 2,
          notCovered: 0,
          failed: 1,
          sites: ['platform'],
          inputTokens: 5100,
          outputTokens: 410,
          guardrailInterventions: 1,
          costUsd: 0.03,
        },
        {
          conversationId: `c_${'b'.repeat(32)}`,
          caller: { id: 'reader-2', email: 'other@umccr.org', clientId: 'docs-app' },
          startedAt: '2026-10-11T01:00:00.000Z',
          lastAt: '2026-10-11T01:00:00.000Z',
          firstQuestion: 'How do I add a site?',
          questions: 1,
          answered: 0,
          notCovered: 1,
          failed: 0,
          sites: [],
          inputTokens: 0,
          outputTokens: 0,
          guardrailInterventions: 0,
          costUsd: 0.001,
        },
      ],
    });
    expect(deps.logs).toContainEqual({
      outcome: 'audit-read',
      viewer: 'admin-1',
      route: 'conversations',
      filtered: false,
      count: 2,
    });
    expect(JSON.stringify(deps.logs)).not.toContain('add a site');
  });

  test('filters conversations by caller, by sub or by email in any case, and by an outcome they hold', async () => {
    const { app } = seeded();
    const page = async (query: string) =>
      (await (
        await app.request(get(`/audit/conversations?${query}`), undefined, ADMIN)
      ).json()) as { total: number; items: Array<{ conversationId: string; answered: number }> };
    const ids = async (query: string) =>
      (await page(query)).items.map((item) => item.conversationId);
    expect(await ids('caller=reader-2')).toEqual([`c_${'b'.repeat(32)}`]);
    expect(await ids('caller=Reader%40UMCCR.org')).toEqual([conversation]);
    expect(await ids('outcome=not-covered')).toEqual([`c_${'b'.repeat(32)}`]);
    // A conversation with a failed exchange is listed whole, its answered one included.
    const failed = await page('outcome=failed');
    expect(failed.total).toBe(1);
    expect(failed.items).toEqual([
      expect.objectContaining({ conversationId: conversation, answered: 1 }),
    ]);
  });

  test("lists a follow-up refused for another reader as that reader's own row, apart from the owner's", async () => {
    const { app, deps } = setup();
    const { conversationId } = (await (
      await app.request(post('/chat', { query: 'How do I add a site?' }), undefined, READER)
    ).json()) as { conversationId: string };
    // Refused an hour later, so it is the conversation's newest entry, the first a newest-first read meets.
    const later = createApp({ ...deps, clock: () => new Date('2026-10-12T04:00:00Z') });
    const other = {
      requestContext: {
        authorizer: { sub: 'reader-2', clientId: 'docs-app', email: 'other@umccr.org' },
      },
    };
    const refused = await later.request(
      post('/chat', { query: 'Mine now?', conversationId }),
      undefined,
      other
    );
    expect(refused.status).toBe(403);

    const page = async (query: string) =>
      (await (
        await later.request(get(`/audit/conversations?${query}`), undefined, ADMIN)
      ).json()) as { total: number; items: Array<Record<string, unknown>>; nextCursor?: string };
    const refusedRow = {
      conversationId,
      caller: { id: 'reader-2', email: 'other@umccr.org', clientId: 'docs-app' },
      firstQuestion: 'Mine now?',
      questions: 1,
      answered: 0,
      failed: 1,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    const ownerRow = {
      conversationId,
      caller: { id: 'reader-1', clientId: 'docs-app' },
      firstQuestion: 'How do I add a site?',
      questions: 1,
      answered: 1,
      failed: 0,
      inputTokens: 4920,
      outputTokens: 388,
    };
    const all = await page('');
    expect(all.total).toBe(2);
    expect(all.items).toEqual([
      expect.objectContaining(refusedRow),
      expect.objectContaining(ownerRow),
    ]);
    // Each row has its own place, so paging one at a time neither repeats nor skips either.
    const first = await page('limit=1');
    expect(first.items).toEqual([expect.objectContaining(refusedRow)]);
    const second = await page(`limit=1&cursor=${String(first.nextCursor)}`);
    expect(second.items).toEqual([expect.objectContaining(ownerRow)]);
    expect(second.nextCursor).toBeUndefined();
    expect((await page('caller=reader-1')).items).toEqual([expect.objectContaining(ownerRow)]);
  });

  test('pages through conversations with the cursor, which keeps the window', async () => {
    const { app, deps } = seeded();
    const later = createApp({ ...deps, clock: () => new Date('2026-10-20T00:00:00Z') });
    const page = async (query: string, from = app) =>
      (await (
        await from.request(get(`/audit/conversations?${query}`), undefined, ADMIN)
      ).json()) as {
        from: string;
        total: number;
        items: Array<{ conversationId: string }>;
        nextCursor?: string;
      };
    const first = await page('limit=1');
    expect(first.total).toBe(2);
    expect(first.items.map((item) => item.conversationId)).toEqual([conversation]);
    const second = await page(`limit=1&cursor=${first.nextCursor}`, later);
    expect(second.from).toBe(first.from);
    expect(second.total).toBe(2);
    expect(second.items.map((item) => item.conversationId)).toEqual([`c_${'b'.repeat(32)}`]);
    expect(second.nextCursor).toBeUndefined();
  });

  test('refuses a cursor that another list made, in either direction', async () => {
    const { app } = seeded();
    const cursorOf = async (path: string) =>
      (
        (await (await app.request(get(`${path}?limit=1`), undefined, ADMIN)).json()) as {
          nextCursor: string;
        }
      ).nextCursor;
    const exchanges = await cursorOf('/audit/exchanges');
    const conversations = await cursorOf('/audit/conversations');
    for (const path of [
      `/audit/conversations?cursor=${exchanges}`,
      `/audit/exchanges?cursor=${conversations}`,
    ]) {
      const response = await app.request(get(path), undefined, ADMIN);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'invalid-request', message: 'cursor must be one a previous page returned.' },
      });
    }
  });

  test.each(['/audit/exchanges', '/audit/conversations'])(
    '%s refuses a cursor whose window is wider than a query may ask for',
    async (path) => {
      const { app } = seeded();
      const { nextCursor } = (await (
        await app.request(get(`${path}?limit=1`), undefined, ADMIN)
      ).json()) as { nextCursor: string };
      const widened = withCursorWindow(nextCursor, { from: '2026-01-01T00:00:00.000Z' });
      const response = await app.request(get(`${path}?cursor=${widened}`), undefined, ADMIN);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'invalid-request', message: 'cursor must be one a previous page returned.' },
      });
    }
  );
});

describe('chat history', () => {
  const mine = `c_${'1'.repeat(32)}`;
  const older = `c_${'2'.repeat(32)}`;
  const theirs = `c_${'3'.repeat(32)}`;
  const failedOnly = `c_${'4'.repeat(32)}`;
  const ONBOARDING = {
    ref: 1,
    id: 'platform:onboarding',
    title: 'Onboarding a repository',
    url: 'https://docs.umccr.org/platform/onboarding/',
    site: 'platform',
    snippet: 'Add one entry to the site registry, then open a pull request.',
    score: 0.82,
  };
  let next = 0;
  const entry = (
    fields: Partial<AuditEntry> & Pick<AuditEntry, 'at' | 'conversationId'>
  ): AuditEntry => ({
    exchangeId: `x_${String((next += 1)).padStart(32, '0')}`,
    callerId: 'reader-1',
    email: 'reader@umccr.org',
    clientId: 'docs-app',
    outcome: 'answered',
    question: 'How do I add a site?',
    answer: 'Add one entry to the site registry [1].',
    sources: [ONBOARDING],
    modelId: 'au.anthropic.claude-sonnet-5',
    usage: { inputTokens: 5000, outputTokens: 400 },
    costUsd: 0.02,
    guardrail: 'none',
    latencyMs: 4000,
    ...fields,
  });
  const failure = {
    outcome: 'failed',
    errorCode: 'unavailable',
    answer: undefined,
    sources: undefined,
    modelId: undefined,
    usage: undefined,
    costUsd: undefined,
    guardrail: undefined,
    latencyMs: undefined,
  } as const;

  /** The fake clock is 2026-10-12T03:00Z, so history reads from 2026-09-12T03:00Z. */
  const seeded = () => {
    const { app, deps } = setup();
    deps.auditStore.entries.push(
      entry({ conversationId: older, at: '2026-09-01T00:00:00.000Z', question: 'Too old' }),
      entry({
        conversationId: older,
        at: '2026-10-01T00:00:00.000Z',
        question: 'Where do docs go?',
        // Saved before sources kept their number, title and site.
        sources: [
          {
            id: 'platform:publishing',
            url: 'https://docs.umccr.org/platform/publishing/',
            score: 0.7,
          },
        ],
      }),
      entry({ conversationId: mine, at: '2026-10-10T01:00:00.000Z' }),
      entry({
        conversationId: mine,
        at: '2026-10-10T01:05:00.000Z',
        question: 'And publish it?',
        ...failure,
      }),
      entry({
        conversationId: mine,
        at: '2026-10-10T01:06:00.000Z',
        question: 'And publish it?',
        outcome: 'not-covered',
        answer: 'The documentation does not cover that.',
        sources: [],
        modelId: undefined,
        usage: undefined,
        costUsd: 0.001,
      }),
      entry({ conversationId: failedOnly, at: '2026-10-11T00:00:00.000Z', ...failure }),
      entry({
        conversationId: theirs,
        at: '2026-10-11T05:00:00.000Z',
        callerId: 'reader-2',
        email: 'other@umccr.org',
      })
    );
    return { app, deps };
  };

  const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

  test("lists the reader's own conversations of the last 30 days, most recently active first, and nothing about them", async () => {
    const { app } = seeded();
    const response = await app.request(get('/chat/history'), undefined, READER);
    expect(response.status).toBe(200);
    // Failed questions are left out, and with them a conversation that holds nothing else; another reader's
    // conversation and anything older than 30 days are not read at all.
    expect(await json(response)).toEqual({
      items: [
        {
          conversationId: mine,
          title: 'How do I add a site?',
          startedAt: '2026-10-10T01:00:00.000Z',
          lastAt: '2026-10-10T01:06:00.000Z',
          questions: 2,
        },
        {
          conversationId: older,
          title: 'Where do docs go?',
          startedAt: '2026-10-01T00:00:00.000Z',
          lastAt: '2026-10-01T00:00:00.000Z',
          questions: 1,
        },
      ],
    });
  });

  test('pages through with the cursor, which keeps the window', async () => {
    const { app, deps } = seeded();
    const first = await json(await app.request(get('/chat/history?limit=1'), undefined, READER));
    expect(first.items).toEqual([expect.objectContaining({ conversationId: mine })]);
    // A follow-up after the first page would move the older conversation ahead of the cursor, and the next page would
    // skip it; the cursor's window ends before the follow-up, so the next page lists it where it was.
    deps.auditStore.entries.push(entry({ conversationId: older, at: '2026-10-15T00:00:00.000Z' }));
    const later = createApp({ ...deps, clock: () => new Date('2026-10-16T00:00:00Z') });
    const second = await json(
      await later.request(
        get(`/chat/history?limit=1&cursor=${String(first.nextCursor)}`),
        undefined,
        READER
      )
    );
    expect(second).toEqual({
      items: [
        expect.objectContaining({ conversationId: older, lastAt: '2026-10-01T00:00:00.000Z' }),
      ],
    });
  });

  test('never reads back past 30 days, whatever window the cursor carries', async () => {
    const { app, deps } = seeded();
    const first = await json(await app.request(get('/chat/history?limit=1'), undefined, READER));
    const cursor = String(first.nextCursor);
    const page = async (from: typeof app, query: string) =>
      json(await from.request(get(`/chat/history?${query}`), undefined, READER));

    // Three weeks on, the older conversation is past its 30 days: the next page leaves it out, as showing it does.
    const later = createApp({ ...deps, clock: () => new Date('2026-11-02T00:00:00Z') });
    expect(await page(later, `limit=1&cursor=${cursor}`)).toEqual({ items: [] });
    expect((await later.request(get(`/chat/history/${older}`), undefined, READER)).status).toBe(
      404
    );

    // A cursor moved back by hand still reads only the last 30 days, so "Too old", of 2026-09-01, is not its title.
    const moved = withCursorWindow(cursor, {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
    });
    expect(await page(app, `cursor=${moved}`)).toEqual({
      items: [expect.objectContaining({ conversationId: older, title: 'Where do docs go?' })],
    });

    // And one wider than 30 days is refused.
    const widened = withCursorWindow(cursor, { from: '2026-01-01T00:00:00.000Z' });
    const response = await app.request(get(`/chat/history?cursor=${widened}`), undefined, READER);
    expect(response.status).toBe(400);
  });

  test('lists a conversation the first page did not reach, though a follow-up asked before it is saved after it', async () => {
    const { app, deps } = seeded();
    const first = await json(await app.request(get('/chat/history?limit=1'), undefined, READER));
    expect(first.items).toEqual([expect.objectContaining({ conversationId: mine })]);
    // Asked at 02:58, two minutes before the first page, and saved once answered, after it; and one in the
    // conversation the first page listed, which is not listed again.
    deps.auditStore.entries.push(
      entry({ conversationId: older, at: '2026-10-12T02:58:00.000Z' }),
      entry({ conversationId: mine, at: '2026-10-12T02:59:00.000Z' })
    );
    const later = createApp({ ...deps, clock: () => new Date('2026-10-12T03:02:00Z') });
    const second = await json(
      await later.request(
        get(`/chat/history?limit=1&cursor=${String(first.nextCursor)}`),
        undefined,
        READER
      )
    );
    expect(second).toEqual({
      items: [
        expect.objectContaining({ conversationId: older, lastAt: '2026-10-12T02:58:00.000Z' }),
      ],
    });
  });

  test('shows each reader only their own exchanges where a lost first turn let two readers share a conversation', async () => {
    const { app, deps } = setup();
    const save = deps.conversationStore.append.bind(deps.conversationStore);
    let failed = false;
    // The first turn is not saved, so a follow-up finds no owner to check; its audit entry is.
    deps.conversationStore.append = async (...args) => {
      if (!failed) {
        failed = true;
        throw new Error('table unavailable');
      }
      return save(...args);
    };
    const { conversationId } = (await (
      await app.request(post('/chat', { query: 'How do I add a site?' }), undefined, READER)
    ).json()) as { conversationId: string };
    const other = { requestContext: { authorizer: { sub: 'reader-2', clientId: 'docs-app' } } };
    const followUp = await app.request(
      post('/chat', { query: 'And publish it?', conversationId }),
      undefined,
      other
    );
    expect(followUp.status).toBe(200);

    const questions = async (context: typeof READER) => {
      const response = await app.request(
        get(`/chat/history/${conversationId}`),
        undefined,
        context
      );
      expect(response.status).toBe(200);
      return ((await json(response)).exchanges as Array<{ question: string }>).map(
        (exchange) => exchange.question
      );
    };
    expect(await questions(READER)).toEqual(['How do I add a site?']);
    expect(await questions(other)).toEqual(['And publish it?']);
    const third = { requestContext: { authorizer: { sub: 'reader-3', clientId: 'docs-app' } } };
    expect(
      (await app.request(get(`/chat/history/${conversationId}`), undefined, third)).status
    ).toBe(403);
  });

  test('answers an empty page for a cursor whose whole window has since expired', async () => {
    const { app, deps } = seeded();
    const first = await json(await app.request(get('/chat/history?limit=1'), undefined, READER));
    // The first page's window ends at 2026-10-12T03:00Z; a month and a day on, all of it is past its 30 days.
    const later = createApp({ ...deps, clock: () => new Date('2026-11-12T04:00:00Z') });
    const response = await later.request(
      get(`/chat/history?limit=1&cursor=${String(first.nextCursor)}`),
      undefined,
      READER
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await json(response)).toEqual({ items: [] });
  });

  test('still shows its owner a conversation another reader was refused a follow-up in, and still refuses them', async () => {
    const { app } = setup();
    const { conversationId } = (await (
      await app.request(post('/chat', { query: 'How do I add a site?' }), undefined, READER)
    ).json()) as { conversationId: string };
    const other = { requestContext: { authorizer: { sub: 'reader-2', clientId: 'docs-app' } } };
    const refused = await app.request(
      post('/chat', { query: 'Mine now?', conversationId }),
      undefined,
      other
    );
    expect(refused.status).toBe(403);

    const owner = await app.request(get(`/chat/history/${conversationId}`), undefined, READER);
    expect(owner.status).toBe(200);
    expect((await json(owner)).exchanges).toEqual([
      expect.objectContaining({ question: 'How do I add a site?' }),
    ]);
    expect(
      (await app.request(get(`/chat/history/${conversationId}`), undefined, other)).status
    ).toBe(403);
    expect(await json(await app.request(get('/chat/history'), undefined, other))).toEqual({
      items: [],
    });
  });

  test("shows one of the reader's conversations oldest first, as they saw it, without what the audit log adds", async () => {
    const { app, deps } = seeded();
    const [asked, , notCovered] = deps.auditStore.entries.filter(
      (item) => item.conversationId === mine
    );
    const response = await app.request(get(`/chat/history/${mine}`), undefined, READER);
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      conversationId: mine,
      exchanges: [
        {
          exchangeId: asked!.exchangeId,
          at: '2026-10-10T01:00:00.000Z',
          question: 'How do I add a site?',
          answer: 'Add one entry to the site registry [1].',
          citations: [ONBOARDING],
        },
        {
          exchangeId: notCovered!.exchangeId,
          at: '2026-10-10T01:06:00.000Z',
          question: 'And publish it?',
          answer: 'The documentation does not cover that.',
          citations: [],
        },
      ],
    });
  });

  test('shows citations saved before their numbers were kept as they were saved, and nothing past 30 days', async () => {
    const { app } = seeded();
    const body = await json(await app.request(get(`/chat/history/${older}`), undefined, READER));
    // "Too old", of 2026-09-01, is past its 30 days but not yet deleted, as DynamoDB's expiry can lag.
    expect(body.exchanges).toEqual([
      expect.objectContaining({
        question: 'Where do docs go?',
        citations: [
          {
            id: 'platform:publishing',
            url: 'https://docs.umccr.org/platform/publishing/',
            score: 0.7,
          },
        ],
      }),
    ]);
  });

  test("refuses another reader's conversation, and says when history does not hold one", async () => {
    const { app } = seeded();
    const status = async (id: string) =>
      (await app.request(get(`/chat/history/${id}`), undefined, READER)).status;
    expect(await status(theirs)).toBe(403);
    expect(await status(failedOnly)).toBe(404);
    expect(await status(`c_${'f'.repeat(32)}`)).toBe(404);
    expect(await status('nope')).toBe(400);
  });

  test.each(['/chat/history', `/chat/history/${mine}`])(
    '%s needs a sign-in but not the audit group, and is never stored by the browser',
    async (path) => {
      const { deps } = seeded();
      const app = createApp({ ...deps, auditGroup: undefined });
      const response = await app.request(get(path), undefined, READER);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect((await app.request(get(path), undefined, {})).status).toBe(401);
    }
  );

  test.each([
    ['limit=0', 'limit'],
    ['limit=500', 'limit'],
    ['cursor=not-a-cursor', 'cursor must be one a previous page returned.'],
  ])('refuses %s', async (query, message) => {
    const { app } = seeded();
    const response = await app.request(get(`/chat/history?${query}`), undefined, READER);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid-request', message: expect.stringContaining(message) },
    });
  });

  test('holds a question asked through /chat, with its citations as the reader was shown them', async () => {
    const { app } = setup();
    const asked = (await (
      await app.request(post('/chat', { query: 'How do I add a site?' }), undefined, READER)
    ).json()) as { conversationId: string; answer: string; citations: unknown[] };
    const list = await json(await app.request(get('/chat/history'), undefined, READER));
    expect(list.items).toEqual([
      expect.objectContaining({ conversationId: asked.conversationId, questions: 1 }),
    ]);
    const conversation = await json(
      await app.request(get(`/chat/history/${asked.conversationId}`), undefined, READER)
    );
    expect(asked.citations).toEqual([
      expect.objectContaining({ ref: 1, title: 'Onboarding a repository' }),
      expect.objectContaining({ ref: 2, title: 'Publishing contract' }),
    ]);
    expect(conversation.exchanges).toEqual([
      expect.objectContaining({ answer: asked.answer, citations: asked.citations }),
    ]);
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
