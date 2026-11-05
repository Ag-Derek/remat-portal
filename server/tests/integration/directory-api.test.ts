import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { type Actor, signedInAs, theSystem } from '../../src/core/auth/actor.js';
import { Guard } from '../../src/core/auth/policy.js';
import { databaseFor } from '../../src/core/db/index.js';
import type { Database } from '../../src/core/db/schema.js';
import { BalanceRepository } from '../../src/apps/leave/balance/balance.db.js';
import { DepartmentRepository } from '../../src/core/organisation/department/department.db.js';
import { EmployeeRepository } from '../../src/core/organisation/employee/employee.db.js';
import { EntitlementRuleRepository } from '../../src/apps/leave/entitlement/entitlement-rule.db.js';
import { HolidayRepository } from '../../src/apps/leave/holiday/holiday.db.js';
import { LeaveDecisionRepository } from '../../src/apps/leave/leave-request/leave-decision.db.js';
import { LeaveRequestRepository } from '../../src/apps/leave/leave-request/leave-request.db.js';
import { ReclassificationRepository } from '../../src/apps/leave/leave-request/reclassification.db.js';
import { LeaveRoutingRepository } from '../../src/apps/leave/leave-request/routing.db.js';
import { LeaveRequestDraftRepository } from '../../src/apps/leave/leave-request/draft.db.js';
import { AttachmentRepository } from '../../src/apps/leave/leave-request/attachment.db.js';
import { AttachmentLinkRepository } from '../../src/apps/leave/leave-request/attachment-link.db.js';
import { SignatureScanner } from '../../src/core/scanning/signature-scanner.js';
import { InMemoryStorage } from '../support/in-memory-storage.js';
import { WithdrawalRepository } from '../../src/apps/leave/leave-request/withdrawal.db.js';
import { LeaveTypeRepository } from '../../src/apps/leave/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../../src/apps/leave/leave-year/leave-year.db.js';
import { LedgerRepository } from '../../src/apps/leave/balance/ledger.db.js';
import { NotificationRepository } from '../../src/apps/leave/notification/notification.db.js';
import { EmailWordingRepository } from '../../src/apps/leave/notification/wording.db.js';
import { AuditRepository } from '../../src/core/audit/audit.db.js';
import { OrganisationRepository } from '../../src/core/organisation/settings/organisation.db.js';
import { RoleRepository } from '../../src/core/identity/role/role.db.js';
import { SignInAccountRepository } from '../../src/core/identity/sign-in/sign-in-account.db.js';
import { Transactions } from '../../src/core/db/transaction.js';
import { WorkPatternRepository } from '../../src/core/calendar/work-pattern/work-pattern.db.js';
import { buildApp } from '../../src/app.js';
import {
  mintSession,
  SESSION_COOKIE,
} from '../../src/core/identity/sign-in/session-cookie.routes.js';
import { BalanceService } from '../../src/apps/leave/balance/balance.service.js';
import { LeaveCalculatorService } from '../../src/apps/leave/leave-calculator/leave-calculator.service.js';
import { LeaveRequestService } from '../../src/apps/leave/leave-request/leave-request.service.js';
import { NotificationService } from '../../src/apps/leave/notification/notification.service.js';
import { SignInService } from '../../src/core/identity/sign-in/sign-in.service.js';
import { AwayTodayService } from '../../src/apps/leave/team/away-today.service.js';
import { DirectoryService } from '../../src/apps/directory/directory.service.js';
import { PhotoRepository } from '../../src/apps/directory/photo.db.js';
import { PhotoService } from '../../src/apps/directory/photo.service.js';
import sharp from 'sharp';
import { EmployeeService } from '../../src/core/organisation/employee/employee.service.js';
import { LeaverReports } from '../../src/core/organisation/employee/leaver-reports.job.js';
import type { Directory } from '../../src/apps/directory/directory.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { EmailOutboxRepository } from '../../src/core/notification/outbox.db.js';
import { EmailOutbox } from '../../src/core/notification/outbox.service.js';
import { EmailPreferenceRepository } from '../../src/apps/directory/email.db.js';
import { DirectoryEmailService } from '../../src/apps/directory/email.service.js';
import { portalLinks } from '../../src/apps/directory/email.js';
import { recordingDenials } from '../support/recording-denials.js';
import { seed } from '../../seeds/seed.mjs';
import { holidayRecalculationService } from '../support/holiday-recalculations.js';
import { delegationService } from '../support/delegations.js';

/**
 * The staff directory, over HTTP and against the leave tables.
 *
 * Four claims:
 *
 *   **It needs a session.** Like everything else behind the line.
 *
 *   **It is everybody current, by surname.** A leaver is not in it.
 *
 *   **Away is agreed leave only, with the day they are back.** A request still being decided
 *   marks nobody.
 *
 *   **Nothing but the directory's fields leaves the server.** No employee number, no kind of
 *   leave, and a colleague's reporting line only on their profile.
 */

const testDatabaseUrl = await databaseForThisFile();

const SECRET = 'a-test-signing-secret-of-at-least-32-chars';

const system = theSystem('directory api integration fixtures');

let db: Kysely<Database>;
let admin: Client;
let server: Server;
let origin: string;
let guard: Guard;
/** NFR SEC 03. Every refusal the guard wrote down, for the 403 tests to read back. */
const denials = recordingDenials();
let balances: BalanceService;
let requests: LeaveRequestService;
let people: Record<string, string>;
let annualId: string;
let y2026: string;
/** Where photos go, so a test can see what was kept and what was removed. */
const storage = new InMemoryStorage();

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  guard = new Guard(denials);
  const employees = new EmployeeRepository(db);
  const accounts = new SignInAccountRepository(db);
  const roles = new RoleRepository(db);
  const cached = new BalanceRepository(db);

  balances = new BalanceService(cached, guard, employees, new Transactions(db));

  const types = new LeaveTypeRepository(db);
  const years = new LeaveYearRepository(db);
  const leaveRequests = new LeaveRequestRepository(db);
  const decisions = new LeaveDecisionRepository(db);

  requests = new LeaveRequestService(
    balances,
    guard,
    employees,
    types,
    years,
    leaveRequests,
    decisions,
    new LeaveRoutingRepository(db),
    new WithdrawalRepository(db),
    new ReclassificationRepository(db),
    new AttachmentRepository(db),
    new RoleRepository(db),
    delegationService(db, guard),
    new OrganisationRepository(db),
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    new NotificationService(new NotificationRepository(db), recordingMailer(), guard),
  );

  const outbox = new EmailOutbox(new EmailOutboxRepository(db), recordingMailer(), guard);

  const app = buildApp({
    /* One person asks far more of this file than of the limits, which directory-routes covers. */
    directoryLimits: {
      lookups: { max: Infinity, windowSeconds: 60 },
      photoUploads: { max: Infinity, windowSeconds: 60 },
    },
    outbox,
    directoryEmails: new DirectoryEmailService(
      guard,
      employees,
      new DepartmentRepository(db),
      roles,
      new EmailPreferenceRepository(db),
      outbox,
      portalLinks('http://portal.test'),
    ),
    guard,
    signIn: new SignInService(accounts, employees, roles, recordingMailer(), guard, {
      domains: ['rematholdings.com'],
    }),
    balances: cached,
    ledger: new LedgerRepository(db),
    adjustments: balances,
    employees,
    departments: new DepartmentRepository(db),
    types,
    years,
    entitlementRules: new EntitlementRuleRepository(db),
    requests: leaveRequests,
    leaveRequests: requests,
    decisions,
    routing: new LeaveRoutingRepository(db),
    withdrawals: new WithdrawalRepository(db),
    drafts: new LeaveRequestDraftRepository(db),
    attachments: new AttachmentRepository(db),
    attachmentLinks: new AttachmentLinkRepository(db),
    holidays: new HolidayRepository(db),
    patterns: new WorkPatternRepository(db),
    holidayRecalculations: holidayRecalculationService(db, guard, balances),
    storage,
    photos: new PhotoRepository(db),
    scanner: new SignatureScanner(),
    accounts,
    roles,
    delegations: delegationService(db, guard),
    organisation: new OrganisationRepository(db),
    emailWording: new EmailWordingRepository(db),
    audit: new AuditRepository(db),
    secret: SECRET,
  });

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => {
      resolve(listening);
    });
  });

  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

beforeEach(async () => {
  denials.clear();
  storage.reset();

  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, attachment_access, attachment_download_link, leave_request_recalculation, leave_request_reclassification, leave_request_attachment, leave_request_decision, leave_request_reassignment, leave_request_routing, leave_request_withdrawal, leave_request_reversal, leave_cover, leave_request',
  );

  people = (await seed(admin)) as Record<string, string>;

  annualId = (await admin.query<{ id: string }>("SELECT id FROM leave_type WHERE code = 'ANNUAL'"))
    .rows[0].id;
  y2026 = (await admin.query<{ id: string }>("SELECT id FROM leave_year WHERE label = '2026'"))
    .rows[0].id;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  await db?.destroy();
  await admin?.end();
});

describe('what it keeps', () => {
  /* `email_outbox` keeps an address on purpose: the log says where a message went that day. */
  it('repeats no field of the employee record in a table of its own', async () => {
    const { rows } = await admin.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('employee_photo', 'email_opt_out')
          AND column_name <> 'id'
          AND column_name IN (
            SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'employee')`,
    );

    expect(rows).toEqual([]);
  });

  it.each([
    ['employee_by_last_name', 'lower(last_name)'],
    ['employee_by_first_name', 'lower(first_name)'],
  ])('finds somebody by the start of a name through %s', async (index, column) => {
    /* The table is too small for the planner to choose an index unprompted. */
    await admin.query('SET enable_seqscan = off');

    const { rows } = await admin.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT id FROM employee WHERE ${column} LIKE 'bo%'`,
    );

    await admin.query('RESET enable_seqscan');

    expect(rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(index);
  });

  it('finds a department’s people through an index', async () => {
    const { rows } = await admin.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'employee'",
    );

    expect(rows.map((row) => row.indexname)).toContain('idx_employee_department');
  });
});

describe('who may read it', () => {
  it('needs a session like everything else behind the line', async () => {
    expect((await fetch(`${origin}/api/directory`)).status).toBe(401);
  });

  it('is any employee, not only HR', async () => {
    const response = await get('/api/directory', people.officer);

    expect(response.status).toBe(200);
  });
});

describe('who is in it', () => {
  it('is every current member of staff, by surname, and not the leaver', async () => {
    const directory = await directoryAs(people.officer);

    expect(directory.people.map((one) => `${one.firstName} ${one.lastName}`)).toEqual([
      'Selorm Adjei',
      'Kwame Asante',
      'Kofi Boateng',
      'Yaw Boateng',
      'Efe Danquah',
      'Akosua Darko',
      'Adwoa Frimpong',
      'Yram Kudjo',
      'Ama Mensah',
      'Efua Owusu',
      'Nana Owusu-Ansah',
      'Abena Sarpong',
    ]);
    expect(directory.people.map((one) => one.employeeId)).not.toContain(people.leaver);
  });

  it('names each person’s department, and offers each department once', async () => {
    const directory = await directoryAs(people.officer);

    const efe = directory.people.find((one) => one.employeeId === people.financeManager);

    expect(efe?.department.name).toBe('Finance');
    expect(directory.departments.map((one) => one.name)).toContain('Operations');
    expect(new Set(directory.departments.map((one) => one.id)).size).toBe(
      directory.departments.length,
    );
  });

  it('carries the directory’s fields and nothing else from the record', async () => {
    const directory = await directoryAs(people.officer);

    expect(Object.keys(directory.people[0]).sort()).toEqual([
      'backOn',
      'cover',
      'department',
      'description',
      'employeeId',
      'firstName',
      'jobTitle',
      'lastName',
      'photo',
      'workEmail',
      'workMobile',
    ]);

    const wire = JSON.stringify(directory);

    expect(wire).not.toContain('managerId');
    expect(wire).not.toContain('RH-0');
    expect(wire).not.toContain('startDate');
  });

  it('dates today as ten characters', async () => {
    expect((await directoryAs(people.officer)).today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('joiners and leavers', () => {
  it('lists a joiner from their start date and not before', async () => {
    await admin.query("UPDATE employee SET start_date = '2099-01-04' WHERE id = $1", [
      people.partTimer,
    ]);

    const directory = await directoryAs(people.officer);
    const chart = await chartAs(people.officer);

    expect(directory.people.map((one) => one.employeeId)).not.toContain(people.partTimer);
    expect(JSON.stringify(chart)).not.toContain(`"${people.partTimer}"`);
    expect((await get(`/api/directory/people/${people.partTimer}`, people.officer)).status).toBe(
      404,
    );
  });

  /* HR doing the paperwork before somebody goes, which checkDatesAgree allows on purpose. */
  it('keeps a leaver already marked TERMINATED listed until their exit date passes', async () => {
    await admin.query(
      `UPDATE employee SET employment_status = 'TERMINATED', exit_date = '2099-12-31'
        WHERE id = $1`,
      [people.partTimer],
    );

    const directory = await directoryAs(people.officer);

    expect(directory.people.map((one) => one.employeeId)).toContain(people.partTimer);
    expect(JSON.stringify(await chartAs(people.officer))).toContain(`"${people.partTimer}"`);
    expect((await get(`/api/directory/people/${people.partTimer}`, people.officer)).status).toBe(
      200,
    );
  });

  it('answers a current colleague’s profile to anybody', async () => {
    const response = await get(`/api/directory/people/${people.partTimer}`, people.officer);
    const body = (await response.json()) as JsonEntry & { notListed: unknown };

    expect(response.status).toBe(200);
    expect(body.firstName).toBe('Abena');
    expect(body.notListed).toBeNull();
  });

  it('answers a leaver’s profile with a 404 to anybody but HR, and logs the attempt', async () => {
    const response = await get(`/api/directory/people/${people.leaver}`, people.officer);

    expect(response.status).toBe(404);
    expect(denials.last()).toMatchObject({
      employeeId: people.officer,
      resource: 'directory',
      action: 'readProfile',
      subject: people.leaver,
    });
  });

  it('and with the same 404 as an id that is nobody, so it cannot tell who has left', async () => {
    const leaver = await get(`/api/directory/people/${people.leaver}`, people.officer);
    const nobody = await get('/api/directory/people/999999', people.officer);

    expect(nobody.status).toBe(404);
    expect(await nobody.json()).toEqual(await leaver.json());
  });

  it('answers a leaver’s profile to HR, saying they have left and when', async () => {
    const response = await get(`/api/directory/people/${people.leaver}`, people.hrOfficer);
    const body = (await response.json()) as { notListed: { reason: string; exitDate: string } };

    expect(response.status).toBe(200);
    expect(body.notListed).toMatchObject({ reason: 'LEFT', exitDate: '2026-07-31' });
  });

  /* The story's third criterion. The record is hidden from the directory, not removed, and
     the leave hanging off it is still HR's to read. */
  it('keeps a leaver’s record and leave history, and HR can still read both', async () => {
    await grant(people.officer, 20);
    const { request } = await requests.submit(asAdwoa(), week('2026-09-07', '2026-09-11'));
    await requests.approve(asKofi(), request.id);

    await admin.query(
      `UPDATE employee SET employment_status = 'TERMINATED', exit_date = '2026-10-02'
        WHERE id = $1`,
      [people.officer],
    );

    expect((await directoryAs(people.partTimer)).people.map((one) => one.employeeId)).not.toContain(
      people.officer,
    );

    const { rows } = await admin.query('SELECT id FROM employee WHERE id = $1', [people.officer]);
    expect(rows).toHaveLength(1);

    const history = await get(`/api/employees/${people.officer}/requests`, people.hrOfficer);
    expect(history.status).toBe(200);
    expect(JSON.stringify(await history.json())).toContain(`"${request.id}"`);

    expect((await get(`/api/leavers/${people.officer}`, people.hrOfficer)).status).toBe(200);
    expect((await get(`/api/directory/people/${people.officer}`, people.hrOfficer)).status).toBe(
      200,
    );
  });
});

describe('a leaver’s reports', () => {
  function theJob(today: string): LeaverReports {
    return new LeaverReports(
      new EmployeeService(
        new EmployeeRepository(db),
        new DepartmentRepository(db),
        new WorkPatternRepository(db),
        guard,
        requests,
        { domains: ['rematholdings.com'] },
      ),
      () => today,
    );
  }

  async function managerOf(employeeId: string): Promise<string | null> {
    const { rows } = await admin.query<{ manager_id: string | null }>(
      'SELECT manager_id::text FROM employee WHERE id = $1',
      [employeeId],
    );

    return rows[0].manager_id;
  }

  /* Kofi Boateng, the team lead, leaves with Adwoa's week off still waiting on him. */
  it('move to the manager above the leaver the day after their last day, leave and all', async () => {
    await grant(people.officer, 20);
    const { request } = await requests.submit(asAdwoa(), week('2026-11-02', '2026-11-06'));

    await admin.query(
      `UPDATE employee SET employment_status = 'TERMINATED', exit_date = '2026-10-01'
        WHERE id = $1`,
      [people.teamLead],
    );

    expect((await theJob('2026-10-01').run(system)).moved).toEqual([]);

    const run = await theJob('2026-10-02').run(system);

    expect(run.moved.map((move) => move.employeeId).sort()).toEqual(
      [people.officer, people.partTimer].sort(),
    );
    expect(await managerOf(people.officer)).toBe(people.opsManager);
    expect(await managerOf(people.partTimer)).toBe(people.opsManager);

    /* The seeded leaver went in July, and keeps the manager she had. */
    expect(await managerOf(people.leaver)).toBe(people.teamLead);

    /* So nobody hangs off a manager who has gone. */
    expect((await chartAs(people.officer)).lines).toHaveLength(1);

    /* And the week off is the new manager's to decide. */
    await expect(
      requests.approve(
        signedInAs(people.opsManager, { roles: ['EMPLOYEE'], isManager: true }),
        request.id,
      ),
    ).resolves.toBeDefined();

    expect((await theJob('2026-10-03').run(system)).moved).toEqual([]);
  });
});

describe('the organisation chart', () => {
  it('needs a session', async () => {
    expect((await fetch(`${origin}/api/directory/chart`)).status).toBe(401);
  });

  it('is any employee’s, not only HR’s', async () => {
    expect((await get('/api/directory/chart', people.officer)).status).toBe(200);
  });

  /* The story's first criterion: every line on the chart is the manager on a record. */
  it('matches the reporting lines in the employee records, for everybody current', async () => {
    const chart = await chartAs(people.officer);

    expect(chart.lines).toHaveLength(1);
    expect(chart.lines[0].standing).toBe('HEAD_OF_THE_ORGANISATION');
    expect(chart.lines[0].top.employeeId).toBe(people.ceo);

    const { rows } = await admin.query<{ id: string; manager_id: string | null }>(
      "SELECT id::text, manager_id::text FROM employee WHERE employment_status = 'ACTIVE'",
    );
    const drawn = linesOf(chart.lines[0].top, null);

    expect(drawn.sort()).toEqual(rows.map((row) => `${row.manager_id} -> ${row.id}`).sort());
    expect(chart.total).toBe(rows.length);
  });

  it('leaves out the leaver', async () => {
    expect(JSON.stringify(await chartAs(people.officer))).not.toContain(`"${people.leaver}"`);
  });

  it('flags the team of a manager who has left, rather than dropping it', async () => {
    await admin.query(
      `UPDATE employee SET employment_status = 'TERMINATED', exit_date = '2026-01-31'
        WHERE id = $1`,
      [people.teamLead],
    );

    const chart = await chartAs(people.officer);

    expect(chart.lines.slice(1).map((line) => line.standing)).toEqual([
      'MANAGER_NOT_ON_THE_CHART',
      'MANAGER_NOT_ON_THE_CHART',
    ]);
    expect(
      chart.lines
        .slice(1)
        .map((line) => line.top.employeeId)
        .sort(),
    ).toEqual([people.officer, people.partTimer].sort());
  });

  it('carries a name, a job title and a photo of each person, and no employee number', async () => {
    const chart = await chartAs(people.officer);

    expect(Object.keys(chart.lines[0].top).sort()).toEqual([
      'department',
      'employeeId',
      'firstName',
      'jobTitle',
      'lastName',
      'ledBy',
      'photo',
      'reports',
    ]);
    expect(JSON.stringify(chart)).not.toContain('RH-0');
  });
});

/**
 * Who is away, on a fixed day rather than the clock's, so the return dates can be asserted
 * exactly. The service is built as `buildApp` builds it, with a day handed in.
 */
describe('my own profile', () => {
  it('needs a session', async () => {
    expect((await fetch(`${origin}/api/me/profile`)).status).toBe(401);
  });

  it('is mine, with when I started and who I report to', async () => {
    const mine = await profileAs(people.officer);

    expect(mine.employeeId).toBe(people.officer);
    expect(mine.startDate).toBe('2023-08-14');
    expect(mine.manager).toMatchObject({
      employeeId: people.teamLead,
      firstName: 'Kofi',
      lastName: 'Boateng',
      jobTitle: 'Operations Team Lead',
    });
    expect(mine.workMobile).toBeNull();
    expect(mine.description).toBeNull();
  });
});

describe('a colleague’s profile', () => {
  it('needs a session', async () => {
    expect((await fetch(`${origin}/api/directory/people/${people.teamLead}`)).status).toBe(401);
  });

  it('is any employee’s to read, with who they report to and who reports to them', async () => {
    const response = await get(`/api/directory/people/${people.teamLead}`, people.partTimer);

    expect(response.status).toBe(200);

    const kofi = (await response.json()) as JsonColleague;

    expect(kofi.firstName).toBe('Kofi');
    expect(kofi.manager).not.toBeNull();
    expect(kofi.reports.map((one) => one.employeeId).sort()).toEqual(
      [people.officer, people.partTimer].sort(),
    );
  });

  it('matches the reporting lines in the employee records', async () => {
    const kofi = await colleagueAs(people.officer, people.teamLead);
    const { rows } = await admin.query<{ manager_id: string }>(
      'SELECT manager_id::text FROM employee WHERE id = $1',
      [people.teamLead],
    );

    expect(kofi.manager?.employeeId).toBe(rows[0].manager_id);
  });

  it('carries the directory’s fields and the reporting line, and no start date', async () => {
    const kofi = await colleagueAs(people.officer, people.teamLead);

    expect(Object.keys(kofi).sort()).toEqual([
      'backOn',
      'cover',
      'department',
      'description',
      'employeeId',
      'firstName',
      'jobTitle',
      'lastName',
      'manager',
      'notListed',
      'photo',
      'reports',
      'workEmail',
      'workMobile',
    ]);
    expect(kofi.notListed).toBeNull();
    expect(JSON.stringify(kofi)).not.toContain('RH-0');
    expect(JSON.stringify(kofi)).not.toContain('startDate');
  });

  /* Kojo left in July. He reported to Kofi, who is still here, and nobody reported to him. */
  it('gives HR a leaver’s reporting line too, among the people still here', async () => {
    const kojo = await colleagueAs(people.hrOfficer, people.leaver);

    expect(kojo.notListed).toMatchObject({ reason: 'LEFT' });
    expect(kojo.manager?.employeeId).toBe(people.teamLead);
    expect(kojo.reports).toEqual([]);
  });

  it('shows what they wrote themselves as soon as they save it', async () => {
    await patch(people.officer, people.officer, { description: 'Tenders.' });

    expect((await colleagueAs(people.partTimer, people.officer)).description).toBe('Tenders.');
  });

  it('is a 404 for a leaver, an id that is nobody’s, not a number or too large, alike', async () => {
    const answers = await Promise.all(
      [people.leaver, '999999', 'not-a-number', '99999999999999999999'].map(async (id) => {
        const response = await get(`/api/directory/people/${id}`, people.officer);

        return { status: response.status, body: (await response.json()) as unknown };
      }),
    );

    expect(answers.map((one) => one.status)).toEqual([404, 404, 404, 404]);
    expect(new Set(answers.map((one) => JSON.stringify(one.body))).size).toBe(1);
  });
});

describe('changing my own profile', () => {
  it('saves my work mobile and description, live at once, for everybody to see', async () => {
    const response = await patch(people.officer, people.officer, {
      workMobile: '024 555 0197',
      description: 'Come to me about tender notices.',
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as JsonProfile).description).toBe(
      'Come to me about tender notices.',
    );

    /* No approval step: a colleague reading the directory straight after sees it. */
    const seen = (await directoryAs(people.partTimer)).people.find(
      (one) => one.employeeId === people.officer,
    );

    expect(seen?.workMobile).toBe('024 555 0197');
    expect(seen?.description).toBe('Come to me about tender notices.');
  });

  it('is audited: the old value, the new one, who changed it and when', async () => {
    const before = new Date();

    await patch(people.officer, people.officer, { description: 'First.' });
    await patch(people.officer, people.officer, { description: 'Second.' });

    const { rows } = await admin.query<{
      action: string;
      before: { description: string | null };
      after: { description: string | null };
      actor_employee_id: string;
      occurred_at: Date;
    }>(
      `SELECT action, before, after, actor_employee_id, occurred_at
         FROM audit_log
        WHERE entity = 'employee' AND entity_id = $1
        ORDER BY id DESC
        LIMIT 1`,
      [people.officer],
    );

    expect(rows[0].action).toBe('UPDATE');
    expect(rows[0].before.description).toBe('First.');
    expect(rows[0].after.description).toBe('Second.');
    expect(String(rows[0].actor_employee_id)).toBe(people.officer);
    expect(rows[0].occurred_at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5_000);
  });

  it('clears a field sent empty', async () => {
    await patch(people.officer, people.officer, { workMobile: '024 555 0197' });
    await patch(people.officer, people.officer, { workMobile: '' });

    expect((await profileAs(people.officer)).workMobile).toBeNull();
  });

  it('refuses a 400 character description, naming the field and the limit', async () => {
    const response = await patch(people.officer, people.officer, { description: 'a'.repeat(400) });
    const body = (await response.json()) as { field: string; message: string };

    expect(response.status).toBe(400);
    expect(body.field).toBe('description');
    expect(body.message).toBe('Description must be 280 characters or fewer. It is 400.');
    expect((await profileAs(people.officer)).description).toBeNull();
  });

  it('refuses a work mobile that is not a phone number', async () => {
    const response = await patch(people.officer, people.officer, { workMobile: 'call me' });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { field: string }).field).toBe('workMobile');
  });

  it('refuses any field HR keeps, and changes nothing', async () => {
    const response = await patch(people.officer, people.officer, {
      description: 'Fine.',
      jobTitle: 'Chief Executive Officer',
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { field: string }).field).toBe('jobTitle');

    const mine = await profileAs(people.officer);

    expect(mine.jobTitle).toBe('Operations Officer');
    expect(mine.description).toBeNull();
  });
});

describe('changing somebody else’s profile', () => {
  it('is refused with a 403, and the attempt is logged', async () => {
    const response = await patch(people.officer, people.partTimer, { description: 'Hacked.' });

    expect(response.status).toBe(403);
    expect(((await response.json()) as { message: string }).message).toContain(
      'only change your own profile',
    );

    expect(denials.last()).toMatchObject({
      employeeId: people.officer,
      resource: 'directory',
      action: 'editProfile',
      subject: people.partTimer,
    });
  });

  it('and changes nothing', async () => {
    await patch(people.officer, people.partTimer, { description: 'Hacked.' });

    expect((await profileAs(people.partTimer)).description).toBeNull();
  });

  it('is refused to HR as well', async () => {
    expect((await patch(people.hrOfficer, people.officer, { description: 'HR.' })).status).toBe(
      403,
    );
  });

  it('and is a 403 whether or not the id is anybody', async () => {
    expect((await patch(people.officer, '999999', { description: 'Nobody.' })).status).toBe(403);
  });
});

describe('a profile photo', () => {
  it('shows in the list at thumbnail size and on the profile at profile size', async () => {
    const response = await putPhoto(people.officer, people.officer, await aPhoto());

    expect(response.status).toBe(201);

    const listed = (await directoryAs(people.partTimer)).people.find(
      (one) => one.employeeId === people.officer,
    );
    const mine = await profileAs(people.officer);

    expect(listed?.photo).not.toBeNull();
    expect(listed?.photo).toEqual(mine.photo);

    const thumbnail = await sharp(
      await imageAt(listed?.photo?.thumbnail, people.partTimer),
    ).metadata();
    const profile = await sharp(await imageAt(mine.photo?.profile, people.officer)).metadata();

    expect([thumbnail.format, thumbnail.width, thumbnail.height]).toEqual(['webp', 128, 128]);
    expect([profile.format, profile.width, profile.height]).toEqual(['webp', 512, 512]);
  });

  it('keeps nothing the camera wrote: no EXIF, no location, no colour profile', async () => {
    const uploaded = await aPhoto({ withLocation: true });

    expect((await sharp(uploaded).metadata()).exif).toBeDefined();

    await putPhoto(people.officer, people.officer, uploaded);
    const { photo } = await profileAs(people.officer);

    for (const address of [photo?.thumbnail, photo?.profile]) {
      const kept = await imageAt(address, people.officer);
      const metadata = await sharp(kept).metadata();

      expect(metadata.exif).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      expect(kept.includes(Buffer.from('Accra'))).toBe(false);
    }
  });

  it('turns a photo the camera stored on its side the right way up before cutting it', async () => {
    /* 600 by 300 on disk, recorded as rotated a quarter turn: 300 by 600 as it is seen. */
    const sideways = await sharp({
      create: { width: 600, height: 300, channels: 3, background: '#808080' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    /* A crop that only fits a 300 wide picture, so a photo left on its side would not fit it. */
    expect((await putPhoto(people.officer, people.officer, sideways, '0,300,300')).status).toBe(
      201,
    );
  });

  it('cuts the square the person chose', async () => {
    /* Red on the left half, blue on the right. */
    const halves = await sharp({
      create: { width: 800, height: 400, channels: 3, background: '#ff0000' },
    })
      .composite([
        {
          input: { create: { width: 400, height: 400, channels: 3, background: '#0000ff' } },
          left: 400,
          top: 0,
        },
      ])
      .png()
      .toBuffer();

    await putPhoto(people.officer, people.officer, halves, '400,0,400');

    const { photo } = await profileAs(people.officer);
    const { data } = await sharp(await imageAt(photo?.profile, people.officer))
      .raw()
      .toBuffer({ resolveWithObject: true });

    /* The first pixel, red, green and blue. */
    expect(data[0]).toBeLessThan(30);
    expect(data[2]).toBeGreaterThan(220);
  });

  it('records both sizes’ keys, dimensions, the type, checksums, and who put it up when', async () => {
    const before = new Date();

    await putPhoto(people.officer, people.officer, await aPhoto());

    const { rows } = await admin.query<Record<string, unknown>>(
      'SELECT * FROM employee_photo WHERE employee_id = $1',
      [people.officer],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      content_type: 'image/webp',
      thumbnail_width: 128,
      thumbnail_height: 128,
      profile_width: 512,
      profile_height: 512,
      uploaded_by_employee_id: people.officer,
    });
    expect(rows[0].thumbnail_key).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].profile_key).toMatch(/^[0-9a-f]{64}$/);
    expect(storage.has(rows[0].thumbnail_key as string)).toBe(true);
    expect(storage.has(rows[0].profile_key as string)).toBe(true);
    expect(rows[0].thumbnail_checksum_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((rows[0].uploaded_at as Date).getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 5_000,
    );
  });

  it('is served to nobody without a session', async () => {
    await putPhoto(people.officer, people.officer, await aPhoto());
    const { photo } = await profileAs(people.officer);

    expect((await fetch(`${origin}${photo?.thumbnail ?? ''}`)).status).toBe(401);
  });

  it('is kept by the browser for a year, privately, and answered 304 when it asks again', async () => {
    await putPhoto(people.officer, people.officer, await aPhoto());
    const { photo } = await profileAs(people.officer);

    const first = await get(photo?.thumbnail ?? '', people.partTimer);

    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('image/webp');
    expect(first.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(first.headers.get('x-content-type-options')).toBe('nosniff');

    const etag = first.headers.get('etag') ?? '';

    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    /* `max-age=0` is what a browser sends when it revalidates. Without a Cache-Control of its
       own, fetch adds `no-cache` to any request carrying If-None-Match, and `no-cache` is a
       request for a full answer, which Express rightly gives. */
    const again = await fetch(`${origin}${photo?.thumbnail ?? ''}`, {
      headers: {
        cookie: `${SESSION_COOKIE}=${mintSession(people.partTimer, SECRET)}`,
        'if-none-match': etag,
        'cache-control': 'max-age=0',
      },
    });

    expect(again.status).toBe(304);
  });

  it('replaced, has a new address, and the old files are gone', async () => {
    await putPhoto(people.officer, people.officer, await aPhoto());
    const old = (await profileAs(people.officer)).photo;
    const oldKeys = await keysOf(people.officer);

    await putPhoto(people.officer, people.officer, await aPhoto({ colour: '#204080' }));
    const replaced = (await profileAs(people.officer)).photo;

    expect(replaced?.thumbnail).not.toBe(old?.thumbnail);
    expect(oldKeys.every((key) => !storage.has(key))).toBe(true);
    expect(storage.size).toBe(2);
    expect((await get(old?.thumbnail ?? '', people.officer)).status).toBe(404);
  });

  it('removed, leaves the initials everywhere and no files behind', async () => {
    await putPhoto(people.officer, people.officer, await aPhoto());
    const { photo } = await profileAs(people.officer);

    const response = await fetch(`${origin}/api/people/${people.officer}/photo`, {
      method: 'DELETE',
      headers: { cookie: `${SESSION_COOKIE}=${mintSession(people.officer, SECRET)}` },
    });

    expect(response.status).toBe(204);
    expect((await profileAs(people.officer)).photo).toBeNull();
    expect(entryOf(await directoryOn('2026-11-04'), people.officer).photoId).toBeNull();
    expect(storage.size).toBe(0);
    expect((await get(photo?.thumbnail ?? '', people.officer)).status).toBe(404);
  });

  it('is null for somebody who never put one up, in the list, on the chart and on profiles', async () => {
    const directory = await directoryAs(people.officer);
    const chart = await chartAs(people.officer);

    expect(directory.people.every((one) => one.photo === null)).toBe(true);
    expect(JSON.stringify(chart)).not.toContain('/api/photos/');
    expect((await colleagueAs(people.officer, people.teamLead)).photo).toBeNull();
  });

  it('shows on a manager’s and a report’s brief, and on the chart', async () => {
    await putPhoto(people.teamLead, people.teamLead, await aPhoto());

    const kofi = (await profileAs(people.teamLead)).photo;
    const asTheirReport = await profileAs(people.officer);

    expect(asTheirReport.manager?.photo).toEqual(kofi);
    expect(JSON.stringify(await chartAs(people.officer))).toContain(kofi?.thumbnail ?? 'missing');
  });

  it('refuses a file that is not a JPEG, PNG or WebP, whatever it is called, and keeps nothing', async () => {
    const response = await putPhoto(
      people.officer,
      people.officer,
      Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n'),
      undefined,
      'image/jpeg',
    );
    const body = (await response.json()) as { error: string; field: string; message: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe('PhotoTypeNotAccepted');
    expect(body.field).toBe('file');
    expect(body.message).toContain('JPEG, PNG or WebP');
    expect(storage.size).toBe(0);
  });

  it('refuses a GIF too', async () => {
    const gif = await sharp({
      create: { width: 200, height: 200, channels: 3, background: '#fff' },
    })
      .gif()
      .toBuffer();

    expect(
      ((await (await putPhoto(people.officer, people.officer, gif)).json()) as { error: string })
        .error,
    ).toBe('PhotoTypeNotAccepted');
  });

  it('refuses a file over 8 MB with a 413 that says the limit', async () => {
    const response = await putPhoto(
      people.officer,
      people.officer,
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(9 * 1024 * 1024)]),
    );
    const body = (await response.json()) as { error: string; message: string };

    expect(response.status).toBe(413);
    expect(body.error).toBe('PhotoTooLarge');
    expect(body.message).toContain('the limit is 8 MB');
  });

  it('refuses a photo too small to show clearly', async () => {
    const tiny = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();
    const response = await putPhoto(people.officer, people.officer, tiny);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('PhotoTooSmall');
  });

  it('is put up by its owner alone: anybody else, HR included, is a 403 and logged', async () => {
    const photo = await aPhoto();

    expect((await putPhoto(people.officer, people.partTimer, photo)).status).toBe(403);
    expect((await putPhoto(people.hrOfficer, people.officer, photo)).status).toBe(403);
    expect(denials.last()).toMatchObject({ action: 'editProfile', subject: people.officer });
    expect(storage.size).toBe(0);
  });

  it('of a leaver is a 404 to anybody but HR, the same 404 as a photo that is nobody’s', async () => {
    /* Put up before they left: a leaver has no session to put one up with now. */
    await new PhotoService(
      guard,
      new PhotoRepository(db),
      new EmployeeRepository(db),
      storage,
    ).upload(signedInAs(people.leaver, { roles: ['EMPLOYEE'], isManager: false }), people.leaver, {
      content: await aPhoto(),
      crop: undefined,
    });

    const [{ id }] = (
      await admin.query<{ id: string }>('SELECT id FROM employee_photo WHERE employee_id = $1', [
        people.leaver,
      ])
    ).rows;

    const refused = await get(`/api/photos/${id}/thumbnail`, people.officer);
    const nobody = await get('/api/photos/999999/thumbnail', people.officer);
    const garbage = await get('/api/photos/not-a-number/huge', people.officer);

    expect([refused.status, nobody.status, garbage.status]).toEqual([404, 404, 404]);
    expect(await refused.json()).toEqual(await nobody.json());
    expect((await get(`/api/photos/${id}/thumbnail`, people.hrOfficer)).status).toBe(200);
  });
});

describe('who is away today', () => {
  it('is somebody on agreed leave, with the working day they are back', async () => {
    await grant(people.officer, 20);
    await agreed(people.officer, asAdwoa(), '2026-11-02', '2026-11-06');

    const directory = await directoryOn('2026-11-04');

    expect(entryOf(directory, people.officer).backOn).toBe('2026-11-09');
    expect(entryOf(directory, people.partTimer).backOn).toBeNull();
  });

  it('and not somebody whose request is still being decided', async () => {
    await grant(people.officer, 20);
    await requests.submit(asAdwoa(), week('2026-11-02', '2026-11-06'));

    expect(entryOf(await directoryOn('2026-11-04'), people.officer).backOn).toBeNull();
  });

  it('and not before the leave starts or after it ends', async () => {
    await grant(people.officer, 20);
    await agreed(people.officer, asAdwoa(), '2026-11-02', '2026-11-06');

    expect(entryOf(await directoryOn('2026-10-30'), people.officer).backOn).toBeNull();
    expect(entryOf(await directoryOn('2026-11-09'), people.officer).backOn).toBeNull();
  });

  /* Abena works Monday, Tuesday, Thursday and Friday, so leave ending on a Tuesday has her
     back on the Thursday. */
  it('and skips the days that person does not work', async () => {
    await grant(people.partTimer, 16);
    await agreed(people.partTimer, asAbena(), '2026-11-02', '2026-11-03');

    expect(entryOf(await directoryOn('2026-11-02'), people.partTimer).backOn).toBe('2026-11-05');
  });
});

/* --------------------------------------------------------------------------- helpers */

interface JsonPhoto {
  thumbnail: string;
  profile: string;
}

interface JsonEntry {
  employeeId: string;
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  department: { id: string; name: string };
  workEmail: string;
  backOn: string | null;
  workMobile: string | null;
  description: string | null;
  photo: JsonPhoto | null;
}

interface JsonProfile extends JsonEntry {
  startDate: string;
  manager: {
    employeeId: string;
    firstName: string;
    lastName: string;
    jobTitle: string;
    photo: JsonPhoto | null;
  } | null;
}

/**
 * A JPEG straight off a phone, as far as the server can tell: 1200 by 900 with an EXIF block,
 * and a GPS position and a place name in it where asked for.
 */
describe('choosing which emails come to me', () => {
  interface JsonChoice {
    email: string;
    optional: boolean;
    receives: boolean;
  }

  const choose = (as: string, email: string, body: unknown) =>
    fetch(`${origin}/api/me/email-preferences/${email}`, {
      method: 'PUT',
      headers: {
        cookie: `${SESSION_COOKIE}=${mintSession(as, SECRET)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

  it('needs a session like everything else behind the line', async () => {
    expect((await fetch(`${origin}/api/me/email-preferences`)).status).toBe(401);
  });

  it('lists my emails, every optional one on until I turn it off', async () => {
    const response = await get('/api/me/email-preferences', people.officer);
    const { emails } = (await response.json()) as { emails: JsonChoice[] };

    expect(response.status).toBe(200);
    expect(emails.find((one) => one.email === 'NEW_COLLEAGUE')).toMatchObject({
      optional: true,
      receives: true,
    });
  });

  it('turns an optional one off, and says so in the answer', async () => {
    const response = await choose(people.officer, 'NEW_COLLEAGUE', { receives: false });
    const { emails } = (await response.json()) as { emails: JsonChoice[] };

    expect(response.status).toBe(200);
    expect(emails.find((one) => one.email === 'NEW_COLLEAGUE')?.receives).toBe(false);
  });

  it('refuses to turn off one that is always sent, with a 409 that says why', async () => {
    const response = await choose(people.officer, 'RECORD_CHANGED', { receives: false });
    const body = (await response.json()) as { error: string; message: string; field: string };

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ error: 'EmailIsMandatory', field: 'receives' });
    expect(body.message).toContain('always sent');
  });

  it('answers an email that is not one with a 404, and a choice that is not one with a 400', async () => {
    expect((await choose(people.officer, 'EVERYTHING', { receives: false })).status).toBe(404);
    expect((await choose(people.officer, 'NEW_COLLEAGUE', { receives: 'no' })).status).toBe(400);
  });
});

describe('writing to a colleague from their profile', () => {
  const write = (as: string, to: string, body: unknown) =>
    fetch(`${origin}/api/people/${to}/messages`, {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE}=${mintSession(as, SECRET)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

  const hello = { subject: 'Rota training', message: 'Can you come on Friday?' };

  it('queues the message in my name and a copy to me, and answers at once', async () => {
    const response = await write(people.officer, people.teamLead, hello);

    expect(response.status).toBe(202);

    const { rows } = await admin.query(
      `SELECT recipient_employee_id, sender_employee_id, from_name, reply_to, subject
         FROM email_outbox WHERE kind = 'DIRECT_MESSAGE' ORDER BY id`,
    );

    expect(rows).toEqual([
      {
        recipient_employee_id: people.teamLead,
        sender_employee_id: people.officer,
        from_name: 'Adwoa Frimpong via Remat Portal',
        reply_to: 'adwoa.frimpong@rematholdings.com',
        subject: 'Rota training',
      },
      {
        recipient_employee_id: people.officer,
        sender_employee_id: people.officer,
        from_name: 'Remat Portal',
        reply_to: 'kofi.boateng@rematholdings.com',
        subject: 'Copy: Rota training',
      },
    ]);
  });

  it('needs a session like everything else behind the line', async () => {
    const response = await fetch(`${origin}/api/people/${people.teamLead}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(hello),
    });

    expect(response.status).toBe(401);
  });

  it('refuses a message to myself, openly', async () => {
    expect((await write(people.officer, people.officer, hello)).status).toBe(403);
  });

  it('answers somebody who has left as nobody, so it cannot be used to learn who has', async () => {
    expect((await write(people.officer, people.leaver, hello)).status).toBe(404);
    expect((await write(people.officer, '999999', hello)).status).toBe(404);
  });

  it('names the box that is missing', async () => {
    const response = await write(people.officer, people.teamLead, { subject: '', message: 'Hi' });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'InvalidMessage', field: 'subject' });
  });

  it('allows ten an hour, and says so on the eleventh', async () => {
    for (let sent = 0; sent < 10; sent += 1) {
      expect((await write(people.officer, people.teamLead, hello)).status).toBe(202);
    }

    const eleventh = await write(people.officer, people.teamLead, hello);

    expect(eleventh.status).toBe(429);
    expect(((await eleventh.json()) as { message: string }).message).toContain('10 messages');
  });
});

describe('the email log', () => {
  it('is an HR Administrator’s to read', async () => {
    const response = await get('/api/email-log', people.headOfHr);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ emails: [] });
  });

  it('is refused to an employee, openly', async () => {
    expect((await get('/api/email-log', people.officer)).status).toBe(403);
  });
});

async function aPhoto(options: { withLocation?: boolean; colour?: string } = {}): Promise<Buffer> {
  const image = sharp({
    create: { width: 1200, height: 900, channels: 3, background: options.colour ?? '#c08040' },
  }).jpeg();

  return (
    options.withLocation
      ? image.withExifMerge({
          IFD0: { Make: 'PhoneCo', Model: 'Phone 12', ImageDescription: 'Home, Accra' },
          IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '5/1 36/1 0/1' },
        })
      : image
  ).toBuffer();
}

/** Somebody, signed in as `as`, putting up a photo on `whose` record. */
function putPhoto(
  as: string,
  whose: string,
  content: Buffer,
  crop?: string,
  contentType = 'image/jpeg',
): Promise<Response> {
  return fetch(`${origin}/api/people/${whose}/photo`, {
    method: 'PUT',
    headers: {
      cookie: `${SESSION_COOKIE}=${mintSession(as, SECRET)}`,
      'content-type': contentType,
      ...(crop === undefined ? {} : { 'x-photo-crop': crop }),
    },
    body: content,
  });
}

/** The bytes at a photo's address, read as somebody. */
async function imageAt(address: string | undefined, as: string): Promise<Buffer> {
  const response = await get(address ?? '/api/photos/none', as);

  expect(response.status).toBe(200);

  return Buffer.from(await response.arrayBuffer());
}

/** The storage keys on somebody's photo row. */
async function keysOf(employeeId: string): Promise<string[]> {
  const { rows } = await admin.query<{ thumbnail_key: string; profile_key: string }>(
    'SELECT thumbnail_key, profile_key FROM employee_photo WHERE employee_id = $1',
    [employeeId],
  );

  return rows.flatMap((row) => [row.thumbnail_key, row.profile_key]);
}

interface JsonColleague extends JsonEntry {
  manager: { employeeId: string; firstName: string; lastName: string } | null;
  reports: { employeeId: string; firstName: string; lastName: string }[];
  notListed: { reason: string; startDate: string; exitDate: string | null } | null;
}

interface JsonDirectory {
  today: string;
  people: JsonEntry[];
  departments: { id: string; name: string }[];
}

interface JsonChartPerson {
  employeeId: string;
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  reports: JsonChartPerson[];
}

interface JsonChart {
  today: string;
  lines: { standing: string; top: JsonChartPerson }[];
  total: number;
}

async function chartAs(employeeId: string): Promise<JsonChart> {
  const response = await get('/api/directory/chart', employeeId);

  expect(response.status).toBe(200);

  return (await response.json()) as JsonChart;
}

/** Every line drawn under somebody, as "manager -> report". */
function linesOf(person: JsonChartPerson, above: string | null): string[] {
  return [
    `${above} -> ${person.employeeId}`,
    ...person.reports.flatMap((report) => linesOf(report, person.employeeId)),
  ];
}

function get(path: string, employeeId: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: { cookie: `${SESSION_COOKIE}=${mintSession(employeeId, SECRET)}` },
  });
}

async function directoryAs(employeeId: string): Promise<JsonDirectory> {
  const response = await get('/api/directory', employeeId);

  expect(response.status).toBe(200);

  return (await response.json()) as JsonDirectory;
}

async function profileAs(employeeId: string): Promise<JsonProfile> {
  const response = await get('/api/me/profile', employeeId);

  expect(response.status).toBe(200);

  return (await response.json()) as JsonProfile;
}

/** Somebody, signed in as `as`, reading `whose` profile. */
async function colleagueAs(as: string, whose: string): Promise<JsonColleague> {
  const response = await get(`/api/directory/people/${whose}`, as);

  expect(response.status).toBe(200);

  return (await response.json()) as JsonColleague;
}

/** Somebody, signed in as `as`, changing the profile on `whose` record. */
function patch(as: string, whose: string, body: unknown): Promise<Response> {
  return fetch(`${origin}/api/people/${whose}/profile`, {
    method: 'PATCH',
    headers: {
      cookie: `${SESSION_COOKIE}=${mintSession(as, SECRET)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

/** The directory as it reads on one day. */
function directoryOn(today: string): Promise<Directory> {
  const employees = new EmployeeRepository(db);

  return new DirectoryService(
    guard,
    employees,
    new DepartmentRepository(db),
    new PhotoRepository(db),
    new AwayTodayService(
      new LeaveRequestRepository(db),
      employees,
      new WorkPatternRepository(db),
      new HolidayRepository(db),
    ),
    () => today,
  ).read(asAdwoa());
}

function entryOf(directory: Directory, employeeId: string) {
  const entry = directory.people.find((one) => one.employeeId === employeeId);

  if (entry === undefined) {
    throw new Error(`${employeeId} is not in the directory.`);
  }

  return entry;
}

function week(from: string, to: string) {
  return {
    employeeId: people.officer,
    leaveTypeId: annualId,
    from,
    to,
    reason: 'A week away',
    acknowledgesShortNotice: true,
  };
}

/** Asked for and agreed at every desk: annual leave sits with the manager, then with HR. */
async function agreed(employeeId: string, actor: Actor, from: string, to: string) {
  const { request } = await requests.submit(actor, { ...week(from, to), employeeId });

  const first = await requests.approve(asKofi(), request.id);

  if (first.request.status !== 'APPROVED') {
    await requests.approve(
      signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false }),
      request.id,
    );
  }
}

function asAdwoa(): Actor {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

function asAbena(): Actor {
  return signedInAs(people.partTimer, { roles: ['EMPLOYEE'], isManager: false });
}

/** Kofi Boateng, who manages both of them. */
function asKofi(): Actor {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

function grant(employeeId: string, days: number) {
  return balances.grantTheYear(system, {
    employeeId,
    leaveTypeId: annualId,
    leaveYearId: y2026,
    days,
    reason: 'Entitlement for the year',
  });
}
