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
 * A deal's stage, over HTTP against a real database. #278, Clients SRS CLI 18 to CLI 26, TDD 5,
 * TDD 11.
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

/** ADB, owned by the BD manager. */
let adb: string;

interface DealJson {
  id: string;
  stage: string;
  outcome: string;
  hasPoc: boolean | null;
  endedOn: string | null;
  may: { change: boolean; move: boolean; decidePoc: boolean; lose: boolean };
  ending: { reason: { id: string; label: string }; note: string | null } | null;
}

interface StageJson {
  fromStage: string | null;
  toStage: string;
  toOutcome: string;
  note: string | null;
  changedBy: { id: string; name: string };
  changedAt: string;
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

/** A deal at ADB for CreditStudio, opened by `as`, who owns it. */
async function aDeal(as: Asker = associate, product = 'CreditStudio'): Promise<DealJson> {
  const response = await app.send('POST', '/api/clients/opportunities', as, {
    clientId: adb,
    productId: products[product],
  });
  expect(response.status).toBe(201);

  return (await response.json()) as DealJson;
}

function move(as: Asker, id: string, body: unknown): Promise<globalThis.Response> {
  return app.send('POST', `/api/clients/opportunities/${id}/stage`, as, body);
}

async function moved(as: Asker, id: string, toStage: string, note?: string): Promise<DealJson> {
  const response = await move(as, id, { toStage, note });
  expect(response.status).toBe(200);

  return (await response.json()) as DealJson;
}

async function refused(response: globalThis.Response, status: number): Promise<ProblemJson> {
  expect(response.status).toBe(status);

  return (await response.json()) as ProblemJson;
}

function answerPoc(as: Asker, id: string, hasPoc: boolean | null): Promise<globalThis.Response> {
  return app.send('PATCH', `/api/clients/opportunities/${id}`, as, { hasPoc });
}

async function stagesOf(id: string, as: Asker = associate): Promise<StageJson[]> {
  const response = await app.send('GET', `/api/clients/opportunities/${id}/stages`, as);
  expect(response.status).toBe(200);

  return ((await response.json()) as { stages: StageJson[] }).stages;
}

async function find(id: string, as: Asker = associate): Promise<DealJson> {
  return (await (await app.send('GET', `/api/clients/opportunities/${id}`, as)).json()) as DealJson;
}

async function nameOf(employeeId: string): Promise<string> {
  const { rows } = await admin.query<{ name: string }>(
    `SELECT first_name || ' ' || last_name AS name FROM employee WHERE id = $1`,
    [employeeId],
  );

  return rows[0].name;
}

/** Puts a deal straight into its POC, which the POC service will do once it exists. */
async function intoItsPoc(id: string): Promise<void> {
  await admin.query(
    `UPDATE clients_opportunity SET has_poc = true, stage = 'CONTRACT_SIGNED' WHERE id = $1`,
    [id],
  );
  await admin.query(`UPDATE clients_opportunity SET stage = 'POC' WHERE id = $1`, [id]);
}

/* --------------------------------------------------------------- the whole ladder */

describe('the ladder, without a POC', () => {
  /* CLI 18 to CLI 26, AC L04. Done when: a deal without a POC can go from Discovery to Live and
     shows as won. */
  it('takes a deal from Discovery to Live, wins it, and adds its product to the client', async () => {
    const deal = await aDeal();
    expect(deal).toMatchObject({
      stage: 'DISCOVERY',
      outcome: 'OPEN',
      hasPoc: null,
      endedOn: null,
    });

    for (const stage of ['QUALIFICATION', 'PROPOSAL', 'NEGOTIATION']) {
      expect(await moved(associate, deal.id, stage)).toMatchObject({ stage, outcome: 'OPEN' });
    }
    expect((await answerPoc(associate, deal.id, false)).status).toBe(200);
    expect(await moved(associate, deal.id, 'CONTRACT_SIGNED')).toMatchObject({
      stage: 'CONTRACT_SIGNED',
      outcome: 'OPEN',
      hasPoc: false,
    });

    const won = await moved(associate, deal.id, 'LIVE');
    expect(won).toMatchObject({
      stage: 'LIVE',
      outcome: 'WON',
      hasPoc: false,
      endedOn: PINNED_DATE,
      may: { change: false, move: false, decidePoc: false },
    });

    const page = (await (
      await app.send('GET', `/api/clients/clients/${adb}`, associate)
    ).json()) as {
      products: { productName: string; sinceOn: string; endedOn: string | null; wonBy: string }[];
    };
    expect(page.products).toEqual([
      expect.objectContaining({
        productName: 'CreditStudio',
        sinceOn: PINNED_DATE,
        endedOn: null,
        wonBy: deal.id,
      }),
    ]);
  });

  /* CLI 26. */
  it('keeps every stage it was at, with who moved it and when, newest first', async () => {
    const deal = await aDeal();
    await moved(associate, deal.id, 'PROPOSAL');
    await moved(bdManager, deal.id, 'QUALIFICATION', 'They want a second demo first');

    const stages = await stagesOf(deal.id);
    expect(stages).toEqual([
      {
        fromStage: 'PROPOSAL',
        toStage: 'QUALIFICATION',
        toOutcome: 'OPEN',
        note: 'They want a second demo first',
        changedBy: { id: people.commercialDirector, name: await nameOf(people.commercialDirector) },
        changedAt: expect.any(String),
      },
      {
        fromStage: 'DISCOVERY',
        toStage: 'PROPOSAL',
        toOutcome: 'OPEN',
        note: null,
        changedBy: { id: people.officer, name: await nameOf(people.officer) },
        changedAt: expect.any(String),
      },
      {
        fromStage: null,
        toStage: 'DISCOVERY',
        toOutcome: 'OPEN',
        note: null,
        changedBy: { id: people.officer, name: await nameOf(people.officer) },
        changedAt: expect.any(String),
      },
    ]);
    expect(stages.every((stage) => !Number.isNaN(Date.parse(stage.changedAt)))).toBe(true);
  });

  /* A win is a stage change like any other, outcome and all. */
  it('records the win in the history', async () => {
    const deal = await aDeal();
    await answerPoc(associate, deal.id, false);
    await moved(associate, deal.id, 'CONTRACT_SIGNED');
    await moved(associate, deal.id, 'LIVE');

    expect((await stagesOf(deal.id))[0]).toMatchObject({
      fromStage: 'CONTRACT_SIGNED',
      toStage: 'LIVE',
      toOutcome: 'WON',
    });
  });
});

/* -------------------------------------------------------------------- forward */

describe('moving a deal forward', () => {
  /* CLI 20. */
  it('may skip stages', async () => {
    const deal = await aDeal();

    expect(await moved(associate, deal.id, 'NEGOTIATION')).toMatchObject({
      stage: 'NEGOTIATION',
    });
    expect((await stagesOf(deal.id))[0]).toMatchObject({
      fromStage: 'DISCOVERY',
      toStage: 'NEGOTIATION',
    });
  });

  it('takes a note where one is given, and does not need one', async () => {
    const deal = await aDeal();
    await moved(associate, deal.id, 'PROPOSAL', '  Sent the deck on Monday  ');

    expect((await stagesOf(deal.id))[0].note).toBe('Sent the deck on Monday');
  });

  /* CLI 19, HAS_POC_REQUIRED. */
  it('to Contract signed or beyond needs the POC question answered first', async () => {
    const deal = await aDeal();
    await moved(associate, deal.id, 'NEGOTIATION');

    for (const stage of ['CONTRACT_SIGNED', 'LIVE']) {
      expect(await refused(await move(associate, deal.id, { toStage: stage }), 409)).toEqual({
        error: 'PocDecisionRequired',
        message: expect.stringMatching(/^Say whether there will be a POC before moving the deal/),
        field: 'hasPoc',
      });
    }
    expect((await find(deal.id)).stage).toBe('NEGOTIATION');
  });

  /* CLI 24. */
  it('to Live is only from Contract signed', async () => {
    const deal = await aDeal();
    await answerPoc(associate, deal.id, false);
    await moved(associate, deal.id, 'NEGOTIATION');

    expect(await refused(await move(associate, deal.id, { toStage: 'LIVE' }), 409)).toMatchObject({
      error: 'LiveAfterSigning',
      field: 'toStage',
    });
  });

  /* CLI 31, POC_STARTS_IT. */
  it('to POC is never by hand: starting the POC moves it', async () => {
    const deal = await aDeal();
    await answerPoc(associate, deal.id, true);
    await moved(associate, deal.id, 'CONTRACT_SIGNED');

    expect(await refused(await move(associate, deal.id, { toStage: 'POC' }), 409)).toMatchObject({
      error: 'PocStartsIt',
    });
  });

  it('to where it is already is refused', async () => {
    const deal = await aDeal();

    expect(
      await refused(await move(associate, deal.id, { toStage: 'DISCOVERY' }), 409),
    ).toMatchObject({
      error: 'AlreadyAtStage',
      message: 'This CreditStudio deal is at Discovery already.',
    });
  });

  it('names a stage there is', async () => {
    const deal = await aDeal();

    for (const body of [{}, { toStage: 'PILOT' }, { toStage: 'discovery' }]) {
      expect(await refused(await move(associate, deal.id, body), 400)).toMatchObject({
        error: 'InvalidStageMove',
        field: 'toStage',
      });
    }
    expect(
      await refused(await move(associate, deal.id, { toStage: 'PROPOSAL', note: 7 }), 400),
    ).toMatchObject({ error: 'InvalidStageMove', field: 'note' });
  });
});

/* ------------------------------------------------------------------------ back */

describe('moving a deal back', () => {
  /* CLI 21, AC L07. */
  it('before Contract signed, is allowed with a note, which is kept', async () => {
    const deal = await aDeal();
    await moved(associate, deal.id, 'PROPOSAL');

    expect(
      await moved(associate, deal.id, 'QUALIFICATION', 'They changed what they want'),
    ).toMatchObject({ stage: 'QUALIFICATION' });
    expect((await stagesOf(deal.id))[0]).toMatchObject({
      fromStage: 'PROPOSAL',
      toStage: 'QUALIFICATION',
      note: 'They changed what they want',
    });
  });

  /* CLI 21, NOTE_REQUIRED. */
  it('needs a note saying why', async () => {
    const deal = await aDeal();
    await moved(associate, deal.id, 'PROPOSAL');

    for (const note of [undefined, null, '   ']) {
      expect(
        await refused(await move(associate, deal.id, { toStage: 'QUALIFICATION', note }), 400),
      ).toEqual({
        error: 'MovingBackNeedsANote',
        message: 'Say why the deal is going back to Qualification.',
        field: 'note',
      });
    }
    expect((await find(deal.id)).stage).toBe('PROPOSAL');
    expect(await stagesOf(deal.id)).toHaveLength(2);
  });

  /* CLI 21, NO_BACKWARD, AC L06. */
  it('from Contract signed onward, is refused, with a note or without', async () => {
    const deal = await aDeal();
    await answerPoc(associate, deal.id, false);
    await moved(associate, deal.id, 'CONTRACT_SIGNED');

    for (const as of [associate, bdManager]) {
      expect(
        await refused(
          await move(as, deal.id, { toStage: 'PROPOSAL', note: 'Legal want changes' }),
          409,
        ),
      ).toMatchObject({ error: 'ContractSignedIsFinal', field: 'toStage' });
    }
    expect((await find(deal.id)).stage).toBe('CONTRACT_SIGNED');
  });
});

/* ------------------------------------------------------------------- with a POC */

describe('a deal with a POC', () => {
  /* CLI 24, AC L05, POC_DECIDES. Done when: moving a POC deal to Live by hand is refused. */
  it('is never moved to Live by hand, from Contract signed or from its POC', async () => {
    const deal = await aDeal();
    await answerPoc(associate, deal.id, true);
    await moved(associate, deal.id, 'CONTRACT_SIGNED');

    for (const as of [associate, bdManager]) {
      expect(await refused(await move(as, deal.id, { toStage: 'LIVE' }), 409)).toEqual({
        error: 'PocDecides',
        message:
          'The CreditStudio deal has a POC, so it goes live only by its POC converting. It is ' +
          'not moved there by hand.',
        field: 'toStage',
      });
    }

    await intoItsPoc(deal.id);
    expect(await refused(await move(bdManager, deal.id, { toStage: 'LIVE' }), 409)).toMatchObject({
      error: 'PocDecides',
    });
    expect(await find(deal.id)).toMatchObject({ stage: 'POC', outcome: 'OPEN' });
  });

  it('is not moved out of its POC by hand at all, and the screen is told so', async () => {
    const deal = await aDeal();
    await intoItsPoc(deal.id);

    expect((await find(deal.id, bdManager)).may).toEqual({
      change: true,
      move: false,
      decidePoc: false,
      lose: false,
    });
  });
});

/* ------------------------------------------------------------- the POC question */

describe('whether a deal will have a POC', () => {
  /* CLI 19. */
  it('is answered, and changed, as often as needed until the contract is signed', async () => {
    const deal = await aDeal();

    for (const answer of [true, false, null, true]) {
      const response = await answerPoc(associate, deal.id, answer);
      expect(response.status).toBe(200);
      expect(((await response.json()) as DealJson).hasPoc).toBe(answer);
    }
  });

  it('may be answered when the deal is opened', async () => {
    const response = await app.send('POST', '/api/clients/opportunities', associate, {
      clientId: adb,
      productId: products.Cloud9,
      hasPoc: true,
    });

    expect(((await response.json()) as DealJson).hasPoc).toBe(true);
  });

  /* CLI 19, HAS_POC_FIXED. */
  it('is settled once the contract is signed', async () => {
    const deal = await aDeal();
    await answerPoc(associate, deal.id, true);
    await moved(associate, deal.id, 'CONTRACT_SIGNED');

    for (const answer of [false, null]) {
      expect(await refused(await answerPoc(bdManager, deal.id, answer), 409)).toEqual({
        error: 'PocDecisionFixed',
        message: 'The CreditStudio contract is signed, so whether there is a POC is settled.',
        field: 'hasPoc',
      });
    }

    /* A form that sends every field, the answer as it is among them, is not refused for it. */
    expect(
      (
        await app.send('PATCH', `/api/clients/opportunities/${deal.id}`, associate, {
          hasPoc: true,
          probability: 80,
        })
      ).status,
    ).toBe(200);
    expect(await find(deal.id)).toMatchObject({ hasPoc: true, may: { decidePoc: false } });
  });

  it('is a yes or a no', async () => {
    const deal = await aDeal();

    expect(await refused(await answerPoc(associate, deal.id, 'maybe' as never), 400)).toMatchObject(
      { error: 'InvalidOpportunity', field: 'hasPoc' },
    );
  });
});

/* ---------------------------------------------------------------- once it is won */

describe('a won deal', () => {
  async function won(): Promise<DealJson> {
    const deal = await aDeal();
    await answerPoc(associate, deal.id, false);
    await moved(associate, deal.id, 'CONTRACT_SIGNED');

    return moved(associate, deal.id, 'LIVE');
  }

  /* CLI 55, CLI 56. */
  it('moves no further, and is kept as it ended', async () => {
    const deal = await won();

    expect(
      await refused(await move(bdManager, deal.id, { toStage: 'NEGOTIATION', note: 'Oops' }), 409),
    ).toMatchObject({ error: 'OpportunityEnded' });
    /* Opened, signed, won: nothing after. */
    expect(await stagesOf(deal.id)).toHaveLength(3);
  });

  /* CLI 11, CLI 56. Its product is free for another deal. */
  it('leaves the client free to open another deal for the product', async () => {
    await won();

    expect((await aDeal()).stage).toBe('DISCOVERY');
  });

  /* CLI 04. */
  it('starts again a product the client had stopped using, naming the deal that won it back', async () => {
    await admin.query(
      `INSERT INTO clients_client_product (client_id, product_id, since_on, ended_on)
       VALUES ($1, $2, '2023-01-01', '2024-06-30')`,
      [adb, products.CreditStudio],
    );

    const deal = await won();

    const { rows } = await admin.query(
      `SELECT since_on::text, ended_on, won_by FROM clients_client_product
        WHERE client_id = $1 AND product_id = $2`,
      [adb, products.CreditStudio],
    );
    expect(rows).toEqual([{ since_on: PINNED_DATE, ended_on: null, won_by: deal.id }]);
  });

  it('leaves alone a product the client already uses', async () => {
    await admin.query(
      `INSERT INTO clients_client_product (client_id, product_id, since_on)
       VALUES ($1, $2, '2023-01-01')`,
      [adb, products.CreditStudio],
    );

    await won();

    const { rows } = await admin.query(
      `SELECT since_on::text, ended_on, won_by FROM clients_client_product
        WHERE client_id = $1 AND product_id = $2`,
      [adb, products.CreditStudio],
    );
    expect(rows).toEqual([{ since_on: '2023-01-01', ended_on: null, won_by: null }]);
  });
});

/* ------------------------------------------------------ what the screen offers */

describe('where a deal could be moved', () => {
  /* The screen offers what the server allows, and says why not in the server's words. */
  it('is every stage, open or not and why, for whoever may move it', async () => {
    const deal = await aDeal();
    await moved(associate, deal.id, 'PROPOSAL');

    const { moves } = (await find(deal.id)) as DealJson & {
      moves: { stage: string; open: boolean; why: string | null; needsNote: boolean }[];
    };
    expect(moves).toEqual([
      { stage: 'DISCOVERY', open: true, why: null, needsNote: true },
      { stage: 'QUALIFICATION', open: true, why: null, needsNote: true },
      {
        stage: 'PROPOSAL',
        open: false,
        why: 'This CreditStudio deal is at Proposal already.',
        needsNote: false,
      },
      { stage: 'NEGOTIATION', open: true, why: null, needsNote: false },
      {
        stage: 'CONTRACT_SIGNED',
        open: false,
        why: 'Say whether there will be a POC before moving the deal to Contract signed.',
        needsNote: false,
      },
      {
        stage: 'POC',
        open: false,
        why: 'Say whether there will be a POC before moving the deal to POC.',
        needsNote: false,
      },
      {
        stage: 'LIVE',
        open: false,
        why: 'Say whether there will be a POC before moving the deal to Live.',
        needsNote: false,
      },
    ]);
  });

  it('is nowhere, for somebody who may not move it', async () => {
    const deal = await aDeal();

    expect(await find(deal.id, { employeeId: people.opsDirector })).toMatchObject({ moves: [] });
  });
});

/* ---------------------------------------------------------- the client's activity */

describe("a client's activity", () => {
  async function activityOf(as: Asker = associate): Promise<globalThis.Response> {
    return app.send('GET', `/api/clients/clients/${adb}/activity`, as);
  }

  /* CLI 99. Every deal's stage and value changes, newest first, each naming its deal. */
  it("is every deal's stage and value changes, newest first, each naming its deal", async () => {
    const credit = await aDeal(associate, 'CreditStudio');
    await moved(associate, credit.id, 'PROPOSAL');
    const cloud = await aDeal(bdManager, 'Cloud9');
    await app.send('PATCH', `/api/clients/opportunities/${cloud.id}`, bdManager, {
      value: { amount: '75600', currency: 'USD' },
      probability: 40,
    });

    const response = await activityOf();
    expect(response.status).toBe(200);
    const { activity } = (await response.json()) as {
      activity: { kind: string; deal: { productName: string }; opening?: boolean }[];
    };

    expect(
      activity.map((entry) => [
        entry.deal.productName,
        entry.kind,
        ...(entry.kind === 'VALUE' ? [entry.opening] : []),
      ]),
    ).toEqual([
      ['Cloud9', 'VALUE', false],
      ['Cloud9', 'VALUE', true],
      ['Cloud9', 'STAGE'],
      ['CreditStudio', 'STAGE'],
      ['CreditStudio', 'VALUE', true],
      ['CreditStudio', 'STAGE'],
    ]);
    expect(activity[0]).toMatchObject({
      value: { amountMinor: 7_560_000, currency: 'USD' },
      probability: 40,
      source: 'MANUAL',
      by: { id: people.commercialDirector },
    });
    expect(activity[3]).toMatchObject({
      fromStage: 'DISCOVERY',
      toStage: 'PROPOSAL',
      toOutcome: 'OPEN',
      by: { id: people.officer },
    });
  });

  it('is empty for a client with no deals', async () => {
    expect(await (await activityOf()).json()).toEqual({ activity: [] });
  });

  /* NFR CLI SEC 04. */
  it('is nothing to somebody without a role', async () => {
    await aDeal();

    expect((await activityOf(nobody)).status).toBe(404);
  });
});

/* ------------------------------------------------------------------------- who */

describe('who may move a deal', () => {
  /* CLI 13. */
  it('is its owner, or a BD manager, whoever owns it', async () => {
    const mine = await aDeal(associate);
    const theirs = await aDeal(bdManager, 'Cloud9');

    expect((await move(associate, mine.id, { toStage: 'PROPOSAL' })).status).toBe(200);
    expect((await move(bdManager, mine.id, { toStage: 'NEGOTIATION' })).status).toBe(200);
    expect((await move(bdManager, theirs.id, { toStage: 'PROPOSAL' })).status).toBe(200);
  });

  /* AC L22. Told whose it is. */
  it('is not another associate, who is told whose it is', async () => {
    const deal = await aDeal(associate);
    const colleague = { employeeId: people.opsDirector };

    expect(await refused(await move(colleague, deal.id, { toStage: 'PROPOSAL' }), 403)).toEqual({
      error: 'NotAuthorised',
      message: `This deal is ${await nameOf(people.officer)}'s. Only they or a BD manager can change it.`,
    });
    expect((await find(deal.id, colleague)).may).toEqual({
      change: false,
      move: false,
      decidePoc: false,
      lose: false,
    });
    expect((await find(deal.id)).stage).toBe('DISCOVERY');
  });

  /* NFR CLI SEC 04. */
  it('is nobody without a role, who is told nothing, for a deal or for no deal', async () => {
    const deal = await aDeal();

    for (const id of [deal.id, '987654321', 'nonsense']) {
      expect((await move(nobody, id, { toStage: 'PROPOSAL' })).status).toBe(404);
      expect(
        (await app.send('GET', `/api/clients/opportunities/${id}/stages`, nobody)).status,
      ).toBe(404);
    }
    expect((await find(deal.id)).stage).toBe('DISCOVERY');
  });

  it('is of a deal that exists', async () => {
    expect(
      await refused(await move(associate, '987654321', { toStage: 'PROPOSAL' }), 404),
    ).toMatchObject({ error: 'OpportunityNotFound' });
  });
});
