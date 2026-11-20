import type { Kysely } from 'kysely';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { PINNED_DATE } from '../setup/pinned-date.js';
import { pinCurrentDate } from '../../src/core/calendar/time.js';
import { seed } from '../../seeds/seed.mjs';
import { type Database, databaseFor } from '../../src/core/db/index.js';
import { ClientsRoleRepository } from '../../src/apps/clients/role.db.js';
import { type Asker, type ClientsApp, startClientsApp } from '../support/clients-app.js';
import { recordingDenials } from '../support/recording-denials.js';

/**
 * Running a POC, over HTTP against a real database. #285, Clients SRS CLI 27 to CLI 34, TDD 4.3,
 * TDD 5, TDD 6.
 *
 * Signing the contract starts the POC (the user, 19 November 2026): a deal with a POC moved to
 * Contract signed is in its POC there and then, run by the deal's owner.
 */

const testDatabaseUrl = await databaseForThisFile();
const denials = recordingDenials();

/** Ten weeks after the pinned day, 30 October 2026 (CLI 31). */
const DECIDED_BY = '2027-01-08';

let db: Kysely<Database>;
let admin: Client;
let app: ClientsApp;
let people: Record<string, string>;
let products: Record<string, string>;
let grants: ClientsRoleRepository;

let bdManager: Asker;
let associate: Asker;
/** A second associate, who owns no deal here. */
let colleague: Asker;
let nobody: Asker;

/** ADB, a bank, owned by the BD manager. */
let adb: string;

interface DealJson {
  id: string;
  stage: string;
  outcome: string;
  hasPoc: boolean | null;
  poc: {
    id: string;
    startedOn: string;
    decisionOn: string;
    csLead: { id: string; name: string };
  } | null;
}

interface StageJson {
  fromStage: string | null;
  toStage: string;
  toOutcome: string;
  note: string | null;
  changedBy: { id: string };
}

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);
  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();
  app = await startClientsApp(db, denials);
});

beforeEach(async () => {
  people = (await seed(admin)) as Record<string, string>;

  grants = new ClientsRoleRepository(db);
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

  const client = await app.send('POST', '/api/clients/clients', bdManager, {
    name: 'ADB',
    typeId: await typeNamed('Bank'),
  });
  adb = ((await client.json()) as { id: string }).id;

  denials.clear();
});

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await admin?.end();
});

async function typeNamed(name: string): Promise<string> {
  return (
    await admin.query<{ id: string }>('SELECT id FROM clients_client_type WHERE name = $1', [name])
  ).rows[0].id;
}

/** A deal at ADB, opened by `as`, who owns it, with the POC question answered. */
async function aDeal(
  as: Asker = associate,
  product = 'Federation',
  hasPoc: boolean | null = true,
): Promise<DealJson> {
  const response = await app.send('POST', '/api/clients/opportunities', as, {
    clientId: adb,
    productId: products[product],
    hasPoc,
  });
  expect(response.status).toBe(201);

  return (await response.json()) as DealJson;
}

async function moved(as: Asker, id: string, toStage: string, note?: string): Promise<DealJson> {
  const response = await app.send('POST', `/api/clients/opportunities/${id}/stage`, as, {
    toStage,
    note,
  });
  expect(response.status).toBe(200);

  return (await response.json()) as DealJson;
}

async function find(id: string, as: Asker = associate): Promise<DealJson> {
  return (await (await app.send('GET', `/api/clients/opportunities/${id}`, as)).json()) as DealJson;
}

async function stagesOf(id: string): Promise<StageJson[]> {
  const response = await app.send('GET', `/api/clients/opportunities/${id}/stages`, associate);

  return ((await response.json()) as { stages: StageJson[] }).stages;
}

async function nameOf(employeeId: string): Promise<string> {
  const { rows } = await admin.query<{ name: string }>(
    `SELECT first_name || ' ' || last_name AS name FROM employee WHERE id = $1`,
    [employeeId],
  );

  return rows[0].name;
}

/** The POC as the table holds it. */
async function pocRow(id: string) {
  const { rows } = await admin.query<{
    client_id: string;
    line: string;
    client_type: string;
    cs_lead_id: string;
    started_on: string;
    decision_on: string;
    created_by: string;
  }>(
    `SELECT poc.client_id, l.name AS line, t.name AS client_type, poc.cs_lead_id,
            poc.started_on::text, poc.decision_on::text, poc.created_by
       FROM clients_poc poc
       JOIN clients_product_line l ON l.id = poc.line_id
       JOIN clients_client_type t ON t.id = poc.client_type_id
      WHERE poc.id = $1`,
    [id],
  );

  return rows[0];
}

/* ---------------------------------------------------------- signing starts the POC */

describe('signing the contract of a deal with a POC', () => {
  /* CLI 28, CLI 31, the user on 19 November 2026. */
  it('starts its POC that day, decided ten weeks later, and puts the deal in it', async () => {
    const deal = await aDeal();

    expect(await moved(associate, deal.id, 'CONTRACT_SIGNED', 'Signed at the bank')).toMatchObject({
      stage: 'POC',
      outcome: 'OPEN',
      hasPoc: true,
      poc: {
        startedOn: PINNED_DATE,
        decisionOn: DECIDED_BY,
        csLead: { id: people.officer, name: await nameOf(people.officer) },
      },
    });
  });

  /* CLI 26. It went through Contract signed, which its history says, with the note given. */
  it('records the deal going through Contract signed and on into its POC', async () => {
    const deal = await aDeal();
    await moved(associate, deal.id, 'NEGOTIATION');
    await moved(associate, deal.id, 'CONTRACT_SIGNED', 'Signed at the bank');

    expect((await stagesOf(deal.id)).slice(0, 2)).toMatchObject([
      { fromStage: 'CONTRACT_SIGNED', toStage: 'POC', toOutcome: 'OPEN', note: null },
      {
        fromStage: 'NEGOTIATION',
        toStage: 'CONTRACT_SIGNED',
        toOutcome: 'OPEN',
        note: 'Signed at the bank',
        changedBy: { id: people.officer },
      },
    ]);
  });

  /* CLI 27, CLI 30, TDD 4.3. For the deal's client and its product's line, with the client's type
     as it was, and who made it. */
  it("makes the POC for the deal's client and line, with the client's type as it is", async () => {
    const deal = await moved(associate, (await aDeal()).id, 'CONTRACT_SIGNED');

    expect(await pocRow(deal.poc!.id)).toEqual({
      client_id: adb,
      line: 'Symphony',
      client_type: 'Bank',
      cs_lead_id: people.officer,
      started_on: PINNED_DATE,
      decision_on: DECIDED_BY,
      created_by: people.officer,
    });
  });

  /* CLI 30. Changing the client's type later does not change a POC already made. */
  it("keeps the client's type it was made with when the client's type changes", async () => {
    const deal = await moved(associate, (await aDeal()).id, 'CONTRACT_SIGNED');

    const response = await app.send('PATCH', `/api/clients/clients/${adb}`, bdManager, {
      typeId: await typeNamed('Broker'),
    });
    expect(response.status).toBe(200);

    expect((await pocRow(deal.poc!.id)).client_type).toBe('Bank');
  });

  /* The user, #279: the deal's owner is its POC's CS lead, whoever signs it. */
  it("makes the deal's owner its CS lead when a BD manager signs it", async () => {
    const deal = await aDeal();

    expect(await moved(bdManager, deal.id, 'CONTRACT_SIGNED')).toMatchObject({
      stage: 'POC',
      poc: { csLead: { id: people.officer } },
    });
    expect((await pocRow((await find(deal.id)).poc!.id)).created_by).toBe(
      people.commercialDirector,
    );
  });

  /* The user, 19 November 2026: an owner who holds no role any more is still made its CS lead,
     and the POC flagged as needing reassignment (CLI 96, with the flags) rather than refused. */
  it('makes the owner its CS lead even where they no longer hold a role', async () => {
    const deal = await aDeal();
    const [grant] = (await grants.live()).filter((live) => live.employeeId === people.officer);
    await grants.end(grant.id, people.headOfHr, 'REVOKED');

    expect(await moved(bdManager, deal.id, 'CONTRACT_SIGNED')).toMatchObject({
      stage: 'POC',
      poc: { csLead: { id: people.officer } },
    });
  });

  /* CLI 43. A line with no POC SOP yet, Dura Capital, runs its POC all the same. */
  it('starts a POC on any line, Dura Capital included', async () => {
    const deal = await moved(
      associate,
      (await aDeal(associate, 'CreditStudio')).id,
      'CONTRACT_SIGNED',
    );

    expect(deal).toMatchObject({ stage: 'POC', poc: { decisionOn: DECIDED_BY } });
    expect((await pocRow(deal.poc!.id)).line).toBe('Dura Capital');
  });
});

describe('a deal with no POC, or none yet', () => {
  /* CLI 24. With no POC, signing leaves it at Contract signed, on its way to Live. */
  it('is not put in a POC when its contract is signed', async () => {
    const deal = await aDeal(associate, 'Federation', false);

    expect(await moved(associate, deal.id, 'CONTRACT_SIGNED')).toMatchObject({
      stage: 'CONTRACT_SIGNED',
      hasPoc: false,
      poc: null,
    });
    expect((await admin.query('SELECT 1 FROM clients_poc')).rowCount).toBe(0);
  });

  it('is in no POC before its contract is signed', async () => {
    const deal = await aDeal();

    expect(await moved(associate, deal.id, 'NEGOTIATION')).toMatchObject({
      stage: 'NEGOTIATION',
      hasPoc: true,
      poc: null,
    });
  });
});

/* --------------------------------------------------------------- one deal per POC */

describe('a second deal for the same client and line', () => {
  /* The user, 20 November 2026, over CLI 27: one deal per POC. Cloud9 and Federation are both in
     the Symphony line. */
  it('signed later starts a POC of its own', async () => {
    const federation = await moved(associate, (await aDeal()).id, 'CONTRACT_SIGNED');
    const cloud9 = await moved(associate, (await aDeal(associate, 'Cloud9')).id, 'CONTRACT_SIGNED');

    expect(federation.poc!.id).not.toBe(cloud9.poc!.id);
    expect((await pocRow(cloud9.poc!.id)).line).toBe('Symphony');
  });
});

/* ------------------------------------------------------------------ the POC itself */

interface PocJson {
  id: string;
  client: { id: string; name: string; type: string };
  lineName: string;
  deal: { id: string; productName: string; stage: string; outcome: string; owner: { id: string } };
  csLead: { id: string; name: string };
  csLeadHoldsARole: boolean;
  startedOn: string;
  decisionOn: string;
  phase: string;
  day: number;
  daysToDecision: number;
  may: { update: boolean; moveLead: boolean };
  reviews: {
    id: string;
    kind: string;
    description: string;
    dueOn: string;
    owner: { id: string };
    done: { at: string; by: { id: string } } | null;
  }[];
  held: { kind: string; heldOn: string; dmAttended: boolean; loggedBy: { id: string } }[];
}

interface ProblemJson {
  error: string;
  message: string;
  field?: string;
}

/** A Federation deal at ADB, owned by the associate, signed: its POC. */
async function aPoc(): Promise<string> {
  return (await moved(associate, (await aDeal()).id, 'CONTRACT_SIGNED')).poc!.id;
}

async function pageOf(id: string, as: Asker = associate): Promise<PocJson> {
  const response = await app.send('GET', `/api/clients/pocs/${id}`, as);
  expect(response.status).toBe(200);

  return (await response.json()) as PocJson;
}

function review(as: Asker, id: string, body: unknown): Promise<globalThis.Response> {
  return app.send('POST', `/api/clients/pocs/${id}/reviews`, as, body);
}

function lead(as: Asker, id: string, employeeId: unknown): Promise<globalThis.Response> {
  return app.send('POST', `/api/clients/pocs/${id}/lead`, as, { employeeId });
}

async function refused(response: globalThis.Response, status: number): Promise<ProblemJson> {
  expect(response.status).toBe(status);

  return (await response.json()) as ProblemJson;
}

/** A review held on the pinned day. */
const DAY7_HELD = { reviewKind: 'DAY7', heldOn: PINNED_DATE, dmAttended: true };

describe('the review meetings', () => {
  /* CLI 33, TDD 6.2. Starting it gives its CS lead three next steps, dated from the start; 2
     November's dates are in the unit test. */
  it('are three next steps for its CS lead, dated from the start', async () => {
    const poc = await pageOf(await aPoc());

    expect(poc.reviews).toMatchObject([
      {
        kind: 'DAY7',
        dueOn: '2026-11-06',
        description: 'Day 7 showcase with ADB on the Federation POC',
        owner: { id: people.officer },
        done: null,
      },
      { kind: 'WEEK6', dueOn: '2026-12-11', owner: { id: people.officer }, done: null },
      { kind: 'WEEK9', dueOn: '2027-01-01', owner: { id: people.officer }, done: null },
    ]);
  });

  /* CLI 97. The Day 7 showcase is the deal's next step on My pipeline. */
  it("put the first one at the top of the CS lead's pipeline", async () => {
    await aPoc();

    const response = await app.send('GET', '/api/clients/pipeline', associate);
    const { deals } = (await response.json()) as {
      deals: { nextStep: { description: string; dueOn: string } | null }[];
    };
    expect(deals[0].nextStep).toMatchObject({
      description: 'Day 7 showcase with ADB on the Federation POC',
      dueOn: '2026-11-06',
    });
  });
});

describe('recording a review meeting', () => {
  /* CLI 34. The senior decision maker there: it counts, and its step is closed. */
  it('with the senior decision maker, closes that review', async () => {
    const id = await aPoc();

    const response = await review(associate, id, {
      ...DAY7_HELD,
      withWhom: 'Ama Owusu (CCO)',
      outcome: 'Showed the archive',
    });
    expect(response.status).toBe(201);
    const poc = (await response.json()) as PocJson;

    expect(poc.reviews).toHaveLength(3);
    expect(poc.reviews[0]).toMatchObject({ kind: 'DAY7', done: { by: { id: people.officer } } });
    expect(poc.reviews.slice(1).every((step) => step.done === null)).toBe(true);
    expect(poc.held).toMatchObject([
      { kind: 'DAY7', heldOn: PINNED_DATE, dmAttended: true, loggedBy: { id: people.officer } },
    ]);
  });

  /* CLI 34, TDD 6.2. Without them: it does not count, the step is closed, and a replacement is due
     seven days after the meeting, for the CS lead. */
  it('without the senior decision maker, does not count and is due again a week later', async () => {
    const id = await aPoc();

    const poc = (await (
      await review(bdManager, id, { ...DAY7_HELD, dmAttended: false })
    ).json()) as PocJson;

    expect(poc.reviews.map((step) => [step.kind, step.dueOn, step.done === null])).toEqual([
      ['DAY7', '2026-11-06', false],
      ['DAY7', '2026-11-06', true],
      ['WEEK6', '2026-12-11', true],
      ['WEEK9', '2027-01-01', true],
    ]);
    expect(poc.reviews[1]).toMatchObject({
      description:
        'Day 7 showcase with ADB on the Federation POC, again: the senior decision maker was ' +
        'not there',
      owner: { id: people.officer },
    });
    expect(poc.held[0]).toMatchObject({
      dmAttended: false,
      loggedBy: { id: people.commercialDirector },
    });
  });

  /* CLI 34. It shows on the client's activity, saying whether it counted. */
  it("is on the client's activity, and fixed once recorded", async () => {
    const id = await aPoc();
    await review(associate, id, { ...DAY7_HELD, dmAttended: false });

    const response = await app.send('GET', `/api/clients/clients/${adb}/activity`, associate);
    const { activity } = (await response.json()) as {
      activity: {
        kind: string;
        id: string;
        activityKind?: string;
        review?: unknown;
        may?: { correct: boolean };
      }[];
    };
    const logged = activity.find((entry) => entry.activityKind === 'REVIEW')!;
    expect(logged).toMatchObject({
      review: { pocId: id, kind: 'DAY7', dmAttended: false },
      may: { correct: false },
    });

    expect(
      await refused(
        await app.send('PATCH', `/api/clients/activities/${logged.id}`, associate, {
          outcome: 'Something else',
        }),
        409,
      ),
    ).toMatchObject({ error: 'ReviewFixed' });
  });

  /* A review is recorded on its POC, never logged as any other activity. */
  it('is not logged as an ordinary activity', async () => {
    const deal = await moved(associate, (await aDeal()).id, 'CONTRACT_SIGNED');

    expect(
      await refused(
        await app.send('POST', '/api/clients/activities', associate, {
          clientId: adb,
          opportunityId: deal.id,
          kind: 'REVIEW',
          happenedOn: PINNED_DATE,
        }),
        400,
      ),
    ).toMatchObject({ error: 'InvalidActivity', field: 'kind' });
  });

  it('says which review, when, and whether the decision maker was there', async () => {
    const id = await aPoc();

    for (const [body, field] of [
      [{ ...DAY7_HELD, reviewKind: 'WEEK7' }, 'reviewKind'],
      [{ ...DAY7_HELD, heldOn: '2026-10-31' }, 'heldOn'],
      [{ ...DAY7_HELD, dmAttended: undefined }, 'dmAttended'],
    ] as const) {
      expect(await refused(await review(associate, id, body), 400)).toMatchObject({
        error: 'InvalidReview',
        field,
      });
    }
    expect((await pageOf(id)).held).toEqual([]);
  });

  /* CLI 35, CLI 91. Its CS lead's or a BD manager's, and nobody else's with a role. */
  it('is refused to anybody else with a role, who is told whose it is', async () => {
    const id = await aPoc();

    expect(await refused(await review(colleague, id, DAY7_HELD), 403)).toEqual({
      error: 'NotAuthorised',
      message: `Only ${await nameOf(people.officer)} or a BD manager can update this POC.`,
    });
  });
});

describe('the CS lead', () => {
  /* CLI 29, CLI 92. A BD manager hands the POC on, and its open review steps go with it. */
  it('is moved by a BD manager, the open reviews with them', async () => {
    const id = await aPoc();
    await review(associate, id, DAY7_HELD);

    const response = await lead(bdManager, id, people.opsDirector);
    expect(response.status).toBe(200);
    const poc = (await response.json()) as PocJson;

    expect(poc.csLead).toEqual({ id: people.opsDirector, name: await nameOf(people.opsDirector) });
    expect(poc.reviews.map((step) => [step.kind, step.owner.id])).toEqual([
      ['DAY7', people.officer],
      ['WEEK6', people.opsDirector],
      ['WEEK9', people.opsDirector],
    ]);
    /* The deal stays its owner's. */
    expect(poc.deal.owner.id).toBe(people.officer);
  });

  /* CLI 92. Not by an associate, even the CS lead. */
  it('is moved by nobody but a BD manager', async () => {
    const id = await aPoc();

    expect(await refused(await lead(associate, id, people.opsDirector), 403)).toEqual({
      error: 'NotAuthorised',
      message: 'Only a BD manager can move a poc.',
    });
  });

  /* CLI 29. To somebody who holds a role. */
  it('is somebody with a role in clients', async () => {
    const id = await aPoc();

    expect(await refused(await lead(bdManager, id, people.engineer), 400)).toMatchObject({
      error: 'InvalidPocLead',
      field: 'employeeId',
    });
    expect(await refused(await lead(bdManager, id, 'x'), 400)).toMatchObject({
      error: 'InvalidPocLead',
    });
    expect((await pageOf(id)).csLead.id).toBe(people.officer);
  });

  /* CLI 91, AC L23. A CS lead who does not own the deal updates the POC, and may not move the deal. */
  it('updates the POC without owning its deal, and does not move the deal', async () => {
    const id = await aPoc();
    await lead(bdManager, id, people.opsDirector);

    expect((await pageOf(id, colleague)).may).toEqual({ update: true, moveLead: false });
    expect((await review(colleague, id, DAY7_HELD)).status).toBe(201);

    const deal = (await pageOf(id)).deal.id;
    expect(
      (
        await app.send('PATCH', `/api/clients/opportunities/${deal}`, colleague, {
          probability: 90,
        })
      ).status,
    ).toBe(403);
    /* The deal's owner, no longer its CS lead, no longer updates the POC. */
    expect((await pageOf(id, associate)).may.update).toBe(false);
    expect((await review(associate, id, { ...DAY7_HELD, reviewKind: 'WEEK6' })).status).toBe(403);
  });

  /* The user, 19 November 2026, CLI 96. One who no longer holds a role is flagged. */
  it('is flagged where they no longer hold a role', async () => {
    const id = await aPoc();
    const [grant] = (await grants.live()).filter((live) => live.employeeId === people.officer);
    await grants.end(grant.id, people.headOfHr, 'REVOKED');

    expect((await pageOf(id, bdManager)).csLeadHoldsARole).toBe(false);
  });
});

/* --------------------------------------------------------- the clock, the list, the page */

describe('the POC list and page', () => {
  /* CLI 101. Every POC running, the soonest decided first, with its phase and days to decide. */
  it('lists every POC running, with its phase and days to decide', async () => {
    const first = await aPoc();

    const response = await app.send('GET', '/api/clients/pocs', colleague);
    expect(response.status).toBe(200);
    const { pocs } = (await response.json()) as { pocs: PocJson[] };

    expect(pocs).toMatchObject([
      {
        id: first,
        client: { name: 'ADB', type: 'Bank' },
        lineName: 'Symphony',
        deal: { productName: 'Federation', stage: 'POC', outcome: 'OPEN' },
        csLead: { id: people.officer },
        csLeadHoldsARole: true,
        startedOn: PINNED_DATE,
        decisionOn: DECIDED_BY,
        phase: 'FOUNDATION',
        day: 1,
        daysToDecision: 70,
        may: { update: false, moveLead: false },
      },
    ]);
  });

  /* CLI 32. Done when: the phase changes on its own as the weeks pass. Nothing is stored. */
  it('moves through its phases as the days pass, and past its decision date', async () => {
    const id = await aPoc();

    try {
      for (const [today, phase, day, toDecide] of [
        ['2026-11-19', 'FOUNDATION', 21, 50],
        ['2026-11-20', 'DEEPENING', 22, 49],
        ['2026-12-11', 'CONVERTING', 43, 28],
        ['2027-01-11', 'CONVERTING', 74, -3],
      ] as const) {
        pinCurrentDate(today);
        expect(await pageOf(id)).toMatchObject({ phase, day, daysToDecision: toDecide });
      }
    } finally {
      pinCurrentDate(PINNED_DATE);
    }
  });

  /* CLI 100. Its page: the deal, the clock, and what the person reading may do. */
  it('shows one POC to anybody with a role, with what they may do', async () => {
    const id = await aPoc();

    expect((await pageOf(id, associate)).may).toEqual({ update: true, moveLead: false });
    expect((await pageOf(id, bdManager)).may).toEqual({ update: true, moveLead: true });
    expect((await pageOf(id, colleague)).may).toEqual({ update: false, moveLead: false });
  });

  /* NFR CLI SEC 04. Nothing at all to somebody with no role, whatever the id. */
  it('is nothing to somebody with no role', async () => {
    const id = await aPoc();

    for (const [method, address] of [
      ['GET', '/api/clients/pocs'],
      ['GET', `/api/clients/pocs/${id}`],
      ['POST', `/api/clients/pocs/${id}/reviews`],
      ['POST', `/api/clients/pocs/${id}/lead`],
    ] as const) {
      expect(
        (await app.send(method, address, nobody, method === 'GET' ? undefined : {})).status,
      ).toBe(404);
    }
  });

  it('says there is no such POC', async () => {
    expect(
      await refused(await app.send('GET', '/api/clients/pocs/999999', associate), 404),
    ).toMatchObject({
      error: 'PocNotFound',
    });
  });
});
