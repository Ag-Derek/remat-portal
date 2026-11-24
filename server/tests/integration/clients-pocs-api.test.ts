import type { Kysely } from 'kysely';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { PINNED_DATE } from '../setup/pinned-date.js';
import { pinCurrentDate } from '../../src/core/calendar/time.js';
import { seed } from '../../seeds/seed.mjs';
import { type Database, databaseFor } from '../../src/core/db/index.js';
import { ClientsRoleRepository } from '../../src/apps/clients/role.db.js';
import { type Asker, type ClientsApp, startClientsApp } from '../support/clients-app.js';
import { tickEveryCheck } from '../support/clients-checks.js';
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

/**
 * A deal at ADB, opened by `as`, who owns it, with the POC question answered: moved to
 * Qualification and its criteria ticked (#284), so it may go on to be signed.
 */
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
  const { id } = (await response.json()) as DealJson;

  await moved(as, id, 'QUALIFICATION');
  await tickEveryCheck(admin, id);

  return (await (await app.send('GET', `/api/clients/opportunities/${id}`, as)).json()) as DealJson;
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
  deal: {
    id: string;
    productName: string;
    stage: string;
    outcome: string;
    endedOn: string | null;
    owner: { id: string };
  };
  csLead: { id: string; name: string };
  csLeadHoldsARole: boolean;
  startedOn: string;
  decisionOn: string;
  extension: { days: number; plan: string; by: { id: string }; at: string } | null;
  phase: string;
  day: number;
  daysToDecision: number;
  may: { update: boolean; moveLead: boolean; extend: boolean };
  reviews: {
    id: string;
    kind: string;
    description: string;
    dueOn: string;
    owner: { id: string };
    done: { at: string; by: { id: string } } | null;
  }[];
  held: { kind: string; heldOn: string; dmAttended: boolean; loggedBy: { id: string } }[];
  health: string;
  healthSince: string;
  healthHistory: {
    id: string;
    health: string;
    note: string | null;
    setBy: { id: string; name: string };
    setAt: string;
    actions: { body: string; loggedBy: { id: string }; loggedAt: string }[];
  }[];
  asks: { what: string; by: string } | null;
  usage: { measuredOn: string; enrolled: number; active: number; percent: number } | null;
  usageReadings: {
    measuredOn: string;
    enrolled: number;
    active: number;
    percent: number;
    recordedBy: { id: string };
    replaced: boolean;
  }[];
  targets: {
    percent: number;
    byDay: number;
    dueOn: string;
    status: string;
    reading: { percent: number } | null;
  }[];
  flags: { kind: string; since: string }[];
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

function health(as: Asker, id: string, body: unknown): Promise<globalThis.Response> {
  return app.send('POST', `/api/clients/pocs/${id}/health`, as, body);
}

function action(as: Asker, id: string, body: unknown): Promise<globalThis.Response> {
  return app.send('POST', `/api/clients/pocs/${id}/actions`, as, body);
}

/** The POC list as the app reads it `hours` from now: only its clock moves, not the database's. */
async function listIn(hours: number): Promise<PocJson[]> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + hours * 3_600_000);
  try {
    const response = await app.send('GET', '/api/clients/pocs', colleague);
    return ((await response.json()) as { pocs: PocJson[] }).pocs;
  } finally {
    vi.useRealTimers();
  }
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

/* ----------------------------------------------------------------------- its health, #286 */

describe("a POC's health", () => {
  /* The user, 20 November 2026. Every POC starts On Track, put down to whoever signed it. */
  it('starts On Track, set by whoever signed the contract', async () => {
    const deal = await aDeal();
    const id = (await moved(bdManager, deal.id, 'CONTRACT_SIGNED')).poc!.id;

    const poc = await pageOf(id);
    expect(poc.health).toBe('ON_TRACK');
    expect(poc.healthHistory).toMatchObject([
      {
        health: 'ON_TRACK',
        note: null,
        setBy: { id: people.commercialDirector, name: await nameOf(people.commercialDirector) },
      },
    ]);
    expect(poc.healthSince).toBe(poc.healthHistory[0].setAt);
  });

  /* CLI 35. Set by the CS lead or a BD manager, each change kept, the latest first. */
  it('is set by its CS lead or a BD manager, every change kept', async () => {
    const id = await aPoc();

    const atRisk = await health(associate, id, {
      health: 'AT_RISK',
      note: '  Only two branches have logged in  ',
    });
    expect(atRisk.status).toBe(201);
    expect(((await atRisk.json()) as PocJson).health).toBe('AT_RISK');

    expect((await health(bdManager, id, { health: 'STALLED' })).status).toBe(201);
    expect((await health(associate, id, { health: 'ON_TRACK', note: '' })).status).toBe(201);

    const poc = await pageOf(id, colleague);
    expect(poc.health).toBe('ON_TRACK');
    expect(poc.healthSince).toBe(poc.healthHistory[0].setAt);
    expect(
      poc.healthHistory.map((change) => [change.health, change.note, change.setBy.id]),
    ).toEqual([
      ['ON_TRACK', null, people.officer],
      ['STALLED', null, people.commercialDirector],
      ['AT_RISK', 'Only two branches have logged in', people.officer],
      ['ON_TRACK', null, people.officer],
    ]);
  });

  /* The user, 20 November 2026. Each is a change: the health it has already is refused. */
  it('is refused the health it has already', async () => {
    const id = await aPoc();
    await health(associate, id, { health: 'AT_RISK' });

    expect(await refused(await health(bdManager, id, { health: 'AT_RISK' }), 409)).toEqual({
      error: 'HealthUnchanged',
      message: 'The POC is At Risk already.',
    });
    expect((await pageOf(id)).healthHistory).toHaveLength(2);
  });

  it('is one of the three, with a note in words if any', async () => {
    const id = await aPoc();

    for (const [body, field] of [
      [{}, 'health'],
      [{ health: 'GREEN' }, 'health'],
      [{ health: 'AT_RISK', note: 7 }, 'note'],
      [{ health: 'AT_RISK', note: 'x'.repeat(2001) }, 'note'],
    ] as const) {
      expect(await refused(await health(associate, id, body), 400)).toMatchObject({
        error: 'InvalidHealth',
        field,
      });
    }
    expect((await pageOf(id)).healthHistory).toHaveLength(1);
  });

  /* CLI 35, CLI 91. Nobody else with a role, who is told whose it is. */
  it('is refused to anybody else with a role, who is told whose it is', async () => {
    const id = await aPoc();

    expect(await refused(await health(colleague, id, { health: 'STALLED' }), 403)).toEqual({
      error: 'NotAuthorised',
      message: `Only ${await nameOf(people.officer)} or a BD manager can update this POC.`,
    });
    expect((await pageOf(id)).health).toBe('ON_TRACK');
  });

  /* CLI 101. The list shows each POC's health. */
  it('shows on the POC list', async () => {
    const id = await aPoc();
    await health(associate, id, { health: 'STALLED' });

    const response = await app.send('GET', '/api/clients/pocs', colleague);
    const { pocs } = (await response.json()) as { pocs: PocJson[] };
    expect(pocs).toMatchObject([{ id, health: 'STALLED' }]);
  });
});

describe('a corrective action', () => {
  /* The SOPs, the user on 20 November 2026. Written with At Risk, against that health. */
  it('is written with At Risk, and answers it', async () => {
    const id = await aPoc();

    const response = await health(associate, id, {
      health: 'AT_RISK',
      action: 'Daily stand-up with the branch leads',
    });
    expect(response.status).toBe(201);
    const poc = (await response.json()) as PocJson;

    expect(poc.healthHistory[0]).toMatchObject({
      health: 'AT_RISK',
      actions: [{ body: 'Daily stand-up with the branch leads', loggedBy: { id: people.officer } }],
    });
    expect(poc.healthHistory[1].actions).toEqual([]);
    expect(poc.asks).toBeNull();
    expect(poc.flags).toEqual([]);
  });

  /* Asked for, but may be skipped, and is due 48 hours after the move. */
  it('is asked for while At Risk with none, due 48 hours after the move', async () => {
    const id = await aPoc();

    const poc = (await (await health(associate, id, { health: 'AT_RISK' })).json()) as PocJson;
    expect(poc.asks).toEqual({
      what: 'CORRECTIVE_ACTION',
      by: new Date(Date.parse(poc.healthSince) + 48 * 3_600_000).toISOString(),
    });
    expect(poc.flags).toEqual([]);
  });

  /* Done when: an At Risk POC with no action after 48 hours shows a flag on the POC list. */
  it('flags the POC on the list once 48 hours pass with none, until one is written', async () => {
    const id = await aPoc();
    await health(associate, id, { health: 'AT_RISK' });

    expect((await listIn(47))[0].flags).toEqual([]);
    const [flagged] = await listIn(48.1);
    expect(flagged.flags).toMatchObject([{ kind: 'NO_CORRECTIVE_ACTION' }]);
    /* A flag never changes the health. */
    expect(flagged.health).toBe('AT_RISK');

    const written = await action(bdManager, id, { action: 'Retraining on Friday' });
    expect(written.status).toBe(201);
    expect(((await written.json()) as PocJson).healthHistory[0].actions).toMatchObject([
      { body: 'Retraining on Friday', loggedBy: { id: people.commercialDirector } },
    ]);
    expect((await listIn(48.1))[0].flags).toEqual([]);
  });

  /* The move is what asks: out of At Risk ends it, and back in asks again. */
  it('is asked for again when the POC moves back into At Risk', async () => {
    const id = await aPoc();
    await health(associate, id, { health: 'AT_RISK', action: 'Weekly call' });
    await health(associate, id, { health: 'ON_TRACK' });
    expect((await listIn(100))[0].flags).toEqual([]);

    await health(associate, id, { health: 'AT_RISK' });
    expect((await pageOf(id)).asks).toMatchObject({ what: 'CORRECTIVE_ACTION' });
    expect((await listIn(48.1))[0].flags).toMatchObject([{ kind: 'NO_CORRECTIVE_ACTION' }]);

    await health(associate, id, { health: 'STALLED' });
    expect((await listIn(48.1))[0].flags).toEqual([]);
  });

  /* Only At Risk asks for one. */
  it('is refused where the health asks for none', async () => {
    const id = await aPoc();

    expect(await refused(await action(associate, id, { action: 'Something' }), 409)).toEqual({
      error: 'NoActionAsked',
      message:
        'The POC is On Track, so nothing is asked for. At Risk asks for a corrective action, ' +
        'and Stalled for a reset.',
    });
    await health(associate, id, { health: 'AT_RISK' });
    expect(
      await refused(await health(associate, id, { health: 'ON_TRACK', action: 'Something' }), 400),
    ).toMatchObject({ error: 'InvalidHealth', field: 'action' });
    expect((await pageOf(id)).healthHistory).toHaveLength(2);
  });

  it('says what is being done', async () => {
    const id = await aPoc();
    await health(associate, id, { health: 'AT_RISK' });

    expect(await refused(await action(associate, id, { action: '  ' }), 400)).toMatchObject({
      error: 'InvalidHealth',
      field: 'action',
    });
  });

  /* CLI 91. Its CS lead's or a BD manager's. */
  it('is refused to anybody else with a role', async () => {
    const id = await aPoc();
    await health(associate, id, { health: 'AT_RISK' });

    expect((await action(colleague, id, { action: 'Something' })).status).toBe(403);
    expect((await pageOf(id)).healthHistory[0].actions).toEqual([]);
  });
});

describe('a reset', () => {
  /* The SOPs, the user on 20 November 2026. Stalled asks for a reset, due seven days after. */
  it('is asked for while Stalled with none, due seven days after the move', async () => {
    const id = await aPoc();

    const poc = (await (await health(associate, id, { health: 'STALLED' })).json()) as PocJson;
    expect(poc.asks).toEqual({
      what: 'RESET',
      by: new Date(Date.parse(poc.healthSince) + 7 * 24 * 3_600_000).toISOString(),
    });
  });

  /* Stalled with nothing logged in seven days is flagged for an exit decision. */
  it('flags the POC for an exit decision once seven days pass with none, until one is written', async () => {
    const id = await aPoc();
    await health(associate, id, { health: 'STALLED' });

    expect((await listIn(7 * 24 - 1))[0].flags).toEqual([]);
    const [flagged] = await listIn(7 * 24 + 0.1);
    expect(flagged.flags).toMatchObject([{ kind: 'EXIT_DECISION' }]);
    expect(flagged.health).toBe('STALLED');

    expect((await action(associate, id, { action: 'Restart with the new COO' })).status).toBe(201);
    expect((await listIn(7 * 24 + 0.1))[0].flags).toEqual([]);
  });

  it('is written with Stalled, and answers it', async () => {
    const id = await aPoc();

    const poc = (await (
      await health(bdManager, id, { health: 'STALLED', action: 'Two-week restart plan' })
    ).json()) as PocJson;
    expect(poc.healthHistory[0]).toMatchObject({
      health: 'STALLED',
      actions: [{ body: 'Two-week restart plan', loggedBy: { id: people.commercialDirector } }],
    });
    expect(poc.asks).toBeNull();
  });
});

/* -------------------------------------------------------------------- its usage, #286 */

describe("a POC's usage", () => {
  function usage(as: Asker, id: string, body: unknown): Promise<globalThis.Response> {
    return app.send('POST', `/api/clients/pocs/${id}/usage`, as, body);
  }

  /* Done when (in part): 28 active out of 64 enrolled shows 44%, worked out, never typed. */
  it('records users enrolled and active on a day, the percentage worked out', async () => {
    const id = await aPoc();

    const response = await usage(associate, id, {
      measuredOn: PINNED_DATE,
      enrolled: 64,
      active: 28,
      percent: 90,
    });
    expect(response.status).toBe(201);
    const poc = (await response.json()) as PocJson;

    expect(poc.usage).toEqual({ measuredOn: PINNED_DATE, enrolled: 64, active: 28, percent: 44 });
    expect(poc.usageReadings).toMatchObject([
      {
        measuredOn: PINNED_DATE,
        enrolled: 64,
        active: 28,
        percent: 44,
        recordedBy: { id: people.officer },
        replaced: false,
      },
    ]);
  });

  /* The user, 20 November 2026. Another for the same day replaces it; both are kept. */
  it('counts the latest reading of a day, and keeps the one it replaced', async () => {
    const id = await aPoc();
    await usage(associate, id, { measuredOn: PINNED_DATE, enrolled: 64, active: 28 });
    await usage(bdManager, id, { measuredOn: PINNED_DATE, enrolled: 64, active: 30 });

    const poc = await pageOf(id);
    expect(poc.usage).toMatchObject({ active: 30, percent: 47 });
    expect(poc.usageReadings.map((reading) => [reading.active, reading.replaced])).toEqual([
      [30, false],
      [28, true],
    ]);
  });

  /* The latest day counts, whenever it was recorded. */
  it('shows the latest day on the list', async () => {
    const id = await aPoc();
    try {
      pinCurrentDate('2026-11-10');
      await usage(associate, id, { measuredOn: '2026-11-09', enrolled: 50, active: 40 });
      await usage(associate, id, { measuredOn: '2026-11-02', enrolled: 50, active: 10 });

      const response = await app.send('GET', '/api/clients/pocs', colleague);
      const { pocs } = (await response.json()) as { pocs: PocJson[] };
      expect(pocs[0].usage).toEqual({
        measuredOn: '2026-11-09',
        enrolled: 50,
        active: 40,
        percent: 80,
      });
    } finally {
      pinCurrentDate(PINNED_DATE);
    }
  });

  /* Done when: 28 active out of 64 enrolled at Day 63 shows 44% and the low usage flag. */
  it('at 28 of 64 on Day 63 shows 44% and the low usage flag on the list', async () => {
    const id = await aPoc();
    const day63 = '2026-12-31';

    try {
      pinCurrentDate('2026-12-30');
      await usage(associate, id, { measuredOn: '2026-12-30', enrolled: 64, active: 28 });
      let [poc] = (
        (await (await app.send('GET', '/api/clients/pocs', colleague)).json()) as {
          pocs: PocJson[];
        }
      ).pocs;
      expect(poc.flags).toEqual([]);

      pinCurrentDate(day63);
      await usage(associate, id, { measuredOn: day63, enrolled: 64, active: 28 });
      [poc] = (
        (await (await app.send('GET', '/api/clients/pocs', colleague)).json()) as {
          pocs: PocJson[];
        }
      ).pocs;

      expect(poc.day).toBe(63);
      expect(poc.usage).toMatchObject({ active: 28, enrolled: 64, percent: 44 });
      expect(poc.flags).toEqual([{ kind: 'LOW_USAGE', since: `${day63}T00:00:00.000Z` }]);
      /* A flag never changes the health. */
      expect(poc.health).toBe('ON_TRACK');
    } finally {
      pinCurrentDate(PINNED_DATE);
    }
  });

  /* The user, 20 November 2026. Nothing recorded by Day 63 is flagged too. */
  it('flags a POC with no usage recorded by Day 63', async () => {
    const id = await aPoc();

    try {
      pinCurrentDate('2026-12-31');
      expect((await pageOf(id)).flags).toEqual([
        { kind: 'NO_USAGE', since: '2026-12-31T00:00:00.000Z' },
      ]);
    } finally {
      pinCurrentDate(PINNED_DATE);
    }
  });

  /* The SOPs. ADB is a bank: 50% by Day 30, 70% by Day 63, each judged once its day comes. */
  it("shows the targets for the client's type, met or missed once their day comes", async () => {
    const id = await aPoc();

    try {
      pinCurrentDate('2026-11-28');
      await usage(associate, id, { measuredOn: '2026-11-28', enrolled: 64, active: 40 });
      const poc = await pageOf(id);

      expect(poc.targets).toEqual([
        {
          percent: 50,
          byDay: 30,
          dueOn: '2026-11-28',
          status: 'MET',
          reading: { measuredOn: '2026-11-28', enrolled: 64, active: 40, percent: 63 },
        },
        { percent: 70, byDay: 63, dueOn: '2026-12-31', status: 'UPCOMING', reading: null },
      ]);
      /* A missed target is shown, never flagged. */
      pinCurrentDate('2026-12-31');
      await usage(associate, id, { measuredOn: '2026-12-31', enrolled: 64, active: 40 });
      const later = await pageOf(id);
      expect(later.targets[1]).toMatchObject({ status: 'MISSED', reading: { percent: 63 } });
      expect(later.flags).toEqual([]);
    } finally {
      pinCurrentDate(PINNED_DATE);
    }
  });

  it('starts with none', async () => {
    const poc = await pageOf(await aPoc());

    expect(poc.usage).toBeNull();
    expect(poc.usageReadings).toEqual([]);
  });

  /* From the start to today, some enrolled, no more active than enrolled. */
  it('is for a day of the POC so far, with counts that make sense', async () => {
    const id = await aPoc();
    const good = { measuredOn: PINNED_DATE, enrolled: 64, active: 28 };

    for (const [body, field] of [
      [{ ...good, measuredOn: '2026-10-29' }, 'measuredOn'],
      [{ ...good, measuredOn: '2026-10-31' }, 'measuredOn'],
      [{ ...good, enrolled: 0 }, 'enrolled'],
      [{ ...good, active: 65 }, 'active'],
    ] as const) {
      expect(await refused(await usage(associate, id, body), 400)).toMatchObject({
        error: 'InvalidUsage',
        field,
      });
    }
    expect((await pageOf(id)).usageReadings).toEqual([]);
  });

  /* CLI 91. Its CS lead's or a BD manager's. */
  it('is refused to anybody else with a role', async () => {
    const id = await aPoc();

    expect(
      (await usage(colleague, id, { measuredOn: PINNED_DATE, enrolled: 64, active: 28 })).status,
    ).toBe(403);
    expect((await pageOf(id)).usage).toBeNull();
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

    expect((await pageOf(id, colleague)).may).toEqual({
      update: true,
      moveLead: false,
      extend: true,
    });
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

  /* #286, CLI 50. A running POC past its decision date is flagged on the list, its health kept. */
  it('flags a POC past its decision date, from the day after it', async () => {
    const id = await aPoc();
    await app.send('POST', `/api/clients/pocs/${id}/usage`, associate, {
      measuredOn: PINNED_DATE,
      enrolled: 10,
      active: 9,
    });

    try {
      const flagsOn = async (today: string) => {
        pinCurrentDate(today);
        const response = await app.send('GET', '/api/clients/pocs', colleague);
        return ((await response.json()) as { pocs: PocJson[] }).pocs[0];
      };

      expect((await flagsOn(DECIDED_BY)).flags).toEqual([]);
      const late = await flagsOn('2027-01-09');
      expect(late.flags).toEqual([{ kind: 'PAST_DECISION', since: '2027-01-09T00:00:00.000Z' }]);
      expect(late.health).toBe('ON_TRACK');
    } finally {
      pinCurrentDate(PINNED_DATE);
    }
  });

  /* CLI 100. Its page: the deal, the clock, and what the person reading may do. */
  it('shows one POC to anybody with a role, with what they may do', async () => {
    const id = await aPoc();

    expect((await pageOf(id, associate)).may).toEqual({
      update: true,
      moveLead: false,
      extend: true,
    });
    expect((await pageOf(id, bdManager)).may).toEqual({
      update: true,
      moveLead: true,
      extend: true,
    });
    expect((await pageOf(id, colleague)).may).toEqual({
      update: false,
      moveLead: false,
      extend: false,
    });
  });

  /* NFR CLI SEC 04. Nothing at all to somebody with no role, whatever the id. */
  it('is nothing to somebody with no role', async () => {
    const id = await aPoc();

    for (const [method, address] of [
      ['GET', '/api/clients/pocs'],
      ['GET', `/api/clients/pocs/${id}`],
      ['POST', `/api/clients/pocs/${id}/reviews`],
      ['POST', `/api/clients/pocs/${id}/health`],
      ['POST', `/api/clients/pocs/${id}/actions`],
      ['POST', `/api/clients/pocs/${id}/usage`],
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

/* ------------------------------------------------------------- the extension, #287 */

describe('the extension', () => {
  function extend(as: Asker, id: string, body: unknown): Promise<globalThis.Response> {
    return app.send('POST', `/api/clients/pocs/${id}/extension`, as, body);
  }

  const PLAN = 'Two more weeks to bring the last three branches onto it';

  /* CLI 31. Up to 30 days, with a plan, and the decision date moved to match. */
  it('adds up to 30 days once, with a written plan and a new decision date', async () => {
    const id = await aPoc();

    const response = await extend(associate, id, { days: 21, plan: `  ${PLAN}  ` });
    expect(response.status).toBe(201);
    const poc = (await response.json()) as PocJson;

    expect(poc).toMatchObject({
      decisionOn: '2027-01-29',
      daysToDecision: 91,
      extension: { days: 21, plan: PLAN, by: { id: people.officer } },
      may: { update: true, extend: false },
    });
  });

  /* Done when: asking for a second extension is refused. */
  it('is refused a second time', async () => {
    const id = await aPoc();
    await extend(associate, id, { days: 10, plan: PLAN });

    expect(await refused(await extend(bdManager, id, { days: 5, plan: 'More' }), 409)).toEqual({
      error: 'ExtendedAlready',
      message:
        'This POC has been extended once already, to 18 January 2027. A POC is extended only ' +
        'once: convert or exit it by then.',
    });
    expect(await pageOf(id)).toMatchObject({ decisionOn: '2027-01-18', extension: { days: 10 } });
  });

  it('is 1 to 30 whole days, with a plan', async () => {
    const id = await aPoc();

    for (const [body, field] of [
      [{ days: 0, plan: PLAN }, 'days'],
      [{ days: 31, plan: PLAN }, 'days'],
      [{ days: 1.5, plan: PLAN }, 'days'],
      [{ plan: PLAN }, 'days'],
      [{ days: 10, plan: '  ' }, 'plan'],
      [{ days: 10 }, 'plan'],
    ] as const) {
      expect(await refused(await extend(associate, id, body), 400)).toMatchObject({
        error: 'InvalidExtension',
        field,
      });
    }
    expect((await pageOf(id)).extension).toBeNull();
  });

  /* The user, 20 November 2026. Past its decision date too, which ends that flag. */
  it('may be asked for past the decision date, and ends that flag', async () => {
    const id = await aPoc();

    try {
      pinCurrentDate('2027-01-12');
      expect((await pageOf(id)).flags.map((flag) => flag.kind)).toContain('PAST_DECISION');

      const poc = (await (await extend(associate, id, { days: 30, plan: PLAN })).json()) as PocJson;
      expect(poc.decisionOn).toBe('2027-02-07');
      expect(poc.flags.map((flag) => flag.kind)).not.toContain('PAST_DECISION');
    } finally {
      pinCurrentDate(PINNED_DATE);
    }
  });

  /* CLI 35, CLI 91. Its CS lead's or a BD manager's. */
  it('is refused to anybody else with a role', async () => {
    const id = await aPoc();

    expect((await extend(colleague, id, { days: 10, plan: PLAN })).status).toBe(403);
  });
});

/* ------------------------------------------------------------ ending a POC, #287 */

describe('ending a POC', () => {
  async function exitReason(label = 'Usage too low'): Promise<string> {
    return (
      await admin.query<{ id: string }>(
        `SELECT id FROM clients_reason WHERE applies_to = 'EXITED' AND label = $1`,
        [label],
      )
    ).rows[0].id;
  }

  function convert(as: Asker, id: string, body: unknown = {}): Promise<globalThis.Response> {
    return app.send('POST', `/api/clients/pocs/${id}/convert`, as, body);
  }

  function exit(as: Asker, id: string, body: unknown): Promise<globalThis.Response> {
    return app.send('POST', `/api/clients/pocs/${id}/exit`, as, body);
  }

  /** A deal for `product` at ADB, owned by the associate, signed: its POC. */
  async function aPocFor(product: string): Promise<string> {
    return (await moved(associate, (await aDeal(associate, product)).id, 'CONTRACT_SIGNED')).poc!
      .id;
  }

  /* Done when: a POC with Federation converted and Cloud9 exited ends with one deal won and one
     exited. One deal per POC (the user, 20 November 2026): each has a POC of its own. */
  it('converts Federation and exits Cloud9: one deal won, one exited', async () => {
    const federation = await aPocFor('Federation');
    const cloud9 = await aPocFor('Cloud9');

    const converted = await convert(associate, federation);
    expect(converted.status).toBe(200);
    const exited = await exit(associate, cloud9, {
      reasonId: await exitReason(),
      note: 'Ran on Cloud9 only',
    });
    expect(exited.status).toBe(200);

    expect(((await converted.json()) as PocJson).deal).toMatchObject({
      productName: 'Federation',
      stage: 'LIVE',
      outcome: 'WON',
      endedOn: PINNED_DATE,
    });
    expect(((await exited.json()) as PocJson).deal).toMatchObject({
      productName: 'Cloud9',
      stage: 'POC',
      outcome: 'EXITED',
      endedOn: PINNED_DATE,
    });

    /* Both have ended, so neither is running. */
    const response = await app.send('GET', '/api/clients/pocs', colleague);
    expect(((await response.json()) as { pocs: PocJson[] }).pocs).toEqual([]);
  });

  /* CLI 49. A converted deal's value may be revised as it converts, the old one kept. */
  it('revises the value of a converted deal, keeping the old one', async () => {
    const deal = await aDeal();
    await app.send('PATCH', `/api/clients/opportunities/${deal.id}`, associate, {
      value: { amount: '12000', currency: 'USD' },
    });
    const id = (await moved(associate, deal.id, 'CONTRACT_SIGNED')).poc!.id;

    expect(
      (await convert(bdManager, id, { value: { amount: '15000', currency: 'USD' } })).status,
    ).toBe(200);

    const response = await app.send(
      'GET',
      `/api/clients/opportunities/${deal.id}/history`,
      associate,
    );
    const { history } = (await response.json()) as {
      history: { value: { amountMinor: number; currency: string } | null; source: string }[];
    };
    expect(history.slice(0, 2)).toMatchObject([
      { value: { amountMinor: 1_500_000, currency: 'USD' }, source: 'CONVERSION' },
      { value: { amountMinor: 1_200_000, currency: 'USD' }, source: 'MANUAL' },
    ]);
  });

  it('leaves the value as it is where none is given', async () => {
    const deal = await aDeal();
    await app.send('PATCH', `/api/clients/opportunities/${deal.id}`, associate, {
      value: { amount: '12000', currency: 'USD' },
    });
    const id = (await moved(associate, deal.id, 'CONTRACT_SIGNED')).poc!.id;
    await convert(associate, id);

    const response = await app.send(
      'GET',
      `/api/clients/opportunities/${deal.id}/history`,
      associate,
    );
    const { history } = (await response.json()) as { history: { source: string }[] };
    expect(history.map((change) => change.source)).not.toContain('CONVERSION');
  });

  it('is told what to fix in a value that makes no sense', async () => {
    const id = await aPoc();

    expect(
      await refused(
        await convert(associate, id, { value: { amount: '15000', currency: 'EUR' } }),
        400,
      ),
    ).toMatchObject({ error: 'InvalidOpportunity', field: 'value' });
    expect((await pageOf(id)).deal.outcome).toBe('OPEN');
  });

  /* CLI 52 to CLI 54. An exit follows the exit rules: a reason, the products, the debrief. */
  it('exits by the exit rules: a reason, which products it ran on, and the debrief', async () => {
    const id = await aPoc();

    expect(
      await refused(await exit(associate, id, { reasonId: await exitReason() }), 400),
    ).toMatchObject({ error: 'InvalidEnding', field: 'note' });
    const lostReason = (
      await admin.query<{ id: string }>(
        `SELECT id FROM clients_reason WHERE applies_to = 'LOST' LIMIT 1`,
      )
    ).rows[0].id;
    expect(
      await refused(await exit(associate, id, { reasonId: lostReason, note: 'Federation' }), 400),
    ).toMatchObject({ error: 'ReasonNotOffered' });

    expect(
      (await exit(associate, id, { reasonId: await exitReason(), note: 'Federation' })).status,
    ).toBe(200);
    const { rows } = await admin.query(
      `SELECT description FROM clients_next_step
        WHERE opportunity_id = $1 AND source = 'DEBRIEF'`,
      [(await pageOf(id)).deal.id],
    );
    expect(rows).toEqual([{ description: 'Internal debrief on the ADB Federation POC exit' }]);
  });

  /* The user, 20 November 2026. Its open review meetings close, put down to whoever ended it. */
  it('closes its open review meetings, put down to whoever ended it', async () => {
    const id = await aPoc();
    await review(associate, id, DAY7_HELD);

    await convert(bdManager, id);

    expect((await pageOf(id)).reviews.map((step) => [step.kind, step.done?.by.id])).toEqual([
      ['DAY7', people.officer],
      ['WEEK6', people.commercialDirector],
      ['WEEK9', people.commercialDirector],
    ]);
  });

  /* Kept as it ended: readable, nothing more to do, no flags. */
  it('keeps an ended POC readable, with nothing more to do and nothing flagged', async () => {
    const id = await aPoc();
    await convert(associate, id);

    try {
      pinCurrentDate('2027-02-01');
      const poc = await pageOf(id, bdManager);

      expect(poc.may).toEqual({ update: false, moveLead: false, extend: false });
      expect(poc.flags).toEqual([]);
      expect(poc.asks).toBeNull();
    } finally {
      pinCurrentDate(PINNED_DATE);
    }

    for (const [address, body] of [
      ['convert', {}],
      ['exit', { reasonId: await exitReason(), note: 'Federation' }],
      ['extension', { days: 5, plan: 'More' }],
    ] as const) {
      expect(
        await refused(
          await app.send('POST', `/api/clients/pocs/${id}/${address}`, associate, body),
          409,
        ),
      ).toMatchObject({ error: 'PocEnded' });
    }
  });

  /* CLI 50. A POC never ends itself when its date passes. */
  it('never ends itself when its date passes', async () => {
    const id = await aPoc();

    try {
      pinCurrentDate('2027-06-01');
      const response = await app.send('GET', '/api/clients/pocs', colleague);
      const { pocs } = (await response.json()) as { pocs: PocJson[] };

      expect(pocs).toMatchObject([{ id, deal: { outcome: 'OPEN', stage: 'POC' } }]);
    } finally {
      pinCurrentDate(PINNED_DATE);
    }
  });

  /* CLI 35, CLI 91. Its CS lead's or a BD manager's; nobody else's, and nothing to no role. */
  it('is refused to anybody else with a role, and is nothing to somebody with none', async () => {
    const id = await aPoc();

    expect((await convert(colleague, id)).status).toBe(403);
    expect(
      (await exit(colleague, id, { reasonId: await exitReason(), note: 'Federation' })).status,
    ).toBe(403);
    for (const address of ['convert', 'exit', 'extension']) {
      expect(
        (await app.send('POST', `/api/clients/pocs/${id}/${address}`, nobody, {})).status,
      ).toBe(404);
    }
    expect((await pageOf(id)).deal.outcome).toBe('OPEN');
  });
});
