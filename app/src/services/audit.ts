import { invalidRequest } from '../lib/errors';
import type { AuditEntry } from './stores';

/**
 * The audit log, for administrators: who asked what, what came back, and what it cost. Entries are kept 30 days, as the
 * records are, and filed by UTC time.
 */

/** The longest window one request reads: the entries' 30 days, and a day to spare. */
export const AUDIT_WINDOW_DAYS = 31;

/** The window read when none is given. */
export const DEFAULT_WINDOW_DAYS = 7;

/** How much of an answer a list shows; the conversation has all of it. */
export const ANSWER_PREVIEW_CHARACTERS = 280;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The window to read, as ISO times. A date alone is the start of that day for `from` and its end for `to`, in UTC.
 * Without `to`, the window ends now; without `from`, it starts a week before its end.
 */
export const auditWindow = (
  from: string | undefined,
  to: string | undefined,
  now: Date
): { from: string; to: string } => {
  const isDate = (value: string) => value.length === 10;
  const end = to ? new Date(isDate(to) ? `${to}T23:59:59.999Z` : to) : now;
  const start = from
    ? new Date(isDate(from) ? `${from}T00:00:00.000Z` : from)
    : new Date(end.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  if (start > end) {
    throw invalidRequest('from must not be after to.');
  }
  if (end.getTime() - start.getTime() > AUDIT_WINDOW_DAYS * DAY_MS) {
    throw invalidRequest(`from and to can be at most ${AUDIT_WINDOW_DAYS} days apart.`);
  }
  return { from: start.toISOString(), to: end.toISOString() };
};

const callerOf = (entry: AuditEntry) => ({
  id: entry.callerId,
  email: entry.email,
  clientId: entry.clientId,
});

const preview = (answer: string) =>
  answer.length <= ANSWER_PREVIEW_CHARACTERS
    ? answer
    : `${answer.slice(0, ANSWER_PREVIEW_CHARACTERS - 1)}…`;

/** An exchange as the list shows it: the whole question, and the start of the answer. */
export const auditRow = (entry: AuditEntry) => ({
  exchangeId: entry.exchangeId,
  conversationId: entry.conversationId,
  at: entry.at,
  caller: callerOf(entry),
  outcome: entry.outcome,
  errorCode: entry.errorCode,
  question: entry.question,
  answerPreview: entry.answer === undefined ? undefined : preview(entry.answer),
  sites: entry.sites,
  citations: entry.sources?.length ?? 0,
  costUsd: entry.costUsd,
  guardrail: entry.guardrail,
  latencyMs: entry.latencyMs,
});

/** An exchange as its conversation shows it: everything the audit log keeps. */
export const auditExchange = (entry: AuditEntry) => ({
  exchangeId: entry.exchangeId,
  at: entry.at,
  caller: callerOf(entry),
  outcome: entry.outcome,
  errorCode: entry.errorCode,
  question: entry.question,
  sites: entry.sites,
  answer: entry.answer,
  sources: entry.sources,
  modelId: entry.modelId,
  usage: entry.usage,
  costUsd: entry.costUsd,
  guardrail: entry.guardrail,
  latencyMs: entry.latencyMs,
});

const dollars = (usd: number) => Math.round(usd * 1_000_000) / 1_000_000;

/** What each caller asked and spent, most questions first, and the totals. */
export const usageByCaller = (entries: readonly AuditEntry[]) => {
  const callers = new Map<
    string,
    {
      id: string;
      email?: string;
      questions: number;
      answered: number;
      notCovered: number;
      failed: number;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      lastAt: string;
    }
  >();
  for (const entry of entries) {
    const usage = callers.get(entry.callerId) ?? {
      id: entry.callerId,
      email: entry.email,
      questions: 0,
      answered: 0,
      notCovered: 0,
      failed: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      lastAt: entry.at,
    };
    usage.email ??= entry.email;
    usage.questions += 1;
    if (entry.outcome === 'answered') {
      usage.answered += 1;
    } else if (entry.outcome === 'not-covered') {
      usage.notCovered += 1;
    } else {
      usage.failed += 1;
    }
    usage.costUsd += entry.costUsd ?? 0;
    usage.inputTokens += entry.usage?.inputTokens ?? 0;
    usage.outputTokens += entry.usage?.outputTokens ?? 0;
    if (entry.at > usage.lastAt) {
      usage.lastAt = entry.at;
    }
    callers.set(entry.callerId, usage);
  }
  const list = [...callers.values()]
    .map((usage) => ({ ...usage, costUsd: dollars(usage.costUsd) }))
    .sort((a, b) => b.questions - a.questions || a.id.localeCompare(b.id));
  return {
    totals: {
      people: list.length,
      questions: entries.length,
      costUsd: dollars(entries.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0)),
    },
    callers: list,
  };
};
