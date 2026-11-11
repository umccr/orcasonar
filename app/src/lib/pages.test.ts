import type { Place } from './pages';
import { byKeyDescending, firstPlace, pageAfter, SETTLE_MS } from './pages';

interface Entry {
  readonly id: string;
  readonly at: string;
}

interface Item {
  readonly id: string;
  readonly lastAt: string;
}

const key = (item: Item) => `${item.lastAt}#${item.id}`;

/** Items from their entries, most recently active first, as the lists of conversations build them. */
const build = (entries: readonly Entry[]): Item[] => {
  const last = new Map<string, string>();
  for (const entry of entries) {
    const at = last.get(entry.id);
    if (at === undefined || entry.at > at) {
      last.set(entry.id, entry.at);
    }
  }
  return [...last].map(([id, lastAt]) => ({ id, lastAt })).sort(byKeyDescending(key));
};

const list = { build, key, id: (item: Item) => item.id };

const READ_AT = new Date('2026-10-12T03:00:00.000Z');
const at = (time: string) => `2026-10-${time}.000Z`;

describe('pageAfter', () => {
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
    const first = pageAfter(entries, list, firstPlace(READ_AT), 3);
    expect(first.items.map((item) => item.id)).toEqual(['f', 'e', 'a']);

    // Asked before the first page, and saved after it: follow-ups in `b`, which the first page did not reach, and in
    // `a` and `e`, which it listed, and a new conversation, `g`.
    entries.push(
      { id: 'b', at: at('12T02:57:00') },
      { id: 'a', at: at('12T02:59:30') },
      { id: 'e', at: at('12T02:59:45') },
      { id: 'g', at: at('12T02:56:00') }
    );
    const second = pageAfter(entries, list, first.next!, 3);
    // Before, `b` and `g` were now ahead of where the first page stopped, and no page listed them.
    expect(second.items.map((item) => item.id)).toEqual(['b', 'g', 'c']);
    const third = pageAfter(entries, list, second.next!, 3);
    expect(third.items.map((item) => item.id)).toEqual(['d']);
    expect(third.next).toBeUndefined();
    expect(third.total).toBe(7);
  });

  test('names nothing in the cursor for a list whose exchanges all came before the first page by a while', () => {
    const entries: Entry[] = [
      { id: 'a', at: at('10T00:00:00') },
      { id: 'b', at: at('08T00:00:00') },
      { id: 'c', at: at('06T00:00:00') },
    ];
    const first = pageAfter(entries, list, firstPlace(READ_AT), 1);
    expect(first.next).toEqual<Place>({
      settled: new Date(READ_AT.getTime() - SETTLE_MS).toISOString(),
      after: `${at('10T00:00:00')}#a`,
      shown: [],
    });
    const second = pageAfter(entries, list, first.next!, 1);
    expect(second.items.map((item) => item.id)).toEqual(['b']);
    expect(second.next?.shown).toEqual([]);
  });
});
