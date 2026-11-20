import type { Kysely } from 'kysely';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { PINNED_DATE } from '../setup/pinned-date.js';
import { seed } from '../../seeds/seed.mjs';
import { type Database, databaseFor } from '../../src/core/db/index.js';
import { ClientsRoleRepository } from '../../src/apps/clients/role.db.js';
import { type Asker, type ClientsApp, startClientsApp } from '../support/clients-app.js';
import { recordingDenials } from '../support/recording-denials.js';

/**
 * My pipeline, over HTTP against a real database. Clients SRS CLI 97, TDD 7.
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

let adb: string;
let ecobank: string;

interface PipelineJson {
  deals: {
    deal: {
      id: string;
      client: { id: string; name: string };
      product: { id: string; name: string; lineName: string };
      stage: string;
      outcome: string;
      value: { amountMinor: number; currency: string } | null;
      probability: number | null;
      waitingOn: { on: string; note: string | null } | null;
    };
    nextStep: { id: string; description: string; dueOn: string; owner: { id: string } } | null;
    lastContact: string | null;
    overdue: boolean;
  }[];
}

function dayFrom(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
}

const LAST_WEEK = dayFrom(PINNED_DATE, -7);
const YESTERDAY = dayFrom(PINNED_DATE, -1);
const TOMORROW = dayFrom(PINNED_DATE, 1);
const NEXT_WEEK = dayFrom(PINNED_DATE, 7);

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

  adb = await aClient('ADB', bdManager);
  ecobank = await aClient('Ecobank', associate);

  denials.clear();
});

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await admin?.end();
});

async function aClient(name: string, as: Asker): Promise<string> {
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
  as: Asker,
  product = 'CreditStudio',
  more: Record<string, unknown> = {},
): Promise<string> {
  const response = await app.send('POST', '/api/clients/opportunities', as, {
    clientId: client,
    productId: products[product],
    ...more,
  });
  expect(response.status).toBe(201);

  return ((await response.json()) as { id: string }).id;
}

/**
 * A step on a deal, written straight to the table: the API refuses a day already gone, and an
 * overdue step is one whose day went by after it was written.
 */
async function aStep(client: string, deal: string, dueOn: string, owner: string, what = 'Call') {
  await admin.query(
    `INSERT INTO clients_next_step
       (client_id, opportunity_id, description, due_on, owner_id, source, created_by)
     VALUES ($1, $2, $3, $4, $5, 'MANUAL', $5)`,
    [client, deal, what, dueOn, owner],
  );
}

async function anActivity(as: Asker, client: string, deal: string, kind: string, on: string) {
  const response = await app.send('POST', '/api/clients/activities', as, {
    clientId: client,
    opportunityId: deal,
    kind,
    happenedOn: on,
  });
  expect(response.status).toBe(201);
}

async function pipelineOf(as: Asker): Promise<PipelineJson['deals']> {
  const response = await app.send('GET', '/api/clients/pipeline', as);
  expect(response.status).toBe(200);

  return ((await response.json()) as PipelineJson).deals;
}

describe('my pipeline', () => {
  it('lists only my open deals, with what the pipeline shows of each', async () => {
    const mine = await aDeal(ecobank, associate, 'CreditStudio', {
      value: { amount: '125000.50', currency: 'GHS' },
      probability: 40,
      waitingOn: { on: 'PROPOSAL_RESPONSE', note: 'Board meets on the 20th' },
    });
    await aDeal(adb, bdManager, 'OnboardStudio');

    const deals = await pipelineOf(associate);

    expect(deals).toHaveLength(1);
    expect(deals[0]).toMatchObject({
      deal: {
        id: mine,
        client: { id: ecobank, name: 'Ecobank' },
        product: { name: 'CreditStudio' },
        stage: 'DISCOVERY',
        outcome: 'OPEN',
        value: { amountMinor: 12_500_050, currency: 'GHS' },
        probability: 40,
        waitingOn: { on: 'PROPOSAL_RESPONSE', note: 'Board meets on the 20th' },
      },
      /* The client's type, which the pipeline shows under its name. */
      clientType: 'Bank',
      nextStep: null,
      lastContact: null,
      overdue: false,
    });
  });

  it('leaves out deals that have ended', async () => {
    const deal = await aDeal(ecobank, associate);
    const reason = (
      await admin.query<{ id: string }>(
        `SELECT id FROM clients_reason WHERE applies_to = 'LOST' ORDER BY id LIMIT 1`,
      )
    ).rows[0].id;
    const lost = await app.send('POST', `/api/clients/opportunities/${deal}/lose`, associate, {
      reasonId: reason,
    });
    expect(lost.status).toBe(200);

    expect(await pipelineOf(associate)).toEqual([]);
  });

  it('orders by next step due, overdue first, and nothing planned last', async () => {
    const none = await aDeal(ecobank, associate, 'CreditStudio');
    const later = await aDeal(ecobank, associate, 'OnboardStudio');
    const late = await aDeal(adb, associate, 'CreditStudio');
    const today = await aDeal(adb, associate, 'OnboardStudio');

    await aStep(ecobank, later, NEXT_WEEK, people.officer);
    await aStep(adb, late, YESTERDAY, people.officer);
    await aStep(adb, today, PINNED_DATE, people.officer);

    const deals = await pipelineOf(associate);

    expect(deals.map((entry) => entry.deal.id)).toEqual([late, today, later, none]);
    expect(deals.map((entry) => entry.overdue)).toEqual([true, false, false, false]);
  });

  it("shows each deal's earliest open step, whoever's it is, and not a closed one", async () => {
    const deal = await aDeal(ecobank, associate);
    await aStep(ecobank, deal, LAST_WEEK, people.officer, 'Done already');
    await admin.query(
      `UPDATE clients_next_step SET done_at = now(), done_by = owner_id WHERE description = $1`,
      ['Done already'],
    );
    await aStep(ecobank, deal, NEXT_WEEK, people.officer, 'Later');
    await aStep(ecobank, deal, TOMORROW, people.commercialDirector, 'Sooner');

    const [entry] = await pipelineOf(associate);

    expect(entry.nextStep).toMatchObject({
      description: 'Sooner',
      dueOn: TOMORROW,
      owner: { id: people.commercialDirector },
    });
    expect(entry.overdue).toBe(false);
  });

  it('gives the last day of contact about the deal, leaving notes out', async () => {
    const deal = await aDeal(ecobank, associate);
    const other = await aDeal(ecobank, associate, 'OnboardStudio');

    await anActivity(associate, ecobank, deal, 'CALL', LAST_WEEK);
    await anActivity(associate, ecobank, deal, 'MEETING', YESTERDAY);
    await anActivity(associate, ecobank, deal, 'NOTE', PINNED_DATE);
    await anActivity(associate, ecobank, other, 'NOTE', PINNED_DATE);

    const deals = await pipelineOf(associate);

    expect(deals.find((entry) => entry.deal.id === deal)?.lastContact).toBe(YESTERDAY);
    expect(deals.find((entry) => entry.deal.id === other)?.lastContact).toBeNull();
  });

  it("is anybody with a role's, a BD manager's included, about their own deals", async () => {
    await aDeal(adb, bdManager);

    expect(await pipelineOf(bdManager)).toHaveLength(1);
    expect(await pipelineOf(associate)).toEqual([]);
  });

  it('is refused silently to somebody with no role', async () => {
    expect((await app.send('GET', '/api/clients/pipeline', nobody)).status).toBe(404);
  });
});
