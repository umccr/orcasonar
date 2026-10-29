import { errorDetail } from '../lib/errors';
import type { Answerer } from './answer';
import { MAX_ANSWER_TOKENS } from './answer';
import type { Budget, Hold } from './budget';
import type { Usage } from './pricing';
import { priceExchange, RETRIEVAL_USD } from './pricing';
import {
  buildMessages,
  citedPassages,
  guardedInputCharacters,
  NOT_COVERED,
  SYSTEM_PROMPT,
} from './prompt';
import type { Passage, Retriever } from './retrieval';
import { ANSWER_PASSAGES, retrievalQuery, toCitation } from './retrieval';
import type { AuditStore, ConversationStore, RecordStore } from './stores';

/**
 * Who is asking, from the authorizer: a reader's Cognito `sub`, the app client their token came from, and their
 * lower-cased email and groups when the token has them.
 */
export interface Caller {
  readonly id: string;
  readonly clientId: string;
  readonly email?: string;
  readonly groups?: readonly string[];
}

export interface ChatDeps {
  readonly stage: string;
  readonly budget: Budget;
  readonly conversations: ConversationStore;
  readonly retriever: Retriever;
  readonly answerer: Answerer;
  readonly records: RecordStore;
  readonly audit: AuditStore;
  /** Passages scoring below this are left out; when none remain, the model is not called. */
  readonly minScore: number;
  readonly clock: () => Date;
  readonly log: (entry: Record<string, unknown>) => void;
}

export interface ChatRequest {
  readonly caller: Caller;
  readonly question: string;
  readonly sites?: readonly string[];
  readonly conversationId: string;
  /** True when the conversation was started by an earlier request and has history to load. */
  readonly continuing: boolean;
  readonly exchangeId: string;
  /** The allowance held for this answer (`Budget.reserve`), which answering it settles. */
  readonly hold: Hold;
}

/** The events a chat sends, in order: `meta`, `delta`…, `citations`, `done`. `error` may end the stream early. */
export type ChatEvent =
  | { event: 'meta'; data: { exchangeId: string; conversationId: string } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'citations'; data: ReturnType<typeof toCitation>[] }
  | { event: 'done'; data: { usage: Usage } }
  | { event: 'error'; data: { code: string; message: string } };

export interface ChatResult {
  readonly answer: string;
  readonly citations: ReturnType<typeof toCitation>[];
  readonly usage: Usage;
}

/**
 * Answer one question, emitting events as they happen. The caller has already reserved allowance for it.
 *
 * Accounting comes first once the answer is written: the cost is priced from the tokens Bedrock reports and replaces
 * the hold before the turn and the exchange are saved. Saving them cannot fail the answer, which the reader already
 * has: a write that fails is logged as `write-error`, and `done` still follows. When answering fails instead, the hold
 * is settled with what is known to be spent: nothing before retrieval, the retrieval until the model accepts the
 * request, and the whole hold once it has, because a failed stream can still bill tokens that it never reports. A
 * request the model refuses, as for missing access or throttling, bills nothing, so it never costs a reader the hold.
 * Logs carry the caller and the outcome, never the question.
 */
export const answerQuestion = async (
  deps: ChatDeps,
  request: ChatRequest,
  emit: (event: ChatEvent) => Promise<void>
): Promise<ChatResult> => {
  const started = deps.clock().getTime();
  // What is known to be spent, for settling if answering fails; undefined once the model has accepted the request.
  let spent: number | undefined = 0;
  let settled = false;
  const settle = async (usd: number) => {
    settled = true;
    try {
      await deps.budget.settle(request.hold, usd);
    } catch (error) {
      // The hold stays counted, and it is never less than the answer cost.
      deps.log({ outcome: 'settle-error', exchangeId: request.exchangeId, ...errorDetail(error) });
    }
  };

  try {
    await emit({
      event: 'meta',
      data: { exchangeId: request.exchangeId, conversationId: request.conversationId },
    });

    const history = request.continuing
      ? await deps.conversations.load(request.conversationId, request.caller.id)
      : [];
    spent = RETRIEVAL_USD;
    const passages: Passage[] = (
      await deps.retriever.retrieve(retrievalQuery(request.question, history), {
        sites: request.sites,
        topK: ANSWER_PASSAGES,
      })
    ).filter((passage) => passage.score >= deps.minScore);

    let answer = '';
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let guardrail: 'none' | 'intervened' = 'none';
    let modelCalled = false;

    if (passages.length === 0) {
      answer = NOT_COVERED;
      await emit({ event: 'delta', data: { text: answer } });
    } else {
      modelCalled = true;
      for await (const part of deps.answerer.stream({
        system: SYSTEM_PROMPT,
        messages: buildMessages(request.question, passages, history),
        maxTokens: MAX_ANSWER_TOKENS,
      })) {
        if (part.type === 'started') {
          spent = undefined;
        } else if (part.type === 'delta') {
          answer += part.text;
          await emit({ event: 'delta', data: { text: part.text } });
        } else if (part.type === 'usage') {
          usage = part.usage;
        } else {
          guardrail = 'intervened';
        }
      }
    }

    const costUsd = priceExchange({
      modelId: modelCalled ? deps.answerer.modelId : undefined,
      usage: modelCalled ? usage : undefined,
      guardedCharacters: modelCalled
        ? guardedInputCharacters(request.question, passages) + answer.length
        : 0,
      retrievals: 1,
    });
    await settle(costUsd);

    const cited = modelCalled && guardrail === 'none' ? citedPassages(answer, passages) : [];
    // Numbered as the answer cites them, `[n]` for the nth passage, rather than in the order they are listed.
    const citations = cited.map((passage) => toCitation(passage, passages.indexOf(passage) + 1));
    await emit({ event: 'citations', data: citations });

    // Logged rather than thrown: a turn, record or audit entry that fails to save must not turn a complete answer
    // into an error.
    const save = async (write: 'turn' | 'record' | 'audit', saving: () => Promise<void>) => {
      try {
        await saving();
      } catch (error) {
        deps.log({
          outcome: 'write-error',
          write,
          exchangeId: request.exchangeId,
          ...errorDetail(error, [request.question, answer]),
        });
      }
    };
    const exchange = {
      exchangeId: request.exchangeId,
      conversationId: request.conversationId,
      at: new Date(started).toISOString(),
      callerId: request.caller.id,
      clientId: request.caller.clientId,
      question: request.question,
      sites: request.sites,
      answer,
      sources: cited.map((passage) => ({ id: passage.id, url: passage.url, score: passage.score })),
      modelId: modelCalled ? deps.answerer.modelId : undefined,
      usage: modelCalled ? usage : undefined,
      costUsd,
      guardrail,
      latencyMs: deps.clock().getTime() - started,
    };
    const outcome = modelCalled ? 'answered' : 'not-covered';
    await Promise.all([
      save('turn', () =>
        deps.conversations.append(request.conversationId, request.caller.id, {
          question: request.question,
          answer,
        })
      ),
      save('record', () => deps.records.putExchange({ ...exchange, stage: deps.stage })),
      save('audit', () => deps.audit.put({ ...exchange, email: request.caller.email, outcome })),
    ]);

    await emit({ event: 'done', data: { usage } });
    deps.log({
      outcome,
      caller: request.caller.id,
      exchangeId: request.exchangeId,
      passages: passages.length,
      guardrail,
      costUsd,
    });
    return { answer, citations, usage };
  } finally {
    if (!settled) {
      await settle(spent ?? request.hold.usd);
    }
  }
};
