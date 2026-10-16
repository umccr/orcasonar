import { ApiError } from '../lib/errors';
import { MemorySpendStore } from '../testing/fakes';
import type { Hold } from './budget';
import { allowance, ANSWER_HOLD_USD, Budget, spendKeys } from './budget';

const limits = { monthlyUsd: 50, callerDailyUsd: 0.4 };
// 12 October in Melbourne: 20 days left in October, today included.
const now = new Date('2026-10-12T03:00:00Z');

describe('allowance', () => {
  test("the team's daily allowance is what is left of the month over the days left", () => {
    const result = allowance({ month: 10, day: 0, caller: 0 }, limits, now);
    expect(result.teamDailyUsd).toBeCloseTo(40 / 20);
    expect(result.allowed).toBe(true);
  });

  test("today's spend does not shrink today's allowance", () => {
    const result = allowance({ month: 11, day: 1, caller: 0.1 }, limits, now);
    expect(result.teamDailyUsd).toBeCloseTo(40 / 20);
  });

  test('refuses a caller who reached the daily cap', () => {
    const result = allowance({ month: 1, day: 0.5, caller: 0.4 }, limits, now);
    expect(result).toMatchObject({ allowed: false, reason: 'caller' });
  });

  test('refuses everyone once the team used up today', () => {
    const result = allowance({ month: 12, day: 2, caller: 0 }, limits, now);
    expect(result).toMatchObject({ allowed: false, reason: 'team' });
  });

  test('allows nothing once the month is spent', () => {
    expect(allowance({ month: 50, day: 0, caller: 0 }, limits, now).allowed).toBe(false);
  });
});

describe('Budget', () => {
  test('holds the most an answer can cost, then settles it at the cost', async () => {
    const store = new MemorySpendStore();
    const budget = new Budget(store, limits, () => now);
    const hold = await budget.reserve('reader-1');
    expect(await store.spent(spendKeys('reader-1', now))).toEqual({
      month: ANSWER_HOLD_USD,
      day: ANSWER_HOLD_USD,
      caller: ANSWER_HOLD_USD,
    });

    await budget.settle(hold, 0.02);
    expect(await store.spent(spendKeys('reader-1', now))).toEqual({
      month: 0.02,
      day: 0.02,
      caller: 0.02,
    });
    expect((await store.spent(spendKeys('reader-2', now))).caller).toBe(0);
  });

  test('settles on the day the hold was taken, even after midnight', async () => {
    const store = new MemorySpendStore();
    let clock = now;
    const budget = new Budget(store, limits, () => clock);
    const hold = await budget.reserve('reader-1');
    clock = new Date('2026-10-12T14:00:00Z'); // 1 am on 13 October in Melbourne
    await budget.settle(hold, 0.03);
    expect((await store.spent(spendKeys('reader-1', now))).caller).toBe(0.03);
    expect((await store.spent(spendKeys('reader-1', clock))).caller).toBe(0);
  });

  test('throws 429 with the seconds until midnight', async () => {
    const store = new MemorySpendStore();
    const budget = new Budget(store, limits, () => now);
    await store.add(spendKeys('reader-1', now), 0.41);
    const error = await budget.reserve('reader-1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: 'over-budget' });
    expect((error as ApiError).retryAfter).toBeGreaterThan(0);
    await expect(budget.reserve('reader-2')).resolves.toMatchObject({ usd: ANSWER_HOLD_USD });
  });

  test('counts answers in flight against the cap, so concurrent requests cannot all pass', async () => {
    const store = new MemorySpendStore();
    const budget = new Budget(store, limits, () => now);
    // $0.40 a day, held $0.10 at a time: four answers at once, then a refusal until one settles.
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => budget.reserve('reader-1')));
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'rejected',
    ]);
    const first = results[0] as PromiseFulfilledResult<Hold>;
    await budget.settle(first.value, 0.02);
    await expect(budget.reserve('reader-1')).resolves.toBeDefined();
  });

  test("refuses everyone once answers in flight reach the team's allowance", async () => {
    const store = new MemorySpendStore();
    // $2.50 a day for the team: $50 over the 20 days left. One answer in flight takes it from $2.45 past that.
    const budget = new Budget(store, limits, () => now);
    await store.add(spendKeys('reader-0', now), 2.45);
    await budget.reserve('reader-1');
    const error = await budget.reserve('reader-2').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 429, code: 'over-budget' });
    expect((error as ApiError).message).toContain('for everyone');
  });
});
