import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { databaseForThisFile } from '../setup/test-database.js';
import { signedInAs, theSystem } from '../../src/core/auth/actor.js';
import { Guard } from '../../src/core/auth/policy.js';
import { databaseFor } from '../../src/core/db/index.js';
import type { Database } from '../../src/core/db/schema.js';
import type { ApproverRole } from '../../src/apps/leave/leave-type/approval-chain.js';
import {
  ApprovalChainChanged,
  type NewLeaveRequest,
} from '../../src/apps/leave/leave-request/leave-request.js';
import type { LeaveYear } from '../../src/apps/leave/leave-year/leave-year.js';
import { AttachmentRepository } from '../../src/apps/leave/leave-request/attachment.db.js';
import { ReclassificationRepository } from '../../src/apps/leave/leave-request/reclassification.db.js';
import { BalanceRepository } from '../../src/apps/leave/balance/balance.db.js';
import { EmployeeRepository } from '../../src/core/organisation/employee/employee.db.js';
import { HolidayRepository } from '../../src/apps/leave/holiday/holiday.db.js';
import { LeaveDecisionRepository } from '../../src/apps/leave/leave-request/leave-decision.db.js';
import { LeaveRequestRepository } from '../../src/apps/leave/leave-request/leave-request.db.js';
import { LeaveRoutingRepository } from '../../src/apps/leave/leave-request/routing.db.js';
import { WithdrawalRepository } from '../../src/apps/leave/leave-request/withdrawal.db.js';
import { LeaveTypeRepository } from '../../src/apps/leave/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../../src/apps/leave/leave-year/leave-year.db.js';
import { NotificationRepository } from '../../src/apps/leave/notification/notification.db.js';
import { OrganisationRepository } from '../../src/core/organisation/settings/organisation.db.js';
import { RoleRepository } from '../../src/core/identity/role/role.db.js';
import { WorkPatternRepository } from '../../src/core/calendar/work-pattern/work-pattern.db.js';
import { Transactions } from '../../src/core/db/transaction.js';
import { BalanceService } from '../../src/apps/leave/balance/balance.service.js';
import { LeaveCalculatorService } from '../../src/apps/leave/leave-calculator/leave-calculator.service.js';
import { LeaveRequestService } from '../../src/apps/leave/leave-request/leave-request.service.js';
import { LeaveYearService } from '../../src/apps/leave/leave-year/leave-year.service.js';
import { NotificationService } from '../../src/apps/leave/notification/notification.service.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';
import { delegationService } from '../support/delegations.js';

/**
 * HR taken out of leave approval, and what happens to the requests it was holding.
 *
 * The migration rewrites the chains; `LeaveRequestService.closeTheHrStage` closes the HR stage
 * on anything already waiting there. What needs a database is that the stage closes through
 * the ordinary decision door: the rules the schema holds — a move explained by a decision at
 * the desk it left, every stage of the chain answered, the days taken or given back once — are
 * all asked of it.
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('HR stage integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let requests: LeaveRequestService;
let balances: BalanceService;
let routing: LeaveRoutingRepository;
let decisions: LeaveDecisionRepository;
let years: LeaveYearService;
let people: Record<string, string>;

let y2026: LeaveYear;
let annualId: string;

const FROM = '2026-03-02';
const TO = '2026-03-10';

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const yearRepository = new LeaveYearRepository(db);

  routing = new LeaveRoutingRepository(db);
  decisions = new LeaveDecisionRepository(db);
  balances = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));
  years = new LeaveYearService(yearRepository, guard);

  requests = new LeaveRequestService(
    balances,
    guard,
    employees,
    new LeaveTypeRepository(db),
    yearRepository,
    new LeaveRequestRepository(db),
    decisions,
    routing,
    new WithdrawalRepository(db),
    new ReclassificationRepository(db),
    new AttachmentRepository(db),
    new RoleRepository(db),
    delegationService(db, guard),
    new OrganisationRepository(db),
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    new NotificationService(new NotificationRepository(db), recordingMailer(), guard),
  );
});

beforeEach(async () => {
  /* FR 18. The fixture days are months behind today. */
  await admin.query('UPDATE leave_type SET max_backdate_calendar_days = 3650');

  await clear();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;
  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0].id;

  await annualLeaveGoesTo('MANAGER');
  await twentyDaysFor(people.officer);
});

afterAll(async () => {
  await clear();

  await db?.destroy();
  await admin?.end();
});

async function clear(): Promise<void> {
  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, ' +
      'attachment_access, attachment_download_link, leave_request_recalculation, leave_request_reclassification, leave_request_attachment, leave_request_decision, leave_request_reassignment, leave_request_routing, leave_request_withdrawal, leave_request_reversal, leave_cover, leave_request',
  );
}

/** As an HR Administrator would, or as the migration did. FR 31. */
async function annualLeaveGoesTo(...chain: ApproverRole[]): Promise<void> {
  await admin.query('BEGIN');
  await admin.query('DELETE FROM leave_type_approval_step WHERE leave_type_id = $1', [annualId]);

  for (const [index, desk] of chain.entries()) {
    await admin.query(
      'INSERT INTO leave_type_approval_step (leave_type_id, step_order, approver_role) ' +
        'VALUES ($1, $2, $3)',
      [annualId, index + 1, desk],
    );
  }

  await admin.query('COMMIT');
}

async function twentyDaysFor(employeeId: string): Promise<void> {
  await balances.grantTheYear(system, {
    employeeId,
    leaveTypeId: annualId,
    leaveYearId: y2026.id,
    days: 20,
    reason: 'Annual entitlement for 2026',
  });
}

function aRequest(employeeId: string): NewLeaveRequest {
  return {
    employeeId,
    leaveTypeId: annualId,
    from: FROM,
    to: TO,
    reason: 'My sister is getting married',
    acknowledgesShortNotice: true,
  };
}

function asTheOfficer() {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

/** The officer's line manager. */
function asTheirManager() {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

function asAnHrOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

function asTheChiefExecutive() {
  return signedInAs(people.ceo, { roles: ['EMPLOYEE'], isManager: true });
}

async function availableToTheOfficer(): Promise<number> {
  return (
    await balances.forOne(system, {
      employeeId: people.officer,
      leaveTypeId: annualId,
      leaveYearId: y2026.id,
    })
  ).available;
}

/** A request the manager has decided, left at HR, and then HR taken out of the chain. */
async function waitingAtHrAfterTheManager(said: 'APPROVE' | 'REFUSE'): Promise<string> {
  await annualLeaveGoesTo('MANAGER', 'HR');

  const { request } = await requests.submit(asTheOfficer(), aRequest(people.officer));

  const decided =
    said === 'APPROVE'
      ? await requests.approve(asTheirManager(), request.id)
      : await requests.refuse(asTheirManager(), request.id, 'We are short that week.');

  expect(decided.request.awaitingApprovalFrom).toBe('HR');

  await annualLeaveGoesTo('MANAGER');

  return request.id;
}

/* ------------------------------------------------------------------ the migration */

describe('the chains on a migrated database', () => {
  it('leave HR out: the manager for most types, the Chief Executive for unpaid leave', async () => {
    const { rows } = await admin.query<{ code: string; chain: string[] }>(
      `SELECT type.code, array_agg(step.approver_role ORDER BY step.step_order) AS chain
         FROM leave_type type
         JOIN leave_type_approval_step step ON step.leave_type_id = type.id
        GROUP BY type.code`,
    );

    const chains = Object.fromEntries(rows.map((row) => [row.code, row.chain]));

    expect(chains.UNPAID).toEqual(['CEO']);
    expect(chains.MAT_EXT_UNPAID).toEqual(['CEO']);
    expect(chains.SICK).toEqual(['MANAGER']);
    expect(Object.values(chains).flat()).not.toContain('HR');
  });

  /* "For now": every chain as it stood is kept, and the repair can still write HR's. */
  it('and keep the chains HR was in, to put back', async () => {
    const { rows } = await admin.query<{ chain: string[] }>(
      `SELECT array_agg(kept.approver_role ORDER BY kept.step_order) AS chain
         FROM leave_type_approval_step_with_hr kept
         JOIN leave_type type ON type.id = kept.leave_type_id
        WHERE type.code IN ('SICK', 'UNPAID')
        GROUP BY type.code
        ORDER BY type.code`,
    );

    expect(rows.map((row) => row.chain)).toEqual([
      ['MANAGER', 'HR'],
      ['HR', 'CEO'],
    ]);
  });

  it('and the repair writes the chains without HR, or with it when asked', async () => {
    await admin.query('BEGIN');
    await admin.query('DELETE FROM leave_type_approval_step WHERE leave_type_id = $1', [annualId]);
    await admin.query('SELECT ensure_statutory_approval_chains()');
    await admin.query('COMMIT');

    expect(await chainOfAnnualLeave()).toEqual(['MANAGER']);

    await admin.query('BEGIN');
    await admin.query('DELETE FROM leave_type_approval_step WHERE leave_type_id = $1', [annualId]);
    await admin.query('SELECT ensure_statutory_approval_chains(true)');
    await admin.query('COMMIT');

    expect(await chainOfAnnualLeave()).toEqual(['MANAGER', 'HR']);
  });

  async function chainOfAnnualLeave(): Promise<string[]> {
    const { rows } = await admin.query<{ approver_role: string }>(
      'SELECT approver_role FROM leave_type_approval_step WHERE leave_type_id = $1 ORDER BY step_order',
      [annualId],
    );

    return rows.map((row) => row.approver_role);
  }
});

/* ----------------------------------------------------- the manager alone decides */

describe('leave asked for now', () => {
  it('is agreed by the manager alone', async () => {
    const { request } = await requests.submit(asTheOfficer(), aRequest(people.officer));

    expect(request.awaitingApprovalFrom).toBe('MANAGER');

    const decided = await requests.approve(asTheirManager(), request.id);

    expect(decided.request.status).toBe('APPROVED');
    expect(decided.entry).not.toBeNull();
  });

  /* The Chief Executive has nobody to fall to while HR is out, so their own leave stops. */
  it('and the Chief Executive’s own leave has nobody to decide it', async () => {
    await twentyDaysFor(people.ceo);

    const { request } = await requests.submit(asTheChiefExecutive(), aRequest(people.ceo));

    expect(request.status).toBe('UNROUTABLE');
    expect(request.awaitingApprovalFrom).toBeNull();
  });
});

/* -------------------------------------------- what HR was holding when it was taken out */

describe('a request HR was holding', () => {
  it('cannot be decided at HR once the chain has dropped it', async () => {
    const id = await waitingAtHrAfterTheManager('APPROVE');

    await expect(requests.approve(asAnHrOfficer(), id)).rejects.toThrow(ApprovalChainChanged);
  });

  it('is agreed where the manager agreed it, and the days are taken', async () => {
    const id = await waitingAtHrAfterTheManager('APPROVE');

    const run = await requests.closeTheHrStage(system);

    expect(run.failed).toEqual([]);
    expect(run.leftWithHr).toEqual([]);
    expect(run.closed.map(({ request }) => [request.id, request.status])).toEqual([
      [id, 'APPROVED'],
    ]);
    expect(run.closed[0].entry).toMatchObject({ entryType: 'DEDUCTION' });

    /* The HR stage closed by nobody, saying why, after the manager's own decision. */
    const [managers, closing] = await decisions.forRequest(id);

    expect(managers).toMatchObject({ action: 'APPROVE', onBehalfOf: 'MANAGER' });
    expect(closing).toMatchObject({
      action: 'APPROVE',
      onBehalfOf: 'HR',
      decidedByEmployeeId: null,
    });
    expect(closing.comment).toContain('HR no longer approves leave');
  });

  it('is turned down where the manager turned it down, and the days come back', async () => {
    const id = await waitingAtHrAfterTheManager('REFUSE');

    const run = await requests.closeTheHrStage(system);

    expect(run.closed.map(({ request }) => [request.id, request.status])).toEqual([
      [id, 'REFUSED'],
    ]);
    expect(await availableToTheOfficer()).toBe(20);
  });

  /* Unpaid leave went HR then the Chief Executive: nobody has decided it yet, so it moves on. */
  it('goes on to the Chief Executive where HR was the first stage, deciding nothing', async () => {
    await annualLeaveGoesTo('HR', 'CEO');

    const { request } = await requests.submit(asTheOfficer(), aRequest(people.officer));

    expect(request.awaitingApprovalFrom).toBe('HR');

    await annualLeaveGoesTo('CEO');

    const run = await requests.closeTheHrStage(system);

    expect(
      run.closed.map(({ request: moved }) => [moved.status, moved.awaitingApprovalFrom]),
    ).toEqual([['SUBMITTED', 'CEO']]);
    expect(run.closed[0].entry).toBeNull();

    const decided = await requests.approve(asTheChiefExecutive(), request.id);

    expect(decided.request.status).toBe('APPROVED');
  });

  /* A recorded skip is never reconsidered, so HR is still the desk that answers this one. */
  it('is left with HR where a recorded skip sends a stage there', async () => {
    await annualLeaveGoesTo('HR');

    const { request } = await requests.submit(asTheOfficer(), aRequest(people.officer));

    await admin.query(
      `INSERT INTO leave_request_routing (leave_request_id, stage, routed_to, because)
       VALUES ($1, 'MANAGER', 'HR', 'Skipped before HR was taken out of leave approval.')`,
      [request.id],
    );

    await annualLeaveGoesTo('MANAGER');

    const run = await requests.closeTheHrStage(system);

    expect(run.closed).toEqual([]);
    expect(run.leftWithHr.map((left) => left.id)).toEqual([request.id]);
    expect((await requests.byId(system, request.id)).awaitingApprovalFrom).toBe('HR');
  });

  it('and a second run finds nothing left to close', async () => {
    await waitingAtHrAfterTheManager('APPROVE');

    await requests.closeTheHrStage(system);

    expect(await requests.closeTheHrStage(system)).toEqual({
      closed: [],
      leftWithHr: [],
      failed: [],
    });
  });

  /* It is a company-wide sweep, so it is the roles that read every record. */
  it('is not something an employee may run', async () => {
    await expect(requests.closeTheHrStage(asTheOfficer())).rejects.toThrow();
  });
});
