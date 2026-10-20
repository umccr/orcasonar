import type { Turn } from './prompt';

/**
 * Storage interfaces. The AWS implementations are in `src/aws/`, in-memory ones for tests and local development in
 * `src/testing/fakes.ts`.
 */

export interface ConversationStore {
  /** The conversation's turns, oldest first. Throws `403 forbidden` if it belongs to another caller. */
  load(conversationId: string, ownerId: string): Promise<Turn[]>;
  append(conversationId: string, ownerId: string, turn: Turn): Promise<void>;
}

/** One question and its answer, kept 30 days for evaluation. */
export interface ExchangeRecord {
  readonly exchangeId: string;
  readonly conversationId: string;
  readonly at: string;
  readonly stage: string;
  readonly callerId: string;
  readonly clientId: string;
  readonly question: string;
  readonly sites?: readonly string[];
  readonly answer: string;
  readonly sources: ReadonlyArray<{ id: string; url: string; score: number }>;
  readonly modelId?: string;
  readonly usage?: { inputTokens: number; outputTokens: number };
  readonly costUsd: number;
  readonly guardrail: 'none' | 'intervened';
  readonly latencyMs: number;
}

export interface FeedbackRecord {
  readonly exchangeId: string;
  readonly at: string;
  readonly callerId: string;
  readonly rating: 'up' | 'down';
  readonly comment?: string;
}

export interface RecordStore {
  putExchange(record: ExchangeRecord): Promise<void>;
  putFeedback(record: FeedbackRecord): Promise<void>;
}

/** A page exported by the docs platform, as `/documents/{id}` returns it. */
export interface DocumentView {
  readonly id: string;
  readonly site: string;
  readonly title: string;
  readonly url: string;
  readonly updated: string;
  readonly markdown: string;
}

export interface DocumentStore {
  /** The document, or null when no such document exists. */
  get(site: string, path: string): Promise<DocumentView | null>;
}
