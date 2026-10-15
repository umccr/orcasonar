import { ApiError } from '../lib/errors';
import { MemorySpendStore } from '../testing/fakes';
import { allowance, Budget, spendKeys } from './budget';

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
  test('records spend per caller, per day and per month', async () => {
    const store = new MemorySpendStore();
    const budget = new Budget(store, limits, () => now);
    await budget.record('reader-1', 0.02);
    await budget.record('reader-1', 0.03);
    const spent = await store.spent(spendKeys('reader-1', now));
    expect(spent.caller).toBeCloseTo(0.05);
    expect(spent.day).toBeCloseTo(0.05);
    expect(spent.month).toBeCloseTo(0.05);
    expect((await store.spent(spendKeys('reader-2', now))).caller).toBe(0);
  });

  test('throws 429 with the seconds until midnight', async () => {
    const store = new MemorySpendStore();
    const budget = new Budget(store, limits, () => now);
    await budget.record('reader-1', 0.41);
    const error = await budget.ensure('reader-1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: 'over-budget' });
    expect((error as ApiError).retryAfter).toBeGreaterThan(0);
    await expect(budget.ensure('reader-2')).resolves.toMatchObject({ allowed: true });
  });
});
