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
import { A_PDF } from '../support/sample-files.js';

/**
 * Proposals and financials, over HTTP against a real database. #281, Clients SRS CLI 59, CLI 65,
 * TDD 4.5.
 *
 * As the department sells (the user, 18 November 2026): a proposal says what Remat wants to offer
 * and names no price; the financials, sent once the client has agreed and given its requirements,
 * carry the amount that becomes the deal's value. Both are about one open deal, and are its
 * owner's or a BD manager's to log.
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
let colleague: Asker;
let nobody: Asker;

/** ADB, owned by the BD manager, and its CreditStudio deal, the associate's. */
let adb: string;
let deal: string;

interface Money {
  amountMinor: number;
  currency: string;
}

interface ActivityJson {
  id: string;
  clientId: string;
  deal: { id: string; productName: string } | null;
  kind: string;
  amount: Money | null;
  loggedAt: string;
}

interface ProblemJson {
  error: string;
  message: string;
  field?: string;
}

const YESTERDAY = dayFrom(PINNED_DATE, -1);

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
  await grants.grant(people.opsDirector, 'ASSOCIATE', people.headOfHr, 'them');

  bdManager = { employeeId: people.commercialDirector };
  associate = { employeeId: people.officer };
  colleague = { employeeId: people.opsDirector };
  nobody = { employeeId: people.engineer };

  await admin.query('UPDATE clients_product SET retired_on = NULL');
  await admin.query('UPDATE clients_product_line SET retired_on = NULL');
  const { rows } = await admin.query<{ id: string; name: string }>(
    'SELECT id, name FROM clients_product',
  );
  products = Object.fromEntries(rows.map((row) => [row.name, row.id]));

  adb = await aClient('ADB');
  deal = await aDeal(adb);

  denials.clear();
});

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await admin?.end();
});

async function typeId(name: string): Promise<string> {
  return (
    await admin.query<{ id: string }>(`SELECT id FROM clients_client_type WHERE name = $1`, [name])
  ).rows[0].id;
}

async function aClient(name: string, type = 'Bank'): Promise<string> {
  const response = await app.send('POST', '/api/clients/clients', bdManager, {
    name,
    typeId: await typeId(type),
  });
  expect(response.status).toBe(201);

  return ((await response.json()) as { id: string }).id;
}

async function aDeal(client: string, product = 'CreditStudio'): Promise<string> {
  const response = await app.send('POST', '/api/clients/opportunities', associate, {
    clientId: client,
    productId: products[product],
  });
  expect(response.status).toBe(201);

  return ((await response.json()) as { id: string }).id;
}

/** Ends the deal as lost, for a reason the lost list offers. */
async function lose(id: string): Promise<void> {
  const reason = await admin.query<{ id: string }>(
    `SELECT id FROM clients_reason WHERE applies_to = 'LOST' AND retired_on IS NULL LIMIT 1`,
  );
  const response = await app.send('POST', `/api/clients/opportunities/${id}/lose`, associate, {
    reasonId: reason.rows[0].id,
  });
  expect(response.status).toBe(200);
}

/** A proposal sent to ADB yesterday on its CreditStudio deal, with `change` over it. */
function aProposal(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientId: adb,
    opportunityId: deal,
    kind: 'PROPOSAL',
    happenedOn: YESTERDAY,
    ...change,
  };
}

/** The financials sent to ADB yesterday, USD 75,600, on its CreditStudio deal. */
function theFinancials(change: Record<string, unknown> = {}): Record<string, unknown> {
  return aProposal({
    kind: 'FINANCIALS',
    amount: { amount: '75600', currency: 'USD' },
    ...change,
  });
}

/** A call with ADB yesterday about its CreditStudio deal. */
function aCall(change: Record<string, unknown> = {}): Record<string, unknown> {
  return aProposal({ kind: 'CALL', ...change });
}

function log(as: Asker, body: unknown): Promise<globalThis.Response> {
  return app.send('POST', '/api/clients/activities', as, body);
}

async function logged(as: Asker, body: unknown): Promise<ActivityJson> {
  const response = await log(as, body);
  expect(response.status).toBe(201);

  return ((await response.json()) as { activity: ActivityJson }).activity;
}

function correct(as: Asker, id: string, body: unknown): Promise<globalThis.Response> {
  return app.send('PATCH', `/api/clients/activities/${id}`, as, body);
}

async function corrected(as: Asker, id: string, body: unknown): Promise<ActivityJson> {
  const response = await correct(as, id, body);
  expect(response.status).toBe(200);

  return (await response.json()) as ActivityJson;
}

async function refused(response: globalThis.Response, status: number): Promise<ProblemJson> {
  expect(response.status).toBe(status);

  return (await response.json()) as ProblemJson;
}

async function activityCount(): Promise<number> {
  const { rows } = await admin.query<{ n: string }>('SELECT count(*) AS n FROM clients_activity');

  return Number(rows[0].n);
}

/* ---------------------------------------------------------------- logging a proposal */

describe('logging a proposal', () => {
  it('records it on one of the client’s deals, with no amount', async () => {
    expect(await logged(associate, aProposal({ withWhom: 'Ama Owusu (CCO)' }))).toMatchObject({
      clientId: adb,
      deal: { id: deal, productName: 'CreditStudio' },
      kind: 'PROPOSAL',
      amount: null,
    });
  });

  it('is for one of the client’s deals', async () => {
    expect(
      await refused(await log(associate, aProposal({ opportunityId: null })), 400),
    ).toMatchObject({ error: 'InvalidActivity', field: 'opportunityId' });

    const other = await aDeal(await aClient('Fidelity'));
    expect(
      await refused(await log(associate, aProposal({ opportunityId: other })), 400),
    ).toMatchObject({ error: 'InvalidActivity', field: 'opportunityId' });
  });

  /* A proposal names no price: the deal's value is not known yet. */
  it('has no amount', async () => {
    expect(
      await refused(
        await log(associate, aProposal({ amount: { amount: '75600', currency: 'USD' } })),
        400,
      ),
    ).toMatchObject({ error: 'InvalidActivity', field: 'amount' });
  });
});

/* ------------------------------------------------------------ logging the financials */

describe('logging the financials', () => {
  /* CLI 65, AC L19. */
  it('records the amount, with its currency, on one of the client’s deals', async () => {
    expect(await logged(associate, theFinancials())).toMatchObject({
      deal: { id: deal, productName: 'CreditStudio' },
      kind: 'FINANCIALS',
      amount: { amountMinor: 7_560_000, currency: 'USD' },
    });
  });

  it('takes pesewas and cents, and cedis as well as dollars', async () => {
    expect(
      await logged(associate, theFinancials({ amount: { amount: '125000.5', currency: 'GHS' } })),
    ).toMatchObject({ amount: { amountMinor: 12_500_050, currency: 'GHS' } });
  });

  /* CLI 65: "shall require an amount with its currency". */
  it('needs the amount and its currency', async () => {
    for (const amount of [
      undefined,
      null,
      { amount: '75600' },
      { amount: '75600', currency: 'EUR' },
      { currency: 'USD' },
      { amount: '75,600', currency: 'USD' },
      { amount: '-5', currency: 'USD' },
      { amount: '75600.505', currency: 'USD' },
      { amount: '1000000000000000', currency: 'USD' },
      '75600',
    ]) {
      expect(await refused(await log(associate, theFinancials({ amount })), 400)).toMatchObject({
        error: 'InvalidActivity',
        field: 'amount',
      });
    }
  });

  it('is for one of the client’s deals', async () => {
    expect(
      await refused(await log(associate, theFinancials({ opportunityId: null })), 400),
    ).toMatchObject({ error: 'InvalidActivity', field: 'opportunityId' });
  });

  it('is the only kind with an amount', async () => {
    for (const kind of ['CALL', 'MEETING', 'DEMO', 'PROPOSAL', 'NOTE']) {
      expect(await refused(await log(associate, theFinancials({ kind })), 400)).toMatchObject({
        error: 'InvalidActivity',
        field: 'amount',
      });
    }
  });

  it('writes nothing where it is refused', async () => {
    await log(associate, theFinancials({ amount: null }));

    expect(await activityCount()).toBe(0);
  });
});

/* ------------------------------------------------- whose to send, and on which deals */

describe('a proposal or the financials', () => {
  /* CLI 13, as the user decided for #281: they are the deal's owner's or a BD manager's. */
  it("is the deal owner's or a BD manager's to log", async () => {
    for (const body of [aProposal(), theFinancials()]) {
      expect((await log(associate, body)).status).toBe(201);
      expect((await log(bdManager, body)).status).toBe(201);
    }
  });

  it('is refused openly to anybody else with a role, naming whose deal it is', async () => {
    for (const body of [aProposal(), theFinancials()]) {
      const problem = await refused(await log(colleague, body), 403);

      expect(problem.error).toBe('NotAuthorised');
      expect(problem.message).toMatch(/Only they or a BD manager can log a proposal/);
    }
    expect(await activityCount()).toBe(0);
  });

  it('is refused silently to somebody with no role', async () => {
    expect((await log(nobody, theFinancials())).status).toBe(404);
  });

  /* An ended deal is kept as it ended: there is nothing left to propose on it (CLI 55, CLI 56). */
  it('is refused on a deal that has ended, though a call about it is not', async () => {
    await lose(deal);

    for (const body of [aProposal(), theFinancials()]) {
      expect(await refused(await log(associate, body), 409)).toMatchObject({
        error: 'OpportunityEnded',
      });
    }
    expect((await log(associate, aCall())).status).toBe(201);
  });
});

/* ------------------------------------------------------------- on the client page */

describe("the client page's Activity section", () => {
  /* CLI 99. */
  it('shows the financials with their amount, and a proposal without one', async () => {
    const financials = await logged(associate, theFinancials());
    const proposal = await logged(associate, aProposal());

    const response = await app.send('GET', `/api/clients/clients/${adb}/activity`, associate);
    expect(response.status).toBe(200);
    const { activity } = (await response.json()) as {
      activity: { id?: string; activityKind?: string; amount?: Money | null }[];
    };

    expect(activity.find((entry) => entry.id === financials.id)).toMatchObject({
      activityKind: 'FINANCIALS',
      amount: { amountMinor: 7_560_000, currency: 'USD' },
    });
    expect(activity.find((entry) => entry.id === proposal.id)).toMatchObject({
      activityKind: 'PROPOSAL',
      amount: null,
    });
  });
});

/* ------------------------------------------------------- correcting within its day */

describe('correcting within the day', () => {
  /* CLI 62, #281. */
  it('changes the financials’ amount and its currency', async () => {
    const financials = await logged(associate, theFinancials());

    expect(
      await corrected(associate, financials.id, { amount: { amount: '80000', currency: 'GHS' } }),
    ).toMatchObject({ kind: 'FINANCIALS', amount: { amountMinor: 8_000_000, currency: 'GHS' } });
  });

  it('never takes the financials’ amount or a deal away', async () => {
    const financials = await logged(associate, theFinancials());
    const proposal = await logged(associate, aProposal());

    expect(
      await refused(await correct(associate, financials.id, { amount: null }), 400),
    ).toMatchObject({ field: 'amount' });
    for (const id of [financials.id, proposal.id]) {
      expect(
        await refused(await correct(associate, id, { opportunityId: null }), 400),
      ).toMatchObject({ field: 'opportunityId' });
    }
  });

  /* #281: the kind may change into the financials, given what they need. */
  it('makes a call into the financials, given the amount', async () => {
    const call = await logged(associate, aCall());

    expect(
      await refused(await correct(associate, call.id, { kind: 'FINANCIALS' }), 400),
    ).toMatchObject({ field: 'amount' });

    expect(
      await corrected(associate, call.id, {
        kind: 'FINANCIALS',
        amount: { amount: '75600', currency: 'USD' },
      }),
    ).toMatchObject({ kind: 'FINANCIALS', amount: { amountMinor: 7_560_000, currency: 'USD' } });
  });

  /* #281: and out of them, which takes the amount with it. */
  it('makes the financials into a proposal or a call, which drops the amount', async () => {
    const one = await logged(associate, theFinancials());
    const other = await logged(associate, theFinancials());

    expect(await corrected(associate, one.id, { kind: 'PROPOSAL' })).toMatchObject({
      kind: 'PROPOSAL',
      amount: null,
    });
    expect(await corrected(associate, other.id, { kind: 'CALL' })).toMatchObject({
      kind: 'CALL',
      amount: null,
    });
  });

  it('refuses an amount on anything but the financials', async () => {
    const financials = await logged(associate, theFinancials());

    expect(
      await refused(
        await correct(associate, financials.id, {
          kind: 'MEETING',
          amount: { amount: '1', currency: 'USD' },
        }),
        400,
      ),
    ).toMatchObject({ field: 'amount' });
  });

  /* Whose to send, asked again of a correction that makes it one. */
  it('refuses making a call into a proposal on a deal that is not theirs', async () => {
    const call = await logged(colleague, aCall());

    expect((await correct(colleague, call.id, { kind: 'PROPOSAL' })).status).toBe(403);
    expect((await correct(colleague, call.id, { outcome: 'Wants a demo' })).status).toBe(200);
  });

  it('corrects the words of a proposal whose deal has since ended', async () => {
    const proposal = await logged(associate, aProposal());
    await lose(deal);

    expect(
      await corrected(associate, proposal.id, { outcome: 'Sent with the configuration sheet' }),
    ).toMatchObject({ kind: 'PROPOSAL' });
    expect(
      await refused(
        await correct(associate, proposal.id, {
          kind: 'FINANCIALS',
          amount: { amount: '1', currency: 'USD' },
        }),
        409,
      ),
    ).toMatchObject({ error: 'OpportunityEnded' });
  });
});

/* ------------------------------------------------------ the financials and the deal's value */

interface HistoryJson {
  value: Money | null;
  probability: number | null;
  source: string;
  changedBy: { id: string };
}

/** Sets the deal's figures by hand, as its owner. */
async function valued(id: string, amount: string, probability = 40): Promise<void> {
  const response = await app.send('PATCH', `/api/clients/opportunities/${id}`, associate, {
    value: { amount, currency: 'USD' },
    probability,
  });
  expect(response.status).toBe(200);
}

async function deal_(id: string): Promise<{ value: Money | null; probability: number | null }> {
  const response = await app.send('GET', `/api/clients/opportunities/${id}`, associate);
  expect(response.status).toBe(200);

  return (await response.json()) as { value: Money | null; probability: number | null };
}

/** The deal's history, newest first. */
async function historyOf(id: string): Promise<HistoryJson[]> {
  const response = await app.send('GET', `/api/clients/opportunities/${id}/history`, associate);
  expect(response.status).toBe(200);

  return ((await response.json()) as { history: HistoryJson[] }).history;
}

const usd = (dollars: number): Money => ({ amountMinor: dollars * 100, currency: 'USD' });

describe("the financials and the deal's value", () => {
  beforeEach(async () => {
    await valued(deal, '60000');
  });

  /* CLI 65, AC L19, as moved to the financials (#281). */
  it('makes the deal worth $75,600 where it was $60,000, and keeps $60,000 in its history', async () => {
    await logged(associate, theFinancials());

    expect(await deal_(deal)).toMatchObject({ value: usd(75_600), probability: 40 });

    const [latest, before] = await historyOf(deal);
    expect(latest).toMatchObject({
      value: usd(75_600),
      probability: 40,
      source: 'FINANCIALS',
      changedBy: { id: people.officer },
    });
    expect(before).toMatchObject({ value: usd(60_000), source: 'MANUAL' });
  });

  it("names the financials that set it, in the deal's history row", async () => {
    const financials = await logged(associate, theFinancials());

    const { rows } = await admin.query<{ activity_id: string }>(
      `SELECT activity_id FROM clients_value_change WHERE source = 'FINANCIALS'`,
    );
    expect(rows).toEqual([{ activity_id: financials.id }]);
  });

  it('gives a deal with no value one, in the financials’ currency', async () => {
    const other = await aDeal(adb, 'OnboardStudio');

    await logged(
      associate,
      theFinancials({ opportunityId: other, amount: { amount: '5000', currency: 'GHS' } }),
    );

    expect((await deal_(other)).value).toEqual({ amountMinor: 500_000, currency: 'GHS' });
  });

  it('takes the later of two financials, both kept in the history', async () => {
    await logged(associate, theFinancials());
    await logged(bdManager, theFinancials({ amount: { amount: '70000', currency: 'USD' } }));

    expect((await deal_(deal)).value).toEqual(usd(70_000));
    expect((await historyOf(deal)).slice(0, 3)).toMatchObject([
      { value: usd(70_000), source: 'FINANCIALS', changedBy: { id: people.commercialDirector } },
      { value: usd(75_600), source: 'FINANCIALS' },
      { value: usd(60_000), source: 'MANUAL' },
    ]);
  });

  /* A proposal names no price, so it leaves the value as it was. */
  it('is left alone by a proposal', async () => {
    const before = await historyOf(deal);

    await logged(associate, aProposal());

    expect((await deal_(deal)).value).toEqual(usd(60_000));
    expect(await historyOf(deal)).toEqual(before);
  });

  it('is left alone where the financials are refused', async () => {
    const before = await historyOf(deal);

    expect((await log(colleague, theFinancials())).status).toBe(403);
    expect((await log(associate, theFinancials({ amount: null }))).status).toBe(400);

    expect((await deal_(deal)).value).toEqual(usd(60_000));
    expect(await historyOf(deal)).toEqual(before);
  });
});

describe("correcting the financials, and the deal's value", () => {
  let financials: ActivityJson;

  beforeEach(async () => {
    await valued(deal, '60000');
    financials = await logged(associate, theFinancials());
  });

  /* #281: a corrected amount sets the value again, with a row of its own. */
  it('sets the value to the corrected amount, every figure kept in the history', async () => {
    await corrected(associate, financials.id, { amount: { amount: '76500', currency: 'USD' } });

    expect((await deal_(deal)).value).toEqual(usd(76_500));
    expect((await historyOf(deal)).slice(0, 3)).toMatchObject([
      { value: usd(76_500), source: 'FINANCIALS' },
      { value: usd(75_600), source: 'FINANCIALS' },
      { value: usd(60_000), source: 'MANUAL' },
    ]);
  });

  /* #281: no longer the financials, so the deal is worth what it was before them. */
  it('puts the value back to what it was before them, where they become something else', async () => {
    await corrected(associate, financials.id, { kind: 'PROPOSAL' });

    expect((await deal_(deal)).value).toEqual(usd(60_000));
    expect((await historyOf(deal))[0]).toMatchObject({ value: usd(60_000), source: 'FINANCIALS' });
  });

  it('puts back no value, where the deal had none before them', async () => {
    const other = await aDeal(adb, 'OnboardStudio');
    const first = await logged(associate, theFinancials({ opportunityId: other }));

    await corrected(associate, first.id, { kind: 'CALL' });

    expect((await deal_(other)).value).toBeNull();
  });

  it('moves the value to the other deal, where they were for another of the client’s', async () => {
    const other = await aDeal(adb, 'OnboardStudio');

    await corrected(associate, financials.id, { opportunityId: other });

    expect((await deal_(deal)).value).toEqual(usd(60_000));
    expect((await deal_(other)).value).toEqual(usd(75_600));
  });

  it('sets the value where a call becomes the financials', async () => {
    const call = await logged(associate, aCall());

    await corrected(associate, call.id, {
      kind: 'FINANCIALS',
      amount: { amount: '90000', currency: 'USD' },
    });

    expect((await deal_(deal)).value).toEqual(usd(90_000));
  });

  it('leaves the value and its history alone where only the words or the day change', async () => {
    const before = await historyOf(deal);

    await corrected(associate, financials.id, {
      outcome: 'Sent after their BRD',
      happenedOn: YESTERDAY,
    });

    expect(await historyOf(deal)).toEqual(before);
  });

  /* An ended deal keeps the value it ended with. */
  it('is refused where it would change the value of a deal that has since ended', async () => {
    await lose(deal);
    const before = await historyOf(deal);

    for (const change of [
      { kind: 'CALL' },
      { amount: { amount: '1', currency: 'USD' } },
      { opportunityId: await aDeal(adb, 'OnboardStudio') },
    ]) {
      expect(await refused(await correct(associate, financials.id, change), 409)).toMatchObject({
        error: 'OpportunityEnded',
      });
    }
    expect(await historyOf(deal)).toEqual(before);
    expect((await deal_(deal)).value).toEqual(usd(75_600));
  });
});

/* ------------------------------------------------------------------- and the stage */

/**
 * TDD 3, TDD 4.5: logging a proposal does not move the deal to Proposal; the owner does. A revised
 * proposal sent during Negotiation must not drag the deal back, and one sent at Discovery must not
 * pull it forward. The financials, which #281 added, are held to the same.
 */
describe("a proposal or the financials, and the deal's stage", () => {
  async function stageOf(id: string): Promise<string> {
    const response = await app.send('GET', `/api/clients/opportunities/${id}`, associate);
    expect(response.status).toBe(200);

    return ((await response.json()) as { stage: string }).stage;
  }

  async function stagesOf(id: string): Promise<unknown[]> {
    const response = await app.send('GET', `/api/clients/opportunities/${id}/stages`, associate);
    expect(response.status).toBe(200);

    return ((await response.json()) as { stages: unknown[] }).stages;
  }

  async function moveTo(id: string, toStage: string): Promise<void> {
    const response = await app.send('POST', `/api/clients/opportunities/${id}/stage`, associate, {
      toStage,
    });
    expect(response.status).toBe(200);
  }

  it('leaves a deal in Negotiation in Negotiation, and its stage history as it was', async () => {
    await moveTo(deal, 'NEGOTIATION');
    const before = await stagesOf(deal);

    await logged(associate, aProposal());
    await logged(associate, theFinancials());

    expect(await stageOf(deal)).toBe('NEGOTIATION');
    expect(await stagesOf(deal)).toEqual(before);
  });

  it('leaves a deal at Discovery at Discovery', async () => {
    await logged(associate, aProposal());
    await logged(bdManager, theFinancials());

    expect(await stageOf(deal)).toBe('DISCOVERY');
    expect(await stagesOf(deal)).toHaveLength(1);
  });

  it('leaves the stage alone when either is corrected', async () => {
    await moveTo(deal, 'QUALIFICATION');
    const call = await logged(associate, aCall());
    const financials = await logged(associate, theFinancials());

    await corrected(associate, call.id, { kind: 'PROPOSAL' });
    await corrected(associate, financials.id, { amount: { amount: '1000', currency: 'USD' } });
    await corrected(associate, financials.id, { kind: 'NOTE' });

    expect(await stageOf(deal)).toBe('QUALIFICATION');
    expect(await stagesOf(deal)).toHaveLength(2);
  });
});

/* ------------------------------------------------------- finding past proposals */

interface PastJson {
  id: string;
  kind: string;
  happenedOn: string;
  client: { id: string; name: string; type: { id: string; name: string } };
  deal: { id: string; productName: string; lineName: string };
  amount: Money | null;
  loggedBy: { id: string };
  files: { id: string; filename: string; downloadable: boolean }[];
}

/**
 * CLI 66, AC "the last proposal sent to a broker for Federation can be found and opened" (#281).
 * The user asked for proposals and financials both.
 */
describe('finding past proposals', () => {
  let oaMarkets: string;
  let federation: string;

  beforeEach(async () => {
    oaMarkets = await aClient('OA Markets', 'Broker');
    federation = await aDeal(oaMarkets, 'Federation');
  });

  async function found(query: string, as: Asker = colleague): Promise<PastJson[]> {
    const response = await app.send('GET', `/api/clients/proposals${query}`, as);
    expect(response.status).toBe(200);

    return ((await response.json()) as { proposals: PastJson[] }).proposals;
  }

  /** Logs `body` as the associate and attaches `filename` to it. */
  async function sent(body: Record<string, unknown>, filename?: string): Promise<string> {
    const { id } = await logged(associate, body);

    if (filename !== undefined) {
      const response = await app.sendFile(`/api/clients/activities/${id}/documents`, associate, {
        content: A_PDF,
        filename,
      });
      expect(response.status).toBe(201);
    }

    return id;
  }

  it('finds the last proposal sent to a broker for Federation, and opens it', async () => {
    await sent(
      aProposal({ clientId: oaMarkets, opportunityId: federation, happenedOn: '2026-09-01' }),
      'OA Markets, first go.pdf',
    );
    const last = await sent(
      aProposal({ clientId: oaMarkets, opportunityId: federation, happenedOn: '2026-10-15' }),
      'OA Markets proposal.pdf',
    );
    /* A bank's, and a broker's for another product: neither is what was asked for. */
    await sent(aProposal(), 'ADB proposal.pdf');
    await sent(
      aProposal({ clientId: oaMarkets, opportunityId: await aDeal(oaMarkets, 'Messaging') }),
      'OA Markets messaging.pdf',
    );

    const proposals = await found(`?type=${await typeId('Broker')}&product=${products.Federation}`);

    expect(proposals.map((proposal) => proposal.files[0]?.filename)).toEqual([
      'OA Markets proposal.pdf',
      'OA Markets, first go.pdf',
    ]);
    expect(proposals[0]).toMatchObject({
      id: last,
      kind: 'PROPOSAL',
      happenedOn: '2026-10-15',
      client: { id: oaMarkets, name: 'OA Markets', type: { name: 'Broker' } },
      deal: { id: federation, productName: 'Federation', lineName: 'Symphony' },
      amount: null,
      loggedBy: { id: people.officer },
      files: [{ downloadable: true }],
    });

    const opened = await app.send(
      'GET',
      `/api/clients/documents/${proposals[0].files[0].id}/download`,
      colleague,
    );
    expect(opened.status).toBe(200);
    expect(Buffer.from(await opened.arrayBuffer()).equals(A_PDF)).toBe(true);
  });

  /* The user, for #281: both, and either alone. */
  it('finds proposals and financials together, or either alone', async () => {
    /* Both before the pinned today, 30 October: an activity is never dated later (CLI 61). */
    const proposal = await sent(aProposal({ happenedOn: '2026-10-01' }));
    const financials = await sent(theFinancials({ happenedOn: '2026-10-20' }));
    await sent(aCall());

    expect((await found('')).map((one) => one.id)).toEqual([financials, proposal]);
    expect((await found('?kind=PROPOSAL')).map((one) => one.id)).toEqual([proposal]);
    expect(await found('?kind=FINANCIALS')).toMatchObject([
      { id: financials, kind: 'FINANCIALS', amount: { amountMinor: 7_560_000, currency: 'USD' } },
    ]);
  });

  it('goes by the client’s type as it is now, and the deal’s product', async () => {
    const one = await sent(aProposal());

    expect(await found(`?type=${await typeId('Broker')}`)).toEqual([]);

    const changed = await app.send('PATCH', `/api/clients/clients/${adb}`, bdManager, {
      typeId: await typeId('Broker'),
    });
    expect(changed.status).toBe(200);

    expect((await found(`?type=${await typeId('Broker')}`)).map((p) => p.id)).toEqual([one]);
    expect(await found(`?product=${products.Federation}`)).toEqual([]);
  });

  it('leaves out a file that was taken off, and keeps the proposal', async () => {
    const id = await sent(aProposal(), 'wrong.pdf');
    const [{ files }] = await found('');
    expect(
      (await app.send('POST', `/api/clients/documents/${files[0].id}/remove`, associate)).status,
    ).toBe(200);

    expect(await found('')).toMatchObject([{ id, files: [] }]);
  });

  it('refuses a filter that is not one', async () => {
    for (const query of ['?type=bank', '?product=x1', '?kind=CALL']) {
      expect(
        await refused(await app.send('GET', `/api/clients/proposals${query}`, associate), 400),
      ).toMatchObject({ error: 'InvalidActivity' });
    }
  });

  it("is anybody's with a role, and silent to somebody with none", async () => {
    await sent(aProposal());

    for (const as of [associate, colleague, bdManager]) {
      expect(await found('', as)).toHaveLength(1);
    }
    expect((await app.send('GET', '/api/clients/proposals', nobody)).status).toBe(404);
  });
});

/* -------------------------------------------------- the database holds the same shape */

describe('the shape, in the database', () => {
  /** Writes an activity straight into the table, as no service would. */
  async function insert(columns: Record<string, unknown>): Promise<string | null> {
    const values = {
      client_id: adb,
      kind: 'CALL',
      happened_on: YESTERDAY,
      logged_by: people.officer,
      ...columns,
    };
    const names = Object.keys(values);

    return admin
      .query(
        `INSERT INTO clients_activity (${names.join(', ')})
         VALUES (${names.map((_, at) => `$${String(at + 1)}`).join(', ')})`,
        Object.values(values),
      )
      .then(
        () => null,
        (error: unknown) => (error as { constraint?: string }).constraint ?? 'no constraint',
      );
  }

  it('refuses a proposal with no deal', async () => {
    expect(await insert({ kind: 'PROPOSAL', opportunity_id: deal })).toBeNull();
    expect(await insert({ kind: 'PROPOSAL' })).toBe('clients_activity_proposal_names_its_deal');
  });

  /* TDD 4.5's act_proposal, moved to the financials. */
  it('refuses the financials without their amount, their currency or their deal', async () => {
    const whole = { kind: 'FINANCIALS', opportunity_id: deal, amount_minor: 100, currency: 'USD' };

    expect(await insert(whole)).toBeNull();
    for (const missing of ['opportunity_id', 'amount_minor', 'currency']) {
      expect(await insert({ ...whole, [missing]: null })).toBe(
        'clients_activity_financials_say_what_and_for_which_deal',
      );
    }
  });

  it('refuses an amount on anything else, with or without a deal', async () => {
    expect(await insert({ amount_minor: 100, currency: 'USD' })).toBe(
      'clients_activity_only_financials_have_an_amount',
    );
    expect(
      await insert({ opportunity_id: deal, amount_minor: 100, currency: 'USD', kind: 'PROPOSAL' }),
    ).toBe('clients_activity_only_financials_have_an_amount');
  });

  it("has the deal's history name the financials that set its value, and nothing else", async () => {
    const financials = await logged(associate, theFinancials());
    const row = (values: Record<string, unknown>) =>
      admin
        .query(
          `INSERT INTO clients_value_change (opportunity_id, source, activity_id, changed_by)
           VALUES ($1, $2, $3, $4)`,
          [deal, values.source, values.activity_id, people.officer],
        )
        .then(
          () => null,
          (error: unknown) => (error as { constraint?: string }).constraint ?? 'no constraint',
        );

    expect(await row({ source: 'FINANCIALS', activity_id: null })).toBe(
      'clients_value_change_financials_name_them',
    );
    expect(await row({ source: 'MANUAL', activity_id: financials.id })).toBe(
      'clients_value_change_financials_name_them',
    );
    /* TDD 4.2's PROPOSAL source is gone: a proposal names no price, so never sets a value. */
    expect(await row({ source: 'PROPOSAL', activity_id: null })).toBe(
      'clients_value_change_source_known',
    );
    expect(await row({ source: 'FINANCIALS', activity_id: '999999' })).toBe(
      'clients_value_change_from_an_activity',
    );
  });

  it('refuses a negative amount, and a currency other than cedis and dollars', async () => {
    const whole = { kind: 'FINANCIALS', opportunity_id: deal, amount_minor: 100, currency: 'USD' };

    expect(await insert({ ...whole, amount_minor: -1 })).toBe(
      'clients_activity_amount_not_negative',
    );
    expect(await insert({ ...whole, currency: 'EUR' })).toBe('clients_activity_currency_known');
  });
});
