/** The directory's emails: who is sent what, and what they have chosen not to get. */

import { type Actor, holdsAny, isSelf } from '../../core/auth/actor.js';
import type { Guard } from '../../core/auth/policy.js';
import {
  type CalendarDate,
  calendarDaysBetween,
  currentDate,
  dayAfter,
} from '../../core/calendar/time.js';
import type { NewOutboxEmail } from '../../core/notification/outbox.js';
import type { EmailOutbox } from '../../core/notification/outbox.service.js';
import type { RoleRepository } from '../../core/identity/role/role.db.js';
import { APPROVES_AS_HR } from '../../core/identity/role/roles.js';
import type { DepartmentRepository } from '../../core/organisation/department/department.db.js';
import { hasLeftBy, isCurrentOn } from '../../core/organisation/employee/current.js';
import {
  type Employee,
  type EmployeeChange,
  type EmployeeChangeSubscriber,
  EmployeeNotFound,
} from '../../core/organisation/employee/employee.js';
import type { EmployeeRepository } from '../../core/organisation/employee/employee.db.js';
import type { EmailPreferenceRepository } from './email.db.js';
import {
  ABOUT_EACH_EMAIL,
  type ChangedField,
  coverNamedEmail,
  directMessageEmails,
  DIRECTORY_EMAILS,
  MESSAGES_PER_HOUR,
  MessageNotQueued,
  TooManyMessages,
  validateMessage,
  type DirectoryEmail,
  EmailIsMandatory,
  isOptional,
  leaverHasReportsEmail,
  newColleagueEmail,
  newReportEmail,
  type Person,
  type PortalLinks,
  recordChangedEmail,
  warningDue,
  welcomeEmail,
} from './email.js';
import { directoryPolicy } from './policy.js';

/**
 * How many days back a start date is still welcomed. A server that was down on somebody's
 * first day still welcomes them the next morning; a dedupe key on each message means nobody
 * is welcomed twice.
 */
export const JOINER_CATCH_UP_DAYS = 3;

/** One email, as the screen where somebody chooses lists it. */
export interface EmailChoice {
  email: DirectoryEmail;
  label: string;
  description: string;
  /** False for the ones that are always sent. */
  optional: boolean;
  receives: boolean;
}

/** What one day's run queued. */
export interface DailyEmailsRun {
  asAt: CalendarDate;
  /** Messages newly queued, by email. A message already queued by an earlier run is not here. */
  queued: Partial<Record<DirectoryEmail, number>>;
  /** Left out because the person turned that email off. */
  turnedOff: number;
  /** Could not be written to the queue. Each is logged. */
  failed: number;
}

/** A cover to tell, as leave's `CoverService` names one. #226. */
export interface CoverNaming {
  absenteeId: string;
  coverId: string;
  from: CalendarDate;
  to: CalendarDate;
  /** Whatever identifies this naming, as the cover row's id. */
  reference: string;
}

export class DirectoryEmailService implements EmployeeChangeSubscriber {
  constructor(
    /** NFR SEC 02. */
    private readonly guard: Guard,
    private readonly employees: EmployeeRepository,
    private readonly departments: DepartmentRepository,
    /** Who is HR, for the leaver warning. */
    private readonly roles: RoleRepository,
    private readonly preferences: EmailPreferenceRepository,
    /** Where every message goes. Queued, never sent here. */
    private readonly outbox: EmailOutbox,
    private readonly links: PortalLinks,
    /** Today, in UTC, the day every other "today" on the server is. NFR DAT 03. */
    private readonly today: () => CalendarDate = () => currentDate(),
  ) {}

  /** The emails the reader can be sent, and whether each comes to them. */
  async choices(actor: Actor): Promise<EmailChoice[]> {
    this.guard.enforce(directoryPolicy.chooseEmails(actor));

    const off = new Set(await this.preferences.turnedOffBy(actor.employeeId ?? ''));
    /* The leaver warning only ever goes to HR, so nobody else is offered it. */
    const isHr = holdsAny(actor, ...APPROVES_AS_HR);

    return DIRECTORY_EMAILS.filter((email) => email !== 'LEAVER_HAS_REPORTS' || isHr).map(
      (email) => ({
        email,
        ...ABOUT_EACH_EMAIL[email],
        optional: isOptional(email),
        receives: !isOptional(email) || !off.has(email),
      }),
    );
  }

  /**
   * Turns one of the reader's optional emails on or off. Turning off one that is always sent is
   * refused, here for the sentence and by `email_opt_out_only_optional_emails` for the guarantee.
   */
  async choose(actor: Actor, email: DirectoryEmail, receives: boolean): Promise<EmailChoice[]> {
    this.guard.enforce(directoryPolicy.chooseEmails(actor));

    const employeeId = actor.employeeId ?? '';

    if (!isOptional(email)) {
      if (!receives) {
        throw new EmailIsMandatory(email);
      }
    } else if (receives) {
      await this.preferences.turnOn(employeeId, email);
    } else {
      await this.preferences.turnOff(employeeId, email);
    }

    return this.choices(actor);
  }

  /**
   * What today brings: a welcome for each joiner and a word to their manager and team, and a
   * warning to HR for each leaver who still has people reporting to them.
   *
   * Safe to run every hour. Every message carries a dedupe key, so a second run queues
   * nothing the first did.
   */
  async sendDailyEmails(actor: Actor): Promise<DailyEmailsRun> {
    this.guard.enforce(directoryPolicy.sendDailyEmails(actor));

    const asAt = this.today();
    const everybody = await this.employees.list();
    const byId = new Map(everybody.map((one) => [one.id, one]));
    const run: DailyEmailsRun = { asAt, queued: {}, turnedOff: 0, failed: 0 };

    for (const joiner of everybody.filter((one) => this.joinedRecently(one, asAt))) {
      await this.welcome(joiner, everybody, byId, asAt, run);
    }

    const leavers = everybody.filter(
      (one) => one.exitDate !== null && warningDue(asAt, one.exitDate) !== null,
    );

    if (leavers.length > 0) {
      const hr = await this.hrStaff(byId, asAt);

      for (const leaver of leavers) {
        await this.warnAbout(leaver, everybody, hr, asAt, run);
      }
    }

    return run;
  }

  /**
   * Tells somebody their job title, department or manager has changed. Called by
   * `EmployeeService` after every change it writes; the change was authorised there.
   *
   * Nobody is told about a change they made themselves, and nobody who is not at the company
   * today is told at all: a joiner hears about their record in their welcome.
   */
  async onEmployeeChanged(actor: Actor, { before, after }: EmployeeChange): Promise<void> {
    if (isSelf(actor, after.id) || !isCurrentOn(after, this.today())) {
      return;
    }

    const changes = await this.changesWorthTelling(before, after);

    if (changes.length === 0) {
      return;
    }

    const changedBy =
      actor.employeeId === null ? undefined : await this.employees.findById(actor.employeeId);

    await this.outbox.queue(
      recordChangedEmail({
        employee: personOf(after),
        changes,
        changedBy: changedBy === undefined ? null : personOf(changedBy),
        managerChanged: before.managerId !== after.managerId,
        links: this.links,
      }),
    );
  }

  /**
   * Tells somebody they have been named as a colleague's cover. Called by leave's
   * `CoverService` through its `CoverNotifier` port, once the cover is written. #226.
   */
  async tellCover(actor: Actor, naming: CoverNaming): Promise<void> {
    const absentee = await this.employees.findById(naming.absenteeId);

    if (absentee === undefined) {
      throw new EmployeeNotFound(naming.absenteeId);
    }

    this.guard.enforce(directoryPolicy.tellCover(actor, absentee));

    const cover = await this.employees.findById(naming.coverId);

    if (cover === undefined) {
      throw new EmployeeNotFound(naming.coverId);
    }

    if ((await this.preferences.whoTurnedOff([cover.id], 'COVER_NAMED')).has(cover.id)) {
      return;
    }

    const namedBy =
      actor.employeeId === null ? absentee : await this.employees.findById(actor.employeeId);

    await this.outbox.queue(
      coverNamedEmail({
        cover: personOf(cover),
        absentee: personOf(absentee),
        namedBy: personOf(namedBy ?? absentee),
        from: naming.from,
        to: naming.to,
        reference: naming.reference,
        links: this.links,
      }),
    );
  }

  /**
   * Sends a colleague a message from their profile, and the writer a copy.
   *
   * Queued, as everything is, so the form answers at once. At most {@link MESSAGES_PER_HOUR}
   * an hour each, counted from the outbox, which is also where HR can read who wrote to whom.
   */
  async sendMessage(actor: Actor, recipientId: string, body: unknown): Promise<void> {
    const recipient = await this.employees.findById(recipientId);
    const listed = recipient !== undefined && isCurrentOn(recipient, this.today());

    this.guard.enforce(directoryPolicy.sendMessage(actor, recipientId, listed));

    if (recipient === undefined) {
      throw new EmployeeNotFound(recipientId);
    }

    const message = validateMessage(body);
    const writer = await this.employees.findById(actor.employeeId ?? '');

    if (writer === undefined) {
      throw new EmployeeNotFound(actor.employeeId ?? '');
    }

    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    /* The copies are counted too, so an hour's limit is the messages, not twice them. */
    if (
      (await this.outbox.countSentBy(writer.id, 'DIRECT_MESSAGE', anHourAgo)) >=
      MESSAGES_PER_HOUR * 2
    ) {
      throw new TooManyMessages();
    }

    const { message: toThem, copy } = directMessageEmails({
      from: personOf(writer),
      to: personOf(recipient),
      message,
      links: this.links,
    });

    const queued = await this.outbox.queue(toThem);

    if (queued.couldNotQueue !== null) {
      throw new MessageNotQueued();
    }

    await this.outbox.queue(copy);
  }

  /** Whether somebody's first day is today or a day or two ago, and they are here today. */
  private joinedRecently(employee: Employee, asAt: CalendarDate): boolean {
    const daysAgo = calendarDaysBetween(employee.startDate, asAt) - 1;

    return (
      employee.startDate <= asAt && daysAgo <= JOINER_CATCH_UP_DAYS && isCurrentOn(employee, asAt)
    );
  }

  /** The joiner, their manager, and everybody else under that manager. */
  private async welcome(
    joiner: Employee,
    everybody: readonly Employee[],
    byId: ReadonlyMap<string, Employee>,
    asAt: CalendarDate,
    run: DailyEmailsRun,
  ): Promise<void> {
    const department =
      (await this.departments.findById(joiner.departmentId))?.name ?? 'the company';
    const managerRecord = joiner.managerId === null ? undefined : byId.get(joiner.managerId);
    const manager =
      managerRecord !== undefined && isCurrentOn(managerRecord, asAt) ? managerRecord : undefined;
    const startDate = joiner.startDate;

    await this.queue(
      welcomeEmail({
        joiner: personOf(joiner),
        manager: manager === undefined ? null : personOf(manager),
        department,
        startDate,
        links: this.links,
      }),
      run,
    );

    if (manager === undefined) {
      return;
    }

    await this.queue(
      newReportEmail({
        manager: personOf(manager),
        joiner: personOf(joiner),
        department,
        startDate,
        links: this.links,
      }),
      run,
    );

    const team = everybody.filter(
      (one) => one.managerId === manager.id && one.id !== joiner.id && isCurrentOn(one, asAt),
    );
    const off = await this.preferences.whoTurnedOff(
      team.map((one) => one.id),
      'NEW_COLLEAGUE',
    );

    for (const colleague of team) {
      if (off.has(colleague.id)) {
        run.turnedOff += 1;
        continue;
      }

      await this.queue(
        newColleagueEmail({
          colleague: personOf(colleague),
          joiner: personOf(joiner),
          manager: personOf(manager),
          department,
          startDate,
          links: this.links,
        }),
        run,
      );
    }
  }

  /** Each HR member, about one leaver whose reports have not been moved yet. */
  private async warnAbout(
    leaver: Employee,
    everybody: readonly Employee[],
    hr: readonly Employee[],
    asAt: CalendarDate,
    run: DailyEmailsRun,
  ): Promise<void> {
    const exitDate = leaver.exitDate;
    const stage = exitDate === null ? null : warningDue(asAt, exitDate);

    if (exitDate === null || stage === null) {
      return;
    }

    /* The people the leaver-reports job would move: still here the day after the exit. */
    const reports = everybody.filter(
      (one) => one.managerId === leaver.id && !hasLeftBy(one, dayAfter(exitDate)),
    );

    if (reports.length === 0) {
      return;
    }

    for (const member of hr.filter((one) => one.id !== leaver.id)) {
      await this.queue(
        leaverHasReportsEmail({
          hr: personOf(member),
          leaver: personOf(leaver),
          reports: reports.map(personOf),
          exitDate,
          today: asAt,
          stage,
          links: this.links,
        }),
        run,
      );
    }
  }

  /** Everybody at the company today who staffs the HR desk. */
  private async hrStaff(
    byId: ReadonlyMap<string, Employee>,
    asAt: CalendarDate,
  ): Promise<Employee[]> {
    const ids = new Set<string>();

    for (const role of APPROVES_AS_HR) {
      for (const id of await this.roles.employeeIdsHolding(role)) {
        ids.add(id);
      }
    }

    return [...ids]
      .map((id) => byId.get(id))
      .filter((one): one is Employee => one !== undefined && isCurrentOn(one, asAt));
  }

  /** The job title, department and manager, where they moved, in words. */
  private async changesWorthTelling(before: Employee, after: Employee): Promise<ChangedField[]> {
    const changes: ChangedField[] = [];

    if (before.jobTitle !== after.jobTitle) {
      changes.push({
        label: 'Job title',
        from: before.jobTitle ?? 'none',
        to: after.jobTitle ?? 'none',
      });
    }

    if (before.departmentId !== after.departmentId) {
      const [from, to] = await Promise.all([
        this.departments.findById(before.departmentId),
        this.departments.findById(after.departmentId),
      ]);

      changes.push({ label: 'Department', from: from?.name ?? 'none', to: to?.name ?? 'none' });
    }

    if (before.managerId !== after.managerId) {
      changes.push({
        label: 'Manager',
        from: await this.nameOf(before.managerId),
        to: await this.nameOf(after.managerId),
      });
    }

    return changes;
  }

  private async nameOf(employeeId: string | null): Promise<string> {
    const found = employeeId === null ? undefined : await this.employees.findById(employeeId);

    return found === undefined ? 'nobody' : `${found.firstName} ${found.lastName}`;
  }

  /** Queues one message and counts what became of it. */
  private async queue(email: NewOutboxEmail, run: DailyEmailsRun): Promise<void> {
    const queued = await this.outbox.queue(email);
    const kind = email.kind as DirectoryEmail;

    if (queued.email !== null) {
      run.queued[kind] = (run.queued[kind] ?? 0) + 1;
    } else if (queued.couldNotQueue !== null) {
      run.failed += 1;
    }
  }
}

function personOf(employee: Employee): Person {
  return {
    id: employee.id,
    firstName: employee.firstName,
    lastName: employee.lastName,
    workEmail: employee.workEmail,
    jobTitle: employee.jobTitle,
  };
}
