import type { Kysely } from 'kysely';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { seed } from '../../seeds/seed.mjs';
import { type Database, databaseFor } from '../../src/core/db/index.js';
import { ClientsRoleRepository } from '../../src/apps/clients/role.db.js';
import { type Asker, type ClientsApp, startClientsApp } from '../support/clients-app.js';
import { recordingDenials } from '../support/recording-denials.js';

/**
 * Deals, over HTTP against a real database. #277, Clients SRS CLI 10 to CLI 17, TDD 11.
 */

const testDatabaseUrl = await databaseForThisFile();

const denials = recordingDenials();

let db: Kysely<Database>;
let admin: Client;
let app: ClientsApp;
let people: Record<string, string>;
/** Product ids by name, as migrated. */
let products: Record<string, string>;

let bdManager: Asker;
let associate: Asker;
let sysadmin: Asker;
let nobody: Asker;

/** ADB, owned by the BD manager, so that an associate opening a deal there is not its owner. */
let adb: string;

interface DealJson {
  id: string;
  client: { id: string; name: string };
  product: { id: string; name: string; lineName: string };
  owner: { id: string; name: string };
  outcome: string;
  value: { amountMinor: number; currency: string } | null;
  probability: number | null;
  expectedClose: { half: string; year: number } | null;
  waitingOn: { on: string; note: string | null } | null;
  statedInterest: string | null;
  createdAt: string;
  /** What the person who asked may do to it. */
  may: { change: boolean };
}

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);
  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();
  app = await startClientsApp(db, denials);
});

beforeEach(async () => {
  /* The seed empties clients, and their deals, with the employees they belong to. */
  people = (await seed(admin)) as Record<string, string>;

  const grants = new ClientsRoleRepository(db);
  await grants.grant(people.commercialDirector, 'BD_MANAGER', people.headOfHr, 'them');
  await grants.grant(people.officer, 'ASSOCIATE', people.headOfHr, 'them');

  bdManager = { employeeId: people.commercialDirector };
  associate = { employeeId: people.officer };
  sysadmin = { employeeId: people.headOfHr, sysAdmin: true };
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

async function nameOf(employeeId: string): Promise<string> {
  const { rows } = await admin.query<{ name: string }>(
    `SELECT first_name || ' ' || last_name AS name FROM employee WHERE id = $1`,
    [employeeId],
  );

  return rows[0].name;
}

function open(as: Asker, body: unknown): Promise<globalThis.Response> {
  return app.send('POST', '/api/clients/opportunities', as, body);
}

async function opened(as: Asker, body: unknown): Promise<DealJson> {
  const response = await open(as, body);
  expect(response.status).toBe(201);

  return (await response.json()) as DealJson;
}

async function dealCount(): Promise<number> {
  return (await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM clients_opportunity'))
    .rows[0].n;
}

/* ------------------------------------------------------------------ opening a deal */

/* CLI 12. Any user can create one and becomes its owner. */
describe('opening a deal', () => {
  it('may be done by an associate, at a client they do not own, and they own the deal', async () => {
    const deal = await opened(associate, {
      clientId: adb,
      productId: products.CreditStudio,
      value: { amount: '125000.50', currency: 'GHS' },
      probability: 40,
      expectedClose: { half: 'H1', year: 2027 },
      waitingOn: { on: 'PROPOSAL_RESPONSE', note: 'Their board meets on the 20th' },
      statedInterest: 'Wants to move SME lending off spreadsheets.',
    });

    expect(deal).toMatchObject({
      client: { id: adb, name: 'ADB' },
      product: { id: products.CreditStudio, name: 'CreditStudio', lineName: 'Dura Capital' },
      owner: { id: people.officer, name: await nameOf(people.officer) },
      outcome: 'OPEN',
      value: { amountMinor: 12_500_050, currency: 'GHS' },
      probability: 40,
      expectedClose: { half: 'H1', year: 2027 },
      waitingOn: { on: 'PROPOSAL_RESPONSE', note: 'Their board meets on the 20th' },
      statedInterest: 'Wants to move SME lending off spreadsheets.',
    });
    expect(Date.parse(deal.createdAt)).not.toBeNaN();
  });

  it('may be done by a BD manager, who owns the deal', async () => {
    const deal = await opened(bdManager, { clientId: adb, productId: products.Cloud9 });

    expect(deal.owner.id).toBe(people.commercialDirector);
  });

  /* Moving a deal is a BD manager's, later, and not a field on opening one (CLI 92). */
  it('is owned by whoever opens it, whoever the request names', async () => {
    const deal = await opened(associate, {
      clientId: adb,
      productId: products.CreditStudio,
      ownerId: people.commercialDirector,
    });

    expect(deal.owner.id).toBe(people.officer);
  });

  /* CLI 06, CLI 10. */
  it('needs only a client and a product, and says the rest is missing rather than nought', async () => {
    const deal = await opened(associate, { clientId: adb, productId: products.CreditStudio });

    expect(deal).toMatchObject({
      value: null,
      probability: null,
      expectedClose: null,
      waitingOn: null,
      statedInterest: null,
    });
  });

  it('is found again by its id, by anybody with a role', async () => {
    const deal = await opened(associate, { clientId: adb, productId: products.CreditStudio });

    for (const as of [associate, bdManager]) {
      const response = await app.send('GET', `/api/clients/opportunities/${deal.id}`, as);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(deal);
    }
  });

  it('is on its client page, open deals first', async () => {
    const first = await opened(associate, { clientId: adb, productId: products.CreditStudio });
    await admin.query(`UPDATE clients_opportunity SET outcome = 'LOST' WHERE id = $1`, [first.id]);
    const second = await opened(bdManager, { clientId: adb, productId: products.Cloud9 });

    const page = (await (
      await app.send('GET', `/api/clients/clients/${adb}`, associate)
    ).json()) as {
      opportunities: DealJson[];
    };

    expect(page.opportunities.map((deal) => [deal.product.name, deal.outcome])).toEqual([
      ['Cloud9', 'OPEN'],
      ['CreditStudio', 'LOST'],
    ]);
    /* The associate reads it, and may not change the BD manager's deal. */
    expect(page.opportunities[0]).toEqual({ ...second, may: { change: false } });
  });

  /* NFR CLI AUD 01. */
  it('is written to the audit log as the person who opened it', async () => {
    const deal = await opened(associate, { clientId: adb, productId: products.CreditStudio });

    const { rows } = await admin.query(
      `SELECT action, actor_employee_id FROM audit_log
        WHERE entity = 'clients_opportunity' AND entity_id = $1`,
      [deal.id],
    );
    expect(rows).toEqual([{ action: 'CREATE', actor_employee_id: people.officer }]);
  });
});

/* ------------------------------------------------- one open deal per client and product */

/* CLI 11, AC L01. Done when: a second open CreditStudio deal for the same client is refused. */
describe('a second open deal for the same client and product', () => {
  it('is refused, naming the client and the product, whoever opens it', async () => {
    await opened(associate, { clientId: adb, productId: products.CreditStudio });

    for (const as of [associate, bdManager]) {
      const response = await open(as, { clientId: adb, productId: products.CreditStudio });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'OpportunityAlreadyOpen',
        message:
          'ADB already has an open CreditStudio deal. Work on that one, or end it before ' +
          'starting another.',
        field: 'productId',
      });
    }
    expect(await dealCount()).toBe(1);
  });

  it('is allowed once the first has ended', async () => {
    const first = await opened(associate, { clientId: adb, productId: products.CreditStudio });
    await admin.query(`UPDATE clients_opportunity SET outcome = 'LOST' WHERE id = $1`, [first.id]);

    expect(
      (await open(associate, { clientId: adb, productId: products.CreditStudio })).status,
    ).toBe(201);
  });

  it('leaves the client free to open deals for its other products', async () => {
    await opened(associate, { clientId: adb, productId: products.CreditStudio });

    expect(
      (await open(associate, { clientId: adb, productId: products.OnboardStudio })).status,
    ).toBe(201);
  });
});

/* ------------------------------------------------------------------ editing a deal */

/* CLI 13, AC L22. Only the owner or the BD manager can edit it. */
describe('editing a deal', () => {
  /** Another associate, who owns nothing here. */
  let colleague: Asker;
  /** The associate's deal, at ADB, with everything filled in. */
  let deal: DealJson;

  beforeEach(async () => {
    await new ClientsRoleRepository(db).grant(
      people.opsDirector,
      'ASSOCIATE',
      people.headOfHr,
      'them',
    );
    colleague = { employeeId: people.opsDirector };

    deal = await opened(associate, {
      clientId: adb,
      productId: products.CreditStudio,
      value: { amount: '60000', currency: 'USD' },
      probability: 30,
      expectedClose: { half: 'H1', year: 2027 },
      waitingOn: { on: 'DEMO' },
      statedInterest: 'Wants SME lending off spreadsheets.',
    });
    denials.clear();
  });

  function edit(as: Asker, body: unknown, id = deal.id): Promise<globalThis.Response> {
    return app.send('PATCH', `/api/clients/opportunities/${id}`, as, body);
  }

  async function asItIs(): Promise<DealJson> {
    return (await (
      await app.send('GET', `/api/clients/opportunities/${deal.id}`, associate)
    ).json()) as DealJson;
  }

  it('may be done by its owner, to every figure and word on it', async () => {
    const response = await edit(associate, {
      value: { amount: '75600', currency: 'USD' },
      probability: 60,
      expectedClose: { half: 'H2', year: 2027 },
      waitingOn: { on: 'OTHER', note: 'Bank of Ghana approval' },
      statedInterest: 'Now wants MicroStudio as well.',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...deal,
      value: { amountMinor: 7_560_000, currency: 'USD' },
      probability: 60,
      expectedClose: { half: 'H2', year: 2027 },
      waitingOn: { on: 'OTHER', note: 'Bank of Ghana approval' },
      statedInterest: 'Now wants MicroStudio as well.',
    });
  });

  it('may be done by a BD manager, to a deal that is not theirs', async () => {
    const response = await edit(bdManager, { probability: 80 });

    expect(response.status).toBe(200);
    expect(((await response.json()) as DealJson).probability).toBe(80);
  });

  /* AC L22: 403, naming the BD manager as who can. */
  it('is refused to another associate, who is told whose it is and who else can', async () => {
    const response = await edit(colleague, { probability: 90 });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'NotAuthorised',
      message: `This deal is ${await nameOf(people.officer)}'s. Only they or a BD manager can change it.`,
    });
    expect(await asItIs()).toEqual(deal);
  });

  it('is offered to its owner and a BD manager, and to nobody else', async () => {
    const may = async (as: Asker) =>
      (
        (await (
          await app.send('GET', `/api/clients/opportunities/${deal.id}`, as)
        ).json()) as DealJson
      ).may.change;

    expect(await may(associate)).toBe(true);
    expect(await may(bdManager)).toBe(true);
    expect(await may(colleague)).toBe(false);
  });

  it('changes only what it names, and takes away what it sets to null', async () => {
    const response = await edit(associate, { value: null, probability: null, waitingOn: null });

    expect(await response.json()).toEqual({
      ...deal,
      value: null,
      probability: null,
      waitingOn: null,
    });
  });

  it('never changes which client, product or owner the deal is', async () => {
    const response = await edit(bdManager, {
      clientId: '987654321',
      productId: products.Cloud9,
      ownerId: people.commercialDirector,
      outcome: 'WON',
    });

    expect(response.status).toBe(200);
    expect(await asItIs()).toEqual(deal);
  });

  it('is refused against the field to fix, and changes nothing', async () => {
    for (const [body, field] of [
      [{ probability: 101 }, 'probability'],
      [{ value: { amount: '12,000', currency: 'GHS' } }, 'value'],
      [{ expectedClose: { half: 'H1' } }, 'expectedClose'],
      [{ waitingOn: { on: 'OTHER', note: ' ' } }, 'waitingOn'],
    ] as const) {
      const response = await edit(associate, { ...body, statedInterest: 'Changed' });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { field: string }).field).toBe(field);
    }
    expect(await asItIs()).toEqual(deal);
  });

  /* CLI 55, CLI 56. */
  it('is refused once the deal has ended, to its owner and a BD manager alike', async () => {
    await admin.query(`UPDATE clients_opportunity SET outcome = 'LOST' WHERE id = $1`, [deal.id]);

    for (const as of [associate, bdManager]) {
      const response = await edit(as, { probability: 90 });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'OpportunityEnded',
        message:
          'This CreditStudio deal was lost, so it is kept as it ended. Open a new deal to take ' +
          'it up again.',
      });
    }
    expect(await asItIs()).toEqual({ ...deal, outcome: 'LOST', may: { change: false } });
  });

  /* NFR CLI AUD 01. */
  it('is written to the audit log as whoever made the change', async () => {
    await edit(bdManager, { probability: 70 });

    const { rows } = await admin.query(
      `SELECT action, actor_employee_id FROM audit_log
        WHERE entity = 'clients_opportunity' AND entity_id = $1 ORDER BY id`,
      [deal.id],
    );
    expect(rows).toEqual([
      { action: 'CREATE', actor_employee_id: people.officer },
      { action: 'UPDATE', actor_employee_id: people.commercialDirector },
    ]);
  });

  /* NFR CLI SEC 04. */
  it('is not found by somebody with no role, a System Administrator included', async () => {
    for (const as of [nobody, sysadmin]) {
      expect((await edit(as, { probability: 90 })).status).toBe(404);
    }
    expect(await asItIs()).toEqual(deal);
  });

  it('is not found for an id that is no deal', async () => {
    const response = await edit(bdManager, { probability: 90 }, '987654321');

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe('OpportunityNotFound');
  });
});

/* ------------------------------------------------------------------ what is refused */

describe('a deal that makes no sense', () => {
  async function refusal(
    body: unknown,
  ): Promise<{ status: number; error: string; field?: string }> {
    const response = await open(associate, body);
    const { error, field } = (await response.json()) as { error: string; field?: string };

    return { status: response.status, error, field };
  }

  it('is refused against the field to fix, and nothing is recorded', async () => {
    const base = { clientId: adb, productId: products.CreditStudio };

    expect(await refusal({ ...base, clientId: '987654321' })).toEqual({
      status: 400,
      error: 'InvalidOpportunity',
      field: 'clientId',
    });
    expect(await refusal({ ...base, productId: '987654321' })).toMatchObject({
      status: 400,
      field: 'productId',
    });
    expect(await refusal({ ...base, value: { amount: '100', currency: 'EUR' } })).toMatchObject({
      status: 400,
      field: 'value',
    });
    expect(await refusal({ ...base, probability: 120 })).toMatchObject({
      status: 400,
      field: 'probability',
    });
    expect(await refusal({ ...base, expectedClose: { half: 'H3', year: 2027 } })).toMatchObject({
      status: 400,
      field: 'expectedClose',
    });
    expect(await refusal({ ...base, waitingOn: { on: 'OTHER' } })).toMatchObject({
      status: 400,
      field: 'waitingOn',
    });
    expect(await dealCount()).toBe(0);
  });

  /* CLI 08. */
  it('is refused on a retired product, or one in a retired line, by name', async () => {
    await admin.query(`UPDATE clients_product SET retired_on = '2026-10-01' WHERE name = 'Cloud9'`);
    await admin.query(
      `UPDATE clients_product_line SET retired_on = '2026-10-01' WHERE name = 'Riskflow'`,
    );

    const cloud9 = await open(associate, { clientId: adb, productId: products.Cloud9 });
    expect(cloud9.status).toBe(400);
    expect(await cloud9.json()).toEqual({
      error: 'InvalidOpportunity',
      message: 'Cloud9 is retired, so it takes no new deals. Choose another product.',
      field: 'productId',
    });

    expect((await open(associate, { clientId: adb, productId: products.ALM })).status).toBe(400);
    expect(await dealCount()).toBe(0);
  });

  it('is not found by an id that is no deal', async () => {
    for (const id of ['987654321', 'not-an-id']) {
      const response = await app.send('GET', `/api/clients/opportunities/${id}`, associate);
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: string }).error).toBe('OpportunityNotFound');
    }
  });
});

/* ------------------------------------------------------------ who may not open one */

/* NFR CLI SEC 04, TDD 12.1. */
describe('somebody without a clients role', () => {
  it('is told nothing is there, and opens nothing: a System Administrator included', async () => {
    for (const as of [nobody, sysadmin]) {
      const response = await open(as, { clientId: adb, productId: products.CreditStudio });
      expect(response.status).toBe(404);
    }

    expect(await dealCount()).toBe(0);
  });

  it('cannot read a deal that exists', async () => {
    const deal = await opened(associate, { clientId: adb, productId: products.CreditStudio });

    for (const as of [nobody, sysadmin]) {
      expect((await app.send('GET', `/api/clients/opportunities/${deal.id}`, as)).status).toBe(404);
    }
  });
});

/* ------------------------------------------------------------ a deal's past values */

interface ValueChangeJson {
  value: { amountMinor: number; currency: string } | null;
  probability: number | null;
  source: string;
  changedBy: { id: string; name: string };
  changedAt: string;
}

/* #277. Every change to value or probability kept in a history. Done when: a deal's past values
   can be seen. AC L19's shape, by hand rather than by proposal. */
describe("a deal's value history", () => {
  let deal: DealJson;

  beforeEach(async () => {
    deal = await opened(associate, {
      clientId: adb,
      productId: products.CreditStudio,
      value: { amount: '60000', currency: 'USD' },
      probability: 30,
    });
  });

  async function historyOf(as: Asker = associate, id = deal.id): Promise<ValueChangeJson[]> {
    const response = await app.send('GET', `/api/clients/opportunities/${id}/history`, as);
    expect(response.status).toBe(200);

    return ((await response.json()) as { history: ValueChangeJson[] }).history;
  }

  function edit(as: Asker, body: unknown): Promise<globalThis.Response> {
    return app.send('PATCH', `/api/clients/opportunities/${deal.id}`, as, body);
  }

  /** Each row as value, probability and who, newest first. */
  async function figures(): Promise<[string | null, number | null, string][]> {
    return (await historyOf()).map((row) => [
      row.value === null ? null : `${row.value.currency} ${String(row.value.amountMinor / 100)}`,
      row.probability,
      row.changedBy.id,
    ]);
  }

  it('starts with what the deal was opened with, and who opened it', async () => {
    const [first] = await historyOf();

    expect(first).toMatchObject({
      value: { amountMinor: 6_000_000, currency: 'USD' },
      probability: 30,
      source: 'MANUAL',
      changedBy: { id: people.officer, name: await nameOf(people.officer) },
    });
    expect(Date.parse(first.changedAt)).not.toBeNaN();
  });

  it('keeps every past value and probability, newest first, with who changed each', async () => {
    await edit(associate, { value: { amount: '75600', currency: 'USD' } });
    await edit(bdManager, { probability: 60 });
    await edit(associate, { value: null });

    expect(await figures()).toEqual([
      [null, 60, people.officer],
      ['USD 75600', 60, people.commercialDirector],
      ['USD 75600', 30, people.officer],
      ['USD 60000', 30, people.officer],
    ]);

    /* The deal itself holds only what is current. */
    const now = (await (
      await app.send('GET', `/api/clients/opportunities/${deal.id}`, associate)
    ).json()) as DealJson;
    expect([now.value, now.probability]).toEqual([null, 60]);
  });

  it('adds nothing for an edit that leaves value and probability as they were', async () => {
    await edit(associate, { expectedClose: { half: 'H2', year: 2027 }, statedInterest: 'More' });
    await edit(associate, { value: { amount: '60000.00', currency: 'USD' }, probability: 30 });

    expect(await historyOf()).toHaveLength(1);
  });

  it('counts a change of currency as a change', async () => {
    await edit(associate, { value: { amount: '60000', currency: 'GHS' } });

    expect((await figures())[0]).toEqual(['GHS 60000', 30, people.officer]);
  });

  it('adds nothing for an edit that was refused', async () => {
    await new ClientsRoleRepository(db).grant(
      people.opsDirector,
      'ASSOCIATE',
      people.headOfHr,
      'them',
    );

    expect((await edit({ employeeId: people.opsDirector }, { probability: 90 })).status).toBe(403);
    expect((await edit(associate, { probability: 101 })).status).toBe(400);

    await admin.query(`UPDATE clients_opportunity SET outcome = 'LOST' WHERE id = $1`, [deal.id]);
    expect((await edit(associate, { probability: 90 })).status).toBe(409);

    expect(await historyOf()).toHaveLength(1);
  });

  /* CLI 55: an ended deal stays on the client's history, its past values with it. */
  it('can still be read once the deal has ended, by anybody with a role', async () => {
    await edit(associate, { probability: 50 });
    await admin.query(`UPDATE clients_opportunity SET outcome = 'LOST' WHERE id = $1`, [deal.id]);

    expect(await historyOf(bdManager)).toHaveLength(2);
  });

  /* NFR CLI SEC 04. */
  it('is not found by somebody with no role, or for an id that is no deal', async () => {
    for (const as of [nobody, sysadmin]) {
      expect(
        (await app.send('GET', `/api/clients/opportunities/${deal.id}/history`, as)).status,
      ).toBe(404);
    }

    const response = await app.send(
      'GET',
      '/api/clients/opportunities/987654321/history',
      associate,
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe('OpportunityNotFound');
  });
});

/* ---------------------------------------------------- what nobody has said, as missing */

/* #277, CLI 06. Missing value or probability shown as missing: null wherever the screen reads a
   deal, never nought or an empty string that the screen could not tell from a figure. A deal
   worth nothing yet, or with no chance yet, is a gap somebody can fill; one that reads as 0 looks
   complete and is not. */
describe('a value or probability nobody has given', () => {
  async function pageDeals(): Promise<DealJson[]> {
    const response = await app.send('GET', `/api/clients/clients/${adb}`, bdManager);
    expect(response.status).toBe(200);

    return ((await response.json()) as { opportunities: DealJson[] }).opportunities;
  }

  it('is null on the client page, whichever of the two is missing', async () => {
    await opened(associate, { clientId: adb, productId: products.CreditStudio });
    await opened(associate, {
      clientId: adb,
      productId: products.Cloud9,
      value: { amount: '26000', currency: 'USD' },
    });
    await opened(associate, { clientId: adb, productId: products.ALM, probability: 60 });

    const figures = Object.fromEntries(
      (await pageDeals()).map((deal) => [deal.product.name, [deal.value, deal.probability]]),
    );
    expect(figures).toEqual({
      CreditStudio: [null, null],
      Cloud9: [{ amountMinor: 2_600_000, currency: 'USD' }, null],
      ALM: [null, 60],
    });
  });

  it('is missing again once taken away, and kept as missing in its past values', async () => {
    const deal = await opened(associate, {
      clientId: adb,
      productId: products.CreditStudio,
      value: { amount: '26000', currency: 'USD' },
      probability: 60,
    });

    await app.send('PATCH', `/api/clients/opportunities/${deal.id}`, associate, {
      value: null,
      probability: null,
    });

    const [onPage] = await pageDeals();
    expect([onPage.value, onPage.probability]).toEqual([null, null]);

    const history = (
      (await (
        await app.send('GET', `/api/clients/opportunities/${deal.id}/history`, associate)
      ).json()) as { history: { value: unknown; probability: unknown }[] }
    ).history;
    expect(history.map((row) => [row.value, row.probability])).toEqual([
      [null, null],
      [{ amountMinor: 2_600_000, currency: 'USD' }, 60],
    ]);
  });

  /* Nought is a figure somebody gave, and is kept as one: it is not missing. */
  it('is told apart from a value or probability of nought', async () => {
    await opened(associate, {
      clientId: adb,
      productId: products.CreditStudio,
      value: { amount: '0', currency: 'GHS' },
      probability: 0,
    });

    const [onPage] = await pageDeals();
    expect([onPage.value, onPage.probability]).toEqual([{ amountMinor: 0, currency: 'GHS' }, 0]);
  });
});
