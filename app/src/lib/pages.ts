import { createHash } from 'node:crypto';

/**
 * Paging for lists the API builds whole in memory, such as conversations grouped from their exchanges. The first page
 * is the list's top, most recently active first. A later page reads on in an order that exchanges saved since the first
 * page cannot change, so across the pages nothing is listed twice and nothing the first page could read is skipped.
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

/** Greatest key first, compared code unit by code unit, as ISO times sort. */
export const byKeyDescending =
  <T>(key: (item: T) => string) =>
  (a: T, b: T): number => {
    const first = key(a);
    const second = key(b);
    return first < second ? 1 : first > second ? -1 : 0;
  };

/**
 * Where an item stands in the order later pages read: its latest exchange on or before `settled`, then its ID. Those
 * exchanges could all be read by the first page, so an exchange saved since cannot move it. An item with none, new
 * since then, has no `lastAt` and comes before the rest.
 */
export interface Placement {
  readonly lastAt?: string;
  readonly id: string;
}

/** Whether `a` comes before `b` in the order later pages read. */
const comesBefore = (a: Placement, b: Placement): boolean =>
  a.lastAt === b.lastAt
    ? a.id > b.id
    : a.lastAt === undefined || (b.lastAt !== undefined && a.lastAt > b.lastAt);

/**
 * An ID cut to a fixed 11 characters (66 bits of SHA-256), so a cursor can name every item of a page, at any length of
 * ID, inside the length a query accepts. Two of a list's items share one about once in 10^14 pages.
 */
export const fingerprint = (id: string) =>
  createHash('sha256').update(id).digest('base64url').slice(0, 11);

/** What `fingerprint` makes, to check a cursor against before trusting it. */
export const FINGERPRINT = /^[\w-]{11}$/;

/**
 * Where a later page reads on from: after `after`, in the order later pages read, leaving out the first page's items
 * named in `shown`. `shown` holds no more than one page, and only the first page's items that `after` does not pass:
 * those it listed ahead of their placement, as they had exchanges since `settled`.
 */
export interface Place {
  readonly settled: string;
  readonly after?: Placement;
  readonly shown: readonly string[];
}

/** A list of items with a `lastAt`, built from a window's entries, most recently active first. */
export interface List<E, T> {
  readonly build: (entries: readonly E[]) => T[];
  readonly id: (item: T) => string;
}

export interface Page<T> {
  readonly items: T[];
  /** How many items the list holds. */
  readonly total: number;
  /** Where the next page reads on from, when more remain. */
  readonly next?: Place;
}

/** The items in the order later pages read, each with its placement. */
const placed = <E extends { at: string }, T extends { lastAt: string }>(
  entries: readonly E[],
  list: List<E, T>,
  items: readonly T[],
  settled: string
) => {
  const settledAt = new Map(
    list
      .build(entries.filter((entry) => entry.at <= settled))
      .map((item) => [list.id(item), item.lastAt])
  );
  return items
    .map((item) => ({
      item,
      placement: { lastAt: settledAt.get(list.id(item)), id: list.id(item) },
    }))
    .sort((a, b) =>
      comesBefore(a.placement, b.placement) ? -1 : comesBefore(b.placement, a.placement) ? 1 : 0
    );
};

/** The first `limit` items of the list `build` makes of the window's `entries`, read at `now`. */
export const firstPage = <E extends { at: string }, T extends { lastAt: string }>(
  entries: readonly E[],
  list: List<E, T>,
  now: Date,
  limit: number
): Page<T> => {
  const items = list.build(entries);
  const page = items.slice(0, limit);
  if (items.length <= limit) {
    return { items: page, total: items.length };
  }
  const settled = new Date(now.getTime() - SETTLE_MS).toISOString();
  // The page's items that lead the order later pages read are passed by `after`; the rest are named.
  const order = placed(entries, list, items, settled);
  const onPage = new Set(page.map((item) => list.id(item)));
  const lead = order.findIndex(({ placement }) => !onPage.has(placement.id));
  const passed = new Set(order.slice(0, lead).map(({ placement }) => placement.id));
  return {
    items: page,
    total: items.length,
    next: {
      settled,
      ...(lead > 0 ? { after: order[lead - 1]!.placement } : {}),
      shown: [...onPage].filter((id) => !passed.has(id)).map(fingerprint),
    },
  };
};

/**
 * The next `limit` items from `place`. One that an exchange saved since the first page has made more recent is listed
 * where the first page would have placed it, not skipped; one new since the first page is left for the next first
 * page, as one started after it is.
 */
export const pageAfter = <E extends { at: string }, T extends { lastAt: string }>(
  entries: readonly E[],
  list: List<E, T>,
  place: Place,
  limit: number
): Page<T> => {
  const items = list.build(entries);
  const shown = new Set(place.shown);
  const { after } = place;
  const rest = placed(entries, list, items, place.settled).filter(
    ({ placement }) =>
      (after === undefined || comesBefore(after, placement)) &&
      (shown.size === 0 || !shown.has(fingerprint(placement.id)))
  );
  const page = rest.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(({ item }) => item),
    total: items.length,
    ...(rest.length > limit && last
      ? { next: { settled: place.settled, after: last.placement, shown: place.shown } }
      : {}),
  };
};
