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

interface Money {
  amountMinor: number;
  currency: string;
}

interface CompanyJson {
  deals: PipelineJson['deals'];
  totals: { recorded: Money[]; opportunities: number; clients: number; noValue: number };
  choices: {
    lines: { id: string; name: string; products: { id: string; name: string }[] }[];
    stages: string[];
    owners: { id: string; name: string }[];
    clientTypes: { id: string; name: string }[];
  };
}

async function companyOf(as: Asker, query = ''): Promise<CompanyJson> {
  const response = await app.send('GET', `/api/clients/pipeline/company${query}`, as);
  expect(response.status).toBe(200);

  return (await response.json()) as CompanyJson;
}

async function companyPipelineOf(as: Asker): Promise<CompanyJson['deals']> {
  return (await companyOf(as)).deals;
}

async function aBroker(name: string, as: Asker): Promise<string> {
  const response = await app.send('POST', '/api/clients/clients', as, {
    name,
    typeId: (
      await admin.query<{ id: string }>(`SELECT id FROM clients_client_type WHERE name = 'Broker'`)
    ).rows[0].id,
  });
  expect(response.status).toBe(201);

  return ((await response.json()) as { id: string }).id;
}

describe('the company pipeline', () => {
  it("lists every open deal, whoever's, with what the pipeline shows of each", async () => {
    const theirs = await aDeal(adb, bdManager, 'OnboardStudio', {
      value: { amount: '75600', currency: 'USD' },
      probability: 70,
    });
    const mine = await aDeal(ecobank, associate);
    await aStep(ecobank, mine, YESTERDAY, people.officer);

    const deals = await companyPipelineOf(associate);

    expect(deals.map((entry) => entry.deal.id)).toEqual([theirs, mine]);
    expect(deals[0]).toMatchObject({
      deal: {
        client: { id: adb, name: 'ADB' },
        product: { name: 'OnboardStudio', lineName: 'Dura Capital' },
        owner: { id: people.commercialDirector },
        stage: 'DISCOVERY',
        value: { amountMinor: 7_560_000, currency: 'USD' },
        probability: 70,
      },
      clientType: 'Bank',
    });
    expect(deals[1]).toMatchObject({ overdue: true, deal: { owner: { id: people.officer } } });
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

    expect(await companyPipelineOf(bdManager)).toEqual([]);
  });

  it('orders by client A to Z, ignoring case, then by product', async () => {
    const zenith = await aClient('zenith Bank', associate);
    const access = await aClient('Access Bank', bdManager);

    const zenithDeal = await aDeal(zenith, associate);
    const ecobankOnboard = await aDeal(ecobank, associate, 'OnboardStudio');
    const ecobankCredit = await aDeal(ecobank, bdManager, 'CreditStudio');
    const accessDeal = await aDeal(access, bdManager);
    const adbDeal = await aDeal(adb, associate);

    expect((await companyPipelineOf(bdManager)).map((entry) => entry.deal.id)).toEqual([
      accessDeal,
      adbDeal,
      ecobankCredit,
      ecobankOnboard,
      zenithDeal,
    ]);
  });

  it('is the same for a BD manager and an associate', async () => {
    await aDeal(adb, bdManager);
    await aDeal(ecobank, associate);

    expect(await companyPipelineOf(associate)).toEqual(await companyPipelineOf(bdManager));
  });

  it('is refused silently to somebody with no role', async () => {
    expect((await app.send('GET', '/api/clients/pipeline/company', nobody)).status).toBe(404);
  });
});

describe('the company pipeline, filtered (CLI 09, CLI 98)', () => {
  let durcap: string;
  let symphony: string;
  let bankType: string;
  let brokerType: string;

  beforeEach(async () => {
    const lines = await admin.query<{ id: string; name: string }>(
      'SELECT id, name FROM clients_product_line',
    );
    durcap = lines.rows.find((line) => line.name === 'Dura Capital')?.id ?? '';
    symphony = lines.rows.find((line) => line.name === 'Symphony')?.id ?? '';
    const types = await admin.query<{ id: string; name: string }>(
      'SELECT id, name FROM clients_client_type',
    );
    bankType = types.rows.find((type) => type.name === 'Bank')?.id ?? '';
    brokerType = types.rows.find((type) => type.name === 'Broker')?.id ?? '';
  });

  it('by a line, keeping every product in it, and by product, owner and client type', async () => {
    const credit = await aDeal(adb, bdManager, 'CreditStudio');
    const onboard = await aDeal(ecobank, associate, 'OnboardStudio');
    const broker = await aBroker('OA Markets', associate);
    const federation = await aDeal(broker, associate, 'Federation');

    const idsOf = async (query: string) =>
      (await companyOf(bdManager, query)).deals.map((entry) => entry.deal.id);

    expect(await idsOf(`?line=${durcap}`)).toEqual([credit, onboard]);
    expect(await idsOf(`?line=${symphony}`)).toEqual([federation]);
    expect(await idsOf(`?product=${products.OnboardStudio}`)).toEqual([onboard]);
    expect(await idsOf(`?owner=${people.officer}`)).toEqual([onboard, federation]);
    expect(await idsOf(`?clientType=${brokerType}`)).toEqual([federation]);
    expect(await idsOf(`?clientType=${bankType}&owner=${people.officer}`)).toEqual([onboard]);
    expect(await idsOf('?stage=DISCOVERY&line=&product=')).toEqual([credit, onboard, federation]);
    expect(await idsOf('?stage=PROPOSAL')).toEqual([]);
  });

  it('offers in each filter what every open deal has, whatever is filtered', async () => {
    await aDeal(adb, bdManager, 'CreditStudio');
    const broker = await aBroker('OA Markets', associate);
    await aDeal(broker, associate, 'Federation');

    const { choices } = await companyOf(associate, `?line=${durcap}`);

    expect(choices.lines.map((line) => line.name)).toEqual(['Dura Capital', 'Symphony']);
    expect(choices.lines[0].products).toEqual([
      { id: products.CreditStudio, name: 'CreditStudio' },
    ]);
    expect(choices.stages).toEqual(['DISCOVERY']);
    expect(choices.owners.map((owner) => owner.id).sort()).toEqual(
      [people.commercialDirector, people.officer].sort(),
    );
    expect(choices.clientTypes.map((type) => type.name)).toEqual(['Bank', 'Broker']);
  });

  it('refuses a filter that is not one, saying which', async () => {
    const response = await app.send('GET', '/api/clients/pipeline/company?stage=WON', associate);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'InvalidPipelineFilter', field: 'stage' });
  });
});

describe('the recorded totals (CLI 75, CLI 77)', () => {
  it('totals each currency on its own, over what is shown, and counts deals with no value', async () => {
    await aDeal(adb, bdManager, 'CreditStudio', {
      value: { amount: '75600', currency: 'USD' },
      probability: 70,
    });
    await aDeal(adb, bdManager, 'OnboardStudio', {
      value: { amount: '190000', currency: 'USD' },
    });
    await aDeal(ecobank, associate, 'CreditStudio', {
      value: { amount: '40000', currency: 'GHS' },
      probability: 25,
    });
    await aDeal(ecobank, associate, 'OnboardStudio', {
      value: { amount: '12000', currency: 'GHS' },
    });
    /* No value at all: in no total, and in no currency. */
    await aDeal(adb, bdManager, 'MicroStudio', { probability: 40 });

    expect((await companyOf(associate)).totals).toEqual({
      recorded: [
        { currency: 'GHS', amountMinor: 5_200_000 },
        { currency: 'USD', amountMinor: 26_560_000 },
      ],
      opportunities: 5,
      clients: 2,
      noValue: 1,
    });

    /* Narrowed to the bank's owner, the figures are only theirs. */
    expect((await companyOf(associate, `?owner=${people.officer}`)).totals).toEqual({
      recorded: [{ currency: 'GHS', amountMinor: 5_200_000 }],
      opportunities: 2,
      clients: 1,
      noValue: 0,
    });
  });
});

/* ---------------------------------------------- searching every client, from the company pipeline */

interface AtAGlanceJson {
  id: string;
  name: string;
  type: { id: string; name: string };
  owner: { id: string; name: string };
  openDeals: number;
  using: string[];
  lastEnded: { outcome: string; productName: string } | null;
}

async function searchOf(as: Asker): Promise<AtAGlanceJson[]> {
  const response = await app.send('GET', '/api/clients/search', as);
  expect(response.status).toBe(200);

  return ((await response.json()) as { clients: AtAGlanceJson[] }).clients;
}

describe('every client, for the search on the company pipeline', () => {
  it('lists every client by name, with or without an open deal, saying where each stands', async () => {
    /* ADB: two open deals. */
    await aDeal(adb, bdManager, 'CreditStudio');
    await aDeal(adb, bdManager, 'OnboardStudio');
    /* Ecobank: lost its only deal, and uses a product it had before. */
    const lost = await aDeal(ecobank, associate, 'CreditStudio');
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
    expect(
      (
        await app.send('POST', `/api/clients/clients/${ecobank}/products`, associate, {
          productId: products.Federation,
          sinceOn: '2025-01-01',
        })
      ).status,
    ).toBe(201);
    /* Zenith: just added, nothing yet. */
    const zenith = await aClient('zenith Bank', associate);

    const found = await searchOf(associate);

    expect(found.map((client) => client.name)).toEqual(['ADB', 'Ecobank', 'zenith Bank']);
    expect(found[0]).toMatchObject({
      id: adb,
      type: { name: 'Bank' },
      owner: { id: people.commercialDirector },
      openDeals: 2,
      using: [],
      lastEnded: null,
    });
    expect(found[1]).toMatchObject({
      id: ecobank,
      openDeals: 0,
      using: ['Federation'],
      lastEnded: { outcome: 'LOST', productName: 'CreditStudio' },
    });
    expect(found[2]).toMatchObject({ id: zenith, openDeals: 0, using: [], lastEnded: null });
  });

  it('is refused silently to somebody with no role', async () => {
    expect((await app.send('GET', '/api/clients/search', nobody)).status).toBe(404);
  });
});
