import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs } from '../../src/core/auth/actor.js';
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
import { DirectoryService } from '../../src/apps/directory/directory.service.js';
import { PhotoRepository } from '../../src/apps/directory/photo.db.js';
import { EmployeeService } from '../../src/core/organisation/employee/employee.service.js';
import { currentDate, dayAfter, dayBefore } from '../../src/core/calendar/time.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { recordingDenials } from '../support/recording-denials.js';
import { seed } from '../../seeds/seed.mjs';
import { holidayRecalculationService } from '../support/holiday-recalculations.js';
import { delegationService } from '../support/delegations.js';

/**
 * HR's Administration tab, over HTTP. Issue 222.
 *
 * The three claims the story is done on:
 *
 *   **HR can add somebody, and they appear in the directory on their start date.**
 *
 *   **An exit date cannot be saved while the person still has reports.**
 *
 *   **Anybody who is not HR is answered 403 on every administration route.**
 *
 * And the rest of what the tab does: duplicates refused, the manager picker, moving reports,
 * the audit trail, leavers kept, and the hand-off to whoever creates the login.
 */

const testDatabaseUrl = await databaseForThisFile();

const SECRET = 'a-test-signing-secret-of-at-least-32-chars';

/* The suite supplies its own rather than reading ALLOWED_EMAIL_DOMAINS, which is not set in CI. */
const DOMAINS = ['rematholdings.com'];

/** The day the server judges by, which these tests cannot choose. */
const TODAY = currentDate();

let db: Kysely<Database>;
let admin: Client;
let server: Server;
let origin: string;
let guard: Guard;
const denials = recordingDenials();
let people: Record<string, string>;
let departments: Record<string, string>;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  guard = new Guard(denials);
  const employees = new EmployeeRepository(db);
  const accounts = new SignInAccountRepository(db);
  const roles = new RoleRepository(db);
  const cached = new BalanceRepository(db);
  const balances = new BalanceService(cached, guard, employees, new Transactions(db));
  const types = new LeaveTypeRepository(db);
  const years = new LeaveYearRepository(db);
  const leaveRequests = new LeaveRequestRepository(db);
  const decisions = new LeaveDecisionRepository(db);
  const patterns = new WorkPatternRepository(db);

  const requests = new LeaveRequestService(
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
    roles,
    delegationService(db, guard),
    new OrganisationRepository(db),
    new LeaveCalculatorService(patterns, new HolidayRepository(db), guard),
    new NotificationService(new NotificationRepository(db), recordingMailer(), guard),
  );

  const app = buildApp({
    /* One person asks far more of this file than of the limits, which directory-routes covers. */
    directoryLimits: {
      lookups: { max: Infinity, windowSeconds: 60 },
      photoUploads: { max: Infinity, windowSeconds: 60 },
    },
    guard,
    signIn: new SignInService(accounts, employees, roles, recordingMailer(), guard, {
      domains: DOMAINS,
    }),
    balances: cached,
    ledger: new LedgerRepository(db),
    adjustments: balances,
    employees,
    employeeRecords: new EmployeeService(
      employees,
      new DepartmentRepository(db),
      patterns,
      guard,
      requests,
      { domains: DOMAINS },
    ),
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
    patterns,
    holidayRecalculations: holidayRecalculationService(db, guard, balances),
    storage: new InMemoryStorage(),
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

  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, attachment_access, attachment_download_link, leave_request_recalculation, leave_request_reclassification, leave_request_attachment, leave_request_decision, leave_request_reassignment, leave_request_routing, leave_request_withdrawal, leave_request_reversal, leave_cover, leave_request',
  );

  people = (await seed(admin)) as Record<string, string>;

  departments = Object.fromEntries(
    (await admin.query<{ id: string; name: string }>('SELECT id, name FROM department')).rows.map(
      (row) => [row.name, row.id],
    ),
  );
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

describe('who may use it', () => {
  it('needs a session', async () => {
    expect((await fetch(`${origin}/api/directory/admin/people`)).status).toBe(401);
  });

  it('answers 403 to anybody who is not HR, on every route, and logs each attempt', async () => {
    const id = people.officer;

    for (const as of [people.officer, people.teamLead, people.ceo]) {
      const answers = await Promise.all([
        call('GET', '/api/directory/admin/people', as),
        call('GET', '/api/directory/admin/choices', as),
        call('GET', `/api/directory/admin/people/${id}`, as),
        call('POST', '/api/directory/admin/people', as, newcomer()),
        call('PATCH', `/api/directory/admin/people/${id}`, as, { jobTitle: 'Boss' }),
        call('POST', `/api/directory/admin/people/${people.teamLead}/reports`, as, {
          toManagerId: people.opsManager,
        }),
        call('GET', '/api/directory/admin/logins-to-create', as),
      ]);

      expect(answers.map((one) => one.status)).toEqual([403, 403, 403, 403, 403, 403, 403]);
    }

    expect(denials.entries).toHaveLength(21);
    expect(denials.entries.every((one) => one.resource === 'directory')).toBe(true);
  });

  it('answers 403 for an id that is nobody, exactly as for one that is somebody', async () => {
    const nobody = await call('GET', '/api/directory/admin/people/999999', people.officer);
    const somebody = await call('GET', `/api/directory/admin/people/${people.ceo}`, people.officer);

    expect(nobody.status).toBe(403);
    expect(await nobody.json()).toEqual(await somebody.json());
  });

  it('changes nothing when refused', async () => {
    await call('PATCH', `/api/directory/admin/people/${people.officer}`, people.officer, {
      jobTitle: 'Chief Everything Officer',
    });

    expect((await jobTitleOf(people.officer)) === 'Chief Everything Officer').toBe(false);
  });

  it('is open to both HR desks', async () => {
    expect((await call('GET', '/api/directory/admin/people', people.headOfHr)).status).toBe(200);
    expect((await call('GET', '/api/directory/admin/people', people.hrOfficer)).status).toBe(200);
  });

  it('tells the screen which tab to draw, without sending anybody’s roles', async () => {
    const hr = (await (await call('GET', '/api/directory', people.headOfHr)).json()) as {
      may: unknown;
    };
    const officer = (await (await call('GET', '/api/directory', people.officer)).json()) as {
      may: unknown;
    };

    expect(hr.may).toEqual({ administer: true, seeLoginsToCreate: true });
    expect(officer.may).toEqual({ administer: false, seeLoginsToCreate: false });
  });
});

describe('the list', () => {
  it('is everybody with a record, leavers included, with where each stands', async () => {
    const list = await listAs(people.headOfHr);
    const leaver = list.records.find((one) => one.employeeId === people.leaver);

    expect(list.records).toHaveLength(Object.keys(people).length);
    expect(leaver).toMatchObject({ standing: 'LEFT', exitDate: '2026-07-31', login: 'ACTIVE' });
  });

  it('says how many people still here report to each person', async () => {
    const list = await listAs(people.headOfHr);

    /* Adwoa and Abena. Kojo has left, and no longer counts. */
    expect(list.records.find((one) => one.employeeId === people.teamLead)?.reports).toBe(2);
  });

  it('opens a leaver’s record, which the directory hides from everybody else', async () => {
    const response = await call(
      'GET',
      `/api/directory/admin/people/${people.leaver}`,
      people.hrOfficer,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ standing: 'LEFT', firstName: 'Kojo' });
  });
});

describe('adding somebody', () => {
  it('creates the record with no login, and they appear in the directory on their start date', async () => {
    const startDate = inDays(4);
    const response = await call('POST', '/api/directory/admin/people', people.headOfHr, {
      ...newcomer(),
      startDate,
    });

    expect(response.status).toBe(201);

    const created = (await response.json()) as JsonRecord;

    expect(created).toMatchObject({ standing: 'STARTING', login: 'NONE', startDate });

    const listed = async (on: string) =>
      (await directoryOn(on)).people.some((one) => one.employeeId === created.employeeId);

    expect(await listed(TODAY)).toBe(false);
    expect(await listed(dayBefore(startDate))).toBe(false);
    expect(await listed(startDate)).toBe(true);
  });

  it('hands them to whoever creates logins, flagged when their start is within a fortnight', async () => {
    const created = (await (
      await call('POST', '/api/directory/admin/people', people.headOfHr, newcomer())
    ).json()) as JsonRecord;

    const waiting = (await (
      await call('GET', '/api/directory/admin/logins-to-create', people.headOfHr)
    ).json()) as { loginsToCreate: { person: { employeeId: string }; soon: boolean }[] };

    expect(waiting.loginsToCreate).toEqual([
      expect.objectContaining({
        person: expect.objectContaining({ employeeId: created.employeeId }),
        soon: true,
      }),
    ]);
  });

  it('refuses a missing required field, naming it', async () => {
    const withoutSurname = newcomer();
    delete withoutSurname.lastName;

    const response = await call(
      'POST',
      '/api/directory/admin/people',
      people.headOfHr,
      withoutSurname,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: 'lastName' });
  });

  it('refuses a work email somebody already has, whatever its case', async () => {
    const response = await call('POST', '/api/directory/admin/people', people.headOfHr, {
      ...newcomer(),
      workEmail: 'ADWOA.Frimpong@rematholdings.com',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'DuplicateWorkEmail',
      field: 'workEmail',
    });
  });

  it('refuses a personal address', async () => {
    const response = await call('POST', '/api/directory/admin/people', people.headOfHr, {
      ...newcomer(),
      workEmail: 'kojo@gmail.com',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: 'workEmail' });
  });

  it('refuses a manager who is not at the company today', async () => {
    const response = await call('POST', '/api/directory/admin/people', people.headOfHr, {
      ...newcomer(),
      managerId: people.leaver,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'ManagerNotCurrent', field: 'managerId' });
  });
});

describe('the manager picker', () => {
  it('offers everybody at the company today, and nobody who has left', async () => {
    const choices = (await (
      await call('GET', '/api/directory/admin/choices', people.headOfHr)
    ).json()) as {
      managers: { employeeId: string }[];
      departments: unknown[];
      patterns: unknown[];
    };
    const offered = choices.managers.map((one) => one.employeeId);

    expect(offered).toContain(people.teamLead);
    expect(offered).not.toContain(people.leaver);
    expect(choices.departments.length).toBeGreaterThan(0);
    expect(choices.patterns.length).toBeGreaterThan(0);
  });
});

describe('changing a record', () => {
  it('saves the fields HR keeps, and the audit log has the old value, the new, who and when', async () => {
    const response = await call(
      'PATCH',
      `/api/directory/admin/people/${people.officer}`,
      people.hrOfficer,
      {
        jobTitle: 'Senior Operations Officer',
        departmentId: departments.Finance,
      },
    );

    expect(response.status).toBe(200);

    const record = (await response.json()) as JsonRecord;
    const latest = record.history[0];

    expect(record).toMatchObject({
      jobTitle: 'Senior Operations Officer',
      department: { name: 'Finance' },
    });
    expect(latest?.by).toBe('Efua Owusu');
    expect(Date.parse(latest?.at ?? '')).toBeGreaterThan(Date.now() - 60_000);
    expect(latest?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Job title', to: 'Senior Operations Officer' }),
        expect.objectContaining({ label: 'Department', from: 'Operations', to: 'Finance' }),
      ]),
    );
  });

  it('refuses a field the person keeps themselves', async () => {
    const response = await call(
      'PATCH',
      `/api/directory/admin/people/${people.officer}`,
      people.headOfHr,
      {
        workMobile: '024 555 0197',
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: 'workMobile' });
  });

  it('refuses another person’s work email', async () => {
    const response = await call(
      'PATCH',
      `/api/directory/admin/people/${people.officer}`,
      people.headOfHr,
      {
        workEmail: 'abena.sarpong@rematholdings.com',
      },
    );

    expect(response.status).toBe(409);
  });

  it('is a 404 for an id that is nobody, once HR is asking', async () => {
    const response = await call('PATCH', '/api/directory/admin/people/999999', people.headOfHr, {
      jobTitle: 'Nobody',
    });

    expect(response.status).toBe(404);
  });
});

describe('an exit date', () => {
  it('cannot be saved while people still report to them, and nothing changes', async () => {
    const response = await call(
      'PATCH',
      `/api/directory/admin/people/${people.teamLead}`,
      people.headOfHr,
      {
        exitDate: inDays(30),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'StillHasReports', field: 'exitDate' });
    expect(await exitDateOf(people.teamLead)).toBeNull();
  });

  it('nor by terminating them', async () => {
    const response = await call(
      'PATCH',
      `/api/directory/admin/people/${people.teamLead}`,
      people.headOfHr,
      {
        employmentStatus: 'TERMINATED',
        exitDate: TODAY,
      },
    );

    expect(response.status).toBe(409);
  });

  it('can be saved once their reports have been moved', async () => {
    const moved = await call(
      'POST',
      `/api/directory/admin/people/${people.teamLead}/reports`,
      people.headOfHr,
      {
        toManagerId: people.opsManager,
      },
    );

    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { moved: unknown[] }).moved).toHaveLength(2);

    const saved = await call(
      'PATCH',
      `/api/directory/admin/people/${people.teamLead}`,
      people.headOfHr,
      {
        exitDate: inDays(30),
      },
    );

    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ standing: 'LEAVING', reports: 0 });
  });

  it('can be saved on somebody nobody reports to', async () => {
    const response = await call(
      'PATCH',
      `/api/directory/admin/people/${people.officer}`,
      people.headOfHr,
      {
        exitDate: inDays(30),
      },
    );

    expect(response.status).toBe(200);
  });
});

describe('moving reports', () => {
  it('moves only the ones chosen, each audited', async () => {
    const response = await call(
      'POST',
      `/api/directory/admin/people/${people.teamLead}/reports`,
      people.headOfHr,
      {
        toManagerId: people.opsManager,
        employeeIds: [people.officer],
      },
    );

    expect(response.status).toBe(200);
    expect(await managerOf(people.officer)).toBe(people.opsManager);
    expect(await managerOf(people.partTimer)).toBe(people.teamLead);

    const record = (await (
      await call('GET', `/api/directory/admin/people/${people.officer}`, people.headOfHr)
    ).json()) as JsonRecord;

    expect(record.history[0]?.changes).toEqual([
      expect.objectContaining({ label: 'Reports to', from: 'Kofi Boateng', to: 'Akosua Darko' }),
    ]);
  });

  it('refuses a manager who has left', async () => {
    const response = await call(
      'POST',
      `/api/directory/admin/people/${people.teamLead}/reports`,
      people.headOfHr,
      {
        toManagerId: people.leaver,
      },
    );

    expect(response.status).toBe(409);
    expect(await managerOf(people.officer)).toBe(people.teamLead);
  });

  it('refuses to move them to one of themselves', async () => {
    const response = await call(
      'POST',
      `/api/directory/admin/people/${people.teamLead}/reports`,
      people.headOfHr,
      {
        toManagerId: people.officer,
      },
    );

    expect(response.status).toBe(400);
    expect(await managerOf(people.partTimer)).toBe(people.teamLead);
  });
});

interface JsonRecord {
  employeeId: string;
  standing: string;
  login: string;
  startDate: string;
  history: { at: string; by: string; changes: { label: string; from: unknown; to: unknown }[] }[];
}

interface JsonList {
  records: { employeeId: string; standing: string; reports: number; exitDate: string | null }[];
}

function call(method: string, path: string, as: string, body?: unknown): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      cookie: `${SESSION_COOKIE}=${mintSession(as, SECRET)}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function listAs(as: string): Promise<JsonList> {
  const response = await call('GET', '/api/directory/admin/people', as);

  expect(response.status).toBe(200);

  return (await response.json()) as JsonList;
}

/** Somebody new, who reports to the team lead and starts in a few days. */
function newcomer(): Record<string, string | null> {
  return {
    employeeNumber: 'RH-0014',
    firstName: 'Esi',
    lastName: 'Amankwah',
    workEmail: 'esi.amankwah@rematholdings.com',
    jobTitle: 'Operations Officer',
    departmentId: departments.Operations ?? '',
    managerId: people.teamLead ?? '',
    employmentType: 'FULL_TIME',
    startDate: inDays(4),
    gender: null,
  };
}

/** The directory as it reads on one day, to somebody who is not HR. */
function directoryOn(today: string) {
  return new DirectoryService(
    guard,
    new EmployeeRepository(db),
    new DepartmentRepository(db),
    new PhotoRepository(db),
    undefined,
    () => today,
  ).read(signedInAs(people.officer ?? '', { roles: ['EMPLOYEE'], isManager: false }));
}

function inDays(days: number): string {
  let day = TODAY;

  for (let step = 0; step < days; step++) {
    day = dayAfter(day);
  }

  return day;
}

async function managerOf(employeeId: string | undefined): Promise<string | null> {
  return (
    await admin.query<{ manager_id: string | null }>(
      'SELECT manager_id FROM employee WHERE id = $1',
      [employeeId],
    )
  ).rows[0]!.manager_id;
}

async function exitDateOf(employeeId: string | undefined): Promise<string | null> {
  return (
    await admin.query<{ exit_date: string | null }>(
      "SELECT to_char(exit_date, 'YYYY-MM-DD') AS exit_date FROM employee WHERE id = $1",
      [employeeId],
    )
  ).rows[0]!.exit_date;
}

async function jobTitleOf(employeeId: string | undefined): Promise<string | null> {
  return (
    await admin.query<{ job_title: string | null }>(
      'SELECT job_title FROM employee WHERE id = $1',
      [employeeId],
    )
  ).rows[0]!.job_title;
}
