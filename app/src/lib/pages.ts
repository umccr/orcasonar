/**
 * Paging for lists the API builds whole in memory, such as conversations grouped from their exchanges. The list is
 * sorted by a key, greatest first, and a page reads on from the key of the last item the previous page returned. A
 * key that has since gone still marks the place, so the next page neither repeats nor skips what was already listed.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long after its `at` an exchange may first be read. `at` is when the question was asked, but the exchange is saved
 * once it has been answered, up to the chat function's 5-minute timeout later, and the audit log's indexes take a
 * moment more. Keep it above that timeout (`infrastructure/stage/stateless-stack.ts`).
 */
export const SETTLE_MS = 6 * 60 * 1000;

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
 * Where the next page of a list reads on from. The window is fixed, but an exchange in it can become readable after the
 * first page was read, as `SETTLE_MS` says, and move its item ahead of where that page stopped. Exchanges on or before
 * `settled` could all be read by the first page, so the keys they give never move: `after` is the last such key
 * listed. An item listed while it had a later exchange is named in `shown` instead, as nothing about it fixes its
 * place.
 */
export interface Place {
  readonly settled: string;
  readonly after?: string;
  readonly shown: readonly string[];
}

/** Where a list's first page, read at `now`, starts. */
export const firstPlace = (now: Date): Place => ({
  settled: new Date(now.getTime() - SETTLE_MS).toISOString(),
  shown: [],
});

/**
 * Up to `limit` items not yet listed from `place`, of the list `build` makes of the window's `entries`, sorted by
 * `key`, greatest first: `total` is how many the list holds, and `next` where to read on from when more remain. An item
 * that an exchange readable only since the first page has moved ahead of `after` is placed by the exchanges before
 * `settled`, as earlier pages placed it, so it is listed once, never skipped. It comes first on its page, as its key is
 * now the newest.
 */
export const pageAfter = <E extends { at: string }, T extends { lastAt: string }>(
  entries: readonly E[],
  list: {
    readonly build: (entries: readonly E[]) => T[];
    readonly key: (item: T) => string;
    readonly id: (item: T) => string;
  },
  place: Place,
  limit: number
): { items: T[]; total: number; next?: Place } => {
  const items = list.build(entries);
  const settledKeys = new Map(
    list
      .build(entries.filter((entry) => entry.at <= place.settled))
      .map((item) => [list.id(item), list.key(item)])
  );
  const shown = new Set(place.shown);
  const rest = items.filter((item) => {
    const settledKey = settledKeys.get(list.id(item));
    return (
      !shown.has(list.id(item)) &&
      (place.after === undefined || settledKey === undefined || settledKey < place.after)
    );
  });
  const page = rest.slice(0, limit);
  if (rest.length <= limit) {
    return { items: page, total: items.length };
  }
  // Items that end by `settled` are placed by their keys, which are their settled keys; the rest, by name.
  const placed = page.filter((item) => item.lastAt <= place.settled).at(-1);
  return {
    items: page,
    total: items.length,
    next: {
      settled: place.settled,
      after: placed === undefined ? place.after : list.key(placed),
      shown: [
        ...place.shown,
        ...page.filter((item) => item.lastAt > place.settled).map((item) => list.id(item)),
      ],
    },
  };
};
