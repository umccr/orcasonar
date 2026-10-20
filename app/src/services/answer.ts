import type { Message } from './prompt';
import type { Usage } from './pricing';

export type AnswerEvent =
  /**
   * The model accepted the request, and its answer is streaming. A call refused before this, as for missing model
   * access or throttling, bills nothing; from here, tokens can be billed even if the stream then fails.
   */
  | { readonly type: 'started' }
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'usage'; readonly usage: Usage }
  /** The guardrail replaced or stopped the answer. */
  | { readonly type: 'guardrail' };

export interface AnswerRequest {
  readonly system: string;
  readonly messages: Message[];
  readonly maxTokens: number;
}

/** Streams an answer from the model, with the guardrail applied: `started` first, once the model accepts it. */
export interface Answerer {
  readonly modelId: string;
  stream(request: AnswerRequest): AsyncIterable<AnswerEvent>;
}

/** The answer's length limit, which caps the most expensive answer. */
export const MAX_ANSWER_TOKENS = 1000;
