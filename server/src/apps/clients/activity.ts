/**
 * What has happened at a client, across every deal it has: each stage a deal moved to, and each
 * change to a deal's value or chance of closing, newest first. #278, Clients SRS CLI 99.
 *
 * The client page's Activity section, filtered there by deal. Calls, meetings and proposals join
 * it with activities (#280). Built from the two append only histories alone, so it is the same
 * whenever it is read (NFR CLI REC 02).
 */

import type { Person } from './client.js';
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

export type Activity = StageActivity | ValueActivity;

/**
 * Newest first. Where a stage change and a value change happened at the same moment, as when a
 * deal is opened, the stage change is the earlier, so that "opened" is the last word about it.
 */
export function newestFirst(entries: readonly Activity[]): Activity[] {
  return [...entries].sort((one, other) => {
    const byTime = other.at.getTime() - one.at.getTime();
    if (byTime !== 0) return byTime;

    return one.kind === other.kind ? 0 : one.kind === 'STAGE' ? 1 : -1;
  });
}
