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
 * Spend is recorded after each answer from the tokens actually used, so a caller can go slightly over a limit with
 * the answer that crosses it; the next request is refused.
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

export interface SpendStore {
  spent(keys: SpendKeys): Promise<Spend>;
  add(keys: SpendKeys, usd: number): Promise<void>;
}

export interface Allowance {
  readonly allowed: boolean;
  readonly reason?: 'caller' | 'team';
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

export class Budget {
  constructor(
    private readonly store: SpendStore,
    private readonly limits: BudgetLimits,
    private readonly clock: () => Date = () => new Date()
  ) {}

  /** Throws `429 over-budget` when the caller or the team has used up today's allowance. */
  async ensure(callerId: string): Promise<Allowance> {
    const now = this.clock();
    const result = allowance(await this.store.spent(spendKeys(callerId, now)), this.limits, now);
    if (!result.allowed) {
      throw new ApiError(
        429,
        'over-budget',
        result.reason === 'caller'
          ? "You have used today's allowance for answers. It resets at midnight; Search still works."
          : "Today's allowance for answers is used up for everyone. It resets at midnight; Search still works.",
        result.retryAfter
      );
    }
    return result;
  }

  async record(callerId: string, usd: number): Promise<void> {
    if (usd > 0) {
      await this.store.add(spendKeys(callerId, this.clock()), usd);
    }
  }
}
