import type { Answerer } from './answer';
import { MAX_ANSWER_TOKENS } from './answer';
import type { Budget } from './budget';
import type { Usage } from './pricing';
import { priceExchange } from './pricing';
import {
  buildMessages,
  citedPassages,
  guardedInputCharacters,
  NOT_COVERED,
  SYSTEM_PROMPT,
} from './prompt';
import type { Passage, Retriever } from './retrieval';
import { ANSWER_PASSAGES, toSource } from './retrieval';
import type { ConversationStore, RecordStore } from './stores';

/** Who is asking, from the authorizer: a reader's Cognito `sub` and the app client their token came from. */
export interface Caller {
  readonly id: string;
  readonly clientId: string;
}

export interface ChatDeps {
  readonly stage: string;
  readonly budget: Budget;
  readonly conversations: ConversationStore;
  readonly retriever: Retriever;
  readonly answerer: Answerer;
  readonly records: RecordStore;
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
}

/** The events a chat sends, in order: `meta`, `delta`…, `citations`, `done`. `error` may end the stream early. */
export type ChatEvent =
  | { event: 'meta'; data: { exchangeId: string; conversationId: string } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'citations'; data: ReturnType<typeof toSource>[] }
  | { event: 'done'; data: { usage: Usage } }
  | { event: 'error'; data: { code: string; message: string } };

export interface ChatResult {
  readonly answer: string;
  readonly citations: ReturnType<typeof toSource>[];
  readonly usage: Usage;
}

/**
 * Answer one question, emitting events as they happen. The caller has already passed the budget check.
 *
 * Accounting happens after the answer: the cost is priced from the tokens Bedrock reports, added to the caller's and
 * the team's spend, and the exchange is recorded. Logs carry the caller and the outcome, never the question.
 */
export const answerQuestion = async (
  deps: ChatDeps,
  request: ChatRequest,
  emit: (event: ChatEvent) => Promise<void>
): Promise<ChatResult> => {
  const started = deps.clock().getTime();
  await emit({
    event: 'meta',
    data: { exchangeId: request.exchangeId, conversationId: request.conversationId },
  });

  const history = request.continuing
    ? await deps.conversations.load(request.conversationId, request.caller.id)
    : [];
  const passages: Passage[] = (
    await deps.retriever.retrieve(request.question, {
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
      if (part.type === 'delta') {
        answer += part.text;
        await emit({ event: 'delta', data: { text: part.text } });
      } else if (part.type === 'usage') {
        usage = part.usage;
      } else {
        guardrail = 'intervened';
      }
    }
  }

  const cited = modelCalled && guardrail === 'none' ? citedPassages(answer, passages) : [];
  const citations = cited.map(toSource);
  await emit({ event: 'citations', data: citations });

  const costUsd = priceExchange({
    modelId: modelCalled ? deps.answerer.modelId : undefined,
    usage: modelCalled ? usage : undefined,
    guardedCharacters: modelCalled
      ? guardedInputCharacters(request.question, passages) + answer.length
      : 0,
    retrievals: 1,
  });
  await deps.budget.record(request.caller.id, costUsd);
  await deps.conversations.append(request.conversationId, request.caller.id, {
    question: request.question,
    answer,
  });
  await deps.records.putExchange({
    exchangeId: request.exchangeId,
    conversationId: request.conversationId,
    at: new Date(started).toISOString(),
    stage: deps.stage,
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
  });

  await emit({ event: 'done', data: { usage } });
  deps.log({
    outcome: modelCalled ? 'answered' : 'not-covered',
    caller: request.caller.id,
    exchangeId: request.exchangeId,
    passages: passages.length,
    guardrail,
    costUsd,
  });
  return { answer, citations, usage };
};
