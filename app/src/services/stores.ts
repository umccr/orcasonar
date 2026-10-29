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

/** How an exchange ended: with an answer, with "the documentation doesn't cover it", or with an error. */
export type AuditOutcome = 'answered' | 'not-covered' | 'failed';

/**
 * One exchange as the audit log keeps it, for 30 days as the records: who asked, what, and what came back. A failed
 * exchange has its error code and none of the answer's fields.
 */
export interface AuditEntry
  extends
    Omit<ExchangeRecord, 'stage' | 'answer' | 'sources' | 'costUsd' | 'guardrail' | 'latencyMs'>,
    Partial<Pick<ExchangeRecord, 'answer' | 'sources' | 'costUsd' | 'guardrail' | 'latencyMs'>> {
  /** The reader's email from their ID token, lower-cased; absent for a token without one. */
  readonly email?: string;
  readonly outcome: AuditOutcome;
  readonly errorCode?: string;
}

export interface AuditQuery {
  /** ISO times, both included. */
  readonly from: string;
  readonly to: string;
  /** Only exchanges by this caller: a `sub`, or a lower-cased email. */
  readonly caller?: string;
  readonly outcome?: AuditOutcome;
  readonly limit: number;
  /** Where the previous page stopped, as `list` returned it. */
  readonly cursor?: string;
}

export interface AuditStore {
  put(entry: AuditEntry): Promise<void>;
  /** A page of exchanges, newest first, with a cursor for the next when there may be more. */
  list(query: AuditQuery): Promise<{ items: AuditEntry[]; cursor?: string }>;
  /** Every exchange between two ISO times, both included, newest first. */
  between(from: string, to: string): Promise<AuditEntry[]>;
  /** A conversation's exchanges, oldest first. */
  conversation(conversationId: string): Promise<AuditEntry[]>;
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
