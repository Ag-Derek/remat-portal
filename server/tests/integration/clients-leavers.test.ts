import type { Kysely } from 'kysely';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { PINNED_DATE } from '../setup/pinned-date.js';
import { seed } from '../../seeds/seed.mjs';
import { type Actor, signedInAs, theSystem } from '../../src/core/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/core/auth/policy.js';
import { WorkPatternRepository } from '../../src/core/calendar/work-pattern/work-pattern.db.js';
import { type Database, databaseFor } from '../../src/core/db/index.js';
import { DepartmentRepository } from '../../src/core/organisation/department/department.db.js';
import { noLeaveFollows } from '../../src/core/organisation/employee/employee.js';
import { EmployeeRepository } from '../../src/core/organisation/employee/employee.db.js';
import { EmployeeService } from '../../src/core/organisation/employee/employee.service.js';
import { accessOf } from '../../src/apps/clients/access.js';
import { ClientsLeavers } from '../../src/apps/clients/leavers.js';
import { ClientsRoleRepository } from '../../src/apps/clients/role.db.js';
import { recordingDenials } from '../support/recording-denials.js';

/**
 * A leaver's clients grants end without anybody remembering to. #274, Clients SRS CLI 95,
 * AC L27, TDD 15 ("an associate leaving: grant ended with LEFT").
 *
 * Through HR's own door, `EmployeeService`, with clients registered as a subscriber exactly as
 * main.ts registers it, so what is proved is that the hook is called, not only that it works.
 *
 * Today is pinned at 2026-10-30 for the whole integration suite.
 */

const testDatabaseUrl = await databaseForThisFile();

let db: Kysely<Database>;
let admin: Client;
let people: Record<string, string>;
let grants: ClientsRoleRepository;
let employees: EmployeeRepository;
let records: EmployeeService;

const guard = new Guard(recordingDenials());

/** HR, who records an exit. */
let hr: Actor;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);
  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  grants = new ClientsRoleRepository(db);
  employees = new EmployeeRepository(db);

  records = new EmployeeService(
    employees,
    new DepartmentRepository(db),
    new WorkPatternRepository(db),
    guard,
    noLeaveFollows(),
    {
      domains: ['rematholdings.com'],
      subscribers: [new ClientsLeavers(guard, grants, employees)],
    },
  );
});

beforeEach(async () => {
  /* The seed empties employee with CASCADE, which empties clients_role with it. */
  people = (await seed(admin)) as Record<string, string>;
  hr = signedInAs(people.headOfHr, { roles: ['EMPLOYEE', 'HR_ADMIN'], isManager: true });
});

afterAll(async () => {
  await db?.destroy();
  await admin?.end();
});

/** Granted by the CEO, standing in for a System Administrator. */
async function grant(employeeId: string, role: 'BD_MANAGER' | 'ASSOCIATE'): Promise<string> {
  return (await grants.grant(employeeId, role, people.ceo, 'them')).id;
}

async function rowsOf(
  employeeId: string,
): Promise<
  { role: string; ended: boolean; ended_by: string | null; ended_reason: string | null }[]
> {
  return (
    await admin.query(
      `SELECT role, ended_at IS NOT NULL AS ended, ended_by, ended_reason
         FROM clients_role WHERE employee_id = $1 ORDER BY role`,
      [employeeId],
    )
  ).rows;
}

/** A sweep as the hourly job runs it, on a day of the test's choosing. */
function sweepOn(day: string) {
  return new ClientsLeavers(guard, grants, employees, () => day).sweep(
    theSystem("ending leavers' clients roles"),
  );
}

describe('an exit recorded on or after the last day', () => {
  it('ends every grant they hold there and then, as left, with nobody named', async () => {
    await grant(people.engineer, 'ASSOCIATE');
    await grant(people.engineer, 'BD_MANAGER');

    await records.terminate(hr, people.engineer, { exitDate: '2026-10-15' });

    expect(await rowsOf(people.engineer)).toEqual([
      { role: 'ASSOCIATE', ended: true, ended_by: null, ended_reason: 'LEFT' },
      { role: 'BD_MANAGER', ended: true, ended_by: null, ended_reason: 'LEFT' },
    ]);

    /* And with them, the tile and the door: they hold nothing in clients now. */
    const actor = signedInAs(people.engineer, { roles: ['EMPLOYEE'], isManager: false });
    expect(await accessOf(actor, grants)).toEqual({ holds: [] });
  });

  it('leaves everybody else’s grants alone', async () => {
    await grant(people.engineer, 'ASSOCIATE');
    await grant(people.officer, 'ASSOCIATE');

    await records.terminate(hr, people.engineer, { exitDate: '2026-10-15' });

    expect(await rowsOf(people.officer)).toEqual([
      { role: 'ASSOCIATE', ended: false, ended_by: null, ended_reason: null },
    ]);
  });
});

/* The exit recorded ahead of time: still here through the last day, gone the day after. */
describe('an exit recorded ahead of the last day', () => {
  const LAST_DAY = '2026-11-20';

  it('ends nothing when it is recorded', async () => {
    await grant(people.engineer, 'ASSOCIATE');

    await records.terminate(hr, people.engineer, { exitDate: LAST_DAY });

    expect(PINNED_DATE < LAST_DAY).toBe(true);
    expect(await rowsOf(people.engineer)).toEqual([
      { role: 'ASSOCIATE', ended: false, ended_by: null, ended_reason: null },
    ]);
  });

  it('is ended by the sweep the day after the last day, and not on it', async () => {
    await grant(people.engineer, 'ASSOCIATE');
    await records.terminate(hr, people.engineer, { exitDate: LAST_DAY });

    expect((await sweepOn(LAST_DAY)).ended).toEqual([]);
    expect((await rowsOf(people.engineer))[0].ended).toBe(false);

    const run = await sweepOn('2026-11-21');
    expect(run.ended.map((one) => [one.employeeId, one.endedReason])).toEqual([
      [people.engineer, 'LEFT'],
    ]);
    expect(await rowsOf(people.engineer)).toEqual([
      { role: 'ASSOCIATE', ended: true, ended_by: null, ended_reason: 'LEFT' },
    ]);
  });
});

describe('the sweep', () => {
  it('ends nothing the second time, and leaves a grant ended otherwise as it was', async () => {
    const revoked = await grant(people.leaver, 'BD_MANAGER');
    await grants.end(revoked, people.ceo, 'REVOKED');
    await grant(people.leaver, 'ASSOCIATE');

    /* The seed's leaver went in July. */
    expect((await sweepOn(PINNED_DATE)).ended).toHaveLength(1);
    expect((await sweepOn(PINNED_DATE)).ended).toEqual([]);

    expect(await rowsOf(people.leaver)).toEqual([
      { role: 'ASSOCIATE', ended: true, ended_by: null, ended_reason: 'LEFT' },
      { role: 'BD_MANAGER', ended: true, ended_by: people.ceo, ended_reason: 'REVOKED' },
    ]);
  });

  it('leaves somebody suspended with their grant, because they have not left', async () => {
    await grant(people.engineer, 'ASSOCIATE');

    await records.update(hr, people.engineer, { employmentStatus: 'SUSPENDED' });
    await sweepOn(PINNED_DATE);

    expect((await rowsOf(people.engineer))[0].ended).toBe(false);
  });

  it('is the system’s to run, and refused to a person, whatever they administer', async () => {
    const sysadmin = signedInAs(people.headOfHr, {
      roles: ['EMPLOYEE', 'SYS_ADMIN'],
      isManager: false,
    });

    await expect(new ClientsLeavers(guard, grants, employees).sweep(sysadmin)).rejects.toThrow(
      NotAuthorised,
    );
  });
});
