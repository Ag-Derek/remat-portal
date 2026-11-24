import type { Kysely } from 'kysely';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { PINNED_DATE } from '../setup/pinned-date.js';
import { seed } from '../../seeds/seed.mjs';
import { type Database, databaseFor } from '../../src/core/db/index.js';
import { ClientsRoleRepository } from '../../src/apps/clients/role.db.js';
import { type Asker, type ClientsApp, startClientsApp } from '../support/clients-app.js';
import { intoItsPoc } from '../support/clients-poc.js';
import { recordingDenials } from '../support/recording-denials.js';

/**
 * The dashboard, over HTTP against a real database. #289, Clients SRS CLI 102.
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
let nobody: Asker;

interface Money {
  amountMinor: number;
  currency: string;
}

interface Standing {
  reason: string;
  exitDate: string | null;
}

interface Named {
  id: string;
  client: { id: string; name: string };
  productName: string;
}

interface DashboardJson {
  totals: { recorded: Money[]; opportunities: number; noValue: number };
  reassign: {
    person: { id: string; name: string };
    standing: Standing;
    clients: { id: string; name: string }[];
    deals: Named[];
    pocs: Named[];
  }[];
  stages: { stage: string; opportunities: number; recorded: Money[]; noValue: number }[];
  quiet: { id: string; name: string; lastContact: string; daysAgo: number }[];
  neverContacted: number;
  pocs: {
    health: Record<string, number>;
    attention: { id: string; health: string; client: { name: string } }[];
  };
}

function dayFrom(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
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

  bdManager = { employeeId: people.commercialDirector };
  associate = { employeeId: people.officer };
  nobody = { employeeId: people.engineer };

  await admin.query('UPDATE clients_product SET retired_on = NULL');
  await admin.query('UPDATE clients_product_line SET retired_on = NULL');
  const { rows } = await admin.query<{ id: string; name: string }>(
    'SELECT id, name FROM clients_product',
  );
  products = Object.fromEntries(rows.map((row) => [row.name, row.id]));

  denials.clear();
});

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await admin?.end();
});

async function aClient(name: string, as: Asker = associate): Promise<string> {
  const response = await app.send('POST', '/api/clients/clients', as, {
    name,
    typeId: (
      await admin.query<{ id: string }>(`SELECT id FROM clients_client_type WHERE name = 'Bank'`)
    ).rows[0].id,
  });
  expect(response.status).toBe(201);

  return ((await response.json()) as { id: string }).id;
}

async function aDeal(
  client: string,
  product = 'CreditStudio',
  more: Record<string, unknown> = {},
  as: Asker = associate,
): Promise<string> {
  const response = await app.send('POST', '/api/clients/opportunities', as, {
    clientId: client,
    productId: products[product],
    ...more,
  });
  expect(response.status).toBe(201);

  return ((await response.json()) as { id: string }).id;
}

/** A call with the client, logged on the day it happened, not against any one deal. */
async function aCall(client: string, on: string, kind = 'CALL') {
  const response = await app.send('POST', '/api/clients/activities', associate, {
    clientId: client,
    kind,
    happenedOn: on,
  });
  expect(response.status).toBe(201);
}

async function dashboardOf(as: Asker): Promise<DashboardJson> {
  const response = await app.send('GET', '/api/clients/dashboard', as);
  expect(response.status).toBe(200);

  return (await response.json()) as DashboardJson;
}

describe('the dashboard', () => {
  it('totals the whole pipeline, and each open stage on its own', async () => {
    const adb = await aClient('ADB');
    await aDeal(adb, 'CreditStudio', {
      value: { amount: '75600', currency: 'USD' },
      probability: 70,
    });
    await aDeal(adb, 'OnboardStudio', {
      value: { amount: '40000', currency: 'GHS' },
      probability: 25,
    });
    await aDeal(adb, 'MicroStudio');

    const { totals, stages } = await dashboardOf(associate);

    expect(totals).toMatchObject({
      recorded: [
        { currency: 'GHS', amountMinor: 4_000_000 },
        { currency: 'USD', amountMinor: 7_560_000 },
      ],
      opportunities: 3,
      noValue: 1,
    });
    expect(stages.map((one) => one.stage)).toEqual([
      'DISCOVERY',
      'QUALIFICATION',
      'PROPOSAL',
      'NEGOTIATION',
      'CONTRACT_SIGNED',
      'POC',
    ]);
    expect(stages[0]).toEqual({
      stage: 'DISCOVERY',
      opportunities: 3,
      recorded: totals.recorded,
      noValue: 1,
    });
    expect(stages[1]).toMatchObject({ opportunities: 0, recorded: [] });
  });

  it('lists clients with an open deal gone quiet, and counts those never spoken to', async () => {
    const quiet = await aClient('Republic Bank');
    const recent = await aClient('ADB');
    const never = await aClient('GT Bank');
    const noDeal = await aClient('Fincap');
    for (const client of [quiet, recent, never]) {
      await aDeal(client);
    }

    await aCall(quiet, dayFrom(PINNED_DATE, -50));
    /* A note is not contact. */
    await aCall(quiet, dayFrom(PINNED_DATE, -2), 'NOTE');
    await aCall(recent, dayFrom(PINNED_DATE, -60));
    await aCall(recent, dayFrom(PINNED_DATE, -30));
    /* No open deal, so not on the dashboard, however quiet. */
    await aCall(noDeal, dayFrom(PINNED_DATE, -90));

    const dashboard = await dashboardOf(bdManager);

    expect(dashboard.quiet).toEqual([
      { id: quiet, name: 'Republic Bank', lastContact: dayFrom(PINNED_DATE, -50), daysAgo: 50 },
    ]);
    expect(dashboard.neverContacted).toBe(1);
  });

  it('counts running POCs by health, and lists those needing a look', async () => {
    const adb = await aClient('ADB');
    const fine = await intoItsPoc(admin, await aDeal(adb, 'Federation'));
    const risky = await intoItsPoc(admin, await aDeal(adb, 'Cloud9'));

    const set = await app.send('POST', `/api/clients/pocs/${risky}/health`, associate, {
      health: 'AT_RISK',
    });
    expect(set.status).toBe(201);

    const { pocs } = await dashboardOf(associate);

    expect(pocs.health).toEqual({ ON_TRACK: 1, AT_RISK: 1, STALLED: 0 });
    expect(pocs.attention.map((poc) => [poc.id, poc.health])).toEqual([[risky, 'AT_RISK']]);
    expect(pocs.attention.map((poc) => poc.id)).not.toContain(fine);
  });

  it('is the same for an associate and a BD manager', async () => {
    await aDeal(await aClient('ADB'));

    expect(await dashboardOf(associate)).toEqual(await dashboardOf(bdManager));
  });

  it('is refused silently to somebody with no role', async () => {
    expect((await app.send('GET', '/api/clients/dashboard', nobody)).status).toBe(404);
  });
});

/* ------------------------------------------------------------ needing reassignment, CLI 96 */

describe('what needs reassigning (CLI 96)', () => {
  const YESTERDAY = dayFrom(PINNED_DATE, -1);

  /** The associate's things: a client, an open deal, a running POC, and a deal they lost. */
  async function theirThings() {
    const ecobank = await aClient('Ecobank');
    const credit = await aDeal(ecobank, 'CreditStudio');
    const poc = await intoItsPoc(admin, await aDeal(ecobank, 'Federation'));
    const lost = await aDeal(ecobank, 'OnboardStudio');
    const reason = (
      await admin.query<{ id: string }>(
        `SELECT id FROM clients_reason WHERE applies_to = 'LOST' ORDER BY id LIMIT 1`,
      )
    ).rows[0].id;
    expect(
      (
        await app.send('POST', `/api/clients/opportunities/${lost}/lose`, associate, {
          reasonId: reason,
        })
      ).status,
    ).toBe(200);
    const federation = (
      await admin.query<{ opportunity: string }>(
        'SELECT id AS opportunity FROM clients_opportunity WHERE poc_id = $1',
        [poc],
      )
    ).rows[0].opportunity;

    /* The BD manager's, who has not gone anywhere. */
    await aDeal(await aClient('ADB', bdManager), 'CreditStudio', {}, bdManager);

    return { ecobank, credit, federation, poc, lost };
  }

  it("lists nobody while everybody's owner is here and holds a role", async () => {
    await theirThings();

    expect((await dashboardOf(bdManager)).reassign).toEqual([]);
  });

  /* The issue's done-when: a departed associate's deals show up as needing reassignment. */
  it("shows a departed associate's client, open deals and POC, everywhere they are listed", async () => {
    const { ecobank, credit, federation, poc } = await theirThings();
    /* They left yesterday; the hourly sweep has not ended their grant yet. */
    await admin.query('UPDATE employee SET exit_date = $2 WHERE id = $1', [
      people.officer,
      YESTERDAY,
    ]);
    const left = { reason: 'LEFT', exitDate: YESTERDAY };

    const { reassign } = await dashboardOf(bdManager);
    expect(reassign).toEqual([
      {
        person: { id: people.officer, name: expect.any(String) as string },
        standing: left,
        /* #289. The BD manager may move it all at once. */
        mayMoveAll: true,
        clients: [{ id: ecobank, name: 'Ecobank' }],
        deals: [
          { id: credit, client: { id: ecobank, name: 'Ecobank' }, productName: 'CreditStudio' },
          { id: federation, client: { id: ecobank, name: 'Ecobank' }, productName: 'Federation' },
        ],
        pocs: [{ id: poc, client: { id: ecobank, name: 'Ecobank' }, productName: 'Federation' }],
      },
    ]);

    /* On the company pipeline, against each of their deals and nobody else's. */
    const pipeline = (await (
      await app.send('GET', '/api/clients/pipeline/company', bdManager)
    ).json()) as { deals: { deal: { id: string }; ownerStanding: Standing | null }[] };
    expect(
      Object.fromEntries(pipeline.deals.map((entry) => [entry.deal.id, entry.ownerStanding])),
    ).toMatchObject({ [credit]: left, [federation]: left });
    expect(pipeline.deals.filter((entry) => entry.ownerStanding === null)).toHaveLength(1);

    /* On the client's page, and the POC's. */
    const page = (await (
      await app.send('GET', `/api/clients/clients/${ecobank}`, bdManager)
    ).json()) as { ownerStanding: Standing | null };
    expect(page.ownerStanding).toEqual(left);
    const pocPage = (await (
      await app.send('GET', `/api/clients/pocs/${poc}`, bdManager)
    ).json()) as { csLeadStanding: Standing | null };
    expect(pocPage.csLeadStanding).toEqual(left);
  });

  it('flags somebody suspended, who keeps their role, and somebody whose role was revoked', async () => {
    await theirThings();
    await admin.query(`UPDATE employee SET employment_status = 'SUSPENDED' WHERE id = $1`, [
      people.officer,
    ]);

    expect((await dashboardOf(bdManager)).reassign.map((one) => one.standing)).toEqual([
      { reason: 'SUSPENDED', exitDate: null },
    ]);

    await admin.query(`UPDATE employee SET employment_status = 'ACTIVE' WHERE id = $1`, [
      people.officer,
    ]);
    await admin.query(
      `UPDATE clients_role SET ended_at = now(), ended_by = $2, ended_reason = 'REVOKED'
        WHERE employee_id = $1 AND ended_at IS NULL`,
      [people.officer, people.headOfHr],
    );

    expect((await dashboardOf(bdManager)).reassign.map((one) => one.standing)).toEqual([
      { reason: 'NO_ROLE', exitDate: null },
    ]);
  });
});
