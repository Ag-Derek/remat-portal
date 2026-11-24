/**
 * The clients morning notifications. #290, Clients TDD 10.
 *
 * A daily job at 07:30, every day of the week (the user, 24 November 2026). main.ts asks it every
 * minute; before 07:30 it does nothing, the first ask after that runs it, and the day is then
 * recorded, so every later ask that day does nothing. A server that was down at 07:30 runs it
 * when it is back, the same day.
 *
 * 07:30 is Accra's, which is UTC all year with no daylight saving, so the clock read is UTC's and
 * the day is `currentDate()`'s, the one "today" on the server.
 *
 * What it sends, on working mornings only:
 *
 * - **Next steps** (task 2): each owner, one email, about what is due and what has just become
 *   overdue (reminders.ts).
 * - **POC alerts** (task 3, CLI 72): each CS lead, and each lead's line manager who is a BD
 *   manager, one email about every POC newly flagged for them (poc-alerts.ts). A flag is recorded
 *   as told to a person in the transaction that queues their email; one nobody could be sent stays
 *   untold, and goes the next working morning somebody can be.
 *
 * **Missed mornings are caught up on the next run** (task 5). A server down for days sends, on
 * its first working morning back, one email per owner holding what came due or fell overdue on
 * the mornings it missed, as it stands now; and every POC flag still raised, which was never told.
 * A flag raised and cleared while it was down is not told: it has been dealt with. The very first
 * run, with none before it, catches nothing up.
 *
 * **Notifications never change anything** (task 7). The job reads deals, steps, POCs, people and
 * roles, and writes only its own record (the days it ran, the POC flags it told) and the emails it
 * queues. Its parts are typed to the read methods it uses, and an integration test runs it through
 * a week and finds every other table, the audit log included, as it was.
 *
 * **One failure does not stop the rest** (task 6, the user, 24 November 2026). An email that
 * cannot be built or queued is counted and logged, and everybody else's go; it is not tried again
 * that day, though a POC flag in it stays untold for the next working morning. A part of the run
 * that fails, next steps or POC alerts, does not stop the other; the day is then not recorded,
 * and the run is tried again 15 minutes on, sending only what had not gone. Sending itself is the
 * outbox's, which tries each email on its own, six times over thirteen hours.
 *
 * Anybody who can no longer look after their things (left, suspended, not started, or holding no
 * clients role; standing.ts) is skipped: what is theirs is on the dashboard's "Needs reassignment".
 *
 * **Running twice in one day sends nothing twice** (task 4), three ways over:
 *
 * - The day is recorded once a run finishes, and a run for a recorded day does nothing.
 * - Every email carries a dedupe key, which the outbox holds unique: a next steps email one per
 *   owner and day, a POC alerts email one per person, day and the flags it tells. A run that
 *   stopped before recording its day, or two servers running at once, queue each email once.
 * - A POC flag told to a person is recorded in the same transaction as their email, so an email is
 *   never queued without its flags recorded, nor a flag recorded that no email carries. A rerun
 *   tells each person only what was not already queued for them, a flag raised in between
 *   included.
 *
 * Like the rest of Clients it is off in production until go-live; main.ts holds that.
 */

import type { Actor } from '../../core/auth/actor.js';
import type { Guard } from '../../core/auth/policy.js';
import type { CompanyCalendar } from '../../core/calendar/company-calendar.js';
import { type CalendarDate, currentDate } from '../../core/calendar/time.js';
import { isWorkingDay, type WorkingWeek } from '../../core/calendar/working-days.js';
import type { Queued } from '../../core/notification/outbox.service.js';
import type { NewOutboxEmail } from '../../core/notification/outbox.js';
import type { EmployeeRepository } from '../../core/organisation/employee/employee.db.js';
import {
  type ClientsLinks,
  nextStepsEmail,
  NEXT_STEPS_EMAIL,
  POC_ALERTS_EMAIL,
  pocAlertsEmail,
  type Recipient,
} from './email.js';
import type { ClientsNotificationRunRepository } from './notification-run.db.js';
import type { AlertQueued, ClientsPocAlertRepository } from './poc-alerts.db.js';
import { alertsByPerson, flaggedOf, flagsIn, toldKeyOf } from './poc-alerts.js';
import type { ClientsPocRepository } from './poc.db.js';
import { clientsPolicy } from './policy.js';
import type { ClientsReminderRepository } from './reminders.db.js';
import { lastWorkingRunOf, missedMorningsOf, reminderWindowOf, remindersOf } from './reminders.js';
import type { ClientsRoleRepository } from './role.db.js';
import type { ClientsStandings } from './standing.js';

/** When in the morning the notifications go: 07:30, Accra's, which is UTC's. */
export const NOTIFY_AT = { hour: 7, minute: 30 } as const;

/** Whether the morning's run is due at `now`: from 07:30 to midnight. */
export function isTimeToNotify(now: Date): boolean {
  return now.getUTCHours() * 60 + now.getUTCMinutes() >= NOTIFY_AT.hour * 60 + NOTIFY_AT.minute;
}

/** What one kind of email did in one run. */
export interface EmailsSent {
  /** People an email was queued for. */
  emailed: number;
  /** People whose email for the day was queued already. */
  alreadyQueued: number;
  /** People whose email could not be queued. */
  couldNotQueue: number;
}

/** What the next steps part of one run did. */
export type NextStepsSent = EmailsSent & {
  /** The steps in the emails queued. */
  steps: number;
  /** Steps left out because their owner can no longer look after them. */
  skipped: number;
};

/** What the POC alerts part of one run did. */
export type PocAlertsSent = EmailsSent & {
  /** Flags newly told this morning. */
  flags: number;
  /** People left out because they can no longer look after their things. */
  skipped: number;
};

/** What one run did. */
export interface NotificationRun {
  /** The day it ran for. */
  ranFor: CalendarDate;
  ranAt: Date;
  /** False on a weekend or public holiday, when nothing is sent. */
  workingDay: boolean;
  /** The working mornings missed since the last run, folded into this one's (task 5). */
  caughtUp: CalendarDate[];
  nextSteps: NextStepsSent;
  pocAlerts: PocAlertsSent;
  /** The parts that failed (task 6). Where any did, the day is not recorded as run. */
  failed: PartFailed[];
  /** When a run with a part failed is tried again; null where none failed. */
  retryFrom: Date | null;
}

/** The two parts of a morning's run. */
export type NotificationPart = 'NEXT_STEPS' | 'POC_ALERTS';

/** A part that failed, and why. */
export interface PartFailed {
  part: NotificationPart;
  because: string;
}

/** How long after a failed run it is tried again (the user, 24 November 2026). */
export const RETRY_AFTER_MINUTES = 15;

/** What the job reads and writes through. */
export interface NotificationParts {
  runs: Pick<ClientsNotificationRunRepository, 'hasRunOn' | 'daysRunBefore' | 'record'>;
  calendar: Pick<CompanyCalendar, 'weekAround'>;
  reminders: Pick<ClientsReminderRepository, 'openStepsDueIn'>;
  pocs: Pick<ClientsPocRepository, 'running'>;
  pocAlerts: Pick<ClientsPocAlertRepository, 'toldOf' | 'queueWith'>;
  employees: Pick<EmployeeRepository, 'findAllById'>;
  grants: Pick<ClientsRoleRepository, 'live'>;
  standings: Pick<ClientsStandings, 'of'>;
  outbox: { queue(email: NewOutboxEmail): Promise<Queued> };
  /**
   * Told when a POC alert is queued straight into the outbox's table, as the outbox tells its own
   * sender, so it goes within seconds rather than at the next minute.
   */
  nudgeOutbox?: () => void;
  links: ClientsLinks;
}

export class ClientsDailyNotifications {
  constructor(
    private readonly guard: Guard,
    private readonly parts: NotificationParts,
    private readonly now: () => Date = () => new Date(),
    private readonly today: () => CalendarDate = () => currentDate(),
  ) {}

  /**
   * Runs the morning's notifications, if it is 07:30 or later and they have not run today.
   * Undefined where it did nothing, which is every ask but one a day.
   */
  async run(actor: Actor): Promise<NotificationRun | undefined> {
    this.guard.enforce(clientsPolicy.runUnattended(actor, 'dailyRun'));

    const ranAt = this.now();
    if (!isTimeToNotify(ranAt)) {
      return undefined;
    }

    /* Task 6. A run that failed is tried again 15 minutes on, not at every minute's ask. */
    if (this.retryFrom !== null && ranAt.getTime() < this.retryFrom.getTime()) {
      return undefined;
    }

    const day = this.today();
    if (await this.parts.runs.hasRunOn(day)) {
      return undefined;
    }

    try {
      return await this.runFor(day, ranAt);
    } catch (error) {
      /* Failed before either part could start, as the calendar unreadable: tried again later. */
      this.holdOff(ranAt);
      throw error;
    }
  }

  /** When a failed run may next be tried, or null where the last one did not fail. */
  private retryFrom: Date | null = null;

  private holdOff(failedAt: Date): void {
    this.retryFrom = new Date(failedAt.getTime() + RETRY_AFTER_MINUTES * 60_000);
  }

  /**
   * One part of the run, whose failure is written down and does not stop the other (task 6).
   * Null where it failed.
   */
  private async part<T>(
    part: NotificationPart,
    failed: PartFailed[],
    work: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await work();
    } catch (error) {
      failed.push({ part, because: becauseOf(error) });
      return null;
    }
  }

  private async runFor(day: CalendarDate, ranAt: Date): Promise<NotificationRun> {
    const week = await this.parts.calendar.weekAround(day);
    const workingDay = isWorkingDay(day, week);

    /* Task 5. The last working morning the job ran, and the ones missed since: their next steps
       are folded into today's emails. POC flags need nothing of the kind: a flag stays untold
       until an email carries it, so whatever is still flagged goes this morning. */
    const lastRunOn = workingDay
      ? lastWorkingRunOf(await this.parts.runs.daysRunBefore(day), week)
      : null;
    const caughtUp = workingDay ? missedMorningsOf(lastRunOn, day, week) : [];

    /* Task 6. Each part on its own: one failing does not stop the other. */
    const failed: PartFailed[] = [];
    const nextSteps = workingDay
      ? await this.part('NEXT_STEPS', failed, () => this.remindOfNextSteps(day, week, lastRunOn))
      : null;
    const pocAlerts = workingDay
      ? await this.part('POC_ALERTS', failed, () => this.alertOfPocs(day, ranAt))
      : null;

    /* The day is done only when both parts are. Otherwise it is tried again 15 minutes on, and
       what went already is not sent twice (task 4). */
    if (failed.length === 0) {
      await this.parts.runs.record(day);
      this.retryFrom = null;
    } else {
      this.holdOff(ranAt);
    }

    return {
      ranFor: day,
      ranAt,
      workingDay,
      caughtUp,
      nextSteps: { ...nothingSent(), steps: 0, skipped: 0, ...nextSteps },
      pocAlerts: { ...nothingSent(), flags: 0, skipped: 0, ...pocAlerts },
      failed,
      retryFrom: failed.length === 0 ? null : this.retryFrom,
    };
  }

  /**
   * Each owner's due and newly overdue steps on the morning of `day`, and on the mornings missed
   * since `lastRunOn`, one email each.
   */
  private async remindOfNextSteps(
    day: CalendarDate,
    week: WorkingWeek,
    lastRunOn: CalendarDate | null,
  ): Promise<NextStepsSent> {
    const sent: NextStepsSent = { ...nothingSent(), steps: 0, skipped: 0 };

    const window = reminderWindowOf(day, week, lastRunOn);
    if (window === null) {
      return sent;
    }

    const open = await this.parts.reminders.openStepsDueIn(window);
    const owners = new Map<string, Recipient>(open.map(({ owner }) => [owner.id, owner]));
    const cannot = await this.parts.standings.of(owners.keys());

    for (const steps of remindersOf(
      day,
      open.map(({ step }) => step),
    )) {
      const count = steps.due.length + steps.overdue.length;
      const owner = owners.get(steps.ownerId);

      if (owner === undefined || cannot.has(steps.ownerId)) {
        sent.skipped += count;
        continue;
      }

      /* Task 6. One email that cannot be built or queued is counted and logged, and the rest
         go. The outbox's queue never throws, but the email is built here first. */
      let queued: Queued;
      try {
        queued = await this.parts.outbox.queue(
          nextStepsEmail({ owner, day, steps, links: this.parts.links }),
        );
      } catch (error) {
        sent.couldNotQueue += 1;
        logCouldNotQueue(NEXT_STEPS_EMAIL, owner.id, error);
        continue;
      }

      if (countOf(sent, queued)) {
        sent.steps += count;
      }
    }

    return sent;
  }

  /** Every running POC's flags nobody has been told about, one email per person told. */
  private async alertOfPocs(day: CalendarDate, now: Date): Promise<PocAlertsSent> {
    const sent: PocAlertsSent = { ...nothingSent(), flags: 0, skipped: 0 };

    const flagged = flaggedOf(await this.parts.pocs.running(), now, day);
    if (flagged.length === 0) {
      return sent;
    }

    const told = await this.parts.pocAlerts.toldOf(flagged.map(({ poc }) => poc.id));

    /* Whom: each lead, and each lead's manager where that manager is a BD manager. */
    const leads = await this.parts.employees.findAllById([
      ...new Set(flagged.map(({ poc }) => poc.csLead.id)),
    ]);
    const managerOf = new Map(leads.map((lead) => [lead.id, lead.managerId]));
    const bdManagers = new Set(
      (await this.parts.grants.live())
        .filter((grant) => grant.role === 'BD_MANAGER')
        .map((grant) => grant.employeeId),
    );
    const byPerson = alertsByPerson(flagged, managerOf, bdManagers, told);
    if (byPerson.size === 0) {
      return sent;
    }

    const people = new Map(
      (await this.parts.employees.findAllById([...byPerson.keys()])).map((person) => [
        person.id,
        { id: person.id, firstName: person.firstName, workEmail: person.workEmail },
      ]),
    );
    const cannot = await this.parts.standings.of(byPerson.keys());

    /* Each flag told to somebody this morning, once however many were told it. */
    const toldNow = new Set<string>();

    for (const [personId, theirs] of byPerson) {
      const recipient = people.get(personId);

      if (recipient === undefined || cannot.has(personId)) {
        sent.skipped += 1;
        continue;
      }

      const flags = flagsIn(theirs);

      /* The email and the flags it tells them, in one transaction: both or neither. */
      let queued: AlertQueued;
      try {
        queued = await this.parts.pocAlerts.queueWith(
          pocAlertsEmail({ recipient, day, alerts: theirs, links: this.parts.links }),
          personId,
          flags,
          day,
        );
      } catch (error) {
        sent.couldNotQueue += 1;
        logCouldNotQueue(POC_ALERTS_EMAIL, personId, error);
        continue;
      }

      if (queued === 'QUEUED') {
        sent.emailed += 1;
        this.parts.nudgeOutbox?.();
      } else {
        sent.alreadyQueued += 1;
      }
      for (const flag of flags) {
        toldNow.add(toldKeyOf(flag));
      }
    }

    sent.flags = toldNow.size;

    return sent;
  }
}

/** One line of JSON on stderr for an email that could not be queued, as the outbox writes. */
function logCouldNotQueue(kind: string, recipientEmployeeId: string, error: unknown): void {
  console.error(
    JSON.stringify({
      event: 'email.undelivered',
      at: new Date().toISOString(),
      emailId: null,
      kind,
      recipientEmployeeId,
      stage: 'queue',
      because: becauseOf(error),
    }),
  );
}

function becauseOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nothingSent(): EmailsSent {
  return { emailed: 0, alreadyQueued: 0, couldNotQueue: 0 };
}

/** Counts what became of one email; true where it was queued now. */
function countOf(sent: EmailsSent, queued: Queued): boolean {
  if (queued.alreadyQueued) {
    sent.alreadyQueued += 1;
    return false;
  }
  if (queued.couldNotQueue !== null) {
    sent.couldNotQueue += 1;
    return false;
  }

  sent.emailed += 1;
  return true;
}

/** What one run did, for the log. */
export function summaryOfNotificationRun(run: NotificationRun): string {
  const head = `Clients morning notifications for ${run.ranFor}, ran at ${run.ranAt.toISOString()}.`;
  if (!run.workingDay) {
    return `${head} Not a working day, so nothing was sent.`;
  }

  const steps = run.nextSteps;
  const pocs = run.pocAlerts;

  return [
    head,
    ...(run.caughtUp.length === 0
      ? []
      : [`Caught up the missed morning(s) of ${run.caughtUp.join(', ')}.`]),
    `Next steps: ${String(steps.emailed)} owner(s) emailed about ${String(steps.steps)} step(s); ` +
      `${String(steps.skipped)} step(s) skipped, their owner unable to take them; ` +
      `${String(steps.alreadyQueued)} already queued, ${String(steps.couldNotQueue)} could not be queued.`,
    `POC alerts: ${String(pocs.flags)} new flag(s) told; ${String(pocs.emailed)} person(s) emailed; ` +
      `${String(pocs.skipped)} skipped, unable to take them; ` +
      `${String(pocs.alreadyQueued)} already queued, ${String(pocs.couldNotQueue)} could not be queued.`,
    ...run.failed.map(
      ({ part, because }) =>
        `FAILED: ${part === 'NEXT_STEPS' ? 'next steps' : 'POC alerts'}, because ${because}.`,
    ),
    ...(run.retryFrom === null
      ? []
      : [`The day is not done; it is tried again from ${run.retryFrom.toISOString()}.`]),
  ].join('\n');
}
