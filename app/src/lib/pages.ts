/**
 * Paging for lists the API builds whole in memory, such as conversations grouped from their exchanges. The list is
 * sorted by a key, greatest first, and a page reads on from the key of the last item the previous page returned. A
 * key that has since gone still marks the place, so the next page neither repeats nor skips what was already listed.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The window a cursor carries, as `toISOString` writes times, so that they compare with stored times as strings; or
 * undefined unless it runs forwards and spans at most `days`. A cursor is not signed, so its window is held to the same
 * limit as a window a query asks for.
 */
export const cursorWindow = (
  from: string,
  to: string,
  days: number
): { from: string; to: string } | undefined => {
  const start = Date.parse(from);
  const end = Date.parse(to);
  return start <= end && end - start <= days * DAY_MS
    ? { from: new Date(start).toISOString(), to: new Date(end).toISOString() }
    : undefined;
};

/** A conversation's key: its latest exchange, then its ID, so the most recently active comes first. */
export const conversationKey = (conversation: { lastAt: string; conversationId: string }) =>
  `${conversation.lastAt}#${conversation.conversationId}`;

/** What `conversationKey` makes, to check a cursor against before trusting it. */
export const CONVERSATION_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#c_[0-9a-f]{32}$/;

/** Greatest key first, compared code unit by code unit, as ISO times sort. */
export const byKeyDescending =
  <T>(key: (item: T) => string) =>
  (a: T, b: T): number => {
    const first = key(a);
    const second = key(b);
    return first < second ? 1 : first > second ? -1 : 0;
  };

/**
 * Up to `limit` items after the one whose key is `after`, from a list sorted by `byKeyDescending(key)`, and the key to
 * read on from when more remain.
 */
export const pageAfter = <T>(
  items: readonly T[],
  key: (item: T) => string,
  after: string | undefined,
  limit: number
): { items: T[]; after?: string } => {
  const rest = after === undefined ? items : items.filter((item) => key(item) < after);
  const page = rest.slice(0, limit);
  const last = page.at(-1);
  return rest.length > limit && last !== undefined
    ? { items: page, after: key(last) }
    : { items: page };
};
