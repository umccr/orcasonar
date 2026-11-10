import { byKeyDescending, conversationKey } from '../lib/pages';
import type { AuditEntry, CallerExchange } from './stores';

/**
 * A reader's own history: their conversations, and the questions and answers in each, so a chat panel can list them
 * and show one again. It is read from the audit log but holds only what the reader saw: no email, client, cost,
 * tokens, model or guardrail. Exchanges that failed are left out, as they are from the turns a follow-up sends the
 * model, so a conversation reads as it would continue.
 */

/** History goes back as far as exchanges are kept. */
export const HISTORY_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The window history reads: the last `HISTORY_DAYS` up to now, as ISO times. */
export const historyWindow = (now: Date): { from: string; to: string } => ({
  from: new Date(now.getTime() - HISTORY_DAYS * DAY_MS).toISOString(),
  to: now.toISOString(),
});

/**
 * The exchanges history shows: answered, or answered with "the documentation doesn't cover it", and, given `since`, no
 * older than that. DynamoDB deletes expired items within days rather than at once, so an entry past its 30 days can
 * still be read; history leaves it out, as the list does.
 */
export const shownInHistory = <T extends Pick<AuditEntry, 'outcome' | 'at'>>(
  entries: readonly T[],
  since?: string
): T[] =>
  entries.filter(
    (entry) => entry.outcome !== 'failed' && (since === undefined || entry.at >= since)
  );

/** The reader's conversations, most recently active first, each titled by its first question. */
export const historyConversations = (entries: readonly CallerExchange[]) => {
  const conversations = new Map<
    string,
    { conversationId: string; title: string; startedAt: string; lastAt: string; questions: number }
  >();
  for (const entry of shownInHistory(entries)) {
    const conversation = conversations.get(entry.conversationId);
    if (!conversation) {
      conversations.set(entry.conversationId, {
        conversationId: entry.conversationId,
        title: entry.question,
        startedAt: entry.at,
        lastAt: entry.at,
        questions: 1,
      });
      continue;
    }
    conversation.questions += 1;
    if (entry.at < conversation.startedAt) {
      conversation.startedAt = entry.at;
      conversation.title = entry.question;
    }
    if (entry.at > conversation.lastAt) {
      conversation.lastAt = entry.at;
    }
  }
  return [...conversations.values()].sort(byKeyDescending(conversationKey));
};

/** An exchange as its reader saw it: the question, the answer, and the pages the answer cited. */
export const historyExchange = (entry: AuditEntry) => ({
  exchangeId: entry.exchangeId,
  at: entry.at,
  question: entry.question,
  sites: entry.sites,
  answer: entry.answer ?? '',
  // Named field by field, so nothing else the audit log may keep on a source reaches the reader.
  citations: (entry.sources ?? []).map(({ ref, id, title, url, site, snippet, score }) => ({
    ref,
    id,
    title,
    url,
    site,
    snippet,
    score,
  })),
});
