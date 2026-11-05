/** HR's Administration tab: every record, and adding, changing and moving people. FR 01, FR 06. */

import type { Actor } from '../../core/auth/actor.js';
import type { Guard } from '../../core/auth/policy.js';
import type { AuditRepository } from '../../core/audit/audit.db.js';
import { type CalendarDate, currentDate } from '../../core/calendar/time.js';
import type { WorkPatternRepository } from '../../core/calendar/work-pattern/work-pattern.db.js';
import type { RoleRepository } from '../../core/identity/role/role.db.js';
import type { SignInAccountRepository } from '../../core/identity/sign-in/sign-in-account.db.js';
import type { DepartmentRepository } from '../../core/organisation/department/department.db.js';
import { hasLeftBy, isCurrentOn } from '../../core/organisation/employee/current.js';
import {
  type Employee,
  EmployeeNotFound,
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_TYPES,
  GENDERS,
  ManagerNotFound,
} from '../../core/organisation/employee/employee.js';
import type { EmployeeRepository } from '../../core/organisation/employee/employee.db.js';
import type { EmployeeService } from '../../core/organisation/employee/employee.service.js';
import {
  assertCanTakeReports,
  historyOf,
  type LoginState,
  type LoginToCreate,
  loginsToCreate,
  ManagerNotCurrent,
  named,
  NobodyToReassign,
  type PersonNamed,
  readEmployeeChanges,
  readNewEmployee,
  readReassignment,
  readTeamLead,
  type RecordChange,
  reportsStillHere,
  setsAnExitDate,
  type StaffRecord,
  standingOf,
  StillHasReports,
} from './administration.js';
import { bySurname } from './directory.js';
import { directoryPolicy } from './policy.js';

/** The Administration list: everybody with a record, leavers included. */
export interface AdministrationList {
  today: CalendarDate;
  /** By surname. */
  records: StaffRecord[];
  /** Every department somebody on the list is in, by name. */
  departments: { id: string; name: string }[];
  /** New records waiting for a login, soonest start first. */
  loginsToCreate: LoginToCreate[];
  /** Who creates them, so the screen can say whose job it now is. */
  systemAdministrators: PersonNamed[];
}

/** One record, as HR opens it to change it. */
export interface AdministrationRecord extends StaffRecord {
  today: CalendarDate;
  workPatternName: string;
  /** The people still here who report to them, by surname. */
  reportsStillHere: PersonNamed[];
  /** Whether the chart draws their reports beside them, under their own manager. */
  teamLead: boolean;
  /** Every change, newest first. NFR AUD 01. */
  history: RecordChange[];
}

/** What the form offers. */
export interface AdministrationChoices {
  today: CalendarDate;
  /** Open departments only: nobody can be put in a closed one. */
  departments: { id: string; name: string }[];
  /** Everybody at the company today, by surname, and nobody else. */
  managers: PersonNamed[];
  patterns: { id: string; name: string; isDefault: boolean }[];
  employmentTypes: readonly string[];
  employmentStatuses: readonly string[];
  genders: readonly string[];
}

/** What a batch of reports moving did. */
export interface ReportsMoved {
  moved: PersonNamed[];
  to: PersonNamed;
}

export class AdministrationService {
  constructor(
    /** NFR SEC 02. */
    private readonly guard: Guard,
    private readonly employees: EmployeeRepository,
    /**
     * The door every change goes through, so the record's own rules, the audit trigger and
     * the pending leave that follows a manager all apply exactly as they do anywhere else.
     */
    private readonly records: EmployeeService,
    private readonly departments: DepartmentRepository,
    private readonly patterns: WorkPatternRepository,
    /** Who has a login, for the hand-off to whoever creates them. */
    private readonly accounts: SignInAccountRepository,
    private readonly roles: RoleRepository,
    private readonly audit: AuditRepository,
    /** Today, in UTC, the day every other "today" on the server is. NFR DAT 03. */
    private readonly today: () => CalendarDate = () => currentDate(),
  ) {}

  /** Everybody with a record, with where they stand and whether they can sign in. */
  async list(actor: Actor): Promise<AdministrationList> {
    this.guard.enforce(directoryPolicy.administer(actor));

    const today = this.today();
    const everybody = await this.employees.list();
    const records = await this.staffRecords(everybody, today);
    const holders = new Set(await this.roles.employeeIdsHolding('SYS_ADMIN'));

    const departments = new Map(
      records.map((record) => [record.employee.departmentId, record.departmentName]),
    );

    return {
      today,
      records,
      departments: [...departments]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      loginsToCreate: loginsToCreate(records, today),
      systemAdministrators: everybody
        .filter((one) => holders.has(one.id) && isCurrentOn(one, today))
        .map(named)
        .sort(bySurname),
    };
  }

  /** One record, leavers included, with who reports to them and how it came to say what it says. */
  async record(actor: Actor, employeeId: string): Promise<AdministrationRecord> {
    this.guard.enforce(directoryPolicy.administer(actor, employeeId));

    const today = this.today();
    const everybody = await this.employees.list();
    const employee = everybody.find((one) => one.id === employeeId);

    if (employee === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    const [[record], departments, patterns, entries, teamLeads] = await Promise.all([
      this.staffRecords(everybody, today, [employee]),
      this.departments.list(),
      this.patterns.list(),
      this.audit.forSubjects([{ entity: 'employee', entityId: employee.id }]),
      this.employees.teamLeadIds(),
    ]);

    const names = new Map(everybody.map((one) => [one.id, `${one.firstName} ${one.lastName}`]));

    return {
      ...record!,
      today,
      workPatternName:
        patterns.find((one) => one.id === employee.workPatternId)?.name ?? 'Not recorded',
      reportsStillHere: reportsStillHere(employee, everybody, today).map(named).sort(bySurname),
      teamLead: teamLeads.has(employee.id),
      history: historyOf(
        entries.map((entry) => ({
          ...entry,
          actor:
            entry.actorEmployeeId === null
              ? entry.actor
              : (names.get(entry.actorEmployeeId) ?? entry.actor),
        })),
        {
          departments: new Map(departments.map((one) => [one.id, one.name])),
          employees: names,
          patterns: new Map(patterns.map((one) => [one.id, one.name])),
        },
      ),
    };
  }

  /** The departments, managers and working patterns the form offers. */
  async choices(actor: Actor): Promise<AdministrationChoices> {
    this.guard.enforce(directoryPolicy.administer(actor));

    const today = this.today();
    const [departments, everybody, patterns] = await Promise.all([
      this.departments.list({ openOnly: true }),
      this.employees.list(),
      this.patterns.list(),
    ]);

    return {
      today,
      departments: departments
        .map((one) => ({ id: one.id, name: one.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      managers: everybody
        .filter((one) => isCurrentOn(one, today))
        .map(named)
        .sort(bySurname),
      patterns: patterns.map((one) => ({ id: one.id, name: one.name, isDefault: one.isDefault })),
      employmentTypes: EMPLOYMENT_TYPES,
      employmentStatuses: EMPLOYMENT_STATUSES,
      genders: GENDERS,
    };
  }

  /**
   * Adds somebody. They are in the directory from their start date, and waiting for a login
   * from the moment this returns.
   */
  async add(actor: Actor, body: unknown): Promise<AdministrationRecord> {
    this.guard.enforce(directoryPolicy.administer(actor));

    const input = readNewEmployee(body);

    if (typeof input.managerId === 'string' && input.managerId.trim() !== '') {
      await this.checkManagerIsCurrent(input.managerId.trim());
    }

    const created = await this.records.create(actor, input);

    return this.record(actor, created.id);
  }

  /**
   * Changes the fields HR keeps on a record.
   *
   * Two rules on top of the record's own: a new manager has to be somebody here today, and an
   * exit date cannot be set while anybody still here reports to them.
   */
  async edit(actor: Actor, employeeId: string, body: unknown): Promise<AdministrationRecord> {
    this.guard.enforce(directoryPolicy.administer(actor, employeeId));

    const changes = readEmployeeChanges(body);
    const current = await this.employees.findById(employeeId);

    if (current === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    if (
      typeof changes.managerId === 'string' &&
      changes.managerId.trim() !== '' &&
      changes.managerId.trim() !== current.managerId
    ) {
      await this.checkManagerIsCurrent(changes.managerId.trim());
    }

    if (setsAnExitDate(changes, current)) {
      const reports = reportsStillHere(current, await this.employees.list(), this.today());

      if (reports.length > 0) {
        throw new StillHasReports(
          current,
          reports.sort((a, b) => bySurname(named(a), named(b))),
        );
      }
    }

    await this.records.update(actor, employeeId, changes);

    return this.record(actor, employeeId);
  }

  /**
   * Moves some or all of somebody's reports to another manager. FR 02, FR 07.
   *
   * Each move is an ordinary change through the record's own door, so each is audited and
   * each person's pending leave follows them. The whole batch is checked first, so a choice
   * that would close a loop refuses the batch rather than stopping halfway.
   */
  async reassignReports(actor: Actor, employeeId: string, body: unknown): Promise<ReportsMoved> {
    this.guard.enforce(directoryPolicy.administer(actor, employeeId));

    const { toManagerId, employeeIds } = readReassignment(body);
    const today = this.today();
    const everybody = await this.employees.list();
    const from = everybody.find((one) => one.id === employeeId);

    if (from === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    const theirs = reportsStillHere(from, everybody, today);
    const moving =
      employeeIds === null ? theirs : theirs.filter((one) => employeeIds.includes(one.id));

    if (moving.length === 0 || (employeeIds !== null && moving.length !== employeeIds.length)) {
      /* Somebody named who is not one of theirs is a stale screen, not a partial instruction. */
      throw new NobodyToReassign();
    }

    const to = await this.checkManagerIsCurrent(toManagerId);

    assertCanTakeReports(to, moving, everybody);

    for (const report of moving) {
      await this.records.update(actor, report.id, { managerId: to.id });
    }

    return { moved: moving.map(named).sort(bySurname), to: named(to) };
  }

  /**
   * Marks somebody a team lead, or not: `{ "teamLead": true }`.
   *
   * Changes the chart and nothing else. Their reports still report to them, so they still
   * approve those people's leave; the chart draws the team beside them, under their manager.
   */
  async setTeamLead(
    actor: Actor,
    employeeId: string,
    body: unknown,
  ): Promise<AdministrationRecord> {
    this.guard.enforce(directoryPolicy.administer(actor, employeeId));

    if ((await this.employees.setTeamLead(actor, employeeId, readTeamLead(body))) === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    return this.record(actor, employeeId);
  }

  /**
   * The people waiting for a login, for whoever creates them.
   *
   * The same list the Administration tab shows HR, without the rest of the records.
   */
  async loginsToCreate(actor: Actor): Promise<LoginToCreate[]> {
    this.guard.enforce(directoryPolicy.loginsToCreate(actor));

    const today = this.today();

    return loginsToCreate(await this.staffRecords(await this.employees.list(), today), today);
  }

  /** That somebody is here today and so can be a manager. */
  private async checkManagerIsCurrent(managerId: string): Promise<Employee> {
    const manager = await this.employees.findById(managerId);

    if (manager === undefined) {
      throw new ManagerNotFound(managerId);
    }
    if (!isCurrentOn(manager, this.today())) {
      throw new ManagerNotCurrent(manager);
    }

    return manager;
  }

  /** Rows for these people, or for everybody, by surname. */
  private async staffRecords(
    everybody: readonly Employee[],
    today: CalendarDate,
    only: readonly Employee[] = everybody,
  ): Promise<StaffRecord[]> {
    const [departments, accounts] = await Promise.all([
      this.departments.list(),
      this.accounts.findByEmployeeIds(only.map((one) => one.id)),
    ]);

    const departmentNames = new Map(departments.map((one) => [one.id, one.name]));
    const logins = new Map(accounts.map((one) => [one.employeeId, one.isActive]));
    const byId = new Map(everybody.map((one) => [one.id, one]));
    const reportCounts = new Map<string, number>();

    for (const one of everybody) {
      if (one.managerId !== null && !hasLeftBy(one, today)) {
        reportCounts.set(one.managerId, (reportCounts.get(one.managerId) ?? 0) + 1);
      }
    }

    return only
      .map((employee): StaffRecord => {
        const manager = employee.managerId === null ? undefined : byId.get(employee.managerId);
        const login = logins.get(employee.id);

        return {
          employee,
          departmentName: departmentNames.get(employee.departmentId) ?? 'Not recorded',
          manager: manager === undefined ? null : named(manager),
          standing: standingOf(employee, today),
          login: (login === undefined ? 'NONE' : login ? 'ACTIVE' : 'CLOSED') as LoginState,
          reports: reportCounts.get(employee.id) ?? 0,
        };
      })
      .sort((a, b) => bySurname(named(a.employee), named(b.employee)));
  }
}
