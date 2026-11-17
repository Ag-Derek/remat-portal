/**
 * What has happened at a client, across every deal it has: each stage a deal moved to, each
 * change to a deal's value or chance of closing, and each call, meeting, demo or note logged (#280),
 * newest first. #278, Clients SRS CLI 99.
 *
 * The client page's Activity section, filtered there by deal. Built from the two append only
 * histories and the activities logged, so it is the same whenever it is read (NFR CLI REC 02),
 * but for an activity corrected within its day.
 */

import type { CalendarDate } from '../../core/calendar/time.js';
import type { Person } from './client.js';
import type { ActivityKind } from './logged-activity.js';
import type { Money, Outcome, ValueSource } from './opportunity.js';
import type { Stage } from './stage.js';

/** The deal an entry is about, as the page names it. */
export interface ActivityDeal {
  id: string;
  productName: string;
}

/** A deal moved, was opened at Discovery, or ended where it stood. */
export interface StageActivity {
  kind: 'STAGE';
  deal: ActivityDeal;
  /** Null where this is the deal being opened. */
  fromStage: Stage | null;
  toStage: Stage;
  toOutcome: Outcome;
  note: string | null;
  by: Person;
  at: Date;
}

/** A deal's value or chance of closing, as they stood after a change to either. */
export interface ValueActivity {
  kind: 'VALUE';
  deal: ActivityDeal;
  value: Money | null;
  probability: number | null;
  source: ValueSource;
  /** What it was opened with, rather than a change to it. */
  opening: boolean;
  by: Person;
  at: Date;
}

/**
 * A call, a meeting, a demo or a note somebody logged (#280, CLI 58). Dated the day it happened,
 * which may be long before it was logged; `at` is when it was logged.
 */
export interface LoggedEntry {
  kind: 'LOGGED';
  id: string;
  /** The deal it was about, or null where it was about the client. */
  deal: ActivityDeal | null;
  activityKind: ActivityKind;
  happenedOn: CalendarDate;
  withWhom: string | null;
  outcome: string | null;
  by: Person;
  at: Date;
  /** Whether the person reading may still correct it: whoever logged it, within its day (CLI 62). */
  may: { correct: boolean };
}

export type Activity = StageActivity | ValueActivity | LoggedEntry;

/**
 * Newest first, by the day each happened: the day a logged activity happened, and the day a deal
 * moved or its figures changed (CLI 99). A call logged today about last Tuesday sits at last
 * Tuesday. On one day, the later recorded is first.
 *
 * Where a stage change and a value change happened at the same moment, as when a deal is opened,
 * the stage change is the earlier, so that "opened" is the last word about it.
 */
export function newestFirst(entries: readonly Activity[]): Activity[] {
  return [...entries].sort((one, other) => {
    const byDay = dayOf(other).localeCompare(dayOf(one));
    if (byDay !== 0) return byDay;

    const byTime = other.at.getTime() - one.at.getTime();
    if (byTime !== 0) return byTime;

    return one.kind === other.kind ? 0 : one.kind === 'STAGE' ? 1 : -1;
  });
}

/** The day an entry is about, in UTC, which is Accra's (NFR DAT 03). */
function dayOf(entry: Activity): CalendarDate {
  return entry.kind === 'LOGGED' ? entry.happenedOn : entry.at.toISOString().slice(0, 10);
}
