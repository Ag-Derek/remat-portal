/**
 * Whether somebody can still look after what is theirs in clients: a client they own, an open deal,
 * a POC they lead. Where not, it needs reassigning (#289, Clients SRS CLI 96).
 *
 * The user's rule, 24 November 2026, which is CLI 96 in full: they need replacing where they are
 * not current staff today, by core's one rule (left, suspended, or not started yet), or where
 * they hold no live clients role (ended because they left, or revoked). A leaver's grant ends
 * within the hour of their going (leavers.ts); a suspended one keeps theirs, and is caught by the
 * first half.
 */

import { type CalendarDate, currentDate } from '../../core/calendar/time.js';
import { whyNotListed } from '../../core/organisation/employee/current.js';
import type { Employee } from '../../core/organisation/employee/employee.js';
import type { EmployeeRepository } from '../../core/organisation/employee/employee.db.js';
import type { ClientsRoleRepository } from './role.db.js';

/** Why somebody's things need a new owner or CS lead. */
export type StandingReason = 'LEFT' | 'SUSPENDED' | 'NOT_STARTED' | 'NO_ROLE';

export interface Standing {
  reason: StandingReason;
  /** Their last day, where they have left. */
  exitDate: CalendarDate | null;
}

/** Why `employee` can no longer look after their things, or null where they can. */
export function standingOf(
  employee: Employee | undefined,
  holdsARole: boolean,
  today: CalendarDate,
): Standing | null {
  /* No record at all is nobody who can look after anything. */
  if (employee === undefined) {
    return { reason: 'NO_ROLE', exitDate: null };
  }

  const away = whyNotListed(employee, today);
  if (away !== null) {
    return { reason: away, exitDate: away === 'LEFT' ? employee.exitDate : null };
  }

  return holdsARole ? null : { reason: 'NO_ROLE', exitDate: null };
}

/** Asks the rule of several people at once, as the screens need it. */
export class ClientsStandings {
  constructor(
    private readonly grants: Pick<ClientsRoleRepository, 'liveHolderIds'>,
    private readonly employees: Pick<EmployeeRepository, 'findAllById'>,
    private readonly today: () => CalendarDate = () => currentDate(),
  ) {}

  /** Each of `ids` who needs replacing, and why. Anybody fine is not in it. */
  async of(ids: Iterable<string>): Promise<Map<string, Standing>> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) {
      return new Map();
    }

    const [holders, employees] = await Promise.all([
      this.grants.liveHolderIds(),
      this.employees.findAllById(wanted),
    ]);
    const holding = new Set(holders);
    const byId = new Map(employees.map((employee) => [employee.id, employee]));
    const today = this.today();

    const standings = new Map<string, Standing>();
    for (const id of wanted) {
      const standing = standingOf(byId.get(id), holding.has(id), today);
      if (standing !== null) {
        standings.set(id, standing);
      }
    }

    return standings;
  }
}

/**
 * Whether somebody can be given clients, deals or POCs: whether they hold a live clients role and
 * are at the company today, so that they would not need replacing themselves (the user, 24
 * November 2026). Asked of every move a BD manager makes: a client, a deal, a POC's lead, and
 * everything of one person's.
 */
export async function canTakeOver(
  standings: Pick<ClientsStandings, 'of'>,
  employeeId: string,
): Promise<boolean> {
  return (await standings.of([employeeId])).size === 0;
}

/** What a move to somebody who cannot take over is refused with. */
export const CANNOT_TAKE_OVER =
  'Choose somebody who has a role in clients and is at the company today.';
