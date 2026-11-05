import { Client } from 'pg';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { type Actor, signedInAs, theSystem } from '../../src/core/auth/actor.js';
import { Guard } from '../../src/core/auth/policy.js';
import { databaseFor } from '../../src/core/db/index.js';
import type { Database } from '../../src/core/db/schema.js';
import { DepartmentRepository } from '../../src/core/organisation/department/department.db.js';
import { EmployeeRepository } from '../../src/core/organisation/employee/employee.db.js';
import { noLeaveFollows } from '../../src/core/organisation/employee/employee.js';
import { EmployeeService } from '../../src/core/organisation/employee/employee.service.js';
import { RoleRepository } from '../../src/core/identity/role/role.db.js';
import { WorkPatternRepository } from '../../src/core/calendar/work-pattern/work-pattern.db.js';
import type { Mailer } from '../../src/core/notification/mailer.js';
import { EmailOutboxRepository } from '../../src/core/notification/outbox.db.js';
import {
  EmailOutbox,
  type OutboxLog,
  type UndeliveredEmail,
} from '../../src/core/notification/outbox.service.js';
import type { NewOutboxEmail } from '../../src/core/notification/outbox.js';
import { EmailPreferenceRepository } from '../../src/apps/directory/email.db.js';
import { DirectoryEmailService } from '../../src/apps/directory/email.service.js';
import { EmailIsMandatory, OPTIONAL_EMAILS, portalLinks } from '../../src/apps/directory/email.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { recordingDenials } from '../support/recording-denials.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * The directory's emails, against a real database.
 *
 * The three things the story is done when:
 *
 *   **A new joiner gets a welcome email on their start date**, and their manager and team are
 *   told, each once however often the job runs.
 *
 *   **A failed send is retried and logged**, on a backoff, until it is sent or six attempts
 *   have failed, and every failure is written down.
 *
 *   **No real emails go out from development** is ../unit/mail-safety.test.ts, since it is a
 *   question about the environment rather than the database.
 *
 * And the rest of what it asked for: a save never waits on the mail server, every email is a
 * row in the log, and a mandatory email cannot be turned off by any connection.
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('email integration fixtures');

/** A Monday, and the joiner's first day. */
const START = '2026-11-02';

let db: Kysely<Database>;
let admin: Client;
let people: Record<string, string>;
let mailer: ReturnType<typeof recordingMailer>;
let failures: UndeliveredEmail[];
let outbox: EmailOutbox;
let emails: DirectoryEmailService;
let today: string;

const log: OutboxLog = {
  record(failure) {
    failures.push(failure);
  },
};

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);
  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();
});

beforeEach(async () => {
  /* Emptying `employee` with CASCADE empties the outbox and the opt-outs with it. */
  people = (await seed(admin)) as Record<string, string>;

  mailer = recordingMailer();
  failures = [];
  today = START;

  const guard = new Guard(recordingDenials());

  outbox = new EmailOutbox(new EmailOutboxRepository(db), mailer, guard, log);
  emails = new DirectoryEmailService(
    guard,
    new EmployeeRepository(db),
    new DepartmentRepository(db),
    new RoleRepository(db),
    new EmailPreferenceRepository(db),
    outbox,
    portalLinks('http://portal.test'),
    () => today,
  );
});

afterAll(async () => {
  await db?.destroy();
  await admin?.end();
});

/** What the outbox holds, oldest first. */
async function outboxRows(kind?: string): Promise<Record<string, unknown>[]> {
  const { rows } = await admin.query(
    `SELECT * FROM email_outbox ${kind === undefined ? '' : 'WHERE kind = $1'} ORDER BY id`,
    kind === undefined ? [] : [kind],
  );

  return rows;
}

/** When a drain runs, for a row queued just now. Whole seconds, so it reads back unchanged. */
function anHourFromNow(): Date {
  return new Date(Math.ceil(Date.now() / 1000) * 1000 + 60 * 60_000);
}

const ONE: NewOutboxEmail = {
  kind: 'WELCOME',
  recipientEmployeeId: null,
  to: 'esi.appiah@rematholdings.com',
  fromName: 'Ama Mensah via Remat Portal',
  replyTo: 'ama.mensah@rematholdings.com',
  subject: 'Welcome to Remat, Esi',
  text: 'Hello Esi,',
  html: '<p>Hello Esi,</p>',
};

/** A joiner starting on START under Kofi, beside Adwoa and Abena. */
async function addAJoiner(): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO employee (
       employee_number, first_name, last_name, work_email, job_title,
       department_id, manager_id, work_pattern_id, start_date
     )
     SELECT 'RH-0099', 'Esi', 'Appiah', 'esi.appiah@rematholdings.com', 'Operations Officer',
            department_id, id, work_pattern_id, $2
       FROM employee WHERE id = $1
     RETURNING id`,
    [people.teamLead, START],
  );

  return rows[0].id;
}

describe('the queue', () => {
  it('writes a row and returns, sending nothing, however slow the mail server is', async () => {
    let asked = 0;
    const stuck: Mailer = {
      send: () => {
        asked += 1;
        return new Promise(() => {});
      },
      close() {},
    };
    const slow = new EmailOutbox(new EmailOutboxRepository(db), stuck, new Guard(), log);

    const started = Date.now();
    const queued = await slow.queue(ONE);

    expect(Date.now() - started).toBeLessThan(2000);
    expect(asked).toBe(0);
    expect(queued.email?.status).toBe('QUEUED');
    expect((await outboxRows())[0]).toMatchObject({ status: 'QUEUED', attempts: 0 });
  });

  it('is sent by the job, as the person’s name from the system address, and logged as sent', async () => {
    await outbox.queue(ONE);

    const run = await outbox.drain(system);

    expect(run.attempted).toHaveLength(1);
    expect(mailer.last()).toMatchObject({
      to: ONE.to,
      subject: ONE.subject,
      text: ONE.text,
      html: ONE.html,
      fromName: 'Ama Mensah via Remat Portal',
      replyTo: 'ama.mensah@rematholdings.com',
    });

    const [row] = await outboxRows();

    expect(row).toMatchObject({
      status: 'SENT',
      attempts: 1,
      delivered_to: ONE.to,
      next_attempt_at: null,
    });
    expect(row.sent_at).toBeInstanceOf(Date);
  });

  it('queues a message with a dedupe key once, however many times it is asked', async () => {
    const first = await outbox.queue({ ...ONE, dedupeKey: 'WELCOME:1:2026-11-02' });
    const second = await outbox.queue({ ...ONE, dedupeKey: 'WELCOME:1:2026-11-02' });

    expect(first.alreadyQueued).toBe(false);
    expect(second).toMatchObject({ email: null, alreadyQueued: true, couldNotQueue: null });
    expect(await outboxRows()).toHaveLength(1);
  });

  it('sends one message once when two runs drain at the same moment', async () => {
    await outbox.queue(ONE);

    await Promise.all([outbox.drain(system), outbox.drain(system)]);

    expect(mailer.sent).toHaveLength(1);
  });

  it('is the job’s to drain, and nobody else’s', async () => {
    const somebody = signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });

    await expect(outbox.drain(somebody)).rejects.toThrow();
  });
});

describe('a send that fails', () => {
  it('is retried a minute later, and the failure is logged', async () => {
    await outbox.queue(ONE);
    /* After the queueing, which stamps the row due now. A fixed date stops being after it. */
    const failedAt = anHourFromNow();
    const aMinuteLater = new Date(failedAt.getTime() + 60_000);

    mailer.failNext(new Error('SMTP is not answering.'));
    await outbox.drain(system, failedAt);

    expect(failures).toEqual([
      expect.objectContaining({
        stage: 'send',
        kind: 'WELCOME',
        attempt: 1,
        because: 'SMTP is not answering.',
        tryingAgainAt: aMinuteLater,
      }),
    ]);
    expect((await outboxRows())[0]).toMatchObject({
      status: 'QUEUED',
      attempts: 1,
      last_error: 'SMTP is not answering.',
      next_attempt_at: aMinuteLater,
    });

    /* Not yet due. */
    expect((await outbox.drain(system, new Date(failedAt.getTime() + 30_000))).attempted).toEqual(
      [],
    );

    await outbox.drain(system, aMinuteLater);

    expect(mailer.sent).toHaveLength(1);
    expect((await outboxRows())[0]).toMatchObject({ status: 'SENT', attempts: 2 });
  });

  it('is given up on after six attempts, and the log says so', async () => {
    const broken: Mailer = {
      send: () => Promise.reject(new Error('550 Mailbox unavailable')),
      close() {},
    };
    const failing = new EmailOutbox(new EmailOutboxRepository(db), broken, new Guard(), log);

    await failing.queue(ONE);

    /* A day apart, so each is due whatever its backoff. */
    const first = anHourFromNow();
    for (let day = 0; day < 8; day += 1) {
      await failing.drain(system, new Date(first.getTime() + day * 24 * 60 * 60_000));
    }

    const [row] = await outboxRows();

    expect(row).toMatchObject({
      status: 'FAILED',
      attempts: 6,
      last_error: '550 Mailbox unavailable',
      next_attempt_at: null,
    });
    expect(row.gave_up_at).toBeInstanceOf(Date);
    expect(failures.map((one) => one.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(failures.at(-1)?.tryingAgainAt).toBeNull();
  });
});

describe('a new joiner’s first day', () => {
  it('welcomes them, tells their manager, and tells each of their team', async () => {
    const esi = await addAJoiner();

    const run = await emails.sendDailyEmails(system);

    expect(run.queued).toEqual({ WELCOME: 1, NEW_REPORT: 1, NEW_COLLEAGUE: 2 });

    const rows = await outboxRows();
    const sentTo = (kind: string) =>
      rows.filter((row) => row.kind === kind).map((row) => row.recipient_employee_id);

    expect(sentTo('WELCOME')).toEqual([esi]);
    expect(sentTo('NEW_REPORT')).toEqual([people.teamLead]);
    /* Adwoa and Abena. Not Kojo, who reported to Kofi too and has left. */
    expect(sentTo('NEW_COLLEAGUE').sort()).toEqual([people.officer, people.partTimer].sort());

    const welcome = rows.find((row) => row.kind === 'WELCOME');

    expect(welcome?.subject).toBe('Welcome to Remat, Esi');
    expect(welcome?.text_body).toContain(`http://portal.test/#/directory/${esi}`);
  });

  it('and the welcome reaches them once the job drains the queue', async () => {
    await addAJoiner();
    await emails.sendDailyEmails(system);
    await outbox.drain(system);

    expect(mailer.sent.find((mail) => mail.to === 'esi.appiah@rematholdings.com')?.subject).toBe(
      'Welcome to Remat, Esi',
    );
    /* Every one, including whatever was queued in the same millisecond the drain began. */
    expect((await outboxRows()).every((row) => row.status === 'SENT')).toBe(true);
  });

  it('sends each of those once, however many times the job runs that day', async () => {
    await addAJoiner();

    await emails.sendDailyEmails(system);
    const again = await emails.sendDailyEmails(system);

    expect(again.queued).toEqual({});
    expect(await outboxRows()).toHaveLength(4);
  });

  it('still welcomes them the next morning if the server was down on the day', async () => {
    await addAJoiner();
    today = '2026-11-03';

    expect((await emails.sendDailyEmails(system)).queued.WELCOME).toBe(1);
  });

  it('does not welcome anybody before their first day', async () => {
    await addAJoiner();
    today = '2026-11-01';

    expect((await emails.sendDailyEmails(system)).queued).toEqual({});
  });

  it('leaves out a colleague who turned those introductions off', async () => {
    await addAJoiner();
    await new EmailPreferenceRepository(db).turnOff(people.partTimer, 'NEW_COLLEAGUE');

    const run = await emails.sendDailyEmails(system);

    expect(run.queued.NEW_COLLEAGUE).toBe(1);
    expect(run.turnedOff).toBe(1);
    expect((await outboxRows('NEW_COLLEAGUE')).map((row) => row.recipient_employee_id)).toEqual([
      people.officer,
    ]);
  });
});

describe('an exit date that is close, with reports still under it', () => {
  beforeEach(async () => {
    await admin.query(
      `UPDATE employee SET employment_status = 'TERMINATED', exit_date = '2026-11-10' WHERE id = $1`,
      [people.teamLead],
    );
  });

  it('tells everybody in HR, naming each report still there', async () => {
    const run = await emails.sendDailyEmails(system);

    expect(run.queued).toEqual({ LEAVER_HAS_REPORTS: 2 });

    const rows = await outboxRows('LEAVER_HAS_REPORTS');

    expect(rows.map((row) => row.recipient_employee_id).sort()).toEqual(
      [people.headOfHr, people.hrOfficer].sort(),
    );
    expect(rows[0].subject).toBe(
      'Kofi Boateng leaves on 10 November 2026 and still has 2 direct reports',
    );
    expect(rows[0].text_body).toContain('Adwoa Frimpong');
    expect(rows[0].text_body).toContain('Abena Sarpong');
    expect(rows[0].text_body).not.toContain('Kojo Antwi');
  });

  it('tells them once, and again three days out if nothing has moved', async () => {
    await emails.sendDailyEmails(system);
    expect((await emails.sendDailyEmails(system)).queued).toEqual({});

    today = '2026-11-08';

    expect((await emails.sendDailyEmails(system)).queued).toEqual({ LEAVER_HAS_REPORTS: 2 });
    expect(await outboxRows('LEAVER_HAS_REPORTS')).toHaveLength(4);
  });

  it('says nothing once the reports have been moved', async () => {
    await admin.query('UPDATE employee SET manager_id = $1 WHERE manager_id = $2', [
      people.opsManager,
      people.teamLead,
    ]);

    expect((await emails.sendDailyEmails(system)).queued).toEqual({});
  });

  it('says nothing while the date is more than a fortnight off', async () => {
    today = '2026-10-20';

    expect((await emails.sendDailyEmails(system)).queued).toEqual({});
  });
});

describe('HR changing somebody’s record', () => {
  let hr: Actor;
  let records: EmployeeService;

  beforeEach(() => {
    hr = signedInAs(people.headOfHr, { roles: ['EMPLOYEE', 'HR_ADMIN'], isManager: true });

    const guard = new Guard(recordingDenials());

    records = new EmployeeService(
      new EmployeeRepository(db),
      new DepartmentRepository(db),
      new WorkPatternRepository(db),
      guard,
      noLeaveFollows(),
      { domains: ['rematholdings.com'], subscribers: [emails] },
    );
  });

  it('tells them what changed, in the name of whoever changed it, with replies to them', async () => {
    await records.update(hr, people.officer, { jobTitle: 'Senior Operations Officer' });

    const [row] = await outboxRows('RECORD_CHANGED');

    expect(row).toMatchObject({
      recipient_employee_id: people.officer,
      to_address: 'adwoa.frimpong@rematholdings.com',
      subject: 'Your job title has changed',
      from_name: 'Ama Mensah via Remat Portal',
      reply_to: 'ama.mensah@rematholdings.com',
      status: 'QUEUED',
    });
    expect(row.text_body).toContain(
      'Job title: Senior Operations Officer (was Operations Officer)',
    );
  });

  it('names a new manager and department, and says where their leave goes now', async () => {
    const { rows } = await admin.query<{ id: string }>(
      "SELECT id FROM department WHERE name = 'Finance'",
    );

    await records.update(hr, people.officer, {
      managerId: people.financeManager,
      departmentId: rows[0].id,
    });

    const [row] = await outboxRows('RECORD_CHANGED');

    expect(row.subject).toBe('Your employee record has changed');
    expect(row.text_body).toContain('Department: Finance (was Operations)');
    expect(row.text_body).toContain('Manager: Efe Danquah (was Kofi Boateng)');
    expect(row.text_body).toContain('Your leave requests now go to your new manager');
  });

  it('says nothing about a change to anything else on the record', async () => {
    await records.update(hr, people.officer, { lastName: 'Frimpong-Mensah' });

    expect(await outboxRows()).toEqual([]);
  });

  it('is sent from the system when the system made the change', async () => {
    await records.update(system, people.officer, { managerId: people.opsManager });

    const [row] = await outboxRows('RECORD_CHANGED');

    expect(row.from_name).toBe('Remat Portal');
    expect(row.reply_to).toBeNull();
  });

  it('cannot be turned off', async () => {
    await expect(
      emails.choose(
        signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false }),
        'RECORD_CHANGED',
        false,
      ),
    ).rejects.toThrow(EmailIsMandatory);
  });

  it('never fails the save, even when the email cannot be queued', async () => {
    const throwing = new EmployeeService(
      new EmployeeRepository(db),
      new DepartmentRepository(db),
      new WorkPatternRepository(db),
      new Guard(recordingDenials()),
      noLeaveFollows(),
      {
        domains: ['rematholdings.com'],
        subscribers: [{ onEmployeeChanged: () => Promise.reject(new Error('outbox is down')) }],
      },
    );

    const saved = await throwing.update(hr, people.officer, { jobTitle: 'Analyst' });

    expect(saved.jobTitle).toBe('Analyst');
  });
});

describe('choosing which emails come to you', () => {
  const adwoa = () => signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });

  it('lists every email they can be sent, with the optional ones on until turned off', async () => {
    const choices = await emails.choices(adwoa());

    expect(choices.map((one) => one.email)).not.toContain('LEAVER_HAS_REPORTS');
    expect(choices.find((one) => one.email === 'NEW_COLLEAGUE')).toMatchObject({
      optional: true,
      receives: true,
    });
    expect(choices.find((one) => one.email === 'RECORD_CHANGED')).toMatchObject({
      optional: false,
      receives: true,
    });
  });

  it('turns an optional one off and back on', async () => {
    const off = await emails.choose(adwoa(), 'NEW_COLLEAGUE', false);

    expect(off.find((one) => one.email === 'NEW_COLLEAGUE')?.receives).toBe(false);

    const on = await emails.choose(adwoa(), 'NEW_COLLEAGUE', true);

    expect(on.find((one) => one.email === 'NEW_COLLEAGUE')?.receives).toBe(true);
  });

  it('shows HR the leaver warning, which is always on', async () => {
    const ama = signedInAs(people.headOfHr, { roles: ['EMPLOYEE', 'HR_ADMIN'], isManager: true });

    expect(
      (await emails.choices(ama)).find((one) => one.email === 'LEAVER_HAS_REPORTS'),
    ).toMatchObject({
      optional: false,
      receives: true,
    });
  });
});

describe('what the database guarantees', () => {
  it('lets only the optional emails be turned off, on any connection', async () => {
    await expect(
      admin.query("INSERT INTO email_opt_out (employee_id, email) VALUES ($1, 'RECORD_CHANGED')", [
        people.officer,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'email_opt_out_only_optional_emails' });
  });

  it('names the same optional emails as the code does', async () => {
    const { rows } = await admin.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'email_opt_out_only_optional_emails'`,
    );
    const named = [...rows[0].definition.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);

    expect(named.sort()).toEqual([...OPTIONAL_EMAILS].sort());
  });

  it('lets the application move a message’s delivery and nothing else, and never delete the log', async () => {
    await outbox.queue(ONE);

    for (const statement of [
      "UPDATE email_outbox SET subject = 'Something else'",
      "UPDATE email_outbox SET to_address = 'somebody@example.com'",
      'DELETE FROM email_outbox',
    ]) {
      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE lms_app');
      await expect(admin.query(statement), statement).rejects.toMatchObject({ code: '42501' });
      await admin.query('ROLLBACK');
    }
  });

  it('refuses a sent message that does not say where it went', async () => {
    await outbox.queue(ONE);

    await expect(
      admin.query("UPDATE email_outbox SET status = 'SENT', next_attempt_at = NULL, attempts = 1"),
    ).rejects.toMatchObject({ code: '23514', constraint: 'email_outbox_sent_says_when' });
  });
});
