/**
 * Counting forward in working days. Clients TDD 2.2, TDD 6.4, SRS section 1.4 item 3.
 *
 * Clients' exit debrief falls five working days after the exit (CLI 53), and "working" means the
 * company's: its default week, less its public holidays. That is a fact about the calendar
 * rather than about clients, so it is here, and Rota will want it the first time somebody asks
 * for a return date counted in working days (TDD 6.4).
 *
 * Pure: the week and the holidays are handed in, so every rule here is tested without a
 * database. {@link CompanyCalendar} reads them for a caller that has only a date.
 */

import { type CalendarDate, dayAfter, dayBefore, isCalendarDate, isoWeekdayOf } from './time.js';

/** Which days the company works: a week, and the days it is closed anyway. */
export interface WorkingWeek {
  /** ISO weekdays worked, 1 for Monday to 7 for Sunday. At least one. */
  workingDays: readonly number[];
  /** Public holidays, `YYYY-MM-DD`. */
  holidays: ReadonlySet<CalendarDate>;
}

/**
 * The longest a search for the next working day may look before giving up: a year and more.
 * No calendar the database can hold gets near it, since a week has at least one working day;
 * the limit is so that one that somehow could not be satisfied fails with a sentence rather
 * than spinning forever.
 */
const LONGEST_SEARCH_DAYS = 400;

/** Whether the company works on this day: a day of its week that is not a public holiday. */
export function isWorkingDay(day: CalendarDate, week: WorkingWeek): boolean {
  return week.workingDays.includes(isoWeekdayOf(day)) && !week.holidays.has(day);
}

/** The first working day after this one, whether or not this one is a working day. */
export function nextWorkingDay(day: CalendarDate, week: WorkingWeek): CalendarDate {
  if (week.workingDays.length === 0) {
    throw new Error('A week with no working day has no next working day.');
  }

  let next = dayAfter(day);
  for (let searched = 1; !isWorkingDay(next, week); searched += 1) {
    if (searched >= LONGEST_SEARCH_DAYS) {
      throw new Error(
        `No working day in the ${String(LONGEST_SEARCH_DAYS)} days after ${day}. Check the ` +
          'default work pattern and the public holidays.',
      );
    }
    next = dayAfter(next);
  }

  return next;
}

/** The last working day before this one, whether or not this one is a working day. */
export function previousWorkingDay(day: CalendarDate, week: WorkingWeek): CalendarDate {
  if (week.workingDays.length === 0) {
    throw new Error('A week with no working day has no previous working day.');
  }

  let previous = dayBefore(day);
  for (let searched = 1; !isWorkingDay(previous, week); searched += 1) {
    if (searched >= LONGEST_SEARCH_DAYS) {
      throw new Error(
        `No working day in the ${String(LONGEST_SEARCH_DAYS)} days before ${day}. Check the ` +
          'default work pattern and the public holidays.',
      );
    }
    previous = dayBefore(previous);
  }

  return previous;
}

/**
 * The working day `count` working days after `day`: {@link nextWorkingDay} applied `count`
 * times (TDD 6.4). From a Friday, one working day on is the Monday; from a Saturday or a
 * holiday, it is the first working day after it, so counting starts from the next working day
 * whatever `day` is. Nought is `day` itself, working day or not.
 */
export function addWorkingDays(day: CalendarDate, count: number, week: WorkingWeek): CalendarDate {
  if (!isCalendarDate(day)) {
    throw new Error(`${String(day)} is not a calendar date, so nothing can be counted from it.`);
  }
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Count working days forward, as a whole number: ${String(count)} is not one.`);
  }

  let landed = day;
  for (let counted = 0; counted < count; counted += 1) {
    landed = nextWorkingDay(landed, week);
  }

  return landed;
}
