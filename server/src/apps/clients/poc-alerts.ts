/**
 * Which POC flags the morning alerts tell, and whom. #290, Clients SRS CLI 72.
 *
 * The user's rules, 24 November 2026:
 *
 * - **What:** every flag a running POC has (poc.ts `pocFlagsOf`): no corrective action, an exit
 *   decision, low or no usage from Day 63, and past its decision date. Told once per POC, flag and
 *   the moment it was flagged from, so a flag that comes back with a new moment is told again.
 * - **Whom:** the CS lead, and the CS lead's line manager where that manager holds the BD manager
 *   role, as an exit's debrief goes. Somebody who cannot look after their things (standing.ts) is
 *   not sent anything.
 * - **When:** on working mornings; a flag raised over a weekend is told on the Monday.
 * - One email per person per morning, every POC newly flagged for them in it.
 *
 * Whether a flag has been told is kept per person (task 4), with the email that tells it, so a
 * run stopped between telling the CS lead and the BD manager still tells the manager.
 */

import type { CalendarDate } from '../../core/calendar/time.js';
import { type Poc, type PocFlag, pocFlagsOf } from './poc.js';

/** A flag as it is told once: its POC, what it is and the moment it was flagged from. */
export interface FlagTold {
  pocId: string;
  kind: PocFlag['kind'];
  since: Date;
}

/** What makes a flag the same flag, from one morning to the next. */
export function toldKeyOf(flag: FlagTold): string {
  return `${flag.pocId}:${flag.kind}:${flag.since.toISOString()}`;
}

/** What makes a flag told to one person the same, from one morning to the next. */
export function toldToKeyOf(personId: string, flag: FlagTold): string {
  return `${personId}|${toldKeyOf(flag)}`;
}

/** A POC and its flags. */
export interface PocAlert {
  poc: Poc;
  flags: PocFlag[];
}

/** Each running POC's flags at `now` on `today`, POCs with none left out. */
export function flaggedOf(pocs: readonly Poc[], now: Date, today: CalendarDate): PocAlert[] {
  return pocs
    .map((poc) => ({ poc, flags: pocFlagsOf(poc, now, today) }))
    .filter((alert) => alert.flags.length > 0);
}

/** The flags an alert carries, as they are recorded. */
export function flagsIn(alerts: readonly PocAlert[]): FlagTold[] {
  return alerts.flatMap(({ poc, flags }) =>
    flags.map((flag) => ({ pocId: poc.id, kind: flag.kind, since: flag.since })),
  );
}

/**
 * Who is told about a POC: its CS lead, and the lead's line manager where that manager is a BD
 * manager. `managerOf` maps a CS lead to their manager, or null where they have none.
 */
export function toldAbout(
  poc: Pick<Poc, 'csLead'>,
  managerOf: ReadonlyMap<string, string | null>,
  bdManagers: ReadonlySet<string>,
): string[] {
  const manager = managerOf.get(poc.csLead.id) ?? null;

  return manager !== null && manager !== poc.csLead.id && bdManagers.has(manager)
    ? [poc.csLead.id, manager]
    : [poc.csLead.id];
}

/**
 * What each person has yet to be told, by who they are, in the order the POCs came: the flags in
 * `told` (`toldToKeyOf` keys) left out, and anybody with nothing left out with them.
 */
export function alertsByPerson(
  flagged: readonly PocAlert[],
  managerOf: ReadonlyMap<string, string | null>,
  bdManagers: ReadonlySet<string>,
  told: ReadonlySet<string> = new Set(),
): Map<string, PocAlert[]> {
  const byPerson = new Map<string, PocAlert[]>();

  for (const { poc, flags } of flagged) {
    for (const person of toldAbout(poc, managerOf, bdManagers)) {
      const untold = flags.filter(
        (flag) =>
          !told.has(toldToKeyOf(person, { pocId: poc.id, kind: flag.kind, since: flag.since })),
      );

      if (untold.length > 0) {
        byPerson.set(person, [...(byPerson.get(person) ?? []), { poc, flags: untold }]);
      }
    }
  }

  return byPerson;
}
