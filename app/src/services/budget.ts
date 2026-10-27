import { ApiError } from '../lib/errors';
import { daysLeftInMonth, localDate, localMonth, secondsUntilMidnight } from '../lib/time';

/**
 * Keeping chat under its monthly budget.
 *
 * - The team's allowance for today is what is left of the month's budget, divided by the days left, today included.
 *   Unused budget carries forward; a heavy day leaves less for the rest of the month.
 * - Each caller (a reader's Cognito `sub`, or a machine client's ID) has a daily cap, so one person cannot use up a
 *   day for everyone.
 * - Both reset at midnight in Melbourne.
 *
 * Before an answer, the most it can cost is held against the caller's and the team's spend, checked against both
 * limits in the same write, so answers asked at the same moment, even on different Lambda instances, cannot all pass a
 * check that each would pass alone. Once the answer's cost is known, from the tokens actually used, it replaces the
 * hold; when it never becomes known (the model call failed part way), the hold stays as the cost. A caller can still
 * go slightly over a limit with the answer that crosses it; the next request is refused.
 */

export interface BudgetLimits {
  readonly monthlyUsd: number;
  readonly callerDailyUsd: number;
}

/** Spend so far, in US dollars. */
export interface Spend {
  readonly month: number;
  readonly day: number;
  readonly caller: number;
}

export interface SpendKeys {
  readonly month: string;
  readonly day: string;
  readonly caller: string;
}

/** The limit that refused an answer. */
export type OverBudget = 'caller' | 'team';

export interface SpendStore {
  spent(keys: SpendKeys): Promise<Spend>;
  /** Adds `usd`, which may be negative, to the month's, the day's and the caller's spend: all three, or none. */
  add(keys: SpendKeys, usd: number): Promise<void>;
  /**
   * Adds `usd` as `add` does, but only while the caller's spend is under `limits.caller` and the day's is under
   * `limits.day`, checked in the same write. Returns the limit that refused it, if one did.
   */
  hold(
    keys: SpendKeys,
    usd: number,
    limits: { readonly caller: number; readonly day: number }
  ): Promise<OverBudget | null>;
}

export interface Allowance {
  readonly allowed: boolean;
  readonly reason?: OverBudget;
  readonly teamDailyUsd: number;
  readonly spent: Spend;
  /** Seconds until midnight in Melbourne, when both limits reset. */
  readonly retryAfter: number;
}

export const allowance = (spent: Spend, limits: BudgetLimits, now: Date): Allowance => {
  const spentBeforeToday = Math.max(0, spent.month - spent.day);
  const teamDailyUsd = Math.max(0, limits.monthlyUsd - spentBeforeToday) / daysLeftInMonth(now);
  const retryAfter = secondsUntilMidnight(now);
  if (spent.caller >= limits.callerDailyUsd) {
    return { allowed: false, reason: 'caller', teamDailyUsd, spent, retryAfter };
  }
  if (spent.day >= teamDailyUsd) {
    return { allowed: false, reason: 'team', teamDailyUsd, spent, retryAfter };
  }
  return { allowed: true, teamDailyUsd, spent, retryAfter };
};

export const spendKeys = (callerId: string, now: Date): SpendKeys => {
  const day = localDate(now);
  return { month: localMonth(now), day, caller: `${callerId}#${day}` };
};

/**
 * What an answer is held at until its cost is known: more than the most expensive answer the per-request limits allow,
 * about 8 cents (2,000 characters of question, six turns of history, eight passages and 1,000 output tokens).
 */
export const ANSWER_HOLD_USD = 0.1;

/** Allowance held for one answer, until `Budget.settle` replaces it with what the answer cost. */
export interface Hold {
  readonly keys: SpendKeys;
  readonly usd: number;
}

export class Budget {
  constructor(
    private readonly store: SpendStore,
    private readonly limits: BudgetLimits,
    private readonly clock: () => Date = () => new Date()
  ) {}

  /**
   * Holds the most an answer can cost against today's allowance, the caller's and the team's, before any of it is
   * spent. Throws `429 over-budget` when either is used up.
   */
  async reserve(callerId: string): Promise<Hold> {
    const now = this.clock();
    const keys = spendKeys(callerId, now);
    const result = allowance(await this.store.spent(keys), this.limits, now);
    // The team's limit can be checked on the day's spend alone: the month's spend less the day's is what was spent
    // before today, which today's writes, adding to both, leave unchanged.
    const refused = result.allowed
      ? await this.store.hold(keys, ANSWER_HOLD_USD, {
          caller: this.limits.callerDailyUsd,
          day: result.teamDailyUsd,
        })
      : result.reason;
    if (refused) {
      throw new ApiError(
        429,
        'over-budget',
        refused === 'caller'
          ? "You have used today's allowance for answers. It resets at midnight; Search still works."
          : "Today's allowance for answers is used up for everyone. It resets at midnight; Search still works.",
        result.retryAfter
      );
    }
    return { keys, usd: ANSWER_HOLD_USD };
  }

  /** Replaces the hold with what the answer cost, on the day it was held. */
  async settle(hold: Hold, usd: number): Promise<void> {
    const difference = Math.round((usd - hold.usd) * 1_000_000) / 1_000_000;
    if (difference !== 0) {
      await this.store.add(hold.keys, difference);
    }
  }
}
