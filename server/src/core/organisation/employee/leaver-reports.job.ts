/** Moving a leaver's reports to the manager above them, once their last day has passed. */

import type { Actor } from '../../auth/actor.js';
import { type CalendarDate, currentDate } from '../../calendar/time.js';
import type { EmployeeService } from './employee.service.js';
import {
  type ReportLeftWhereItIs,
  type ReportToMove,
  planLeaverReports,
} from './leaver-reports.js';

export interface LeaverReportsRun {
  asAt: CalendarDate;
  moved: ReportToMove[];
  /** Nobody to move them to, or a move the service refused. Each says why. */
  stranded: ReportLeftWhereItIs[];
}

/**
 * The job. Hourly from main.ts, so a report moves within the hour after midnight UTC rather
 * than a day late on an instance that restarted at teatime.
 *
 * Safe to rerun: a report once moved no longer reports to a leaver, so the next run finds
 * nobody. Each move goes through `EmployeeService.update`, the door HR's own corrections use,
 * so the rules about a reporting line are checked, the audit trigger records the change, and
 * the report's pending leave follows them to the new manager (FR 07). One that is refused
 * does not stop the rest.
 */
export class LeaverReports {
  constructor(
    private readonly employees: EmployeeService,
    private readonly today: () => CalendarDate = () => currentDate(),
  ) {}

  async run(actor: Actor): Promise<LeaverReportsRun> {
    const asAt = this.today();
    const plan = planLeaverReports(await this.employees.list(actor), asAt);

    const moved: ReportToMove[] = [];
    const stranded = [...plan.stranded];

    for (const move of plan.moves) {
      try {
        await this.employees.update(actor, move.employeeId, { managerId: move.toId });
        moved.push(move);
      } catch (error) {
        stranded.push({
          employeeId: move.employeeId,
          leaverId: move.leaverId,
          because: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { asAt, moved, stranded };
  }
}

/** For the log. Undefined when there was nothing to do. */
export function summaryOfLeaverReports(run: LeaverReportsRun): string | undefined {
  if (run.moved.length === 0 && run.stranded.length === 0) {
    return undefined;
  }

  return [
    `Leavers' reports as at ${run.asAt}: ${String(run.moved.length)} moved, ` +
      `${String(run.stranded.length)} left for HR.`,
    ...run.moved.map((move) => `  moved ${move.employeeId} from ${move.leaverId} to ${move.toId}`),
    ...run.stranded.map((one) => `  left ${one.employeeId} under ${one.leaverId}: ${one.because}`),
  ].join('\n');
}
