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
 * Activities and next steps, over HTTP against a real database. #280, Clients SRS CLI 58 to CLI
 * 64, TDD 4.5, TDD 11.
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

/** ADB, owned by the BD manager. */
let adb: string;

interface Named {
  id: string;
  name: string;
}

interface ActivityJson {
  id: string;
  clientId: string;
  deal: { id: string; productName: string } | null;
  kind: string;
  happenedOn: string;
  withWhom: string | null;
  outcome: string | null;
  loggedBy: Named;
  loggedAt: string;
}

interface NextStepJson {
  id: string;
  clientId: string;
  deal: { id: string; productName: string } | null;
  description: string;
  dueOn: string;
  owner: Named;
  source: string;
  fromActivity: string | null;
  done: { at: string; by: Named } | null;
  createdBy: Named;
  createdAt: string;
  overdue: boolean;
  may: { close: boolean; reopen: boolean };
}

interface LoggedJson {
  activity: ActivityJson;
  nextStep: NextStepJson | null;
}

interface ProblemJson {
  error: string;
  message: string;
  field?: string;
}

/** The day before the pinned today, and the day after it. */
const YESTERDAY = dayFrom(PINNED_DATE, -1);
const TOMORROW = dayFrom(PINNED_DATE, 1);

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

  adb = await aClient('ADB', bdManager);

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

/** A deal at `client` for `product`, opened by `as`, who owns it. */
async function aDeal(
  client = adb,
  as: Asker = associate,
  product = 'CreditStudio',
): Promise<string> {
  const response = await app.send('POST', '/api/clients/opportunities', as, {
    clientId: client,
    productId: products[product],
  });
  expect(response.status).toBe(201);

  return ((await response.json()) as { id: string }).id;
}

/** A call with ADB yesterday, with `change` over the top. */
function aCall(change: Record<string, unknown> = {}): Record<string, unknown> {
  return { clientId: adb, kind: 'CALL', happenedOn: YESTERDAY, ...change };
}

function log(as: Asker, body: unknown): Promise<globalThis.Response> {
  return app.send('POST', '/api/clients/activities', as, body);
}

async function logged(as: Asker, body: unknown): Promise<LoggedJson> {
  const response = await log(as, body);
  expect(response.status).toBe(201);

  return (await response.json()) as LoggedJson;
}

async function refused(response: globalThis.Response, status: number): Promise<ProblemJson> {
  expect(response.status).toBe(status);

  return (await response.json()) as ProblemJson;
}

async function countOf(table: 'clients_activity' | 'clients_next_step'): Promise<number> {
  return Number((await admin.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
}

/* ------------------------------------------------------------------ logging an activity */

describe('logging an activity', () => {
  /* CLI 58, CLI 60. */
  it('records what, when, with whom and what came of it, and who logged it', async () => {
    const { activity, nextStep } = await logged(
      associate,
      aCall({
        kind: 'MEETING',
        withWhom: '  Ama Owusu (CCO) and their IT lead ',
        outcome: 'Wants the archive shown to compliance before the proposal',
      }),
    );

    expect(activity).toMatchObject({
      clientId: adb,
      deal: null,
      kind: 'MEETING',
      happenedOn: YESTERDAY,
      withWhom: 'Ama Owusu (CCO) and their IT lead',
      outcome: 'Wants the archive shown to compliance before the proposal',
      loggedBy: { id: people.officer },
    });
    expect(Date.parse(activity.loggedAt)).not.toBeNaN();
    expect(nextStep).toBeNull();
  });

  /* CLI 60. Any client, not only one they own. */
  it("is anybody with a role's, at any client", async () => {
    expect((await log(associate, aCall())).status).toBe(201);
    expect((await log(colleague, aCall())).status).toBe(201);
    expect((await log(bdManager, aCall())).status).toBe(201);
  });

  /* CLI 59. A review comes with the POC (#285). A proposal, which also needs an amount and a
     deal, is clients-proposals-api.test.ts's (#281). */
  it('is a call, a meeting, a demo or a note, or a proposal, for now', async () => {
    for (const kind of ['CALL', 'MEETING', 'DEMO', 'NOTE']) {
      expect((await log(associate, aCall({ kind }))).status).toBe(201);
    }
    for (const kind of ['REVIEW', 'EMAIL', undefined]) {
      expect(await refused(await log(associate, aCall({ kind })), 400)).toMatchObject({
        error: 'InvalidActivity',
        field: 'kind',
      });
    }
  });

  /* CLI 61. */
  it('happened on any day up to today, however long ago, and not later', async () => {
    expect((await logged(associate, aCall({ happenedOn: '2019-03-01' }))).activity.happenedOn).toBe(
      '2019-03-01',
    );
    expect((await logged(associate, aCall({ happenedOn: PINNED_DATE }))).activity.happenedOn).toBe(
      PINNED_DATE,
    );

    for (const happenedOn of [TOMORROW, '2026-02-30', 'yesterday', undefined]) {
      expect(await refused(await log(associate, aCall({ happenedOn })), 400)).toMatchObject({
        field: 'happenedOn',
      });
    }
  });

  /* CLI 58. Who it was with and what came of it are optional; blank is left out. */
  it('leaves who it was with and what came of it out where nothing is said', async () => {
    const { activity } = await logged(associate, aCall({ withWhom: '   ', outcome: '' }));

    expect(activity).toMatchObject({ withWhom: null, outcome: null });
    expect(
      await refused(await log(associate, aCall({ withWhom: 'x'.repeat(201) })), 400),
    ).toMatchObject({ field: 'withWhom' });
    expect(
      await refused(await log(associate, aCall({ outcome: 'x'.repeat(4001) })), 400),
    ).toMatchObject({ field: 'outcome' });
  });

  it('is against a client that exists', async () => {
    for (const clientId of ['999999', 'ADB', undefined]) {
      expect(await refused(await log(associate, aCall({ clientId })), 400)).toMatchObject({
        error: 'InvalidActivity',
        field: 'clientId',
      });
    }
  });

  /* CLI 58, CLI 55. One of the client's own deals, open or ended. */
  it("may be about one of the client's deals, open or ended", async () => {
    const open = await aDeal();
    expect((await logged(associate, aCall({ opportunityId: open }))).activity.deal).toEqual({
      id: open,
      productName: 'CreditStudio',
    });

    const ended = await aDeal(adb, associate, 'OnboardStudio');
    const reason = (
      await admin.query<{ id: string }>(
        `SELECT id FROM clients_reason WHERE applies_to = 'LOST' AND retired_on IS NULL LIMIT 1`,
      )
    ).rows[0].id;
    expect(
      (
        await app.send('POST', `/api/clients/opportunities/${ended}/lose`, associate, {
          reasonId: reason,
        })
      ).status,
    ).toBe(200);

    expect((await logged(associate, aCall({ opportunityId: ended }))).activity.deal).toEqual({
      id: ended,
      productName: 'OnboardStudio',
    });
  });

  it("is never about another client's deal", async () => {
    const othersDeal = await aDeal(await aClient('Otherbank', associate));

    for (const opportunityId of [othersDeal, '999999', 'CreditStudio']) {
      expect(await refused(await log(associate, aCall({ opportunityId })), 400)).toMatchObject({
        error: 'InvalidActivity',
        field: 'opportunityId',
      });
    }
    expect(await countOf('clients_activity')).toBe(0);
  });

  /* NFR CLI SEC 04. */
  it('is refused silently to somebody with no role, a System Administrator included', async () => {
    expect((await log(nobody, aCall())).status).toBe(404);
    expect((await log({ ...nobody, sysAdmin: true }, aCall())).status).toBe(404);
    expect(await countOf('clients_activity')).toBe(0);
  });
});

/* ------------------------------------------------------------ with a next step, CLI 63 */

describe('logging an activity with a next step', () => {
  /** A call with ADB yesterday, and a step due today or `step` over the top. */
  function withAStep(
    step: Record<string, unknown> = {},
    change: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return aCall({
      nextStep: { description: 'Send the revised proposal', dueOn: TOMORROW, ...step },
      ...change,
    });
  }

  /* CLI 63. What, by when, and whose: the client owner's unless somebody else is named. */
  it("makes it, by default the client owner's, named after the activity", async () => {
    const { activity, nextStep } = await logged(associate, withAStep());

    expect(nextStep).toMatchObject({
      clientId: adb,
      deal: null,
      description: 'Send the revised proposal',
      dueOn: TOMORROW,
      owner: { id: people.commercialDirector },
      source: 'ACTIVITY',
      fromActivity: activity.id,
      done: null,
      createdBy: { id: people.officer },
    });
  });

  it('is about the same deal as the activity', async () => {
    const deal = await aDeal();
    const { nextStep } = await logged(associate, withAStep({}, { opportunityId: deal }));

    expect(nextStep?.deal).toEqual({ id: deal, productName: 'CreditStudio' });
  });

  /* #280. Anybody holding a role may be named; anybody else is named in what it says. */
  it('may be somebody else holding a role, and only somebody who does', async () => {
    expect(
      (await logged(associate, withAStep({ ownerId: people.opsDirector }))).nextStep?.owner.id,
    ).toBe(people.opsDirector);
    expect(
      (await logged(associate, withAStep({ ownerId: people.officer }))).nextStep?.owner.id,
    ).toBe(people.officer);

    const before = await countOf('clients_activity');
    for (const ownerId of [people.engineer, '999999', 'Kofi']) {
      expect(await refused(await log(associate, withAStep({ ownerId })), 400)).toMatchObject({
        error: 'InvalidNextStep',
        field: 'nextStep.ownerId',
      });
    }
    expect(await countOf('clients_activity')).toBe(before);
  });

  it('is refused to the client owner by default, once they hold no role', async () => {
    await admin.query(
      `UPDATE clients_role SET ended_at = now(), ended_by = $2, ended_reason = 'REVOKED'
        WHERE employee_id = $1`,
      [people.commercialDirector, people.headOfHr],
    );

    const problem = await refused(await log(associate, withAStep()), 400);
    expect(problem).toMatchObject({ field: 'nextStep.ownerId' });
    expect(problem.message).toMatch(/owner no longer has a role/);
  });

  /* #280. Due today or later, where somebody types it. */
  it('is due today or later', async () => {
    expect((await logged(associate, withAStep({ dueOn: PINNED_DATE }))).nextStep?.dueOn).toBe(
      PINNED_DATE,
    );

    for (const dueOn of [YESTERDAY, '2026-13-01', undefined]) {
      expect(await refused(await log(associate, withAStep({ dueOn })), 400)).toMatchObject({
        field: 'nextStep.dueOn',
      });
    }
  });

  it('says what happens next, in up to 300 characters', async () => {
    for (const description of ['  ', undefined, 'x'.repeat(301)]) {
      expect(await refused(await log(associate, withAStep({ description })), 400)).toMatchObject({
        error: 'InvalidNextStep',
        field: 'nextStep.description',
      });
    }
    expect(
      (await logged(associate, withAStep({ description: '  Book the Week 6 review  ' }))).nextStep
        ?.description,
    ).toBe('Book the Week 6 review');
  });

  /* Both or neither. */
  it('writes neither the activity nor the step where either is refused', async () => {
    await refused(await log(associate, withAStep({}, { happenedOn: TOMORROW })), 400);
    await refused(await log(associate, withAStep({ dueOn: YESTERDAY })), 400);

    expect(await countOf('clients_activity')).toBe(0);
    expect(await countOf('clients_next_step')).toBe(0);
  });

  it('is left out where none is asked for', async () => {
    expect((await logged(associate, aCall({ nextStep: null }))).nextStep).toBeNull();
    expect(await countOf('clients_next_step')).toBe(0);
  });
});

/* ------------------------------------------------------------- correcting one, CLI 62 */

describe('correcting an activity', () => {
  function correct(as: Asker, id: string, body: unknown): Promise<globalThis.Response> {
    return app.send('PATCH', `/api/clients/activities/${id}`, as, body);
  }

  async function corrected(as: Asker, id: string, body: unknown): Promise<ActivityJson> {
    const response = await correct(as, id, body);
    expect(response.status).toBe(200);

    return (await response.json()) as ActivityJson;
  }

  /** ADB's CreditStudio deal, which each meeting below is about. */
  let deal: string;

  beforeEach(async () => {
    deal = await aDeal();
  });

  /** A meeting with ADB yesterday, about its CreditStudio deal, logged by `as`. */
  async function aMeeting(as: Asker = associate): Promise<ActivityJson> {
    return (
      await logged(
        as,
        aCall({
          kind: 'MEETING',
          opportunityId: deal,
          withWhom: 'Ama Owusu (CCO)',
          outcome: 'Wants a demo',
        }),
      )
    ).activity;
  }

  /** Moves when it was logged back by `hours`, as only a test can. */
  async function loggedHoursAgo(id: string, hours: number): Promise<void> {
    await admin.query(
      `UPDATE clients_activity SET logged_at = now() - make_interval(hours => $2) WHERE id = $1`,
      [id, hours],
    );
  }

  /* CLI 62. */
  it('changes what was asked, and only that, for whoever logged it', async () => {
    const meeting = await aMeeting();

    expect(
      await corrected(associate, meeting.id, {
        kind: 'DEMO',
        happenedOn: '2026-10-28',
        outcome: '  Showed the archive; they want pricing  ',
      }),
    ).toMatchObject({
      id: meeting.id,
      clientId: adb,
      deal: meeting.deal,
      kind: 'DEMO',
      happenedOn: '2026-10-28',
      withWhom: 'Ama Owusu (CCO)',
      outcome: 'Showed the archive; they want pricing',
      loggedBy: { id: people.officer },
      loggedAt: meeting.loggedAt,
    });
  });

  it('takes away who it was with, what came of it, and the deal, with null or blank', async () => {
    const meeting = await aMeeting();

    expect(
      await corrected(associate, meeting.id, { opportunityId: null, withWhom: ' ', outcome: null }),
    ).toMatchObject({ deal: null, withWhom: null, outcome: null });
  });

  /* CLI 55. Another of the client's deals, open or ended, and never another client's. */
  it("moves it to another of the client's deals, and never another client's", async () => {
    const meeting = await aMeeting();
    const other = await aDeal(adb, associate, 'OnboardStudio');

    expect((await corrected(associate, meeting.id, { opportunityId: other })).deal).toEqual({
      id: other,
      productName: 'OnboardStudio',
    });

    const othersDeal = await aDeal(await aClient('Otherbank', associate));
    expect(
      await refused(await correct(associate, meeting.id, { opportunityId: othersDeal }), 400),
    ).toMatchObject({ error: 'InvalidActivity', field: 'opportunityId' });
  });

  /* #280. Its client never changes. */
  it('stays with its client', async () => {
    const meeting = await aMeeting();
    const otherbank = await aClient('Otherbank', associate);

    expect(
      await refused(await correct(associate, meeting.id, { clientId: otherbank }), 400),
    ).toMatchObject({ field: 'clientId' });
    expect((await corrected(associate, meeting.id, { clientId: adb, kind: 'CALL' })).kind).toBe(
      'CALL',
    );
  });

  it('is refused what logging it would be refused', async () => {
    const meeting = await aMeeting();

    for (const [body, field] of [
      [{ kind: 'REVIEW' }, 'kind'],
      [{ happenedOn: TOMORROW }, 'happenedOn'],
      [{ withWhom: 'x'.repeat(201) }, 'withWhom'],
      [{ opportunityId: 'CreditStudio' }, 'opportunityId'],
    ] as const) {
      expect(await refused(await correct(associate, meeting.id, body), 400)).toMatchObject({
        field,
      });
    }
  });

  /* CLI 62, TDD 12.1. Whoever logged it, and nobody else: not a BD manager either. */
  it('is refused openly to anybody else with a role, naming who logged it', async () => {
    const meeting = await aMeeting();

    for (const as of [colleague, bdManager]) {
      const problem = await refused(await correct(as, meeting.id, { kind: 'CALL' }), 403);
      expect(problem.message).toMatch(/can change this activity/);
    }
    expect(
      (await corrected(bdManager, (await aMeeting(bdManager)).id, { kind: 'CALL' })).kind,
    ).toBe('CALL');
  });

  /* NFR CLI SEC 04. */
  it('is refused silently to somebody with no role, for a real id', async () => {
    const meeting = await aMeeting();

    expect((await correct(nobody, meeting.id, { kind: 'CALL' })).status).toBe(404);
    expect(
      (await correct({ ...nobody, sysAdmin: true }, meeting.id, { kind: 'CALL' })).status,
    ).toBe(404);
  });

  it('is not found where there is no such activity', async () => {
    for (const id of ['999999', 'abc']) {
      expect(await refused(await correct(associate, id, { kind: 'CALL' }), 404)).toMatchObject({
        error: 'ActivityNotFound',
      });
    }
  });

  /* CLI 62, TDD 11's ACTIVITY_LOCKED. */
  it('may be corrected for 24 hours after it was logged, and is fixed after', async () => {
    const recent = await aMeeting();
    await loggedHoursAgo(recent.id, 23);
    expect((await corrected(associate, recent.id, { kind: 'CALL' })).kind).toBe('CALL');

    const old = await aMeeting();
    await loggedHoursAgo(old.id, 25);
    const problem = await refused(await correct(associate, old.id, { kind: 'CALL' }), 409);

    expect(problem).toMatchObject({ error: 'ActivityLocked' });
    expect(problem.message).toMatch(/Log a note to correct it/);
    expect(
      (
        await admin.query<{ kind: string }>('SELECT kind FROM clients_activity WHERE id = $1', [
          old.id,
        ])
      ).rows[0].kind,
    ).toBe('MEETING');
  });

  /* What it said before each correction, and who made it. */
  it('keeps what it said before, in the audit log', async () => {
    const meeting = await aMeeting();
    await corrected(associate, meeting.id, { outcome: 'Agreed a demo' });

    const { rows } = await admin.query<{
      action: string;
      before: { outcome: string } | null;
      actor_employee_id: string | null;
    }>(
      `SELECT action, before, actor_employee_id::text FROM audit_log
        WHERE entity = 'clients_activity' AND entity_id = $1 ORDER BY id`,
      [meeting.id],
    );

    expect(rows.map((row) => row.action)).toEqual(['CREATE', 'UPDATE']);
    expect(rows[1]).toMatchObject({
      before: { outcome: 'Wants a demo' },
      actor_employee_id: people.officer,
    });
  });
});

/* ------------------------------------------------------- a next step on its own, CLI 63 */

/** A step at ADB due tomorrow, with `change` over the top. */
function aStep(change: Record<string, unknown> = {}): Record<string, unknown> {
  return { clientId: adb, description: 'Send the revised proposal', dueOn: TOMORROW, ...change };
}

function addStep(as: Asker, body: unknown): Promise<globalThis.Response> {
  return app.send('POST', '/api/clients/next-steps', as, body);
}

async function added(as: Asker, body: unknown): Promise<NextStepJson> {
  const response = await addStep(as, body);
  expect(response.status).toBe(201);

  return (await response.json()) as NextStepJson;
}

function close(as: Asker, id: string): Promise<globalThis.Response> {
  return app.send('POST', `/api/clients/next-steps/${id}/done`, as);
}

function reopen(as: Asker, id: string): Promise<globalThis.Response> {
  return app.send('POST', `/api/clients/next-steps/${id}/reopen`, as);
}

async function stepAfter(response: Promise<globalThis.Response>): Promise<NextStepJson> {
  const answered = await response;
  expect(answered.status).toBe(200);

  return (await answered.json()) as NextStepJson;
}

describe('adding a next step on its own', () => {
  /* CLI 63. */
  it("makes it, by default the client owner's, made by hand", async () => {
    expect(await added(associate, aStep())).toMatchObject({
      clientId: adb,
      deal: null,
      description: 'Send the revised proposal',
      dueOn: TOMORROW,
      owner: { id: people.commercialDirector },
      source: 'MANUAL',
      fromActivity: null,
      done: null,
      createdBy: { id: people.officer },
      overdue: false,
      /* The BD manager's, so the associate who added it may not close it. */
      may: { close: false, reopen: false },
    });
  });

  it("may be about one of the client's deals, and be anybody's with a role", async () => {
    const deal = await aDeal();
    const step = await added(associate, aStep({ opportunityId: deal, ownerId: people.officer }));

    expect(step).toMatchObject({
      deal: { id: deal, productName: 'CreditStudio' },
      owner: { id: people.officer },
      may: { close: true, reopen: false },
    });
  });

  it('is refused what a step offered with an activity would be refused', async () => {
    const othersDeal = await aDeal(await aClient('Otherbank', associate));

    for (const [change, field] of [
      [{ clientId: '999999' }, 'clientId'],
      [{ opportunityId: othersDeal }, 'opportunityId'],
      [{ ownerId: people.engineer }, 'ownerId'],
      [{ dueOn: YESTERDAY }, 'dueOn'],
      [{ description: ' ' }, 'description'],
    ] as const) {
      expect(await refused(await addStep(associate, aStep(change)), 400)).toMatchObject({
        error: 'InvalidNextStep',
        field,
      });
    }
    expect(await countOf('clients_next_step')).toBe(0);
  });

  /* NFR CLI SEC 04. */
  it('is refused silently to somebody with no role', async () => {
    expect((await addStep(nobody, aStep())).status).toBe(404);
    expect((await addStep({ ...nobody, sysAdmin: true }, aStep())).status).toBe(404);
  });
});

/* ------------------------------------------------------ closing and reopening, CLI 64 */

describe('closing a next step', () => {
  /* CLI 64. */
  it("is its owner's, who it records as having done it, and when", async () => {
    const step = await added(associate, aStep({ ownerId: people.officer }));
    const closed = await stepAfter(close(associate, step.id));

    expect(closed).toMatchObject({
      done: { by: { id: people.officer } },
      overdue: false,
      may: { close: false, reopen: true },
    });
    expect(Date.parse(closed.done?.at ?? '')).not.toBeNaN();
  });

  /* CLI 64, #280: the SRS over TDD 11. Not a BD manager either. */
  it('is refused openly to anybody else with a role, a BD manager included', async () => {
    const step = await added(associate, aStep({ ownerId: people.officer }));

    for (const as of [colleague, bdManager]) {
      expect((await refused(await close(as, step.id), 403)).message).toMatch(
        /Only they can close it/,
      );
    }
    expect((await stepAfter(close(associate, step.id))).done).not.toBeNull();
  });

  it('is refused once it is closed, naming who closed it', async () => {
    const step = await added(associate, aStep({ ownerId: people.officer }));
    await stepAfter(close(associate, step.id));

    const problem = await refused(await close(associate, step.id), 409);
    expect(problem.error).toBe('NextStepAlreadyClosed');
    expect(problem.message).toMatch(/closed already, by /);
  });

  /* One offered with an activity is closed the same way, by the person it is for. */
  it('closes a step whatever made it', async () => {
    const { nextStep } = await logged(
      associate,
      aCall({ nextStep: { description: 'Chase the signature', dueOn: TOMORROW } }),
    );

    expect((await stepAfter(close(bdManager, nextStep?.id ?? ''))).done?.by.id).toBe(
      people.commercialDirector,
    );
  });

  it('is not found where there is no such step, and silent to somebody with no role', async () => {
    const step = await added(associate, aStep());

    for (const id of ['999999', 'abc']) {
      expect(await refused(await close(associate, id), 404)).toMatchObject({
        error: 'NextStepNotFound',
      });
    }
    expect((await close(nobody, step.id)).status).toBe(404);
  });
});

describe('reopening a next step', () => {
  async function aClosedStep(): Promise<NextStepJson> {
    const step = await added(associate, aStep({ ownerId: people.officer }));

    return stepAfter(close(associate, step.id));
  }

  /* #280. */
  it("is its owner's, and leaves it open as if never closed", async () => {
    expect(await stepAfter(reopen(associate, (await aClosedStep()).id))).toMatchObject({
      done: null,
      may: { close: true, reopen: false },
    });
  });

  /* #280. A BD manager may reopen what only its owner may close. */
  it("is a BD manager's too, and nobody else's", async () => {
    const step = await aClosedStep();

    expect((await refused(await reopen(colleague, step.id), 403)).message).toMatch(
      /Only they or a BD manager can reopen it/,
    );
    expect((await stepAfter(reopen(bdManager, step.id))).done).toBeNull();
    expect((await reopen(nobody, step.id)).status).toBe(404);
  });

  it('is refused for a step that is open', async () => {
    const step = await added(associate, aStep({ ownerId: people.officer }));

    expect(await refused(await reopen(associate, step.id), 409)).toMatchObject({
      error: 'NextStepNotClosed',
    });
  });
});

/* ---------------------------------------------------------------- overdue, CLI 64 */

describe('a next step overdue', () => {
  /** A closed step of the associate's at ADB, due on `dueOn`, put in as only a test can. */
  async function aClosedStepDue(dueOn: string): Promise<string> {
    return (
      await admin.query<{ id: string }>(
        `INSERT INTO clients_next_step
           (client_id, description, due_on, owner_id, source, created_by, done_at, done_by)
         VALUES ($1, 'Send pricing', $2, $3, 'MANUAL', $3, now(), $3) RETURNING id`,
        [adb, dueOn, people.officer],
      )
    ).rows[0].id;
  }

  /* The done-when line: worked out from the day it was due, never stored, never closed by it. */
  it('is overdue once open past the day it was due, and not on that day', async () => {
    expect((await stepAfter(reopen(associate, await aClosedStepDue(YESTERDAY)))).overdue).toBe(
      true,
    );
    expect((await stepAfter(reopen(associate, await aClosedStepDue(PINNED_DATE)))).overdue).toBe(
      false,
    );
  });

  it('may still be closed by its owner, late, and is then no longer overdue', async () => {
    const id = await aClosedStepDue('2026-09-01');
    await stepAfter(reopen(associate, id));

    expect(await stepAfter(close(associate, id))).toMatchObject({ overdue: false });
  });
});

/* ------------------------------------------------- on the client page, CLI 99, CLI 63 */

describe("the client page's Activity section", () => {
  interface EntryJson {
    kind: string;
    id?: string;
    deal: { id: string } | null;
    activityKind?: string;
    happenedOn?: string;
    by: Named;
    at: string;
    may?: { correct: boolean };
  }

  async function activityAt(as: Asker = associate): Promise<EntryJson[]> {
    const response = await app.send('GET', `/api/clients/clients/${adb}/activity`, as);
    expect(response.status).toBe(200);

    return ((await response.json()) as { activity: EntryJson[] }).activity;
  }

  /* CLI 99, #280. */
  it('lists what was logged with what happened to the deals, by the day each happened', async () => {
    const old = (await logged(associate, aCall({ happenedOn: '2019-03-01', kind: 'NOTE' })))
      .activity;
    const deal = await aDeal();
    const recent = (await logged(colleague, aCall({ opportunityId: deal, happenedOn: YESTERDAY })))
      .activity;

    const entries = await activityAt();

    /* The deal opened just now, its figures and its stage, so first; the call yesterday; and the
       note from 2019 last of all. */
    expect(entries.map((entry) => entry.kind)).toEqual(['VALUE', 'STAGE', 'LOGGED', 'LOGGED']);
    expect(entries[2]).toMatchObject({
      kind: 'LOGGED',
      id: recent.id,
      deal: { id: deal, productName: 'CreditStudio' },
      activityKind: 'CALL',
      happenedOn: YESTERDAY,
      by: { id: people.opsDirector },
    });
    expect(entries[3]).toMatchObject({ id: old.id, deal: null, activityKind: 'NOTE' });
  });

  /* CLI 62. Offered only to whoever logged it, and only within its day. */
  /* And whether they may attach a file to it, which is the logger's at any time (#281). */
  it('says whether the person reading may still correct each one', async () => {
    const mine = (await logged(associate, aCall())).activity;

    expect((await activityAt(associate))[0].may).toEqual({ correct: true, attach: true });
    expect((await activityAt(bdManager))[0].may).toEqual({ correct: false, attach: false });

    await admin.query(
      `UPDATE clients_activity SET logged_at = now() - interval '25 hours' WHERE id = $1`,
      [mine.id],
    );
    expect((await activityAt(associate))[0].may).toEqual({ correct: false, attach: true });
  });
});

describe("the client page's next steps", () => {
  async function stepsOnThePage(as: Asker = associate): Promise<NextStepJson[]> {
    const response = await app.send('GET', `/api/clients/clients/${adb}`, as);
    expect(response.status).toBe(200);

    return ((await response.json()) as { nextSteps: NextStepJson[] }).nextSteps;
  }

  /** A step at ADB of `owner`'s due on `dueOn`, put in as only a test can, closed or not. */
  async function aStepDue(dueOn: string, closed = false, owner = people.officer): Promise<string> {
    return (
      await admin.query<{ id: string }>(
        `INSERT INTO clients_next_step
           (client_id, description, due_on, owner_id, source, created_by, done_at, done_by)
         VALUES ($1, 'Send pricing', $2, $3, 'MANUAL', $3,
                 CASE WHEN $4 THEN now() END, CASE WHEN $4 THEN $3::bigint END)
         RETURNING id`,
        [adb, dueOn, owner, closed],
      )
    ).rows[0].id;
  }

  /* CLI 63, CLI 64. */
  it('lists open steps soonest due first, overdue ones marked, then closed ones', async () => {
    const later = await aStepDue(TOMORROW);
    const late = await aStepDue('2026-10-01');
    const today = await aStepDue(PINNED_DATE);
    const closed = await aStepDue('2026-09-01', true);

    expect(
      (await stepsOnThePage()).map((step) => ({
        id: step.id,
        overdue: step.overdue,
        closed: step.done !== null,
      })),
    ).toEqual([
      { id: late, overdue: true, closed: false },
      { id: today, overdue: false, closed: false },
      { id: later, overdue: false, closed: false },
      { id: closed, overdue: false, closed: true },
    ]);
  });

  it('says what the person reading may do to each', async () => {
    await aStepDue(TOMORROW);
    await aStepDue('2026-09-01', true);

    expect((await stepsOnThePage(associate)).map((step) => step.may)).toEqual([
      { close: true, reopen: false },
      { close: false, reopen: true },
    ]);
    expect((await stepsOnThePage(bdManager)).map((step) => step.may)).toEqual([
      { close: false, reopen: false },
      { close: false, reopen: true },
    ]);
    expect((await stepsOnThePage(colleague)).map((step) => step.may)).toEqual([
      { close: false, reopen: false },
      { close: false, reopen: false },
    ]);
  });

  it('lists only its own client’s', async () => {
    const otherbank = await aClient('Otherbank', associate);
    await added(associate, aStep({ clientId: otherbank }));

    expect(await stepsOnThePage()).toEqual([]);
  });
});
