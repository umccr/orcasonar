import type { Page } from './pages';
import { byKeyDescending, fingerprint, firstPage, pageAfter, SETTLE_MS } from './pages';

interface Entry {
  readonly id: string;
  readonly at: string;
}

interface Item {
  readonly id: string;
  readonly lastAt: string;
}

/** Items from their entries, most recently active first, as the lists of conversations build them. */
const build = (entries: readonly Entry[]): Item[] => {
  const last = new Map<string, string>();
  for (const entry of entries) {
    const at = last.get(entry.id);
    if (at === undefined || entry.at > at) {
      last.set(entry.id, entry.at);
    }
  }
  return [...last]
    .map(([id, lastAt]) => ({ id, lastAt }))
    .sort(byKeyDescending((item) => `${item.lastAt}#${item.id}`));
};

const list = { build, id: (item: Item) => item.id };

const READ_AT = new Date('2026-10-12T03:00:00.000Z');
const SETTLED = new Date(READ_AT.getTime() - SETTLE_MS).toISOString();
const at = (time: string) => `2026-10-${time}.000Z`;
const ids = (page: Page<Item>) => page.items.map((item) => item.id);

/** Every page from the first, each read with the entries as they are by then. */
const allPages = (entries: Entry[], limit: number, saved: Entry[][] = []) => {
  const pages = [firstPage(entries, list, READ_AT, limit)];
  while (pages.at(-1)!.next) {
    entries.push(...(saved[pages.length - 1] ?? []));
    pages.push(pageAfter(entries, list, pages.at(-1)!.next!, limit));
  }
  return pages;
};

describe('paging a list built in memory', () => {
  test('passes a first page with no recent activity by its last item alone', () => {
    const entries: Entry[] = [
      { id: 'a', at: at('10T00:00:00') },
      { id: 'b', at: at('08T00:00:00') },
      { id: 'c', at: at('06T00:00:00') },
    ];
    const first = firstPage(entries, list, READ_AT, 1);
    expect(first.next).toEqual({
      settled: SETTLED,
      after: { lastAt: at('10T00:00:00'), id: 'a' },
      shown: [],
    });
    expect(allPages(entries, 1).map(ids)).toEqual([['a'], ['b'], ['c']]);
  });

  test('lists every item once, though exchanges asked before the first page are only read after it', () => {
    const entries: Entry[] = [
      { id: 'a', at: at('10T00:00:00') },
      { id: 'b', at: at('08T00:00:00') },
      { id: 'c', at: at('06T00:00:00') },
      { id: 'd', at: at('04T00:00:00') },
      // Resumed in the minutes before the first page.
      { id: 'e', at: at('01T00:00:00') },
      { id: 'e', at: at('12T02:58:00') },
      // Started then.
      { id: 'f', at: at('12T02:59:00') },
    ];
    // Asked before the first page and saved after it: follow-ups in `b`, which the first page did not reach, and in
    // `a` and `e`, which it listed; and a new conversation, `g`.
    const late = [
      { id: 'b', at: at('12T02:57:00') },
      { id: 'a', at: at('12T02:59:30') },
      { id: 'e', at: at('12T02:59:45') },
      { id: 'g', at: at('12T02:56:00') },
    ];
    const pages = allPages(entries, 3, [late]);
    // `e` is listed ahead of where it was placed before, so the cursor names it; `b` is listed where the first page
    // would have placed it; `g` was not there to read, and is for the next first page.
    expect(pages[0]!.next!.shown).toEqual([fingerprint('e')]);
    expect(pages.map(ids)).toEqual([
      ['f', 'e', 'a'],
      ['b', 'c', 'd'],
    ]);
    expect(pages[1]!.total).toBe(7);
  });

  test('names at most a page in the cursor, however many items are active when the first page is read', () => {
    // Twelve conversations active in the minutes before the first page, half of them resumed, and older ones.
    const entries: Entry[] = Array.from({ length: 12 }, (_, n) => [
      { id: `r${String(n).padStart(2, '0')}`, at: `2026-10-12T02:5${4 + (n % 5)}:${10 + n}.000Z` },
      ...(n % 2
        ? [{ id: `r${String(n).padStart(2, '0')}`, at: at(`0${1 + (n % 9)}T00:00:00`) }]
        : []),
    ]).flat();
    entries.push({ id: 'old1', at: at('09T00:00:00') }, { id: 'old2', at: at('07T00:00:00') });
    // And answers asked before the first page and saved after each page.
    const late = [1, 3, 5].map((n) => [{ id: `r0${n}`, at: at('12T02:59:59') }]);
    const pages = allPages(entries, 4, late);
    for (const page of pages) {
      expect(page.next?.shown.length ?? 0).toBeLessThanOrEqual(4);
    }
    const listed = pages.flatMap(ids);
    expect(listed).toHaveLength(14);
    expect(new Set(listed).size).toBe(14);
  });
});
