/**
 * Calendar arithmetic in UMCCR's time zone. Budgets reset at midnight in Melbourne, not UTC, so a reader's allowance
 * renews overnight rather than mid-afternoon.
 */

export const TIME_ZONE = 'Australia/Melbourne';

const parts = (now: Date) => {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-AU', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value])
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
};

const pad = (value: number) => String(value).padStart(2, '0');

/** `2026-10-12`: the day in Melbourne. */
export const localDate = (now: Date): string => {
  const { year, month, day } = parts(now);
  return `${year}-${pad(month)}-${pad(day)}`;
};

/** `2026-10`: the month in Melbourne. */
export const localMonth = (now: Date): string => localDate(now).slice(0, 7);

/** Days left in Melbourne's month, today included: 1 on the last day. */
export const daysLeftInMonth = (now: Date): number => {
  const { year, month, day } = parts(now);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return daysInMonth - day + 1;
};

/** Seconds until the next midnight in Melbourne, at least 1. */
export const secondsUntilMidnight = (now: Date): number => {
  const { hour, minute, second } = parts(now);
  return Math.max(1, 24 * 60 * 60 - (hour * 3600 + minute * 60 + second));
};
