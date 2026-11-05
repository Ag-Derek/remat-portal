/** The managers above somebody who are still here to answer for them. SRS CMP 38. */

import type { CalendarDate } from '../../calendar/time.js';
import { isCurrentOn } from './current.js';
import { type Employee, EmployeeNotFound } from './employee.js';

/**
 * Everybody above this employee in their reporting line who is at the company today, nearest
 * first, not including the employee.
 *
 * What an escalation walks: the first is who it goes to, and each one after is where it goes
 * next. Rota only ever needed one level, which is why this is a walk of its own rather than
 * a `managerId` read.
 *
 * **Somebody who is not here is stepped over, not stopped at.** A manager who has left, who
 * has not started, or who is suspended is nobody an escalation can reach — {@link isCurrentOn}
 * is the one rule for that — so the walk goes on to whoever they report to. Where nobody above
 * is here, the answer is empty and the caller decides what that means; the leaver's own
 * reporting line still runs through them, which is their history.
 *
 * **From whatever records it is handed**, so it can be read and tested without a database:
 * `EmployeeRepository.chainFrom(employeeId)` is exactly the records it needs, and the whole
 * staff list serves as well. A line that runs off the end of what it was given ends there.
 *
 * Walked upward, remembering where it has been, for the reason every walk of the reporting
 * line here is: a loop the database should never hold is infinitely deep to a walk that does
 * not.
 */
export function managerChainOf(
  employeeId: string,
  employees: readonly Employee[],
  today: CalendarDate,
): Employee[] {
  const byId = new Map(employees.map((employee) => [employee.id, employee]));
  const employee = byId.get(employeeId);

  if (employee === undefined) {
    throw new EmployeeNotFound(employeeId);
  }

  const walked = new Set<string>([employee.id]);
  const chain: Employee[] = [];
  let at = employee;

  for (;;) {
    const above = at.managerId === null ? undefined : byId.get(at.managerId);

    if (above === undefined || walked.has(above.id)) {
      return chain;
    }
    if (isCurrentOn(above, today)) {
      chain.push(above);
    }

    walked.add(above.id);
    at = above;
  }
}
