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
 * A BD manager moving clients, open deals and POCs to somebody else, over HTTP against a real
 * database. #289, Clients SRS CLI 92, CLI 96.
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

const TOMORROW = (() => {
  const date = new Date(`${PINNED_DATE}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
})();

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
  await grants.grant(people.teamLead, 'ASSOCIATE', people.headOfHr, 'them');

  bdManager = { employeeId: people.commercialDirector };
  associate = { employeeId: people.officer };
  colleague = { employeeId: people.teamLead };
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

async function aDeal(client: string, product = 'CreditStudio', as: Asker = associate) {
  const response = await app.send('POST', '/api/clients/opportunities', as, {
    clientId: client,
    productId: products[product],
  });
  expect(response.status).toBe(201);

  return ((await response.json()) as { id: string }).id;
}

/** An open step, written straight to the table, on a deal or (with no deal) on the client. */
async function aStep(client: string, deal: string | null, owner: string, what: string) {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO clients_next_step
       (client_id, opportunity_id, description, due_on, owner_id, source, created_by)
     VALUES ($1, $2, $3, $4, $5, 'MANUAL', $5) RETURNING id`,
    [client, deal, what, TOMORROW, owner],
  );
  return rows[0].id;
}

/** A POC's open review meeting, its lead's. */
async function aReview(client: string, deal: string, poc: string, owner: string) {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO clients_next_step (client_id, opportunity_id, poc_id, description, due_on,
                                    owner_id, source, review_kind, created_by)
     VALUES ($1, $2, $3, 'Day 7 showcase', $4, $5, 'REVIEW', 'DAY7', $5) RETURNING id`,
    [client, deal, poc, TOMORROW, owner],
  );
  return rows[0].id;
}

async function ownerOfStep(id: string): Promise<string> {
  return (
    await admin.query<{ owner_id: string }>(
      'SELECT owner_id FROM clients_next_step WHERE id = $1',
      [id],
    )
  ).rows[0].owner_id;
}

async function ownerOf(table: string, id: string, column = 'owner_id'): Promise<string> {
  return (
    await admin.query<Record<string, string>>(`SELECT ${column} FROM ${table} WHERE id = $1`, [id])
  ).rows[0][column];
}

async function lose(deal: string) {
  const reason = (
    await admin.query<{ id: string }>(
      `SELECT id FROM clients_reason WHERE applies_to = 'LOST' ORDER BY id LIMIT 1`,
    )
  ).rows[0].id;
  expect(
    (
      await app.send('POST', `/api/clients/opportunities/${deal}/lose`, associate, {
        reasonId: reason,
      })
    ).status,
  ).toBe(200);
}

function moveDeal(as: Asker, deal: string, ownerId: unknown) {
  return app.send('POST', `/api/clients/opportunities/${deal}/owner`, as, { ownerId });
}

describe('moving an open deal', () => {
  it("moves it, and the old owner's open steps on it, but nobody else's", async () => {
    const ecobank = await aClient('Ecobank');
    const deal = await aDeal(ecobank);
    const theirs = await aStep(ecobank, deal, people.officer, 'Send the proposal');
    const someoneElses = await aStep(ecobank, deal, people.commercialDirector, 'Call the CEO');
    const onTheClient = await aStep(ecobank, null, people.officer, 'Annual review');

    const response = await moveDeal(bdManager, deal, people.teamLead);
    expect(response.status).toBe(200);

    expect(await ownerOf('clients_opportunity', deal)).toBe(people.teamLead);
    expect(await ownerOfStep(theirs)).toBe(people.teamLead);
    expect(await ownerOfStep(someoneElses)).toBe(people.commercialDirector);
    /* The client and its own steps are not the deal's. */
    expect(await ownerOf('clients_client', ecobank)).toBe(people.officer);
    expect(await ownerOfStep(onTheClient)).toBe(people.officer);
  });

  it('takes its POC with it: the CS lead and the open review meetings', async () => {
    const ecobank = await aClient('Ecobank');
    const deal = await aDeal(ecobank, 'Federation');
    const poc = await intoItsPoc(admin, deal);
    const review = await aReview(ecobank, deal, poc, people.officer);

    expect((await moveDeal(bdManager, deal, people.teamLead)).status).toBe(200);

    expect(await ownerOf('clients_poc', poc, 'cs_lead_id')).toBe(people.teamLead);
    expect(await ownerOfStep(review)).toBe(people.teamLead);
  });

  it('offers it to a BD manager alone, while it is open', async () => {
    const ecobank = await aClient('Ecobank');
    const deal = await aDeal(ecobank);

    const read = async (as: Asker) =>
      (
        (await (await app.send('GET', `/api/clients/opportunities/${deal}`, as)).json()) as {
          may: { reassign: boolean };
        }
      ).may.reassign;

    expect(await read(bdManager)).toBe(true);
    expect(await read(associate)).toBe(false);

    await lose(deal);
    expect(await read(bdManager)).toBe(false);
  });

  it('is refused to an associate, even their own, and silently to somebody with no role', async () => {
    const deal = await aDeal(await aClient('Ecobank'));

    expect((await moveDeal(associate, deal, people.teamLead)).status).toBe(403);
    expect((await moveDeal(nobody, deal, people.teamLead)).status).toBe(404);
  });

  it('is refused once it has ended, which keeps its owner', async () => {
    const deal = await aDeal(await aClient('Ecobank'));
    await lose(deal);

    const response = await moveDeal(bdManager, deal, people.teamLead);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'OpportunityEnded' });
    expect(await ownerOf('clients_opportunity', deal)).toBe(people.officer);
  });

  it('goes only to somebody with a role who is at the company today', async () => {
    const deal = await aDeal(await aClient('Ecobank'));
    await admin.query(`UPDATE employee SET employment_status = 'SUSPENDED' WHERE id = $1`, [
      people.teamLead,
    ]);

    for (const to of [people.engineer, people.teamLead, 'Ama', undefined]) {
      const response = await moveDeal(bdManager, deal, to);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: 'InvalidReassignment',
        field: 'ownerId',
      });
    }
    expect(await ownerOf('clients_opportunity', deal)).toBe(people.officer);
  });
});

describe('moving a client', () => {
  it("takes the old owner's open steps on the client alone, not its deals", async () => {
    const ecobank = await aClient('Ecobank');
    const deal = await aDeal(ecobank);
    const onTheClient = await aStep(ecobank, null, people.officer, 'Annual review');
    const onTheDeal = await aStep(ecobank, deal, people.officer, 'Send the proposal');

    const response = await app.send('PATCH', `/api/clients/clients/${ecobank}`, bdManager, {
      ownerId: people.teamLead,
    });
    expect(response.status).toBe(200);

    expect(await ownerOf('clients_client', ecobank)).toBe(people.teamLead);
    expect(await ownerOfStep(onTheClient)).toBe(people.teamLead);
    expect(await ownerOf('clients_opportunity', deal)).toBe(people.officer);
    expect(await ownerOfStep(onTheDeal)).toBe(people.officer);
  });

  it('goes only to somebody at the company today', async () => {
    const ecobank = await aClient('Ecobank');
    await admin.query(`UPDATE employee SET employment_status = 'SUSPENDED' WHERE id = $1`, [
      people.teamLead,
    ]);

    const response = await app.send('PATCH', `/api/clients/clients/${ecobank}`, bdManager, {
      ownerId: people.teamLead,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: 'ownerId' });
  });
});

describe("moving a POC's CS lead", () => {
  it('goes only to somebody at the company today', async () => {
    const poc = await intoItsPoc(admin, await aDeal(await aClient('Ecobank'), 'Federation'));
    await admin.query(`UPDATE employee SET employment_status = 'SUSPENDED' WHERE id = $1`, [
      people.teamLead,
    ]);

    const response = await app.send('POST', `/api/clients/pocs/${poc}/lead`, bdManager, {
      employeeId: people.teamLead,
    });
    expect(response.status).toBe(400);
  });
});

describe("moving everything of one person's", () => {
  it('moves every client, open deal and running POC, and leaves what ended', async () => {
    const ecobank = await aClient('Ecobank');
    const zenith = await aClient('Zenith');
    const credit = await aDeal(ecobank);
    const federationDeal = await aDeal(ecobank, 'Federation');
    const poc = await intoItsPoc(admin, federationDeal);
    const review = await aReview(ecobank, federationDeal, poc, people.officer);
    const lost = await aDeal(zenith, 'OnboardStudio');
    await lose(lost);
    const step = await aStep(zenith, null, people.officer, 'Annual review');
    /* Somebody else's, untouched. */
    const theirs = await aDeal(await aClient('ADB', bdManager), 'CreditStudio', bdManager);

    const response = await app.send('POST', '/api/clients/reassign', bdManager, {
      fromId: people.officer,
      toId: people.teamLead,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ clients: 2, deals: 2, pocs: 1 });

    expect(await ownerOf('clients_client', ecobank)).toBe(people.teamLead);
    expect(await ownerOf('clients_client', zenith)).toBe(people.teamLead);
    expect(await ownerOf('clients_opportunity', credit)).toBe(people.teamLead);
    expect(await ownerOf('clients_opportunity', federationDeal)).toBe(people.teamLead);
    expect(await ownerOf('clients_poc', poc, 'cs_lead_id')).toBe(people.teamLead);
    expect(await ownerOfStep(review)).toBe(people.teamLead);
    expect(await ownerOfStep(step)).toBe(people.teamLead);
    expect(await ownerOf('clients_opportunity', lost)).toBe(people.officer);
    expect(await ownerOf('clients_opportunity', theirs)).toBe(people.commercialDirector);
  });

  /* The issue: a departed associate's things, moved from the dashboard, are no longer listed. */
  it('clears a departed associate from what needs reassigning', async () => {
    const ecobank = await aClient('Ecobank');
    await aDeal(ecobank);
    await admin.query('UPDATE employee SET exit_date = $2 WHERE id = $1', [
      people.officer,
      '2026-01-01',
    ]);

    const before = (await (await app.send('GET', '/api/clients/dashboard', bdManager)).json()) as {
      reassign: { person: { id: string }; mayMoveAll: boolean }[];
    };
    expect(before.reassign).toMatchObject([{ person: { id: people.officer }, mayMoveAll: true }]);

    expect(
      (
        await app.send('POST', '/api/clients/reassign', bdManager, {
          fromId: people.officer,
          toId: people.teamLead,
        })
      ).status,
    ).toBe(200);

    const after = (await (await app.send('GET', '/api/clients/dashboard', bdManager)).json()) as {
      reassign: unknown[];
    };
    expect(after.reassign).toEqual([]);
  });

  it('is offered to a BD manager alone', async () => {
    await aDeal(await aClient('Ecobank'));
    await admin.query(`UPDATE employee SET employment_status = 'SUSPENDED' WHERE id = $1`, [
      people.officer,
    ]);

    const seen = (await (await app.send('GET', '/api/clients/dashboard', colleague)).json()) as {
      reassign: { mayMoveAll: boolean }[];
    };
    expect(seen.reassign).toMatchObject([{ mayMoveAll: false }]);

    expect(
      (
        await app.send('POST', '/api/clients/reassign', colleague, {
          fromId: people.officer,
          toId: people.teamLead,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.send('POST', '/api/clients/reassign', nobody, {
          fromId: people.officer,
          toId: people.teamLead,
        })
      ).status,
    ).toBe(404);
  });

  it('is refused to nobody named, to the same person, and to somebody who cannot take over', async () => {
    const tryMoving = async (body: unknown) => {
      const response = await app.send('POST', '/api/clients/reassign', bdManager, body);
      return [response.status, ((await response.json()) as { field?: string }).field];
    };

    expect(await tryMoving({ toId: people.teamLead })).toEqual([400, 'fromId']);
    expect(await tryMoving({ fromId: people.officer, toId: people.officer })).toEqual([
      400,
      'toId',
    ]);
    expect(await tryMoving({ fromId: people.officer, toId: people.engineer })).toEqual([
      400,
      'toId',
    ]);
  });
});

describe('the people things may be moved to', () => {
  it('says of each role holder whether they can take things over', async () => {
    await admin.query(`UPDATE employee SET employment_status = 'SUSPENDED' WHERE id = $1`, [
      people.teamLead,
    ]);

    const { people: holders } = (await (
      await app.send('GET', '/api/clients/holders', bdManager)
    ).json()) as { people: { id: string; canTakeOver: boolean }[] };

    expect(Object.fromEntries(holders.map((one) => [one.id, one.canTakeOver]))).toEqual({
      [people.commercialDirector]: true,
      [people.officer]: true,
      [people.teamLead]: false,
    });
  });
});
