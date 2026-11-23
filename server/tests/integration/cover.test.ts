import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { databaseForThisFile } from '../setup/test-database.js';
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
import { CoverRepository } from '../../src/apps/leave/cover/cover.db.js';
import { CoverService } from '../../src/apps/leave/cover/cover.service.js';
import { hrStillApprovesLeave } from '../support/hr-approves.js';

/**
 * Who covers for somebody while they are on leave. #226.
 *
 * Over HTTP and against the leave tables, the claims the issue is done on:
 *
 *   **Someone on leave shows who to contact instead**, on their profile and in the list, and
 *   only while the leave is agreed and under way.
 *
 *   **The cover is told they have been named**, once.
 *
 *   **Leave that ends takes its cover with it**, straight away, whichever door ended it.
 *
 * Adwoa asks for a week in November. Kofi manages her and Abena. Efua is HR. Kojo has left.
 */

const testDatabaseUrl = await databaseForThisFile();

const SECRET = 'a-test-signing-secret-of-at-least-32-chars';

const system = theSystem('cover integration fixtures');

const WEEK = { from: '2026-11-02', to: '2026-11-06' };

let db: Kysely<Database>;
let admin: Client;
let server: Server;
let origin: string;
let guard: Guard;
const denials = recordingDenials();
let balances: BalanceService;
let requests: LeaveRequestService;
let people: Record<string, string>;
let annualId: string;
let y2026: string;

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
    covers: new CoverRepository(db),
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

  await admin.query('TRUNCATE leave_balance, email_outbox, email_opt_out');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, attachment_access, attachment_download_link, leave_request_recalculation, leave_request_reclassification, leave_request_attachment, leave_request_decision, leave_request_reassignment, leave_request_routing, leave_request_withdrawal, leave_request_reversal, leave_cover, leave_request',
  );

  people = (await seed(admin)) as Record<string, string>;
  /* The chains as they were while HR approved leave, which is what this file proves. */
  await hrStillApprovesLeave(admin);

  annualId = (await admin.query<{ id: string }>("SELECT id FROM leave_type WHERE code = 'ANNUAL'"))
    .rows[0].id;
  y2026 = (await admin.query<{ id: string }>("SELECT id FROM leave_year WHERE label = '2026'"))
    .rows[0].id;

  await grant(people.officer, 20);
  await grant(people.partTimer, 16);
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

/* ------------------------------------------------------------------ naming cover */

describe('naming cover on a leave request', () => {
  it('names a colleague for the whole leave, and answers with who they are', async () => {
    const id = await asked(people.officer, WEEK);

    const response = await putCover(people.officer, id, [{ coverId: people.partTimer, ...WEEK }]);
    const plan = (await response.json()) as JsonPlan;

    expect(response.status).toBe(200);
    expect(plan.parts).toEqual([
      {
        coverId: people.partTimer,
        ...WEEK,
        cover: expect.objectContaining({ firstName: 'Abena' }) as unknown,
      },
    ]);
    expect(plan.mayChange).toBe(true);
    expect((await planAs(people.officer, id)).parts).toHaveLength(1);
  });

  it('names different colleagues for different parts of the leave', async () => {
    const id = await asked(people.officer, WEEK);

    const plan = (await (
      await putCover(people.officer, id, [
        { coverId: people.partTimer, from: '2026-11-02', to: '2026-11-03' },
        { coverId: people.teamLead, from: '2026-11-04', to: '2026-11-06' },
      ])
    ).json()) as JsonPlan;

    expect(plan.parts.map((part) => [part.coverId, part.from, part.to])).toEqual([
      [people.partTimer, '2026-11-02', '2026-11-03'],
      [people.teamLead, '2026-11-04', '2026-11-06'],
    ]);
  });

  it('cannot be the person on leave', async () => {
    const id = await asked(people.officer, WEEK);

    const response = await putCover(people.officer, id, [{ coverId: people.officer, ...WEEK }]);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'CoverIsTheAbsentee', field: 'coverId' });
  });

  it('cannot be somebody who has left', async () => {
    const id = await asked(people.officer, WEEK);

    const response = await putCover(people.officer, id, [{ coverId: people.leaver, ...WEEK }]);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'CoverNotAtTheCompany' });
  });

  it('cannot be somebody leaving before the cover ends', async () => {
    await admin.query(
      `UPDATE employee SET employment_status = 'TERMINATED', exit_date = '2026-11-04' WHERE id = $1`,
      [people.partTimer],
    );
    const id = await asked(people.officer, WEEK);

    const response = await putCover(people.officer, id, [{ coverId: people.partTimer, ...WEEK }]);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { message: string }).message).toContain(
      'leaves the company on 4 November 2026',
    );
  });

  it('offers only current staff, never the person themselves, and suggests their manager', async () => {
    const response = await get('/api/cover/colleagues', people.officer);
    const choices = (await response.json()) as {
      colleagues: { employeeId: string }[];
      suggestedId: string | null;
    };
    const offered = choices.colleagues.map((one) => one.employeeId);

    expect(response.status).toBe(200);
    expect(offered).toContain(people.partTimer);
    expect(offered).not.toContain(people.officer);
    expect(offered).not.toContain(people.leaver);
    expect(choices.suggestedId).toBe(people.teamLead);
  });

  it('is cleared by naming nobody', async () => {
    const id = await asked(people.officer, WEEK);
    await putCover(people.officer, id, [{ coverId: people.partTimer, ...WEEK }]);

    const cleared = (await (await putCover(people.officer, id, [])).json()) as JsonPlan;

    expect(cleared.parts).toEqual([]);
    expect(await standingRows(id)).toEqual([]);
  });
});

/* -------------------------------------------------------------- who may name it */

describe('who may name cover', () => {
  it('is the person’s manager, for their direct report', async () => {
    const id = await asked(people.officer, WEEK);

    expect(
      (await putCover(people.teamLead, id, [{ coverId: people.partTimer, ...WEEK }])).status,
    ).toBe(200);
  });

  it('is HR', async () => {
    const id = await asked(people.officer, WEEK);

    expect(
      (await putCover(people.hrOfficer, id, [{ coverId: people.partTimer, ...WEEK }])).status,
    ).toBe(200);
  });

  it('is not a colleague, who gets the same 404 as a request that is nobody, logged', async () => {
    const id = await asked(people.officer, WEEK);

    const refused = await putCover(people.partTimer, id, [{ coverId: people.partTimer, ...WEEK }]);
    const nobody = await putCover(people.partTimer, '999999', [
      { coverId: people.teamLead, ...WEEK },
    ]);

    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual(await nobody.json());
    expect(denials.last()).toMatchObject({
      employeeId: people.partTimer,
      resource: 'leave cover',
      action: 'name',
    });
    expect(await standingRows(id)).toEqual([]);
  });

  it('and a colleague cannot read it either', async () => {
    const id = await asked(people.officer, WEEK);

    expect((await get(`/api/requests/${id}/cover`, people.partTimer)).status).toBe(404);
  });
});

/* ------------------------------------------------------------- the cover is told */

describe('telling the cover', () => {
  it('queues one email to the colleague named, saying whose leave and when', async () => {
    const id = await asked(people.officer, WEEK);

    await putCover(people.officer, id, [{ coverId: people.partTimer, ...WEEK }]);

    const sent = await coverEmails();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ recipient_employee_id: people.partTimer });
    expect(sent[0].subject).toBe(
      'Adwoa Frimpong has named you as cover from 2 November 2026 to 6 November 2026',
    );
  });

  it('does not tell them twice when the same cover is saved again', async () => {
    const id = await asked(people.officer, WEEK);
    const cover = [{ coverId: people.partTimer, ...WEEK }];

    await putCover(people.officer, id, cover);
    await putCover(people.officer, id, cover);

    expect(await coverEmails()).toHaveLength(1);
  });

  it('tells each colleague named for a part', async () => {
    const id = await asked(people.officer, WEEK);

    await putCover(people.teamLead, id, [
      { coverId: people.partTimer, from: '2026-11-02', to: '2026-11-03' },
      { coverId: people.hrOfficer, from: '2026-11-04', to: '2026-11-06' },
    ]);

    expect((await coverEmails()).map((one) => one.recipient_employee_id).sort()).toEqual(
      [people.partTimer, people.hrOfficer].sort(),
    );
  });

  it('leaves out somebody who turned the email off', async () => {
    await admin.query(`INSERT INTO email_opt_out (employee_id, email) VALUES ($1, 'COVER_NAMED')`, [
      people.partTimer,
    ]);
    const id = await asked(people.officer, WEEK);

    expect(
      (await putCover(people.officer, id, [{ coverId: people.partTimer, ...WEEK }])).status,
    ).toBe(200);
    expect(await coverEmails()).toEqual([]);
  });
});

/* --------------------------------------------------------- a cover who is away too */

describe('a cover who is on leave for some of those days', () => {
  it('is warned about with the days, and the cover is still named', async () => {
    const theirs = await asked(people.partTimer, { from: '2026-11-05', to: '2026-11-06' });
    expect(theirs).toBeDefined();
    const id = await asked(people.officer, WEEK);

    const plan = (await (
      await putCover(people.officer, id, [{ coverId: people.partTimer, ...WEEK }])
    ).json()) as JsonPlan;

    expect(plan.parts).toHaveLength(1);
    expect(plan.clashes).toEqual([
      { coverId: people.partTimer, from: '2026-11-05', to: '2026-11-06' },
    ]);
  });

  it('is said before there is a request to name them on', async () => {
    await asked(people.partTimer, { from: '2026-11-05', to: '2026-11-06' });

    const response = await get(
      `/api/cover/clashes?coverId=${people.partTimer}&from=2026-11-02&to=2026-11-06`,
      people.officer,
    );

    expect(await response.json()).toEqual({
      clashes: [{ coverId: people.partTimer, from: '2026-11-05', to: '2026-11-06' }],
    });
  });
});

/* ----------------------------------------------------------- ends with the leave */

describe('leave that ends', () => {
  it('takes its cover with it when withdrawn', async () => {
    const id = await asked(people.officer, WEEK);
    await putCover(people.officer, id, [{ coverId: people.partTimer, ...WEEK }]);

    await requests.withdraw(asAdwoa(), id);

    expect(await standingRows(id)).toEqual([]);
    expect(await endedBecause(id)).toEqual(['LEAVE_ENDED']);
  });

  it('takes its cover with it when HR cancels it', async () => {
    const id = await asked(people.officer, WEEK);
    await putCover(people.officer, id, [{ coverId: people.partTimer, ...WEEK }]);

    await requests.cancel(asEfua(), id);

    expect(await standingRows(id)).toEqual([]);
  });

  /* Annual leave goes manager then HR, and a refusal is the answer only at the last desk. */
  it('keeps its cover while a refusal is handed on, and loses it when it is turned down', async () => {
    const id = await asked(people.officer, WEEK);
    await putCover(people.officer, id, [{ coverId: people.partTimer, ...WEEK }]);

    await requests.refuse(asKofi(), id, 'The team is short that week');

    expect(await standingRows(id)).toHaveLength(1);

    await requests.refuse(asEfua(), id, 'The team is short that week');

    expect(await standingRows(id)).toEqual([]);
  });

  it('then refuses new cover, saying the leave has ended', async () => {
    const id = await asked(people.officer, WEEK);
    await requests.withdraw(asAdwoa(), id);

    const response = await putCover(people.officer, id, [{ coverId: people.partTimer, ...WEEK }]);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'CoverCannotBeChanged' });
  });

  /* Agreed leave taken off the books, FR 47: asked for by the person, granted by HR. */
  it('and agreed leave taken off the books stops showing it in the directory at once', async () => {
    const id = await agreed(people.officer, asAdwoa(), WEEK);
    await putCover(people.officer, id, [{ coverId: people.partTimer, ...WEEK }]);

    expect(entryOf(await directoryOn('2026-11-04'), people.officer).cover?.employeeId).toBe(
      people.partTimer,
    );

    await requests.askToWithdraw(asAdwoa(), id, 'Plans changed');
    await beforeTheWeekStarts(() => requests.grantWithdrawal(asEfua(), id));

    expect(entryOf(await directoryOn('2026-11-04'), people.officer).cover).toBeNull();
    expect(await standingRows(id)).toEqual([]);
  });
});

describe('leave whose dates change', () => {
  it('keeps its cover, cut to the new dates', async () => {
    const id = await asked(people.officer, WEEK);
    await putCover(people.officer, id, [
      { coverId: people.partTimer, from: '2026-11-02', to: '2026-11-03' },
      { coverId: people.teamLead, from: '2026-11-04', to: '2026-11-06' },
    ]);

    const { request } = await requests.change(asAdwoa(), id, {
      from: '2026-11-03',
      to: '2026-11-05',
      acknowledgesShortNotice: true,
    });

    const plan = await planAs(people.officer, request.id);

    expect(plan.parts.map((part) => [part.coverId, part.from, part.to])).toEqual([
      [people.partTimer, '2026-11-03', '2026-11-03'],
      [people.teamLead, '2026-11-04', '2026-11-05'],
    ]);
    expect(await standingRows(id)).toEqual([]);
    /* Already told when they were named; the new dates are the same naming. */
    expect(await coverEmails()).toHaveLength(2);
  });
});

/* ----------------------------------------------------------- what the directory shows */

describe('the directory', () => {
  it('names the cover beside somebody on agreed leave today, and on their profile', async () => {
    const id = await agreed(people.officer, asAdwoa(), WEEK);
    await putCover(people.officer, id, [{ coverId: people.partTimer, ...WEEK }]);

    const service = directoryServiceOn('2026-11-04');
    const entry = entryOf(await service.read(asKofi()), people.officer);
    const profile = await service.person(asKofi(), people.officer);

    expect(entry.backOn).toBe('2026-11-09');
    expect(entry.cover).toMatchObject({ employeeId: people.partTimer, firstName: 'Abena' });
    expect(profile.cover).toMatchObject({ employeeId: people.partTimer });
  });

  it('names nobody while the leave is still being decided', async () => {
    const id = await asked(people.officer, WEEK);
    await putCover(people.officer, id, [{ coverId: people.partTimer, ...WEEK }]);

    expect(entryOf(await directoryOn('2026-11-04'), people.officer).cover).toBeNull();
  });

  it('names nobody before the leave starts or after it ends', async () => {
    const id = await agreed(people.officer, asAdwoa(), WEEK);
    await putCover(people.officer, id, [{ coverId: people.partTimer, ...WEEK }]);

    expect(entryOf(await directoryOn('2026-10-30'), people.officer).cover).toBeNull();
    expect(entryOf(await directoryOn('2026-11-09'), people.officer).cover).toBeNull();
  });

  it('names whoever covers that day, where the cover is split', async () => {
    const id = await agreed(people.officer, asAdwoa(), WEEK);
    await putCover(people.officer, id, [
      { coverId: people.partTimer, from: '2026-11-02', to: '2026-11-03' },
      { coverId: people.teamLead, from: '2026-11-05', to: '2026-11-06' },
    ]);

    expect(entryOf(await directoryOn('2026-11-02'), people.officer).cover?.employeeId).toBe(
      people.partTimer,
    );
    expect(entryOf(await directoryOn('2026-11-04'), people.officer).cover).toBeNull();
    expect(entryOf(await directoryOn('2026-11-06'), people.officer).cover?.employeeId).toBe(
      people.teamLead,
    );
  });

  it('names nobody once the cover has left the company', async () => {
    const id = await agreed(people.officer, asAdwoa(), WEEK);
    await putCover(people.officer, id, [{ coverId: people.partTimer, ...WEEK }]);

    await admin.query(
      `UPDATE employee SET employment_status = 'TERMINATED', exit_date = '2026-11-03' WHERE id = $1`,
      [people.partTimer],
    );

    const entry = entryOf(await directoryOn('2026-11-04'), people.officer);

    expect(entry.backOn).toBe('2026-11-09');
    expect(entry.cover).toBeNull();
  });

  it('shows the cover who they are covering for, and when, on their own profile', async () => {
    const agreedId = await agreed(people.officer, asAdwoa(), WEEK);
    await putCover(people.officer, agreedId, [
      { coverId: people.partTimer, from: '2026-11-02', to: '2026-11-03' },
    ]);

    const mine = await directoryServiceOn('2026-10-29').mine(asAbena());

    expect(mine.covering).toEqual([
      {
        person: expect.objectContaining({
          employeeId: people.officer,
          firstName: 'Adwoa',
        }) as unknown,
        from: '2026-11-02',
        to: '2026-11-03',
        agreed: true,
      },
    ]);
  });

  it('and over HTTP, on /me/profile and in the list', async () => {
    const id = await asked(people.officer, WEEK);
    await putCover(people.officer, id, [{ coverId: people.partTimer, ...WEEK }]);

    const mine = (await (await get('/api/me/profile', people.partTimer)).json()) as {
      covering: { person: { employeeId: string }; agreed: boolean }[];
    };
    const list = (await (await get('/api/directory', people.partTimer)).json()) as {
      people: { employeeId: string; cover: unknown }[];
    };

    expect(mine.covering).toMatchObject([
      { person: { employeeId: people.officer }, agreed: false },
    ]);
    /* Still being decided, so nobody is pointed at anybody yet. */
    expect(list.people.find((one) => one.employeeId === people.officer)?.cover).toBeNull();
  });
});

/* --------------------------------------------------------- what the database holds */

describe('the database', () => {
  it('refuses cover by the person on leave, whoever writes it', async () => {
    const id = await asked(people.officer, WEEK);

    await expect(
      admin.query(
        `INSERT INTO leave_cover (leave_request_id, cover_employee_id, starts_on, ends_on)
         VALUES ($1, $2, '2026-11-02', '2026-11-06')`,
        [id, people.officer],
      ),
    ).rejects.toMatchObject({ constraint: 'leave_cover_is_somebody_else' });
  });

  it('refuses two people covering one day', async () => {
    const id = await asked(people.officer, WEEK);
    await putCover(people.officer, id, [{ coverId: people.partTimer, ...WEEK }]);

    await expect(
      admin.query(
        `INSERT INTO leave_cover (leave_request_id, cover_employee_id, starts_on, ends_on)
         VALUES ($1, $2, '2026-11-06', '2026-11-06')`,
        [id, people.teamLead],
      ),
    ).rejects.toMatchObject({ constraint: 'leave_cover_one_person_a_day' });
  });

  it('only ever ends a row, and never deletes one', async () => {
    const id = await asked(people.officer, WEEK);
    await putCover(people.officer, id, [{ coverId: people.partTimer, ...WEEK }]);

    await expect(
      admin.query(`UPDATE leave_cover SET ends_on = '2026-11-03' WHERE leave_request_id = $1`, [
        id,
      ]),
    ).rejects.toMatchObject({ constraint: 'leave_cover_is_never_rewritten' });
    await expect(
      admin.query('DELETE FROM leave_cover WHERE leave_request_id = $1', [id]),
    ).rejects.toThrow(/never deleted/);
  });

  it('records who named it', async () => {
    const id = await asked(people.officer, WEEK);
    await putCover(people.teamLead, id, [{ coverId: people.partTimer, ...WEEK }]);

    const { rows } = await admin.query<{ named_by_employee_id: string }>(
      'SELECT named_by_employee_id::text FROM leave_cover WHERE leave_request_id = $1',
      [id],
    );

    expect(rows).toEqual([{ named_by_employee_id: people.teamLead }]);
  });
});

/* --------------------------------------------------------------------------- helpers */

interface JsonPlan {
  parts: { coverId: string; from: string; to: string; cover: { firstName: string } }[];
  clashes: { coverId: string; from: string; to: string }[];
  mayChange: boolean;
}

function get(path: string, employeeId: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: { cookie: `${SESSION_COOKIE}=${mintSession(employeeId, SECRET)}` },
  });
}

function putCover(
  as: string,
  requestId: string,
  parts: { coverId: string; from: string; to: string }[],
): Promise<Response> {
  return fetch(`${origin}/api/requests/${requestId}/cover`, {
    method: 'PUT',
    headers: {
      cookie: `${SESSION_COOKIE}=${mintSession(as, SECRET)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ parts }),
  });
}

async function planAs(as: string, requestId: string): Promise<JsonPlan> {
  const response = await get(`/api/requests/${requestId}/cover`, as);

  expect(response.status).toBe(200);

  return (await response.json()) as JsonPlan;
}

async function standingRows(requestId: string): Promise<unknown[]> {
  return (
    await admin.query(
      'SELECT id FROM leave_cover WHERE leave_request_id = $1 AND ended_at IS NULL',
      [requestId],
    )
  ).rows;
}

async function endedBecause(requestId: string): Promise<string[]> {
  return (
    await admin.query<{ ended_because: string }>(
      'SELECT ended_because FROM leave_cover WHERE leave_request_id = $1 ORDER BY id',
      [requestId],
    )
  ).rows.map((row) => row.ended_because);
}

async function coverEmails(): Promise<{ recipient_employee_id: string; subject: string }[]> {
  return (
    await admin.query<{ recipient_employee_id: string; subject: string }>(
      `SELECT recipient_employee_id::text, subject FROM email_outbox
        WHERE kind = 'COVER_NAMED' ORDER BY id`,
    )
  ).rows;
}

function directoryServiceOn(today: string): DirectoryService {
  const employees = new EmployeeRepository(db);
  const leave = new LeaveRequestRepository(db);

  return new DirectoryService(
    guard,
    employees,
    new DepartmentRepository(db),
    new PhotoRepository(db),
    new AwayTodayService(
      leave,
      employees,
      new WorkPatternRepository(db),
      new HolidayRepository(db),
    ),
    () => today,
    new CoverService(guard, new CoverRepository(db), leave, employees, undefined, () => today),
  );
}

function directoryOn(today: string) {
  return directoryServiceOn(today).read(asAdwoa());
}

function entryOf(directory: { people: { employeeId: string }[] }, employeeId: string) {
  const entry = (
    directory.people as {
      employeeId: string;
      backOn: string | null;
      cover: { employeeId: string } | null;
    }[]
  ).find((one) => one.employeeId === employeeId);

  if (entry === undefined) {
    throw new Error(`${employeeId} is not in the directory.`);
  }

  return entry;
}

/** Asked for, and still being decided. */
async function asked(employeeId: string, period: { from: string; to: string }): Promise<string> {
  const { request } = await requests.submit(
    signedInAs(employeeId, { roles: ['EMPLOYEE'], isManager: false }),
    {
      employeeId,
      leaveTypeId: annualId,
      ...period,
      reason: 'A week away',
      acknowledgesShortNotice: true,
    },
  );

  return request.id;
}

/** Asked for and agreed at every desk: annual leave sits with the manager, then with HR. */
async function agreed(
  employeeId: string,
  actor: Actor,
  period: { from: string; to: string },
): Promise<string> {
  const { request } = await requests.submit(actor, {
    employeeId,
    leaveTypeId: annualId,
    ...period,
    reason: 'A week away',
    acknowledgesShortNotice: true,
  });

  const first = await requests.approve(asKofi(), request.id);

  if (first.request.status !== 'APPROVED') {
    await requests.approve(asEfua(), request.id);
  }

  return request.id;
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

/** Efua Owusu, HR. */
function asEfua(): Actor {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
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

/**
 * Runs `act` on a day before the fixture week starts. FR 47.
 *
 * Granted before its first day, agreed leave is withdrawn whole; from then on it is amended,
 * which needs a reason. The service reads the wall clock, and the fixture week is fixed.
 */
async function beforeTheWeekStarts<T>(act: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-30T09:00:00Z'));

  try {
    return await act();
  } finally {
    vi.useRealTimers();
  }
}
