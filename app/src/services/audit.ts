import { invalidRequest } from '../lib/errors';
import { byKeyDescending, conversationKey } from '../lib/pages';
import type { AuditEntry, AuditOutcome } from './stores';

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

/** Each outcome's count, as a conversation or a reader's usage names it. */
const OUTCOME_COUNTS = {
  answered: 'answered',
  'not-covered': 'notCovered',
  failed: 'failed',
} as const satisfies Record<AuditOutcome, string>;

/**
 * The window's exchanges as conversations, most recently active first: who asked, the first question, and what its
 * exchanges in the window add up to. A conversation that began before the window counts only the exchanges inside it;
 * `/audit/conversations/{conversationId}` has all of it. `caller` keeps one reader's, by `sub` or lower-cased email,
 * and `outcome` those with at least one exchange that ended that way.
 */
export const auditConversations = (
  entries: readonly AuditEntry[],
  filter: { readonly caller?: string; readonly outcome?: AuditOutcome } = {}
) => {
  const conversations = new Map<
    string,
    {
      conversationId: string;
      callerId: string;
      email?: string;
      clientId: string;
      startedAt: string;
      lastAt: string;
      firstQuestion: string;
      questions: number;
      answered: number;
      notCovered: number;
      failed: number;
      sites: string[];
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      guardrailInterventions: number;
    }
  >();
  for (const entry of entries) {
    if (filter.caller && entry.callerId !== filter.caller && entry.email !== filter.caller) {
      continue;
    }
    let conversation = conversations.get(entry.conversationId);
    if (!conversation) {
      conversation = {
        conversationId: entry.conversationId,
        callerId: entry.callerId,
        email: entry.email,
        clientId: entry.clientId,
        startedAt: entry.at,
        lastAt: entry.at,
        firstQuestion: entry.question,
        questions: 0,
        answered: 0,
        notCovered: 0,
        failed: 0,
        sites: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        guardrailInterventions: 0,
      };
      conversations.set(entry.conversationId, conversation);
    }
    conversation.email ??= entry.email;
    if (entry.at < conversation.startedAt) {
      conversation.startedAt = entry.at;
      conversation.firstQuestion = entry.question;
    }
    if (entry.at > conversation.lastAt) {
      conversation.lastAt = entry.at;
      conversation.clientId = entry.clientId;
    }
    conversation.questions += 1;
    conversation[OUTCOME_COUNTS[entry.outcome]] += 1;
    for (const site of entry.sites ?? []) {
      if (!conversation.sites.includes(site)) {
        conversation.sites.push(site);
      }
    }
    conversation.costUsd += entry.costUsd ?? 0;
    conversation.inputTokens += entry.usage?.inputTokens ?? 0;
    conversation.outputTokens += entry.usage?.outputTokens ?? 0;
    if (entry.guardrail === 'intervened') {
      conversation.guardrailInterventions += 1;
    }
  }
  return [...conversations.values()]
    .filter((conversation) => !filter.outcome || conversation[OUTCOME_COUNTS[filter.outcome]] > 0)
    .map(({ conversationId, callerId, email, clientId, costUsd, ...conversation }) => ({
      conversationId,
      caller: { id: callerId, email, clientId },
      ...conversation,
      costUsd: dollars(costUsd),
    }))
    .sort(byKeyDescending(conversationKey));
};

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
