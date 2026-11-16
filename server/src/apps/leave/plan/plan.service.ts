/** Planning leave: a person's own plans, and how they sit against the balance. */

import type { Actor } from '../../../core/auth/actor.js';
import type { Guard } from '../../../core/auth/policy.js';
import { available } from '../balance/balance.js';
import type { BalanceRepository } from '../balance/balance.db.js';
import { theYearToOpenOn } from '../balance/balance-statement.js';
import type { Employee } from '../../../core/organisation/employee/employee.js';
import { EmployeeNotFound } from '../../../core/organisation/employee/employee.js';
import type { EmployeeRepository } from '../../../core/organisation/employee/employee.db.js';
import type { LeaveCalculatorService } from '../leave-calculator/leave-calculator.service.js';
import { leaveRequestPolicy } from '../leave-request/policy.js';
import {
  assertEligible,
  assertStillOffered,
  countingBasisLabel,
  hasRunningBalance,
  type LeaveType,
} from '../leave-type/leave-type.js';
import type { LeaveTypeRepository } from '../leave-type/leave-type.db.js';
import { byStartDate, type LeaveYear, LeaveYearNotFound } from '../leave-year/leave-year.js';
import type { LeaveYearRepository } from '../leave-year/leave-year.db.js';
import { type CalendarDate, currentDate, formatDay } from '../../../core/calendar/time.js';
import type { LeavePlanRepository } from './plan.db.js';
import {
  InvalidPlan,
  type LeavePlan,
  type PlanAsSent,
  PlanNotFound,
  validatePlan,
} from './plan.js';

/** One plan, with what it would cost. */
export interface PlanLine {
  plan: LeavePlan;
  typeName: string;
  countingBasisLabel: string;
  /** What it would cost, counted as a request would be. */
  days: number;
}

/** Everything planned of one kind of leave in the year, against what is left. */
export interface PlanTotal {
  leaveTypeId: string;
  typeName: string;
  planned: number;
  /** What the balance holds now, after leave already asked for. Null where it has none. */
  available: number | null;
  /** Planned past what is left. A warning, never a refusal. */
  over: boolean;
}

export interface PlanBook {
  year: LeaveYear;
  years: LeaveYear[];
  plans: PlanLine[];
  totals: PlanTotal[];
}

export class LeavePlanService {
  constructor(
    private readonly guard: Guard,
    private readonly plans: LeavePlanRepository,
    private readonly employees: EmployeeRepository,
    private readonly types: LeaveTypeRepository,
    private readonly years: LeaveYearRepository,
    private readonly balances: BalanceRepository,
    private readonly calculator: LeaveCalculatorService,
  ) {}

  /** This person's plans for one year, with each kind set against its balance. */
  async forEmployee(actor: Actor, employeeId: string, leaveYearId?: string): Promise<PlanBook> {
    const employee = await this.require(employeeId);

    this.guard.enforce(leaveRequestPolicy.read(actor, ownerOf(employee)));

    const years = [...(await this.years.list())].sort(byStartDate);
    const year = this.yearToShow(years, leaveYearId);

    const plans = await this.plans.forEmployee(employee.id, {
      from: year.startDate,
      to: year.endDate,
    });

    const types = new Map<string, LeaveType>();

    for (const plan of plans) {
      if (!types.has(plan.leaveTypeId)) {
        const type = await this.types.findById(plan.leaveTypeId);

        if (type !== undefined) {
          types.set(type.id, type);
        }
      }
    }

    const lines: PlanLine[] = [];

    for (const plan of plans) {
      const type = types.get(plan.leaveTypeId);

      lines.push({
        plan,
        typeName: type?.name ?? 'Leave',
        countingBasisLabel: type === undefined ? '' : countingBasisLabel(type.countingBasis),
        days:
          type === undefined ? 0 : (await this.calculator.count(actor, employee, type, plan)).days,
      });
    }

    const totals: PlanTotal[] = [];

    for (const type of types.values()) {
      const planned = lines
        .filter((line) => line.plan.leaveTypeId === type.id)
        .reduce((sum, line) => sum + line.days, 0);

      const left = hasRunningBalance(type)
        ? available(
            await this.balances.forOne({
              employeeId: employee.id,
              leaveTypeId: type.id,
              leaveYearId: year.id,
            }),
          )
        : null;

      totals.push({
        leaveTypeId: type.id,
        typeName: type.name,
        planned,
        available: left,
        over: left !== null && planned > left,
      });
    }

    return { year, years, plans: lines, totals };
  }

  async add(actor: Actor, employeeId: string, sent: PlanAsSent): Promise<LeavePlan> {
    const employee = await this.require(employeeId);

    this.guard.enforce(leaveRequestPolicy.submit(actor, ownerOf(employee)));

    return this.plans.add(employee.id, await this.checked(employee, sent));
  }

  async change(actor: Actor, employeeId: string, id: string, sent: PlanAsSent): Promise<LeavePlan> {
    const employee = await this.require(employeeId);

    this.guard.enforce(leaveRequestPolicy.submit(actor, ownerOf(employee)));

    const changed = await this.plans.replace(employee.id, id, await this.checked(employee, sent));

    if (changed === undefined) {
      throw new PlanNotFound(id);
    }

    return changed;
  }

  async remove(actor: Actor, employeeId: string, id: string): Promise<void> {
    const employee = await this.require(employeeId);

    this.guard.enforce(leaveRequestPolicy.submit(actor, ownerOf(employee)));

    if (!(await this.plans.remove(employee.id, id))) {
      throw new PlanNotFound(id);
    }
  }

  /** The rules a plan shares with a request: a type they may ask for, inside one year. */
  private async checked(employee: Employee, sent: PlanAsSent) {
    const plan = validatePlan(sent, this.today());

    const type = await this.types.findById(plan.leaveTypeId);

    if (type === undefined) {
      throw new InvalidPlan('leaveTypeId', 'That is not a kind of leave that exists.');
    }

    assertStillOffered(type);
    assertEligible(type, employee.gender);

    const year = await this.years.findCovering(plan.from);

    if (year === undefined) {
      throw new InvalidPlan(
        'from',
        `No leave year covers ${formatDay(plan.from)} yet, so there is nothing to plan against.`,
      );
    }

    if (plan.to > year.endDate) {
      throw new InvalidPlan(
        'to',
        `A plan stays inside one leave year, and ${year.label} ends on ` +
          `${formatDay(year.endDate)}. Make one plan each side of it.`,
      );
    }

    return plan;
  }

  private yearToShow(years: readonly LeaveYear[], leaveYearId: string | undefined): LeaveYear {
    if (leaveYearId !== undefined) {
      const chosen = years.find((year) => year.id === leaveYearId);

      if (chosen === undefined) {
        throw new LeaveYearNotFound(leaveYearId);
      }

      return chosen;
    }

    const opening = theYearToOpenOn(years, this.today());

    if (opening === undefined) {
      throw new LeaveYearNotFound('covering today');
    }

    return opening;
  }

  private async require(employeeId: string): Promise<Employee> {
    const employee = await this.employees.findById(employeeId);

    if (employee === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    return employee;
  }

  /** NFR DAT 03. */
  private today(): CalendarDate {
    return currentDate();
  }
}

function ownerOf(employee: Employee) {
  return { employeeId: employee.id, managerId: employee.managerId };
}
