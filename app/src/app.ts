import type { Context } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { ApiError, errorDetail, invalidRequest } from './lib/errors';
import { newId } from './lib/ids';
import { CONVERSATION_KEY, conversationKey, cursorWindow, pageAfter } from './lib/pages';
import {
  AUDIT_CONVERSATION_KEY,
  AUDIT_WINDOW_DAYS,
  auditConversationKey,
  auditConversations,
  auditExchange,
  auditRow,
  auditWindow,
  usageByCaller,
} from './services/audit';
import type { Budget } from './services/budget';
import type { Caller, ChatDeps, ChatEvent, ChatRequest, ChatResult } from './services/chat';
import { answerQuestion } from './services/chat';
import { parseDocumentId } from './services/documents';
import {
  HISTORY_DAYS,
  historyConversations,
  historyExchange,
  historyWindow,
  shownInHistory,
} from './services/history';
import type { Retriever } from './services/retrieval';
import { MAX_QUESTION_CHARACTERS, toSource } from './services/retrieval';
import type { DocumentStore, RecordStore } from './services/stores';

export interface AppDeps extends Omit<ChatDeps, 'budget' | 'answerer'> {
  readonly corsAllowOrigins: readonly string[];
  readonly budget: Budget;
  readonly retriever: Retriever;
  readonly records: RecordStore;
  readonly documents: DocumentStore;
  /** Only the chat function has a model; the query function never builds one. */
  readonly answerer: () => ChatDeps['answerer'];
  /**
   * Who may read the audit log: the Cognito group whose members may, or `*` for every signed-in caller. Without one,
   * no one may.
   */
  readonly auditGroup?: string;
  /** Local development only: a caller to assume when no authorizer ran. */
  readonly devCaller?: Caller;
}

/**
 * Every route the functions serve, for the OpenAPI contract test. Paths are relative to `/api/v1`. Each needs a token:
 * `/health`, the one open route, is answered by API Gateway itself (`infrastructure/stage/stateless-stack.ts`), so
 * nothing without a token reaches a function.
 */
export const ROUTES = [
  { method: 'post', path: '/chat' },
  { method: 'get', path: '/chat/history' },
  { method: 'get', path: '/chat/history/{conversationId}' },
  { method: 'post', path: '/search' },
  { method: 'get', path: '/documents/{id}' },
  { method: 'post', path: '/feedback' },
  { method: 'get', path: '/audit/exchanges' },
  { method: 'get', path: '/audit/conversations' },
  { method: 'get', path: '/audit/conversations/{conversationId}' },
  { method: 'get', path: '/audit/usage' },
] as const;

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const Sites = z.array(z.string().regex(SLUG)).min(1).max(20).optional();
const ConversationId = z.string().regex(/^c_[0-9a-f]{32}$/);

const ChatBody = z.object({
  query: z.string().trim().min(1).max(MAX_QUESTION_CHARACTERS),
  conversationId: ConversationId.optional(),
  sites: Sites,
  mode: z.enum(['ask']).default('ask'),
});

const SearchBody = z.object({
  query: z.string().trim().min(1).max(MAX_QUESTION_CHARACTERS),
  topK: z.number().int().min(1).max(20).default(8),
  sites: Sites,
});

const FeedbackBody = z.object({
  exchangeId: z.string().regex(/^x_[0-9a-f]{32}$/),
  rating: z.enum(['up', 'down']),
  comment: z.string().trim().max(1000).optional(),
});

/** A UTC date, or an ISO time in UTC. */
const Moment = z.union([z.iso.date(), z.iso.datetime()]).optional();

const AuditListQuery = z.object({
  from: Moment,
  to: Moment,
  caller: z
    .string()
    .trim()
    .min(1)
    .max(320)
    .transform((caller) => caller.toLowerCase())
    .optional(),
  outcome: z.enum(['answered', 'not-covered', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2000).optional(),
});

const AuditUsageQuery = z.object({ from: Moment, to: Moment });

const HistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2000).optional(),
});

/**
 * A page of a list carries its window, so the next page reads the same one even when `to` defaulted to now, and where
 * the last page stopped.
 */
const PageCursor = z.object({ from: z.iso.datetime(), to: z.iso.datetime(), after: z.string() });

type Env = {
  Bindings: {
    requestContext?: { authorizer?: Record<string, unknown> | null };
  };
  Variables: { caller: Caller };
};

/** The value as the schema reads it; its first problem is a `400 invalid-request`. */
const validated = <T>(schema: z.ZodType<T>, value: unknown, name: string): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw invalidRequest(
      issue ? `${issue.path.join('.') || name}: ${issue.message}` : 'Invalid request.'
    );
  }
  return result.data;
};

const parseBody = async <T>(c: Context<Env>, schema: z.ZodType<T>): Promise<T> => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw invalidRequest('The request body must be JSON.');
  }
  return validated(schema, body, 'body');
};

const pageCursor = (window: { from: string; to: string }, after: string) =>
  Buffer.from(JSON.stringify({ ...window, after })).toString('base64url');

/**
 * The cursor's window and place. It is refused unless its window spans at most `days`, as a list's own window may, and,
 * when `after` is given, unless the place has the form it must take.
 */
const fromPageCursor = (cursor: string, limits: { days: number; after?: RegExp }) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    parsed = undefined;
  }
  const result = PageCursor.safeParse(parsed);
  const window = result.success
    ? cursorWindow(result.data.from, result.data.to, limits.days)
    : undefined;
  if (!result.success || !window || (limits.after && !limits.after.test(result.data.after))) {
    throw invalidRequest('cursor must be one a previous page returned.');
  }
  return { ...window, after: result.data.after };
};

/**
 * Responses that hold readers' questions are never stored by a browser or anything between: the token in the request
 * keeps them from shared caches, and this from the browser's own.
 */
const noStore = (c: Context<Env>) => c.header('Cache-Control', 'no-store');

/** The caller the authorizer verified. API Gateway passes its context as `requestContext.authorizer`. */
const callerFrom = (c: Context<Env>, devCaller?: Caller): Caller => {
  const context = c.env?.requestContext?.authorizer;
  const id = context?.['sub'];
  const clientId = context?.['clientId'];
  const email = context?.['email'];
  const groups = context?.['groups'];
  if (typeof id === 'string' && id && typeof clientId === 'string') {
    return {
      id,
      clientId,
      ...(typeof email === 'string' && email ? { email: email.toLowerCase() } : {}),
      groups: typeof groups === 'string' ? groups.split(' ').filter(Boolean) : [],
    };
  }
  if (devCaller) {
    return devCaller;
  }
  throw new ApiError(401, 'unauthorized', 'Sign in again to use OrcaSonar.');
};

export const createApp = (deps: AppDeps) => {
  const app = new Hono<Env>().basePath('/api/v1');

  app.use(
    '*',
    cors({
      origin: [...deps.corsAllowOrigins],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'Accept'],
      maxAge: 3600,
    })
  );

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      if (error.retryAfter !== undefined) {
        c.header('Retry-After', String(error.retryAfter));
      }
      return c.json(error.body(), error.status);
    }
    deps.log({ outcome: 'error', ...errorDetail(error) });
    return c.json(new ApiError(500, 'internal', 'Something went wrong. Try again.').body(), 500);
  });
  app.notFound((c) => c.json(new ApiError(404, 'not-found', 'No such endpoint.').body(), 404));

  /**
   * A failed answer as the client sees it, streamed or not: an ApiError as it is, and anything else, such as Bedrock
   * refusing or throttling, as `503 unavailable`. What failed is logged, without the question, and the exchange goes
   * in the audit log with its code. An audit entry that cannot be saved is logged, and changes nothing for the client.
   */
  const answerFailure = async (
    error: unknown,
    request: ChatRequest,
    outcome: string
  ): Promise<ApiError> => {
    const failure =
      error instanceof ApiError
        ? error
        : new ApiError(503, 'unavailable', 'The answer stopped early. Try again shortly.');
    deps.log({
      outcome,
      exchangeId: request.exchangeId,
      code: failure.code,
      ...(error instanceof ApiError ? {} : errorDetail(error, [request.question])),
    });
    try {
      await deps.audit.put({
        exchangeId: request.exchangeId,
        conversationId: request.conversationId,
        at: deps.clock().toISOString(),
        callerId: request.caller.id,
        email: request.caller.email,
        clientId: request.caller.clientId,
        question: request.question,
        sites: request.sites,
        outcome: 'failed',
        errorCode: failure.code,
      });
    } catch (saving) {
      deps.log({
        outcome: 'write-error',
        write: 'audit',
        exchangeId: request.exchangeId,
        ...errorDetail(saving, [request.question]),
      });
    }
    return failure;
  };

  /**
   * The audit log holds everyone's questions with their emails, so only members of the audit group may read it, or,
   * where the group is `*`, every signed-in caller. Each read is logged with who read it, and never with what it
   * returned.
   */
  const auditorFrom = (c: Context<Env>): Caller => {
    const caller = callerFrom(c, deps.devCaller);
    const group = deps.auditGroup;
    if (group !== '*' && (!group || !caller.groups?.includes(group))) {
      throw new ApiError(403, 'forbidden', 'Only OrcaSonar administrators can read the audit log.');
    }
    return caller;
  };

  app.post('/chat', async (c) => {
    const caller = callerFrom(c, deps.devCaller);
    const body = await parseBody(c, ChatBody);
    const chat: ChatDeps = { ...deps, answerer: deps.answerer() };
    const conversationId = body.conversationId ?? newId('c');
    const exchangeId = newId('x');
    // Last before answering: from here, answering the question settles what is held.
    const hold = await deps.budget.reserve(caller.id);
    const request: ChatRequest = {
      caller,
      question: body.query,
      sites: body.sites,
      conversationId,
      continuing: body.conversationId !== undefined,
      exchangeId,
      hold,
    };

    if ((c.req.header('accept') ?? '').includes('text/event-stream')) {
      c.header('Cache-Control', 'no-store');
      // Errors are caught here rather than in streamSSE's onError: after onError, Hono also sends the raw error
      // message as a second error event, which for an AWS error holds account IDs and ARNs.
      return streamSSE(c, async (stream) => {
        try {
          await answerQuestion(chat, request, (event: ChatEvent) =>
            stream.writeSSE({ event: event.event, data: JSON.stringify(event.data) })
          );
        } catch (error) {
          const failure = await answerFailure(error, request, 'stream-error');
          // The reader may have gone; there is then no one to tell.
          await stream
            .writeSSE({
              event: 'error',
              data: JSON.stringify({ code: failure.code, message: failure.message }),
            })
            .catch(() => undefined);
        }
      });
    }

    let result: ChatResult;
    try {
      result = await answerQuestion(chat, request, async () => undefined);
    } catch (error) {
      throw await answerFailure(error, request, 'answer-error');
    }
    return c.json({
      exchangeId: request.exchangeId,
      conversationId: request.conversationId,
      answer: result.answer,
      citations: result.citations,
      usage: result.usage,
      costUsd: result.costUsd,
    });
  });

  /**
   * The caller's own conversations from the last 30 days, most recently active first. The caller is the token's, never
   * a parameter, so no one can read another reader's history; it reads the audit log through its index by caller, so
   * it never reads anyone else's entries either.
   */
  app.get('/chat/history', async (c) => {
    const caller = callerFrom(c, deps.devCaller);
    const query = validated(HistoryQuery, c.req.query(), 'query');
    const cursor =
      query.cursor === undefined
        ? undefined
        : fromPageCursor(query.cursor, { days: HISTORY_DAYS, after: CONVERSATION_KEY });
    const last30Days = historyWindow(deps.clock());
    // A later page keeps its cursor's window, but never reads back past 30 days, as one conversation does not: what is
    // older is expired, and a cursor is not signed.
    const window = cursor
      ? { from: cursor.from > last30Days.from ? cursor.from : last30Days.from, to: cursor.to }
      : last30Days;
    // A cursor whose whole window has since expired has nothing left to read, and DynamoDB refuses a window that ends
    // before it starts.
    if (window.from > window.to) {
      noStore(c);
      return c.json({ items: [] });
    }
    const entries = await deps.audit.byCaller(caller.id, window.from, window.to);
    const page = pageAfter(
      historyConversations(entries),
      conversationKey,
      cursor?.after,
      query.limit
    );
    noStore(c);
    return c.json({
      items: page.items,
      nextCursor: page.after === undefined ? undefined : pageCursor(window, page.after),
    });
  });

  /**
   * One of the caller's own conversations, oldest first; another reader's is refused, as for a follow-up. Whose it is
   * goes by the exchanges history shows, which only the owner can have: a follow-up refused because the conversation
   * was someone else's is kept under it, failed, with the caller who sent it, and does not lock the owner out.
   */
  app.get('/chat/history/:conversationId', async (c) => {
    const caller = callerFrom(c, deps.devCaller);
    const conversationId = validated(
      ConversationId,
      c.req.param('conversationId'),
      'conversationId'
    );
    const entries = await deps.audit.conversation(conversationId);
    if (shownInHistory(entries).some((entry) => entry.callerId !== caller.id)) {
      throw new ApiError(403, 'forbidden', 'That conversation belongs to someone else.');
    }
    const shown = shownInHistory(entries, historyWindow(deps.clock()).from);
    if (shown.length === 0) {
      throw new ApiError(404, 'not-found', 'Your history has no such conversation.');
    }
    noStore(c);
    return c.json({ conversationId, exchanges: shown.map(historyExchange) });
  });

  app.post('/search', async (c) => {
    callerFrom(c, deps.devCaller);
    const body = await parseBody(c, SearchBody);
    const passages = await deps.retriever.retrieve(body.query, {
      sites: body.sites,
      topK: body.topK,
    });
    return c.json({ results: passages.map(toSource) });
  });

  app.get('/documents/:id', async (c) => {
    callerFrom(c, deps.devCaller);
    // Hono has decoded the parameter already; decoding it again would change or refuse IDs that contain `%`.
    const parsed = parseDocumentId(c.req.param('id'));
    if (!parsed) {
      throw invalidRequest('id must be <site>:<path>, as in a citation.');
    }
    const document = await deps.documents.get(parsed.site, parsed.path);
    if (!document) {
      throw new ApiError(404, 'not-found', 'No such document.');
    }
    return c.json(document);
  });

  app.post('/feedback', async (c) => {
    const caller = callerFrom(c, deps.devCaller);
    const body = await parseBody(c, FeedbackBody);
    await deps.records.putFeedback({
      exchangeId: body.exchangeId,
      at: deps.clock().toISOString(),
      callerId: caller.id,
      rating: body.rating,
      comment: body.comment,
    });
    return c.body(null, 204);
  });

  app.get('/audit/exchanges', async (c) => {
    const viewer = auditorFrom(c);
    const query = validated(AuditListQuery, c.req.query(), 'query');
    const cursor =
      query.cursor === undefined
        ? undefined
        : fromPageCursor(query.cursor, { days: AUDIT_WINDOW_DAYS });
    const window = cursor
      ? { from: cursor.from, to: cursor.to }
      : auditWindow(query.from, query.to, deps.clock());
    const page = await deps.audit.list({
      ...window,
      caller: query.caller,
      outcome: query.outcome,
      limit: query.limit,
      cursor: cursor?.after,
    });
    deps.log({
      outcome: 'audit-read',
      viewer: viewer.id,
      route: 'exchanges',
      filtered: query.caller !== undefined || query.outcome !== undefined,
      count: page.items.length,
    });
    noStore(c);
    return c.json({
      ...window,
      items: page.items.map(auditRow),
      nextCursor: page.cursor === undefined ? undefined : pageCursor(window, page.cursor),
    });
  });

  /**
   * The audit log grouped by conversation, a row for each caller in it. Like usage, it reads the whole window, which
   * the budget keeps small, and groups and pages it here; `total` counts every row that matches, across pages.
   */
  app.get('/audit/conversations', async (c) => {
    const viewer = auditorFrom(c);
    const query = validated(AuditListQuery, c.req.query(), 'query');
    const cursor =
      query.cursor === undefined
        ? undefined
        : fromPageCursor(query.cursor, {
            days: AUDIT_WINDOW_DAYS,
            after: AUDIT_CONVERSATION_KEY,
          });
    const window = cursor
      ? { from: cursor.from, to: cursor.to }
      : auditWindow(query.from, query.to, deps.clock());
    const conversations = auditConversations(await deps.audit.between(window.from, window.to), {
      caller: query.caller,
      outcome: query.outcome,
    });
    const page = pageAfter(conversations, auditConversationKey, cursor?.after, query.limit);
    deps.log({
      outcome: 'audit-read',
      viewer: viewer.id,
      route: 'conversations',
      filtered: query.caller !== undefined || query.outcome !== undefined,
      count: page.items.length,
    });
    noStore(c);
    return c.json({
      ...window,
      total: conversations.length,
      items: page.items,
      nextCursor: page.after === undefined ? undefined : pageCursor(window, page.after),
    });
  });

  app.get('/audit/conversations/:conversationId', async (c) => {
    const viewer = auditorFrom(c);
    const conversationId = validated(
      ConversationId,
      c.req.param('conversationId'),
      'conversationId'
    );
    const entries = await deps.audit.conversation(conversationId);
    deps.log({
      outcome: 'audit-read',
      viewer: viewer.id,
      route: 'conversation',
      count: entries.length,
    });
    if (entries.length === 0) {
      throw new ApiError(404, 'not-found', 'The audit log has no such conversation.');
    }
    noStore(c);
    return c.json({ conversationId, exchanges: entries.map(auditExchange) });
  });

  app.get('/audit/usage', async (c) => {
    const viewer = auditorFrom(c);
    const query = validated(AuditUsageQuery, c.req.query(), 'query');
    const window = auditWindow(query.from, query.to, deps.clock());
    const entries = await deps.audit.between(window.from, window.to);
    deps.log({ outcome: 'audit-read', viewer: viewer.id, route: 'usage', count: entries.length });
    noStore(c);
    return c.json({ ...window, ...usageByCaller(entries) });
  });

  return app;
};
