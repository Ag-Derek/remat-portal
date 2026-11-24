import { describe, expect, it } from 'vitest';
import {
  addWorkingDays,
  isWorkingDay,
  nextWorkingDay,
  previousWorkingDay,
  type WorkingWeek,
} from '../../src/core/calendar/working-days.js';

/**
 * Counting forward in working days. Clients TDD 6.4, and TDD 15's unit cases: across a weekend,
 * across a public holiday, and starting on a non working day.
 *
 * November 2026: Monday the 16th, Friday the 20th, Saturday the 21st, Monday the 23rd.
 */

const MONDAY_TO_FRIDAY = [1, 2, 3, 4, 5];

function week(holidays: string[] = [], workingDays = MONDAY_TO_FRIDAY): WorkingWeek {
  return { workingDays, holidays: new Set(holidays) };
}

describe('a working day', () => {
  it('is a day of the week worked that is not a holiday', () => {
    expect(isWorkingDay('2026-11-16', week())).toBe(true);
    expect(isWorkingDay('2026-11-21', week())).toBe(false);
    expect(isWorkingDay('2026-11-22', week())).toBe(false);
    expect(isWorkingDay('2026-11-16', week(['2026-11-16']))).toBe(false);
  });

  it('follows the week the company works, not Monday to Friday', () => {
    const sixDays = week([], [1, 2, 3, 4, 5, 6]);

    expect(isWorkingDay('2026-11-21', sixDays)).toBe(true);
    expect(nextWorkingDay('2026-11-20', sixDays)).toBe('2026-11-21');
  });
});

describe('the next working day', () => {
  it('is tomorrow on a weekday', () => {
    expect(nextWorkingDay('2026-11-16', week())).toBe('2026-11-17');
  });

  it('is Monday after a Friday, a Saturday or a Sunday', () => {
    for (const day of ['2026-11-20', '2026-11-21', '2026-11-22']) {
      expect(nextWorkingDay(day, week())).toBe('2026-11-23');
    }
  });

  it('skips a holiday, and a holiday beside a weekend', () => {
    expect(nextWorkingDay('2026-11-16', week(['2026-11-17']))).toBe('2026-11-18');
    expect(nextWorkingDay('2026-11-20', week(['2026-11-23']))).toBe('2026-11-24');
  });

  it('crosses the end of a month and of a year', () => {
    /* Thursday 31 December 2026; Friday 1 January 2027 is a holiday. */
    expect(nextWorkingDay('2026-12-31', week(['2027-01-01']))).toBe('2027-01-04');
  });

  it('is refused for a week with no working day, rather than searched for forever', () => {
    expect(() => nextWorkingDay('2026-11-16', week([], []))).toThrow(/no working day/);
  });
});

describe('the previous working day', () => {
  it('is yesterday on a Tuesday', () => {
    expect(previousWorkingDay('2026-11-17', week())).toBe('2026-11-16');
  });

  it('is the Friday before, from a Monday or a weekend', () => {
    expect(previousWorkingDay('2026-11-23', week())).toBe('2026-11-20');
    expect(previousWorkingDay('2026-11-22', week())).toBe('2026-11-20');
    expect(previousWorkingDay('2026-11-21', week())).toBe('2026-11-20');
  });

  it('skips public holidays', () => {
    expect(previousWorkingDay('2026-11-23', week(['2026-11-20', '2026-11-19']))).toBe('2026-11-18');
  });

  it('refuses a week with no working day', () => {
    expect(() => previousWorkingDay('2026-11-23', week([], []))).toThrow(/no previous working day/);
  });
});

describe('adding working days', () => {
  /* CLI 53, AC L16. */
  it('five from a Monday is the Monday after', () => {
    expect(addWorkingDays('2026-11-16', 5, week())).toBe('2026-11-23');
  });

  /* TDD 15: across a weekend. */
  it('counts across a weekend without counting it', () => {
    expect(addWorkingDays('2026-11-19', 5, week())).toBe('2026-11-26');
    expect(addWorkingDays('2026-11-20', 1, week())).toBe('2026-11-23');
  });

  /* TDD 15: across a public holiday. */
  it('counts across a public holiday without counting it', () => {
    expect(addWorkingDays('2026-11-16', 5, week(['2026-11-18']))).toBe('2026-11-24');
    /* Ghana's Christmas: Friday 25 and Saturday 26 December 2026, and the Monday after. */
    expect(addWorkingDays('2026-12-24', 5, week(['2026-12-25', '2026-12-28']))).toBe('2027-01-04');
  });

  /* TDD 15: starting on a non working day. Counting starts from the next working day. */
  it('from a weekend or a holiday, counts from the first working day after it', () => {
    expect(addWorkingDays('2026-11-21', 1, week())).toBe('2026-11-23');
    expect(addWorkingDays('2026-11-21', 5, week())).toBe('2026-11-27');
    expect(addWorkingDays('2026-11-18', 2, week(['2026-11-18']))).toBe('2026-11-20');
  });

  it('nought is the day itself, working day or not', () => {
    expect(addWorkingDays('2026-11-16', 0, week())).toBe('2026-11-16');
    expect(addWorkingDays('2026-11-21', 0, week())).toBe('2026-11-21');
  });

  it('counts forward only, in whole days, from a date', () => {
    for (const count of [-1, 1.5, Number.NaN]) {
      expect(() => addWorkingDays('2026-11-16', count, week())).toThrow(/whole number/);
    }
    expect(() => addWorkingDays('16/11/2026', 5, week())).toThrow(/not a calendar date/);
  });
});
