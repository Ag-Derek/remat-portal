import type { Kysely } from 'kysely';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { seed } from '../../seeds/seed.mjs';
import { type Database, databaseFor } from '../../src/core/db/index.js';
import { ClientsRoleRepository } from '../../src/apps/clients/role.db.js';
import { type Asker, type ClientsApp, startClientsApp } from '../support/clients-app.js';
import { tickEveryCheck } from '../support/clients-checks.js';
import { recordingDenials } from '../support/recording-denials.js';

/**
 * A deal's and a POC's checks, ticked and unticked over HTTP against a real database. #284,
 * Clients SRS CLI 40, CLI 41.
 */

const testDatabaseUrl = await databaseForThisFile();

const denials = recordingDenials();

let db: Kysely<Database>;
let admin: Client;
let app: ClientsApp;
let people: Record<string, string>;
let products: Record<string, string>;

let bdManager: Asker;
let associate: Asker;
let otherAssociate: Asker;
let nobody: Asker;

/** ADB, a bank, owned by the BD manager. */
let adb: string;

interface TickJson {
  ticked: boolean;
  by: { id: string; name: string };
  at: string;
}

interface CheckJson {
  id: string;
  group: string;
  label: string;
  pocOnly: boolean;
  ticked: boolean;
  latest: TickJson | null;
}

interface ChecklistJson {
  on: 'DEAL' | 'POC';
  id: string;
  checks: CheckJson[];
  may: { tick: boolean };
}

interface ProblemJson {
  error: string;
  message: string;
  field?: string;
}

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);
  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();
  app = await startClientsApp(db, denials);
});

beforeEach(async () => {
  people = (await seed(admin)) as Record<string, string>;

  const grants = new ClientsRoleRepository(db);
  await grants.grant(people.commercialDirector, 'BD_MANAGER', people.headOfHr, 'them');
  await grants.grant(people.officer, 'ASSOCIATE', people.headOfHr, 'them');
  await grants.grant(people.opsDirector, 'ASSOCIATE', people.headOfHr, 'them');

  bdManager = { employeeId: people.commercialDirector };
  associate = { employeeId: people.officer };
  otherAssociate = { employeeId: people.opsDirector };
  nobody = { employeeId: people.engineer };

  await admin.query('UPDATE clients_product SET retired_on = NULL');
  await admin.query('UPDATE clients_product_line SET retired_on = NULL');
  const { rows } = await admin.query<{ id: string; name: string }>(
    'SELECT id, name FROM clients_product',
  );
  products = Object.fromEntries(rows.map((row) => [row.name, row.id]));

  const client = await app.send('POST', '/api/clients/clients', bdManager, {
    name: 'ADB',
    typeId: (
      await admin.query<{ id: string }>(`SELECT id FROM clients_client_type WHERE name = 'Bank'`)
    ).rows[0].id,
  });
  adb = ((await client.json()) as { id: string }).id;

  denials.clear();
});

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await admin?.end();
});

/**
 * A deal at ADB, opened and owned by the associate, moved on to `stage`. Past Qualification, its
 * criteria are ticked on the way, as the gate into Negotiation asks (#284).
 */
async function aDeal(product = 'Federation', stage = 'QUALIFICATION'): Promise<string> {
  const response = await app.send('POST', '/api/clients/opportunities', associate, {
    clientId: adb,
    productId: products[product],
  });
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };

  if (stage === 'DISCOVERY') {
    return id;
  }

  await moved(id, 'QUALIFICATION');
  if (stage !== 'QUALIFICATION') {
    await tickEveryCheck(admin, id);
    await moved(id, stage);
  }
  return id;
}

async function moved(id: string, toStage: string): Promise<void> {
  const response = await app.send('POST', `/api/clients/opportunities/${id}/stage`, associate, {
    toStage,
  });
  expect(response.status).toBe(200);
}

async function checklistOf(path: string, as: Asker = associate): Promise<ChecklistJson> {
  const response = await app.send('GET', path, as);
  expect(response.status).toBe(200);
  return (await response.json()) as ChecklistJson;
}

function tick(as: Asker, checkId: string, ticked: unknown): Promise<globalThis.Response> {
  return app.send('POST', `/api/clients/checks/${checkId}/tick`, as, { ticked });
}

async function ticked(as: Asker, checkId: string, to: boolean): Promise<ChecklistJson> {
  const response = await tick(as, checkId, to);
  expect(response.status).toBe(200);
  return (await response.json()) as ChecklistJson;
}

async function refused(response: globalThis.Response, status: number): Promise<ProblemJson> {
  expect(response.status).toBe(status);
  return (await response.json()) as ProblemJson;
}

async function nameOf(employeeId: string): Promise<string> {
  const { rows } = await admin.query<{ name: string }>(
    `SELECT first_name || ' ' || last_name AS name FROM employee WHERE id = $1`,
    [employeeId],
  );
  return rows[0].name;
}

function checkNamed(checklist: ChecklistJson, label: string): CheckJson {
  const found = checklist.checks.find((check) => check.label === label);
  if (found === undefined) throw new Error(`No check "${label}".`);
  return found;
}

/* ------------------------------------------------------------------- reading them */

describe("a deal's checklist", () => {
  /* CLI 40. */
  it('lists its criteria and gates in order, none ticked, for anybody with a role', async () => {
    const deal = await aDeal();
    const checklist = await checklistOf(
      `/api/clients/opportunities/${deal}/checks`,
      otherAssociate,
    );

    expect(checklist).toMatchObject({ on: 'DEAL', id: deal, may: { tick: false } });
    expect(checklist.checks.map((check) => check.group)).toEqual([
      ...Array<string>(6).fill('QUALIFICATION'),
      ...Array<string>(8).fill('PRE_POC'),
    ]);
    expect(checklist.checks[0]).toMatchObject({
      label:
        'All three stakeholders identified (decision maker, COO, IT contact), each committed to three review meetings',
      pocOnly: true,
      ticked: false,
      latest: null,
    });
    expect((await checklistOf(`/api/clients/opportunities/${deal}/checks`)).may.tick).toBe(true);
  });

  /* CLI 43. */
  it('is empty on a line with no checklist', async () => {
    const deal = await aDeal('CreditStudio');

    expect((await checklistOf(`/api/clients/opportunities/${deal}/checks`)).checks).toEqual([]);
  });

  it('is nothing to somebody with no clients role', async () => {
    const deal = await aDeal();

    expect(
      (await app.send('GET', `/api/clients/opportunities/${deal}/checks`, nobody)).status,
    ).toBe(404);
  });
});

/* -------------------------------------------------------------- ticking and unticking */

describe('ticking a check', () => {
  /* CLI 41: who and when, every one kept. */
  it('records who ticked and unticked it, and when, keeping every one', async () => {
    const deal = await aDeal();
    const check = checkNamed(
      await checklistOf(`/api/clients/opportunities/${deal}/checks`),
      'Point person identified',
    );

    const after = await ticked(associate, check.id, true);
    expect(checkNamed(after, 'Point person identified')).toMatchObject({
      ticked: true,
      latest: { ticked: true, by: { id: people.officer, name: await nameOf(people.officer) } },
    });

    const again = await ticked(bdManager, check.id, false);
    expect(checkNamed(again, 'Point person identified')).toMatchObject({
      ticked: false,
      latest: { ticked: false, by: { id: people.commercialDirector } },
    });

    const history = (await (
      await app.send('GET', `/api/clients/checks/${check.id}/ticks`, otherAssociate)
    ).json()) as { ticks: TickJson[] };
    expect(history.ticks.map((one) => [one.ticked, one.by.id])).toEqual([
      [false, people.commercialDirector],
      [true, people.officer],
    ]);
    expect(Date.parse(history.ticks[0].at)).not.toBeNaN();
  });

  /* The user, 23 November 2026: the history says only what moved. */
  it('is refused where it is that already', async () => {
    const deal = await aDeal();
    const check = checkNamed(
      await checklistOf(`/api/clients/opportunities/${deal}/checks`),
      'Point person identified',
    );

    expect(await refused(await tick(associate, check.id, false), 409)).toEqual({
      error: 'TickUnchanged',
      message: '"Point person identified" is not ticked already.',
    });
    await ticked(associate, check.id, true);
    expect(await refused(await tick(associate, check.id, true), 409)).toMatchObject({
      error: 'TickUnchanged',
      message: '"Point person identified" is ticked already.',
    });
  });

  it('needs to be told which, and a check that exists', async () => {
    const deal = await aDeal();
    const [check] = (await checklistOf(`/api/clients/opportunities/${deal}/checks`)).checks;

    expect(await refused(await tick(associate, check.id, 'yes'), 400)).toMatchObject({
      error: 'InvalidTick',
      field: 'ticked',
    });
    expect((await tick(associate, '999999', true)).status).toBe(404);
  });

  /* CLI 41: a deal's are its owner's or a BD manager's. */
  it("on a deal is its owner's or a BD manager's, and nobody else's", async () => {
    const deal = await aDeal();
    const [check] = (await checklistOf(`/api/clients/opportunities/${deal}/checks`)).checks;

    expect(await refused(await tick(otherAssociate, check.id, true), 403)).toEqual({
      error: 'NotAuthorised',
      message: `Only ${await nameOf(people.officer)} or a BD manager can tick this.`,
    });
    expect((await tick(nobody, check.id, true)).status).toBe(404);
    await ticked(bdManager, check.id, true);
  });

  /* The user, 23 November 2026: recorded, and the deal stays where it is. */
  it('can be undone after its gate was passed, which moves nothing', async () => {
    const deal = await aDeal('Federation', 'NEGOTIATION');
    const [check] = (await checklistOf(`/api/clients/opportunities/${deal}/checks`)).checks;
    expect(check.ticked).toBe(true);

    await ticked(associate, check.id, false);

    const { rows } = await admin.query<{ stage: string }>(
      'SELECT stage FROM clients_opportunity WHERE id = $1',
      [deal],
    );
    expect(rows[0].stage).toBe('NEGOTIATION');
  });

  /* The user, 23 November 2026: nothing is judged by them once it has ended. */
  it('is refused once the deal has ended, and the screen is told so', async () => {
    const deal = await aDeal();
    const [check] = (await checklistOf(`/api/clients/opportunities/${deal}/checks`)).checks;
    const reasons = (await (await app.send('GET', '/api/clients/reasons', associate)).json()) as {
      LOST: { id: string }[];
    };
    const lost = await app.send('POST', `/api/clients/opportunities/${deal}/lose`, associate, {
      reasonId: reasons.LOST[0].id,
    });
    expect(lost.status).toBe(200);

    expect(await refused(await tick(associate, check.id, true), 409)).toMatchObject({
      error: 'OpportunityEnded',
    });
    expect((await checklistOf(`/api/clients/opportunities/${deal}/checks`, bdManager)).may).toEqual(
      { tick: false },
    );
  });
});

/* ------------------------------------------------------------------- a POC's checks */

describe("a POC's checklist", () => {
  /** A Federation deal signed with a POC, which starts it (#285). Its POC's id. */
  async function aPoc(): Promise<string> {
    const deal = await aDeal('Federation', 'NEGOTIATION');
    expect(
      (await app.send('PATCH', `/api/clients/opportunities/${deal}`, associate, { hasPoc: true }))
        .status,
    ).toBe(200);
    await moved(deal, 'CONTRACT_SIGNED');

    const { rows } = await admin.query<{ poc_id: string }>(
      'SELECT poc_id FROM clients_opportunity WHERE id = $1',
      [deal],
    );
    return rows[0].poc_id;
  }

  /* CLI 40, CLI 41: its three phases; its CS lead's, its deal owner's or a BD manager's. */
  it("lists its three phases, and is its CS lead's or a BD manager's to tick", async () => {
    const poc = await aPoc();
    const checklist = await checklistOf(`/api/clients/pocs/${poc}/checks`);

    expect(checklist).toMatchObject({ on: 'POC', id: poc, may: { tick: true } });
    expect([...new Set(checklist.checks.map((check) => check.group))]).toEqual([
      'FOUNDATION',
      'DEEPENING',
      'CONVERTING',
    ]);

    const kickoff = checkNamed(checklist, 'Kickoff delivered');
    expect(checkNamed(await ticked(associate, kickoff.id, true), 'Kickoff delivered').ticked).toBe(
      true,
    );
    await ticked(bdManager, kickoff.id, false);
    expect(await refused(await tick(otherAssociate, kickoff.id, true), 403)).toMatchObject({
      error: 'NotAuthorised',
    });
  });
});
