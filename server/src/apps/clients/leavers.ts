/**
 * Clients grants end when their holder leaves, without anybody remembering to. #274, Clients
 * SRS CLI 95, TDD 4.8.
 *
 * "Left" is core's rule, `hasLeftBy`: here through the exit date, and gone the day after. That
 * is not when HR records the exit, which is often done ahead of time, so there are two ways in:
 *
 * - **The employee change hook**, for an exit recorded on or after the day: the change itself
 *   says they have left, and their grants end there and then.
 * - **A sweep**, run hourly, for the exit recorded in advance: nothing changes on the record when
 *   the last day passes, so nothing would tell the hook. The sweep finds whoever holds a grant
 *   and has left by today.
 *
 * Both end grants the same way, as the system, with reason LEFT and nobody named as ending them.
 * Somebody suspended has not left and keeps theirs; what they own is flagged instead (CLI 96).
 * Ending is idempotent, so the two meeting, or the sweep running twice, ends nothing twice.
 */

import { type Actor, theSystem } from '../../core/auth/actor.js';
import type { Guard } from '../../core/auth/policy.js';
import { type CalendarDate, currentDate } from '../../core/calendar/time.js';
import { hasLeftBy } from '../../core/organisation/employee/current.js';
import type {
  EmployeeChange,
  EmployeeChangeSubscriber,
} from '../../core/organisation/employee/employee.js';
import type { EmployeeRepository } from '../../core/organisation/employee/employee.db.js';
import { clientsPolicy } from './policy.js';
import type { Grant } from './role.js';
import type { ClientsRoleRepository } from './role.db.js';

/** What one sweep did. */
export interface LeaversSwept {
  asAt: CalendarDate;
  /** Every grant it ended, for the job's log. */
  ended: Grant[];
}

export class ClientsLeavers implements EmployeeChangeSubscriber {
  /** Who ends a leaver's grants: the system, which nobody is, on behalf of the rule. */
  private readonly system: Actor = theSystem("ending a leaver's clients roles");

  constructor(
    private readonly guard: Guard,
    private readonly grants: Pick<ClientsRoleRepository, 'liveHolderIds' | 'endAllBecauseTheyLeft'>,
    private readonly employees: Pick<EmployeeRepository, 'findAllById'>,
    private readonly today: () => CalendarDate = () => currentDate(),
  ) {}

  /**
   * A record changed. If it now says they have left, their grants end. Whoever made the change,
   * HR, is not who ends the grants: that is the rule's doing, so it is the system's.
   */
  async onEmployeeChanged(_actor: Actor, change: EmployeeChange): Promise<Grant[]> {
    if (!hasLeftBy(change.after, this.today())) {
      return [];
    }

    return this.endFor(change.after.id);
  }

  /** Ends the grants of everybody holding one who has left by today. The hourly job's. */
  async sweep(actor: Actor): Promise<LeaversSwept> {
    this.guard.enforce(clientsPolicy.runUnattended(actor, 'endGrantsOnExit'));

    const asAt = this.today();
    const holders = await this.employees.findAllById(await this.grants.liveHolderIds());
    const ended: Grant[] = [];

    for (const holder of holders.filter((one) => hasLeftBy(one, asAt))) {
      ended.push(...(await this.grants.endAllBecauseTheyLeft(holder.id)));
    }

    return { asAt, ended };
  }

  private async endFor(employeeId: string): Promise<Grant[]> {
    this.guard.enforce(clientsPolicy.runUnattended(this.system, 'endGrantsOnExit'));

    return this.grants.endAllBecauseTheyLeft(employeeId);
  }
}

/** A line for the job log, or nothing where nothing ended. */
export function summaryOfLeaversSwept(run: LeaversSwept): string | undefined {
  if (run.ended.length === 0) {
    return undefined;
  }

  return [
    `Clients roles of leavers as at ${run.asAt}: ${String(run.ended.length)} ended.`,
    ...run.ended.map((grant) => `  ended ${grant.role} held by ${grant.employeeId}`),
  ].join('\n');
}
