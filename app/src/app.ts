import type { Context } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { ApiError, invalidRequest } from './lib/errors';
import { newId } from './lib/ids';
import type { Budget } from './services/budget';
import type { Caller, ChatDeps, ChatEvent } from './services/chat';
import { answerQuestion } from './services/chat';
import { parseDocumentId } from './services/documents';
import type { Retriever } from './services/retrieval';
import { toSource } from './services/retrieval';
import type { DocumentStore, RecordStore } from './services/stores';

export interface AppDeps extends Omit<ChatDeps, 'budget' | 'answerer'> {
  readonly corsAllowOrigins: readonly string[];
  readonly budget: Budget;
  readonly retriever: Retriever;
  readonly records: RecordStore;
  readonly documents: DocumentStore;
  /** Only the chat function has a model; the query function never builds one. */
  readonly answerer: () => ChatDeps['answerer'];
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
  { method: 'post', path: '/search' },
  { method: 'get', path: '/documents/{id}' },
  { method: 'post', path: '/feedback' },
] as const;

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const Sites = z.array(z.string().regex(SLUG)).min(1).max(20).optional();

const ChatBody = z.object({
  query: z.string().trim().min(1).max(2000),
  conversationId: z
    .string()
    .regex(/^c_[0-9a-f]{32}$/)
    .optional(),
  sites: Sites,
  mode: z.enum(['ask']).default('ask'),
});

const SearchBody = z.object({
  query: z.string().trim().min(1).max(2000),
  topK: z.number().int().min(1).max(20).default(8),
  sites: Sites,
});

const FeedbackBody = z.object({
  exchangeId: z.string().regex(/^x_[0-9a-f]{32}$/),
  rating: z.enum(['up', 'down']),
  comment: z.string().trim().max(1000).optional(),
});

type Env = {
  Bindings: {
    requestContext?: { authorizer?: Record<string, unknown> | null };
  };
  Variables: { caller: Caller };
};

const parseBody = async <T>(c: Context<Env>, schema: z.ZodType<T>): Promise<T> => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw invalidRequest('The request body must be JSON.');
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw invalidRequest(
      issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid request.'
    );
  }
  return result.data;
};

/** The caller the authorizer verified. API Gateway passes its context as `requestContext.authorizer`. */
const callerFrom = (c: Context<Env>, devCaller?: Caller): Caller => {
  const context = c.env?.requestContext?.authorizer;
  const id = context?.['sub'];
  const clientId = context?.['clientId'];
  if (typeof id === 'string' && id && typeof clientId === 'string') {
    return { id, clientId };
  }
  if (devCaller) {
    return devCaller;
  }
  throw new ApiError(401, 'unauthorized', 'Sign in again to use OrcaSonar.');
};

/**
 * An unexpected error, for the logs only: its name and the start of its message, so an operator can see which call
 * failed and why (an AWS error names the action and the resource it refused). Any text given in `remove`, such as
 * the question, is cut out, so a message that echoes it never reaches the logs. Clients never see this.
 */
export const errorDetail = (error: unknown, remove: string[] = []): Record<string, string> => {
  if (!(error instanceof Error)) {
    return { error: 'unknown' };
  }
  let detail = error.message.slice(0, 500);
  for (const text of remove.filter(Boolean)) {
    detail = detail.split(text).join('[removed]');
  }
  return { error: error.name, detail };
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

  app.post('/chat', async (c) => {
    const caller = callerFrom(c, deps.devCaller);
    const body = await parseBody(c, ChatBody);
    await deps.budget.ensure(caller.id);

    const chat: ChatDeps = { ...deps, answerer: deps.answerer() };
    const request = {
      caller,
      question: body.query,
      sites: body.sites,
      conversationId: body.conversationId ?? newId('c'),
      continuing: body.conversationId !== undefined,
      exchangeId: newId('x'),
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
          const failure =
            error instanceof ApiError
              ? error
              : new ApiError(503, 'unavailable', 'The answer stopped early. Try again shortly.');
          deps.log({
            outcome: 'stream-error',
            exchangeId: request.exchangeId,
            code: failure.code,
            ...(error instanceof ApiError ? {} : errorDetail(error, [request.question])),
          });
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

    const result = await answerQuestion(chat, request, async () => undefined);
    return c.json({
      exchangeId: request.exchangeId,
      conversationId: request.conversationId,
      answer: result.answer,
      citations: result.citations,
      usage: result.usage,
    });
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
    const parsed = parseDocumentId(decodeURIComponent(c.req.param('id')));
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

  return app;
};
