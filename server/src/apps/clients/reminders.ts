/**
 * Which next steps the morning reminders are about, on a day. #290, Clients SRS CLI 64.
 *
 * The user's rules, 24 November 2026:
 *
 * - **Due:** the morning a step is due. A step due on a day the company does not work (a weekend
 *   or a public holiday) is reminded of the working day before, so Friday's email carries what
 *   is due on Saturday and Sunday.
 * - **Overdue:** once, on the first working day it is overdue. A step due on Friday is overdue on
 *   Saturday, and Monday is the first working day it is.
 * - Every open step, whatever made it and whether or not its deal has ended. A closed one never.
 * - One email per owner per morning, holding both.
 *
 * Both come down to one window. On a working day D, a step is reminded of where its due date is
 * from the last working day before D up to, not including, the next working day after it: before
 * D it is overdue, and from D on it is due. On a day the company does not work, nothing is.
 */

import type { CalendarDate } from '../../core/calendar/time.js';
import {
  isWorkingDay,
  nextWorkingDay,
  previousWorkingDay,
  type WorkingWeek,
} from '../../core/calendar/working-days.js';

/** The due dates a morning reminds of: `from` itself, up to `before`, not including it. */
export interface ReminderWindow {
  from: CalendarDate;
  before: CalendarDate;
}

/**
 * The due dates the morning of `day` reminds of, or null where the company does not work it.
 *
 * **Missed mornings are folded in** (task 5, the user, 24 November 2026). `lastRunOn` is the last
 * working day the reminders went before `day`; where mornings since then were missed, the window
 * reaches back to it, so what came due or fell overdue on them is in today's one email, labelled
 * as it stands today. Where nothing was missed it is the working day before, and the window is a
 * single morning's. Null, the first run there has been, catches nothing up.
 */
export function reminderWindowOf(
  day: CalendarDate,
  week: WorkingWeek,
  lastRunOn: CalendarDate | null = null,
): ReminderWindow | null {
  if (!isWorkingDay(day, week)) {
    return null;
  }

  const previous = previousWorkingDay(day, week);

  return {
    from: lastRunOn !== null && lastRunOn < previous ? lastRunOn : previous,
    before: nextWorkingDay(day, week),
  };
}

/**
 * The last of `daysRun` (the days the job ran, before today, any order) on which the company
 * worked, so the reminders went; null where there is none. A run on a weekend or a holiday sends
 * nothing, so it is not the one a catch-up reaches back to.
 */
export function lastWorkingRunOf(
  daysRun: readonly CalendarDate[],
  week: WorkingWeek,
): CalendarDate | null {
  return (
    [...daysRun]
      .sort()
      .reverse()
      .find((day) => isWorkingDay(day, week)) ?? null
  );
}

/** The working mornings after `lastRunOn` and before `day` that the job did not run on. */
export function missedMorningsOf(
  lastRunOn: CalendarDate | null,
  day: CalendarDate,
  week: WorkingWeek,
): CalendarDate[] {
  if (lastRunOn === null) {
    return [];
  }

  const missed: CalendarDate[] = [];
  for (let next = nextWorkingDay(lastRunOn, week); next < day; next = nextWorkingDay(next, week)) {
    missed.push(next);
  }

  return missed;
}

/** An open next step as a reminder needs it. */
export interface StepToRemind {
  id: string;
  client: { id: string; name: string };
  /** The deal's product, or null where the step is about the client. */
  productName: string | null;
  description: string;
  dueOn: CalendarDate;
  ownerId: string;
}

/** One owner's morning: what is due, and what has just become overdue. */
export interface OwnersSteps {
  ownerId: string;
  due: StepToRemind[];
  overdue: StepToRemind[];
}

/**
 * The open steps in the window, one entry per owner. Each list is by due date, then client, then
 * what it says, so the email reads the same however the steps were read.
 */
export function remindersOf(day: CalendarDate, steps: readonly StepToRemind[]): OwnersSteps[] {
  const byOwner = new Map<string, OwnersSteps>();

  for (const step of [...steps].sort(inOrder)) {
    const owner = byOwner.get(step.ownerId) ?? { ownerId: step.ownerId, due: [], overdue: [] };
    (step.dueOn < day ? owner.overdue : owner.due).push(step);
    byOwner.set(step.ownerId, owner);
  }

  return [...byOwner.values()];
}

function inOrder(one: StepToRemind, other: StepToRemind): number {
  return (
    compare(one.dueOn, other.dueOn) ||
    compare(one.client.name.toLowerCase(), other.client.name.toLowerCase()) ||
    compare(one.description, other.description) ||
    compare(one.id, other.id)
  );
}

function compare(one: string, other: string): number {
  return one < other ? -1 : one > other ? 1 : 0;
}
