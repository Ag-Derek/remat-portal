/**
 * HR's administration of employee records: who is on the list, what a form may send, and the
 * rules the Administration tab adds to the record's own. FR 01, FR 02, FR 06, NFR AUD 01.
 */

import { type AuditEntry, changedFields } from '../../core/audit/audit.js';
import { type CalendarDate, calendarDaysBetween } from '../../core/calendar/time.js';
import { hasLeftBy } from '../../core/organisation/employee/current.js';
import type {
  Employee,
  EmployeeChanges,
  NewEmployee,
} from '../../core/organisation/employee/employee.js';

/**
 * Where somebody stands on a day, as the list filters by it.
 *
 * `LEAVING` is somebody still here with an exit date ahead of them, which the directory does
 * not distinguish and HR does: it is who has notice to serve and reports to hand over.
 */
export const STANDINGS = ['CURRENT', 'STARTING', 'LEAVING', 'LEFT', 'SUSPENDED'] as const;

export type Standing = (typeof STANDINGS)[number];

/** Whether somebody can sign in: no login yet, one that works, or one that has been closed. */
export type LoginState = 'NONE' | 'ACTIVE' | 'CLOSED';

/** A joiner whose start date is this close or closer has their login asked for first. */
export const LOGIN_NEEDED_WITHIN_DAYS = 14;

/** Where somebody stands on this day. The same dates `whyNotListed` judges by. */
export function standingOf(employee: Employee, today: CalendarDate): Standing {
  if (hasLeftBy(employee, today)) {
    return 'LEFT';
  }
  if (employee.startDate > today) {
    return 'STARTING';
  }
  if (employee.employmentStatus === 'SUSPENDED') {
    return 'SUSPENDED';
  }

  return employee.exitDate === null ? 'CURRENT' : 'LEAVING';
}

/** Somebody named on a record: a manager, or a report. */
export interface PersonNamed {
  employeeId: string;
  firstName: string;
  lastName: string;
  jobTitle: string | null;
}

/** One row of the Administration list. */
export interface StaffRecord {
  employee: Employee;
  departmentName: string;
  manager: PersonNamed | null;
  standing: Standing;
  login: LoginState;
  /** How many people still here report to them. */
  reports: number;
}

/** Somebody waiting for a login, as the people who create them are shown it. */
export interface LoginToCreate {
  person: PersonNamed;
  workEmail: string;
  startDate: CalendarDate;
  /** Their start date is today, has passed, or is within {@link LOGIN_NEEDED_WITHIN_DAYS}. */
  soon: boolean;
}

/**
 * Everybody with a record and no login, who is not gone: soonest start first.
 *
 * A leaver never had one to create. A login that was closed is somebody's decision, so it is
 * not on this list either.
 */
export function loginsToCreate(
  records: readonly StaffRecord[],
  today: CalendarDate,
): LoginToCreate[] {
  return records
    .filter((record) => record.login === 'NONE' && record.standing !== 'LEFT')
    .map((record) => ({
      person: named(record.employee),
      workEmail: record.employee.workEmail,
      startDate: record.employee.startDate,
      soon:
        record.employee.startDate <= today ||
        calendarDaysBetween(today, record.employee.startDate) <= LOGIN_NEEDED_WITHIN_DAYS + 1,
    }))
    .sort(
      (a, b) =>
        a.startDate.localeCompare(b.startDate) ||
        a.person.lastName.localeCompare(b.person.lastName),
    );
}

/** The people still here who report to somebody: theirs to hand over before they go. */
export function reportsStillHere(
  manager: Pick<Employee, 'id'>,
  everybody: readonly Employee[],
  today: CalendarDate,
): Employee[] {
  return everybody.filter((one) => one.managerId === manager.id && !hasLeftBy(one, today));
}

/** Just the name and title, for a list. */
export function named(employee: Employee): PersonNamed {
  return {
    employeeId: employee.id,
    firstName: employee.firstName,
    lastName: employee.lastName,
    jobTitle: employee.jobTitle,
  };
}

/**
 * An exit date on somebody people still report to.
 *
 * Refused rather than left to the overnight job that moves a leaver's reports, because who
 * takes over a team is HR's decision and the moment to make it is before the exit is on the
 * record. The sentence names who is still reporting.
 */
export class StillHasReports extends Error {
  readonly field = 'exitDate';
  readonly reportIds: string[];

  constructor(employee: Employee, reports: readonly Employee[]) {
    const names = reports.map((one) => `${one.firstName} ${one.lastName}`);
    const listed =
      names.length <= 3
        ? names.join(', ')
        : `${names.slice(0, 3).join(', ')} and ${String(names.length - 3)} more`;

    super(
      `${employee.firstName} ${employee.lastName} still has ${String(reports.length)} ` +
        `${reports.length === 1 ? 'person' : 'people'} reporting to them (${listed}). ` +
        `Move their reports to another manager first, then set the exit date.`,
    );
    this.name = 'StillHasReports';
    this.reportIds = reports.map((one) => one.id);
  }
}

/** A manager who is not at the company today: not started yet, suspended, or gone. */
export class ManagerNotCurrent extends Error {
  readonly field = 'managerId';

  constructor(manager: Employee) {
    super(
      `${manager.firstName} ${manager.lastName} is not at the company today, so they cannot ` +
        `be anybody's manager. Choose somebody who is.`,
    );
    this.name = 'ManagerNotCurrent';
  }
}

/** A reassignment with nobody in it. */
export class NobodyToReassign extends Error {
  readonly field = 'employeeIds';

  constructor() {
    super('Choose at least one of their reports to move.');
    this.name = 'NobodyToReassign';
  }
}

/** Reports moved to one of themselves, or to somebody below one of them. FR 03. */
export class CannotTakeTheirOwnReports extends Error {
  readonly field = 'toManagerId';

  constructor(to: Employee, below: Employee) {
    super(
      to.id === below.id
        ? `${to.firstName} ${to.lastName} is one of the people being moved, and cannot be ` +
            `their own manager. Choose somebody else.`
        : `${to.firstName} ${to.lastName} reports, through the line, to ` +
            `${below.firstName} ${below.lastName}, who is being moved to them. That would ` +
            `close a loop. Choose somebody else.`,
    );
    this.name = 'CannotTakeTheirOwnReports';
  }
}

/**
 * Whether an edit is setting an exit date, which is when {@link StillHasReports} applies.
 *
 * An exit date already on the record and left as it is is not being set: correcting the name
 * of somebody serving notice is not the moment to be asked about their team.
 */
export function setsAnExitDate(changes: EmployeeChanges, current: Employee): boolean {
  const exitDate = 'exitDate' in changes ? (changes.exitDate ?? null) : current.exitDate;
  const terminating =
    changes.employmentStatus === 'TERMINATED' && current.employmentStatus !== 'TERMINATED';

  return exitDate !== null && (exitDate !== current.exitDate || terminating);
}

/**
 * That nobody being moved is the new manager or above them. FR 03.
 *
 * Asked of the whole batch before the first move, so a loop refuses the batch rather than
 * landing halfway through it. The walk remembers where it has been, as every walk of the
 * line here does.
 */
export function assertCanTakeReports(
  to: Employee,
  moving: readonly Employee[],
  everybody: readonly Employee[],
): void {
  const byId = new Map(everybody.map((one) => [one.id, one]));
  const movingIds = new Map(moving.map((one) => [one.id, one]));
  const walked = new Set<string>();
  let at: Employee | undefined = to;

  while (at !== undefined && !walked.has(at.id)) {
    const below = movingIds.get(at.id);

    if (below !== undefined) {
      throw new CannotTakeTheirOwnReports(to, below);
    }

    walked.add(at.id);
    at = at.managerId === null ? undefined : byId.get(at.managerId);
  }
}

/** A refusal of what a form sent, naming the box. */
export class InvalidAdministrationForm extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidAdministrationForm';
    this.field = field;
  }
}

/** The fields on a record HR keeps, which is every field the Administration form sends. */
const HR_FIELDS = [
  'employeeNumber',
  'firstName',
  'lastName',
  'workEmail',
  'jobTitle',
  'departmentId',
  'managerId',
  'workPatternId',
  'startDate',
  'exitDate',
  'employmentType',
  'employmentStatus',
  'gender',
] as const;

/** What the person keeps, named so the refusal can say so. */
const SELF_SERVICE_FIELDS = new Set(['workMobile', 'description', 'photo']);

/**
 * A new record, as the form sent it. The record's own rules are the service's to apply.
 *
 * `managerId` absent is passed on as absent, so the record's rule refuses it in its own words;
 * every other field is a string or null, and anything else is refused here.
 */
export function readNewEmployee(body: unknown): NewEmployee {
  return readFields(body) as unknown as NewEmployee;
}

/** A change to a record, as the form sent it: only the fields it named. */
export function readEmployeeChanges(body: unknown): EmployeeChanges {
  const changes = readFields(body);

  if (Object.keys(changes).length === 0) {
    throw new InvalidAdministrationForm('body', 'Nothing was sent to change.');
  }

  return changes as EmployeeChanges;
}

function readFields(body: unknown): Record<string, string | null> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InvalidAdministrationForm('body', 'Send the record as an object of fields.');
  }

  const fields: Record<string, string | null> = {};

  for (const [field, value] of Object.entries(body)) {
    if (SELF_SERVICE_FIELDS.has(field)) {
      throw new InvalidAdministrationForm(
        field,
        `${field} is kept by the person themselves on their own profile, not by HR.`,
      );
    }
    if (!(HR_FIELDS as readonly string[]).includes(field)) {
      throw new InvalidAdministrationForm(field, `${field} is not a field on an employee record.`);
    }
    if (value !== null && typeof value !== 'string') {
      throw new InvalidAdministrationForm(field, `${field} must be text, or empty.`);
    }

    fields[field] = value;
  }

  return fields;
}

/** A batch of reports to move, as the form sent it. */
export interface Reassignment {
  toManagerId: string;
  /** Null for every one of them still here. */
  employeeIds: string[] | null;
}

export function readReassignment(body: unknown): Reassignment {
  const { toManagerId, employeeIds } = (
    typeof body === 'object' && body !== null ? body : {}
  ) as Record<string, unknown>;

  if (typeof toManagerId !== 'string' || toManagerId.trim() === '') {
    throw new InvalidAdministrationForm('toManagerId', 'Choose who they will report to.');
  }

  if (employeeIds === undefined || employeeIds === null) {
    return { toManagerId: toManagerId.trim(), employeeIds: null };
  }

  if (!Array.isArray(employeeIds) || !employeeIds.every((id) => typeof id === 'string')) {
    throw new InvalidAdministrationForm('employeeIds', 'employeeIds must be a list of ids.');
  }

  if (employeeIds.length === 0) {
    throw new NobodyToReassign();
  }

  return { toManagerId: toManagerId.trim(), employeeIds: [...new Set(employeeIds as string[])] };
}

/** Whether somebody is a team lead, as the form sent it: `{ "teamLead": true }`. */
export function readTeamLead(body: unknown): boolean {
  const { teamLead } = (typeof body === 'object' && body !== null ? body : {}) as Record<
    string,
    unknown
  >;

  if (typeof teamLead !== 'boolean') {
    throw new InvalidAdministrationForm('teamLead', 'teamLead must be true or false.');
  }

  return teamLead;
}

/** One change to a record, as HR reads its history. NFR AUD 01. */
export interface RecordChange {
  at: Date;
  /** Created or changed. */
  action: AuditEntry['action'];
  /** Who, in words. */
  by: string;
  changes: { field: string; label: string; from: unknown; to: unknown }[];
}

/** The columns a person reads a change of, in words. Bookkeeping columns are left out. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  employee_number: 'Employee number',
  first_name: 'First name',
  last_name: 'Last name',
  work_email: 'Work email',
  job_title: 'Job title',
  department_id: 'Department',
  manager_id: 'Reports to',
  work_pattern_id: 'Working pattern',
  start_date: 'Start date',
  exit_date: 'Exit date',
  employment_type: 'Employment type',
  employment_status: 'Status',
  gender: 'Gender',
  work_mobile: 'Work mobile',
  description: 'Description',
  team_lead: 'Team lead on the chart',
};

/** What the ids in a history point at, by the column that holds them. */
export interface NamesInHistory {
  departments: ReadonlyMap<string, string>;
  employees: ReadonlyMap<string, string>;
  patterns: ReadonlyMap<string, string>;
}

/**
 * A record's history, newest first, with each change's old and new value, who and when.
 *
 * A department, a manager or a working pattern is named rather than shown as an id. Looked
 * up by column, because ids from different tables can be the same number.
 */
export function historyOf(entries: readonly AuditEntry[], names: NamesInHistory): RecordChange[] {
  const lookup: Readonly<Record<string, ReadonlyMap<string, string>>> = {
    department_id: names.departments,
    manager_id: names.employees,
    work_pattern_id: names.patterns,
  };

  const nameOf = (field: string, value: unknown): unknown =>
    value === null || value === undefined ? null : (lookup[field]?.get(String(value)) ?? value);

  return entries
    .map((entry): RecordChange => ({
      at: entry.occurredAt,
      action: entry.action,
      by: entry.actor,
      changes: changedFields(entry)
        .filter((change) => change.field in FIELD_LABELS)
        .map((change) => ({
          field: change.field,
          label: FIELD_LABELS[change.field] ?? change.field,
          from: nameOf(change.field, change.from),
          to: nameOf(change.field, change.to),
        })),
    }))
    .filter((change) => change.changes.length > 0)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}
