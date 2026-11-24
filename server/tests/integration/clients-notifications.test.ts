import type { Kysely } from 'kysely';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { seed } from '../../seeds/seed.mjs';
import { theSystem } from '../../src/core/auth/actor.js';
import { Guard } from '../../src/core/auth/policy.js';
import { CompanyCalendar } from '../../src/core/calendar/company-calendar.js';
import type { CalendarDate } from '../../src/core/calendar/time.js';
import { type Database, databaseFor } from '../../src/core/db/index.js';
import { EmailOutboxRepository } from '../../src/core/notification/outbox.db.js';
import { EmailOutbox } from '../../src/core/notification/outbox.service.js';
import { EmployeeRepository } from '../../src/core/organisation/employee/employee.db.js';
import { clientsLinks } from '../../src/apps/clients/email.js';
import { ClientsNotificationRunRepository } from '../../src/apps/clients/notification-run.db.js';
import {
  ClientsDailyNotifications,
  type NotificationParts,
} from '../../src/apps/clients/notifications.job.js';
import { ClientsReminderRepository } from '../../src/apps/clients/reminders.db.js';
import { ClientsPocRepository } from '../../src/apps/clients/poc.db.js';
import { ClientsPocAlertRepository } from '../../src/apps/clients/poc-alerts.db.js';
import { intoItsPocWithin } from '../support/clients-poc.js';
import { ClientsRoleRepository } from '../../src/apps/clients/role.db.js';
import { ClientsStandings } from '../../src/apps/clients/standing.js';
import { recordingDenials } from '../support/recording-denials.js';
import { recordingMailer } from '../support/recording-mailer.js';

/**
 * The clients morning notifications, against a real database. #290.
 *
 * Task 1: a daily job at 07:30, asked every minute, that runs once a day and records the day.
 * Task 2: each owner told the morning a next step is due, and once on the first working day it
 * is overdue.
 * Task 3: the CS lead and their BD manager told the first working morning a POC is flagged.
 * Task 4: running twice in one day, one after the other, half done, or at once, sends one set.
 * Task 5: mornings missed are caught up by the next run.
 * Task 6: one failed send, or one failed part, stops nothing else.
 * Task 7: notifications never change anything but the job's own record and the emails.
 *
 * November 2026: Wednesday the 25th, Friday the 27th, Saturday the 28th, Monday the 30th. The
 * public holidays from November on are emptied, so the week is Monday to Friday.
 */

const testDatabaseUrl = await databaseForThisFile();

let db: Kysely<Database>;
let admin: Client;
let people: Record<string, string>;
let runs: ClientsNotificationRunRepository;
let grants: ClientsRoleRepository;
/** The officer's client, a bank with a CreditStudio deal. */
let client: string;
let deal: string;

const SYSTEM = theSystem('the clients morning notifications');

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);
  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();
  runs = new ClientsNotificationRunRepository(db);
  grants = new ClientsRoleRepository(db);
});

beforeEach(async () => {
  /* Emptying `employee` with CASCADE empties the clients tables and the outbox with it. */
  people = (await seed(admin)) as Record<string, string>;
  await admin.query(`DELETE FROM holiday WHERE holiday_date >= '2026-11-01'`);
  /* Kept for good by its triggers, and not tied to anybody, so emptied on its own. */
  await admin.query('TRUNCATE clients_notification_run');

  await grants.grant(people.commercialDirector, 'BD_MANAGER', people.headOfHr, 'them');
  await grants.grant(people.officer, 'ASSOCIATE', people.headOfHr, 'them');

  client = (
    await admin.query<{ id: string }>(
      `INSERT INTO clients_client (name, type_id, owner_id)
       SELECT 'Testbank', id, $1 FROM clients_client_type WHERE name = 'Bank' RETURNING id`,
      [people.officer],
    )
  ).rows[0].id;
  deal = (
    await admin.query<{ id: string }>(
      `INSERT INTO clients_opportunity (client_id, product_id, owner_id)
       SELECT $1, id, $2 FROM clients_product WHERE name = 'CreditStudio' RETURNING id`,
      [client, people.officer],
    )
  ).rows[0].id;
});

afterAll(async () => {
  await db?.destroy();
  await admin?.end();
});

/** The job at a moment of a day, which the test moves, with any part `instead` swapped in. */
function theJobAt(
  at: { now: Date; today: CalendarDate },
  instead: Partial<NotificationParts> = {},
) {
  const guard = new Guard(recordingDenials());

  return new ClientsDailyNotifications(
    guard,
    {
      runs,
      calendar: new CompanyCalendar(db),
      reminders: new ClientsReminderRepository(db),
      pocs: new ClientsPocRepository(db),
      pocAlerts: new ClientsPocAlertRepository(db),
      employees: new EmployeeRepository(db),
      grants,
      standings: new ClientsStandings(grants, new EmployeeRepository(db), () => at.today),
      outbox: new EmailOutbox(new EmailOutboxRepository(db), recordingMailer(), guard),
      links: clientsLinks('http://portal.test'),
      ...instead,
    },
    () => at.now,
    () => at.today,
  );
}

/** The morning of `day`, at 07:30. */
function morningOf(day: CalendarDate) {
  return { now: new Date(`${day}T07:30:00Z`), today: day };
}

async function daysRun(): Promise<string[]> {
  const { rows } = await admin.query<{ run_on: string }>(
    'SELECT run_on::text FROM clients_notification_run ORDER BY run_on',
  );
  return rows.map((row) => row.run_on);
}

/** An open step of the officer's, about the deal or, with `aboutDeal` false, the client. */
async function aStep(
  dueOn: CalendarDate,
  description: string,
  options: { aboutDeal?: boolean; closed?: boolean } = {},
): Promise<void> {
  await admin.query(
    `INSERT INTO clients_next_step
            (client_id, opportunity_id, description, due_on, owner_id, source, created_by,
             done_at, done_by)
     VALUES ($1, $2, $3, $4, $5, 'MANUAL', $5,
             CASE WHEN $6 THEN now() END, CASE WHEN $6 THEN $5::bigint END)`,
    [
      client,
      options.aboutDeal === false ? null : deal,
      description,
      dueOn,
      people.officer,
      options.closed === true,
    ],
  );
}

async function emailsSent(): Promise<
  { to_address: string; subject: string; text_body: string; dedupe_key: string }[]
> {
  const { rows } = await admin.query<{
    to_address: string;
    subject: string;
    text_body: string;
    dedupe_key: string;
  }>(
    `SELECT to_address, subject, text_body, dedupe_key FROM email_outbox
      WHERE kind = 'CLIENTS_NEXT_STEPS' ORDER BY id`,
  );
  return rows;
}

async function workEmailOf(employeeId: string): Promise<string> {
  return (
    await admin.query<{ work_email: string }>('SELECT work_email FROM employee WHERE id = $1', [
      employeeId,
    ])
  ).rows[0].work_email;
}

describe('the daily job at 07:30', () => {
  it('does nothing before 07:30', async () => {
    const job = theJobAt({ now: new Date('2026-11-24T07:29:00Z'), today: '2026-11-24' });

    expect(await job.run(SYSTEM)).toBeUndefined();
    expect(await daysRun()).toEqual([]);
  });

  it('runs at 07:30, once however often it is asked, and again the next morning', async () => {
    const at = morningOf('2026-11-24');
    const job = theJobAt(at);

    expect((await job.run(SYSTEM))?.ranFor).toBe('2026-11-24');

    for (const time of ['07:31', '12:00', '23:59']) {
      at.now = new Date(`2026-11-24T${time}:00Z`);
      expect(await job.run(SYSTEM)).toBeUndefined();
    }

    at.now = new Date('2026-11-25T07:29:00Z');
    at.today = '2026-11-25';
    expect(await job.run(SYSTEM)).toBeUndefined();

    at.now = new Date('2026-11-25T07:30:00Z');
    expect((await job.run(SYSTEM))?.ranFor).toBe('2026-11-25');

    expect(await daysRun()).toEqual(['2026-11-24', '2026-11-25']);
  });

  it('records a day twice as once', async () => {
    await runs.record('2026-11-24');
    await runs.record('2026-11-24');

    expect(await daysRun()).toEqual(['2026-11-24']);
    expect(await runs.hasRunOn('2026-11-24')).toBe(true);
    expect(await runs.hasRunOn('2026-11-25')).toBe(false);
  });
});

describe('the next steps reminded of', () => {
  it('on a Friday: today’s and the weekend’s as due, Thursday’s as overdue, in one email', async () => {
    await aStep('2026-11-27', 'Send the revised proposal');
    await aStep('2026-11-28', 'Call the CFO', { aboutDeal: false });
    await aStep('2026-11-26', 'Collect the signed NDA');
    /* Not this morning: overdue since Thursday, due next week, or done. */
    await aStep('2026-11-25', 'Already reminded on Thursday');
    await aStep('2026-11-30', 'Monday’s business');
    await aStep('2026-11-27', 'Done already', { closed: true });

    const run = await theJobAt(morningOf('2026-11-27')).run(SYSTEM);

    expect(run?.nextSteps).toEqual({
      emailed: 1,
      steps: 3,
      skipped: 0,
      alreadyQueued: 0,
      couldNotQueue: 0,
    });

    const [email, ...others] = await emailsSent();
    expect(others).toEqual([]);
    expect(email.to_address).toBe(await workEmailOf(people.officer));
    expect(email.subject).toBe('Your next steps: 2 due, 1 overdue');
    expect(email.dedupe_key).toBe(`CLIENTS_NEXT_STEPS:${people.officer}:2026-11-27`);
    expect(email.text_body).toContain(
      'Due today: Testbank · CreditStudio: Send the revised proposal',
    );
    expect(email.text_body).toContain('Due 28 November 2026: Testbank: Call the CFO');
    expect(email.text_body).toContain(
      'Overdue, was due 26 November 2026: Testbank · CreditStudio: Collect the signed NDA',
    );
    expect(email.text_body).not.toMatch(/Already reminded|Monday’s business|Done already/);
  });

  it('on the Monday: Friday’s and the weekend’s, overdue for the first working day', async () => {
    await aStep('2026-11-27', 'Send the revised proposal');
    await aStep('2026-11-28', 'Call the CFO');
    await aStep('2026-11-30', 'Book the demo');

    await theJobAt(morningOf('2026-11-30')).run(SYSTEM);

    const [email] = await emailsSent();
    expect(email.subject).toBe('Your next steps: 1 due, 2 overdue');
  });

  it('a public holiday is a day off: Wednesday carries Thursday’s, and Friday finds it overdue', async () => {
    await admin.query(
      `INSERT INTO holiday (name, holiday_date) VALUES ('A holiday', '2026-11-26')`,
    );
    await aStep('2026-11-26', 'Send the revised proposal');

    await theJobAt(morningOf('2026-11-25')).run(SYSTEM);
    await theJobAt(morningOf('2026-11-27')).run(SYSTEM);

    expect((await emailsSent()).map((email) => email.subject)).toEqual([
      'Your next steps: 1 due',
      'Your next steps: 1 overdue',
    ]);
  });

  it('nothing on a weekend', async () => {
    await aStep('2026-11-28', 'Call the CFO');

    expect((await theJobAt(morningOf('2026-11-28')).run(SYSTEM))?.nextSteps.emailed).toBe(0);
    expect(await emailsSent()).toEqual([]);
  });

  it('skips an owner who no longer holds a clients role', async () => {
    await aStep('2026-11-27', 'Send the revised proposal');
    await admin.query(
      `UPDATE clients_role SET ended_at = now(), ended_by = $2, ended_reason = 'REVOKED'
        WHERE employee_id = $1`,
      [people.officer, people.headOfHr],
    );

    const run = await theJobAt(morningOf('2026-11-27')).run(SYSTEM);

    expect(run?.nextSteps).toMatchObject({ emailed: 0, skipped: 1 });
    expect(await emailsSent()).toEqual([]);
  });
});

/* ---------------------------------------------------------- task 3: POC alerts */

/** The officer's deal, or `dealId`, into a POC started 17 September: decided by Thursday the 26th. */
async function aPocPastItsDecision(dealId = deal): Promise<string> {
  await admin.query('BEGIN');
  try {
    const poc = await intoItsPocWithin(admin, dealId, `'2026-09-17'::date`);
    await admin.query('COMMIT');
    /* Used well, so its decision date is its one flag. */
    await admin.query(
      `INSERT INTO clients_poc_usage (poc_id, measured_on, enrolled, active, recorded_by)
       VALUES ($1, '2026-11-20', 10, 8, $2)`,
      [poc, people.officer],
    );
    return poc;
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}

async function pocAlertsSent(): Promise<{ to_address: string; subject: string }[]> {
  const { rows } = await admin.query<{ to_address: string; subject: string }>(
    `SELECT to_address, subject FROM email_outbox
      WHERE kind = 'CLIENTS_POC_ALERTS' ORDER BY id`,
  );
  return rows;
}

describe('the POC alerts', () => {
  beforeEach(async () => {
    /* The officer reports to the commercial director, who is a BD manager. */
    await admin.query('UPDATE employee SET manager_id = $2 WHERE id = $1', [
      people.officer,
      people.commercialDirector,
    ]);
  });

  it('tell the CS lead and their BD manager, once, the first working morning it is flagged', async () => {
    const poc = await aPocPastItsDecision();

    const run = await theJobAt(morningOf('2026-11-27')).run(SYSTEM);

    expect(run?.pocAlerts).toMatchObject({ flags: 1, emailed: 2, skipped: 0 });
    expect(await pocAlertsSent()).toEqual([
      {
        to_address: await workEmailOf(people.officer),
        subject: 'POC alert: Testbank · CreditStudio needs attention',
      },
      {
        to_address: await workEmailOf(people.commercialDirector),
        subject: 'POC alert: Testbank · CreditStudio needs attention',
      },
    ]);

    const { rows } = await admin.query<{
      poc_id: string;
      flag: string;
      recipient_id: string;
      alerted_on: string;
    }>(
      `SELECT poc_id, flag, recipient_id, alerted_on::text FROM clients_poc_alert
        ORDER BY recipient_id`,
    );
    expect(rows).toEqual(
      [people.officer, people.commercialDirector]
        .map((recipient) => ({
          poc_id: poc,
          flag: 'PAST_DECISION',
          recipient_id: recipient,
          alerted_on: '2026-11-27',
        }))
        .sort((one, other) => Number(one.recipient_id) - Number(other.recipient_id)),
    );

    /* Monday: still past its date, and nobody is told again. */
    expect((await theJobAt(morningOf('2026-11-30')).run(SYSTEM))?.pocAlerts.flags).toBe(0);
    expect(await pocAlertsSent()).toHaveLength(2);
  });

  it('only the CS lead, where their manager is not a BD manager', async () => {
    await admin.query('UPDATE employee SET manager_id = $2 WHERE id = $1', [
      people.officer,
      people.headOfHr,
    ]);
    await aPocPastItsDecision();

    await theJobAt(morningOf('2026-11-27')).run(SYSTEM);

    expect((await pocAlertsSent()).map((email) => email.to_address)).toEqual([
      await workEmailOf(people.officer),
    ]);
  });

  it('nothing on a weekend, and Monday tells it', async () => {
    await aPocPastItsDecision();

    await theJobAt(morningOf('2026-11-28')).run(SYSTEM);
    expect(await pocAlertsSent()).toEqual([]);

    expect((await theJobAt(morningOf('2026-11-30')).run(SYSTEM))?.pocAlerts.flags).toBe(1);
  });

  it('change nothing about the POC', async () => {
    const poc = await aPocPastItsDecision();
    const before = await admin.query('SELECT * FROM clients_poc WHERE id = $1', [poc]);

    await theJobAt(morningOf('2026-11-27')).run(SYSTEM);

    expect((await admin.query('SELECT * FROM clients_poc WHERE id = $1', [poc])).rows).toEqual(
      before.rows,
    );
  });
});

/* ----------------------------------------------------- task 4: run twice, sent once */

/** Every email in the outbox, of either kind, as who it went to and what it was. */
async function everyEmail(): Promise<string[]> {
  const { rows } = await admin.query<{ kind: string; to_address: string }>(
    'SELECT kind, to_address FROM email_outbox ORDER BY id',
  );
  return rows.map((row) => `${row.kind} to ${row.to_address}`);
}

async function alertsRecorded(): Promise<number> {
  return (await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM clients_poc_alert'))
    .rows[0].n;
}

describe('running twice in one day', () => {
  /** A Friday with something of each: a step due, and a POC past its decision date. */
  let friday: { now: Date; today: CalendarDate };
  let firstRun: string[];

  beforeEach(async () => {
    await admin.query('UPDATE employee SET manager_id = $2 WHERE id = $1', [
      people.officer,
      people.commercialDirector,
    ]);
    await aStep('2026-11-27', 'Send the revised proposal');
    await aPocPastItsDecision();
    friday = morningOf('2026-11-27');
    firstRun = [
      `CLIENTS_NEXT_STEPS to ${await workEmailOf(people.officer)}`,
      `CLIENTS_POC_ALERTS to ${await workEmailOf(people.officer)}`,
      `CLIENTS_POC_ALERTS to ${await workEmailOf(people.commercialDirector)}`,
    ];
  });

  it('sends one set: a second run that morning, or that afternoon, sends nothing', async () => {
    await theJobAt(friday).run(SYSTEM);
    expect(await everyEmail()).toEqual(firstRun);

    expect(await theJobAt({ ...friday, now: new Date('2026-11-27T07:31:00Z') }).run(SYSTEM)).toBe(
      undefined,
    );
    expect(await theJobAt({ ...friday, now: new Date('2026-11-27T16:00:00Z') }).run(SYSTEM)).toBe(
      undefined,
    );

    expect(await everyEmail()).toEqual(firstRun);
    expect(await alertsRecorded()).toBe(2);
  });

  it('a run that stopped before recording its day, run again, sends nothing it sent', async () => {
    const stopped = theJobAt(friday, {
      runs: {
        hasRunOn: (day) => runs.hasRunOn(day),
        daysRunBefore: (day) => runs.daysRunBefore(day),
        record: () => Promise.reject(new Error('The server stopped.')),
      },
    });
    await expect(stopped.run(SYSTEM)).rejects.toThrow('The server stopped.');
    expect(await everyEmail()).toEqual(firstRun);
    expect(await daysRun()).toEqual([]);

    const again = await theJobAt(friday).run(SYSTEM);

    expect(again?.nextSteps).toMatchObject({ emailed: 0, alreadyQueued: 1 });
    expect(again?.pocAlerts).toMatchObject({ flags: 0, emailed: 0 });
    expect(await everyEmail()).toEqual(firstRun);
    expect(await daysRun()).toEqual(['2026-11-27']);
  });

  it('a run stopped between the CS lead and their BD manager, run again, tells only the manager', async () => {
    const repository = new ClientsPocAlertRepository(db);
    let calls = 0;
    const stopped = theJobAt(friday, {
      runs: {
        hasRunOn: (day) => runs.hasRunOn(day),
        daysRunBefore: (day) => runs.daysRunBefore(day),
        record: () => Promise.reject(new Error('The server stopped.')),
      },
      pocAlerts: {
        toldOf: (ids) => repository.toldOf(ids),
        /* The lead's goes; the server stops before the manager's. */
        queueWith: (...args) => {
          calls += 1;
          return calls === 1
            ? repository.queueWith(...args)
            : Promise.reject(new Error('The server stopped.'));
        },
      },
    });
    await expect(stopped.run(SYSTEM)).rejects.toThrow('The server stopped.');
    expect(await everyEmail()).toEqual(firstRun.slice(0, 2));
    expect(await alertsRecorded()).toBe(1);

    const again = await theJobAt(friday).run(SYSTEM);

    expect(again?.pocAlerts).toMatchObject({ flags: 1, emailed: 1, alreadyQueued: 0 });
    expect(await everyEmail()).toEqual(firstRun);
    expect(await alertsRecorded()).toBe(2);
  });

  it('a flag raised between a stopped run and its rerun is still told, and only it', async () => {
    const stopped = theJobAt(friday, {
      runs: {
        hasRunOn: (day) => runs.hasRunOn(day),
        daysRunBefore: (day) => runs.daysRunBefore(day),
        record: () => Promise.reject(new Error('The server stopped.')),
      },
    });
    await expect(stopped.run(SYSTEM)).rejects.toThrow('The server stopped.');
    expect(await everyEmail()).toEqual(firstRun);

    /* Before the rerun, a second of the officer's POCs is past its decision date. */
    const agrobank = (
      await admin.query<{ id: string }>(
        `INSERT INTO clients_client (name, type_id, owner_id)
         SELECT 'Agrobank', id, $1 FROM clients_client_type WHERE name = 'Bank' RETURNING id`,
        [people.officer],
      )
    ).rows[0].id;
    const itsDeal = (
      await admin.query<{ id: string }>(
        `INSERT INTO clients_opportunity (client_id, product_id, owner_id)
         SELECT $1, id, $2 FROM clients_product WHERE name = 'CreditStudio' RETURNING id`,
        [agrobank, people.officer],
      )
    ).rows[0].id;
    await aPocPastItsDecision(itsDeal);

    const again = await theJobAt(friday).run(SYSTEM);

    expect(again?.pocAlerts).toMatchObject({ flags: 1, emailed: 2 });
    expect((await pocAlertsSent()).map((email) => email.subject)).toEqual([
      'POC alert: Testbank · CreditStudio needs attention',
      'POC alert: Testbank · CreditStudio needs attention',
      'POC alert: Agrobank · CreditStudio needs attention',
      'POC alert: Agrobank · CreditStudio needs attention',
    ]);
    expect(await alertsRecorded()).toBe(4);
  });

  it('two runs at once, as two servers would, send one set', async () => {
    await Promise.all([theJobAt(friday).run(SYSTEM), theJobAt(friday).run(SYSTEM)]);

    expect((await everyEmail()).sort()).toEqual([...firstRun].sort());
    expect(await alertsRecorded()).toBe(2);
    expect(await daysRun()).toEqual(['2026-11-27']);
  });
});

/* ------------------------------------------------- task 5: missed days caught up */

describe('missed mornings', () => {
  /* Done when: after two days without a run, the next run sends what was missed. */
  it('after two days without a run, the next run sends what was missed', async () => {
    await aStep('2026-11-20', 'Told on Monday, overdue since');
    await aStep('2026-11-23', 'Due Monday');
    await aStep('2026-11-24', 'Due on the missed Tuesday');
    await aStep('2026-11-25', 'Due on the missed Wednesday');
    await aStep('2026-11-26', 'Due Thursday');

    /* Monday runs; Tuesday and Wednesday do not; Thursday does. */
    await theJobAt(morningOf('2026-11-23')).run(SYSTEM);
    const thursday = await theJobAt(morningOf('2026-11-26')).run(SYSTEM);

    expect(thursday?.caughtUp).toEqual(['2026-11-24', '2026-11-25']);

    const [monday, caughtUp, ...others] = await emailsSent();
    expect(others).toEqual([]);
    expect(monday.subject).toBe('Your next steps: 1 due, 1 overdue');
    expect(caughtUp.subject).toBe('Your next steps: 1 due, 3 overdue');
    expect(caughtUp.text_body).toContain('Overdue, was due 23 November 2026');
    expect(caughtUp.text_body).toContain('Overdue, was due 24 November 2026');
    expect(caughtUp.text_body).toContain('Overdue, was due 25 November 2026');
    expect(caughtUp.text_body).toContain('Due today: Testbank · CreditStudio: Due Thursday');
    expect(caughtUp.text_body).not.toContain('Told on Monday');
    expect(await daysRun()).toEqual(['2026-11-23', '2026-11-26']);
  });

  it('a weekend run between does not hide the working mornings missed before it', async () => {
    await aStep('2026-11-27', 'Due on the missed Friday');

    await theJobAt(morningOf('2026-11-26')).run(SYSTEM);
    await theJobAt(morningOf('2026-11-28')).run(SYSTEM);
    const monday = await theJobAt(morningOf('2026-11-30')).run(SYSTEM);

    expect(monday?.caughtUp).toEqual(['2026-11-27']);
    expect((await emailsSent()).map((email) => email.subject)).toEqual([
      'Your next steps: 1 overdue',
    ]);
  });
});

/* ------------------------------------------- task 6: one failure stops nothing else */

describe('one failed send', () => {
  it('does not stop the rest, and the one it could not tell is told when it can be', async () => {
    await admin.query('UPDATE employee SET manager_id = $2 WHERE id = $1', [
      people.officer,
      people.commercialDirector,
    ]);
    await aStep('2026-11-27', 'Send the revised proposal');
    await aPocPastItsDecision();

    /* The BD manager's address on file is not one an email can go to. */
    const address = await workEmailOf(people.commercialDirector);
    await admin.query(`UPDATE employee SET work_email = 'not an address' WHERE id = $1`, [
      people.commercialDirector,
    ]);

    const friday = await theJobAt(morningOf('2026-11-27')).run(SYSTEM);

    expect(friday?.nextSteps).toMatchObject({ emailed: 1, couldNotQueue: 0 });
    expect(friday?.pocAlerts).toMatchObject({ emailed: 1, couldNotQueue: 1 });
    expect(friday?.failed).toEqual([]);
    expect(await everyEmail()).toEqual([
      `CLIENTS_NEXT_STEPS to ${await workEmailOf(people.officer)}`,
      `CLIENTS_POC_ALERTS to ${await workEmailOf(people.officer)}`,
    ]);

    /* Put right by Monday: the manager is told then, and the lead not again. */
    await admin.query('UPDATE employee SET work_email = $2 WHERE id = $1', [
      people.commercialDirector,
      address,
    ]);
    const monday = await theJobAt(morningOf('2026-11-30')).run(SYSTEM);

    expect(monday?.pocAlerts).toMatchObject({ flags: 1, emailed: 1 });
    expect((await everyEmail()).at(-1)).toBe(`CLIENTS_POC_ALERTS to ${address}`);
  });

  it('a part that fails leaves the other to send, and the day to be tried again', async () => {
    await aStep('2026-11-27', 'Send the revised proposal');
    await aPocPastItsDecision();

    const at = morningOf('2026-11-27');
    let stepsFail = true;
    const reminders = new ClientsReminderRepository(db);
    const job = theJobAt(at, {
      reminders: {
        openStepsDueIn: (window) =>
          stepsFail
            ? Promise.reject(new Error('The next steps cannot be read.'))
            : reminders.openStepsDueIn(window),
      },
    });

    const first = await job.run(SYSTEM);

    expect(first?.failed.map((one) => one.part)).toEqual(['NEXT_STEPS']);
    expect(await everyEmail()).toEqual([
      `CLIENTS_POC_ALERTS to ${await workEmailOf(people.officer)}`,
    ]);
    expect(await daysRun()).toEqual([]);

    stepsFail = false;
    at.now = new Date('2026-11-27T07:45:00Z');
    await job.run(SYSTEM);

    expect(await everyEmail()).toEqual([
      `CLIENTS_POC_ALERTS to ${await workEmailOf(people.officer)}`,
      `CLIENTS_NEXT_STEPS to ${await workEmailOf(people.officer)}`,
    ]);
    expect(await daysRun()).toEqual(['2026-11-27']);
  });
});

/* ------------------------------------------------ task 7: notifications change nothing */

/** The tables the job writes: its own day log, its POC alert log, and the emails it queues. */
const THE_JOBS_OWN = ['clients_notification_run', 'clients_poc_alert', 'email_outbox'];

/** Every other table in the database, each as a fingerprint of every row it holds. */
async function everythingElse(): Promise<Record<string, string>> {
  const { rows: tables } = await admin.query<{ name: string }>(
    `SELECT tablename AS name FROM pg_tables
      WHERE schemaname = 'public' AND NOT (tablename = ANY($1)) ORDER BY tablename`,
    [THE_JOBS_OWN],
  );

  const fingerprints: Record<string, string> = {};
  for (const { name } of tables) {
    const { rows } = await admin.query<{ rows: number; fingerprint: string | null }>(
      `SELECT count(*)::int AS rows, md5(string_agg(t::text, '|' ORDER BY t::text)) AS fingerprint
         FROM "${name}" t`,
    );
    fingerprints[name] = `${String(rows[0].rows)}:${rows[0].fingerprint ?? 'empty'}`;
  }

  return fingerprints;
}

describe('the notifications', () => {
  /* Task 7: notifications never change anything. */
  it('never change anything: every table but the job’s own is as it was', async () => {
    await admin.query('UPDATE employee SET manager_id = $2 WHERE id = $1', [
      people.officer,
      people.commercialDirector,
    ]);

    /* Something of everything the job reads. */
    await aStep('2026-11-20', 'Long overdue');
    await aStep('2026-11-26', 'Due Thursday');
    await aStep('2026-11-27', 'Due Friday', { aboutDeal: false });
    await aStep('2026-11-28', 'Due Saturday');
    await aStep('2026-11-27', 'Done already', { closed: true });
    const poc = await aPocPastItsDecision();
    /* At Risk for days with nothing written, as well as past its decision date. */
    await admin.query(
      `INSERT INTO clients_poc_health (poc_id, health, set_by, set_at)
       VALUES ($1, 'AT_RISK', $2, '2026-11-23T09:00:00Z')`,
      [poc, people.officer],
    );
    /* A step whose owner no longer holds a role, so is skipped. */
    await grants.grant(people.headOfHr, 'ASSOCIATE', people.commercialDirector, 'them');
    await admin.query(
      `INSERT INTO clients_next_step (client_id, description, due_on, owner_id, source, created_by)
       VALUES ($1, 'Theirs', '2026-11-27', $2, 'MANUAL', $2)`,
      [client, people.headOfHr],
    );
    await admin.query(
      `UPDATE clients_role SET ended_at = now(), ended_by = $2, ended_reason = 'REVOKED'
        WHERE employee_id = $1`,
      [people.headOfHr, people.commercialDirector],
    );

    const before = await everythingElse();
    /* What is compared is what the job reads, and the audit log, each with rows in. */
    for (const table of ['clients_next_step', 'clients_poc', 'clients_poc_health', 'audit_log']) {
      expect(before[table]).toMatch(/^[1-9]\d*:[0-9a-f]{32}$/);
    }

    /* Wednesday; Thursday missed; Friday, with a part failing and tried again; a Saturday;
       Monday. */
    await theJobAt(morningOf('2026-11-25')).run(SYSTEM);
    const friday = morningOf('2026-11-27');
    let stepsFail = true;
    const reminders = new ClientsReminderRepository(db);
    const job = theJobAt(friday, {
      reminders: {
        openStepsDueIn: (window) =>
          stepsFail
            ? Promise.reject(new Error('The next steps cannot be read.'))
            : reminders.openStepsDueIn(window),
      },
    });
    await job.run(SYSTEM);
    stepsFail = false;
    friday.now = new Date('2026-11-27T07:45:00Z');
    await job.run(SYSTEM);
    await theJobAt(morningOf('2026-11-28')).run(SYSTEM);
    await theJobAt(morningOf('2026-11-30')).run(SYSTEM);

    /* It did its work... */
    expect((await everyEmail()).length).toBeGreaterThanOrEqual(4);
    expect(await alertsRecorded()).toBeGreaterThan(0);
    expect(await daysRun()).toEqual(['2026-11-25', '2026-11-27', '2026-11-28', '2026-11-30']);

    /* ...and touched nothing else, the audit log included. */
    expect(await everythingElse()).toEqual(before);
  });
});
