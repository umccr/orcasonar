import { daysLeftInMonth, localDate, localMonth, secondsUntilMidnight } from './time';

describe('Melbourne time', () => {
  // 2026-10-12T13:30:00Z is 00:30 on 13 October in Melbourne (AEDT, UTC+11).
  const afterMidnight = new Date('2026-10-12T13:30:00Z');

  test('uses the Melbourne date, not the UTC date', () => {
    expect(localDate(afterMidnight)).toBe('2026-10-13');
    expect(localMonth(afterMidnight)).toBe('2026-10');
  });

  test('counts the days left in the month, today included', () => {
    expect(daysLeftInMonth(new Date('2026-10-30T23:00:00Z'))).toBe(1); // 31 October in Melbourne
    expect(daysLeftInMonth(new Date('2026-10-01T02:00:00Z'))).toBe(31);
    expect(daysLeftInMonth(new Date('2027-02-01T02:00:00Z'))).toBe(28);
  });

  test('counts the seconds to the next Melbourne midnight', () => {
    expect(secondsUntilMidnight(afterMidnight)).toBe(23.5 * 3600);
  });
});
