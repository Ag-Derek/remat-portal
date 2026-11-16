import type { Router } from 'express';
import type { Kysely } from 'kysely';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { seed } from '../../seeds/seed.mjs';
import { type Database, databaseFor } from '../../src/core/db/index.js';
import { NO_SUCH_ROUTE } from '../../src/core/http/problems.js';
import { type Asker, type ClientsApp, startClientsApp } from '../support/clients-app.js';
import { recordingDenials } from '../support/recording-denials.js';

/**
 * The clients roles screen, over HTTP against a real database. #274, Clients SRS CLI 94.
 *
 * Mounted as app.ts mounts it, by ../support/clients-app.ts.
 */

const testDatabaseUrl = await databaseForThisFile();

const denials = recordingDenials();

let db: Kysely<Database>;
let admin: Client;
let app: ClientsApp;
let people: Record<string, string>;
let clients: Router;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);
  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  app = await startClientsApp(db, denials);
  /* Kept, so the test below can ask it which routes it has. */
  clients = app.router;
});

beforeEach(async () => {
  /* The seed empties employee with CASCADE, which empties clients_role with it. */
  people = (await seed(admin)) as Record<string, string>;
  denials.clear();
});

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await admin?.end();
});

function send(method: string, path: string, as: Asker, body?: unknown) {
  return app.send(method, path, as, body);
}

/** The system administrator in these tests: the head of HR, who holds no clients role. */
function sysadmin(): Asker {
  return { employeeId: people.headOfHr, sysAdmin: true };
}

async function grant(employeeId: string, role: string): Promise<string> {
  const response = await send('POST', '/api/clients/roles', sysadmin(), { employeeId, role });
  expect(response.status).toBe(201);

  return ((await response.json()) as { id: string }).id;
}

async function liveRows(): Promise<{ employee_id: string; role: string }[]> {
  return (
    await admin.query<{ employee_id: string; role: string }>(
      'SELECT employee_id, role FROM clients_role WHERE ended_at IS NULL ORDER BY id',
    )
  ).rows;
}

/* --------------------------------------------------------- a system administrator */

describe('a portal System Administrator', () => {
  it('sees who holds what, and everybody at the company to choose from', async () => {
    await grant(people.officer, 'ASSOCIATE');
    await grant(people.commercialDirector, 'BD_MANAGER');

    const response = await send('GET', '/api/clients/roles', sysadmin());
    expect(response.status).toBe(200);

    const screen = (await response.json()) as {
      grants: {
        role: string;
        holder: { id: string; current: boolean };
        grantedBy: { id: string };
      }[];
      people: { id: string; name: string }[];
    };

    /* BD managers first. */
    expect(screen.grants.map((one) => [one.role, one.holder.id])).toEqual([
      ['BD_MANAGER', people.commercialDirector],
      ['ASSOCIATE', people.officer],
    ]);
    expect(screen.grants.every((one) => one.holder.current)).toBe(true);
    expect(screen.grants.every((one) => one.grantedBy.id === people.headOfHr)).toBe(true);

    /* Everybody here today, and not the person who left in July. */
    const ids = screen.people.map((one) => one.id);
    expect(ids).toContain(people.officer);
    expect(ids).not.toContain(people.leaver);
    expect(screen.people.find((one) => one.id === people.leaver)).toBeUndefined();
  });

  it('grants a role, recording who granted it and when', async () => {
    const response = await send('POST', '/api/clients/roles', sysadmin(), {
      employeeId: people.officer,
      role: 'ASSOCIATE',
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      employeeId: people.officer,
      role: 'ASSOCIATE',
      grantedBy: people.headOfHr,
      endedAt: null,
    });

    const { rows } = await admin.query<{ granted_by: string; granted_at: Date }>(
      'SELECT granted_by, granted_at FROM clients_role WHERE employee_id = $1',
      [people.officer],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].granted_by).toBe(people.headOfHr);
    expect(rows[0].granted_at).toBeInstanceOf(Date);
  });

  it('may grant BD manager to more than one person', async () => {
    await grant(people.commercialDirector, 'BD_MANAGER');
    await grant(people.opsDirector, 'BD_MANAGER');

    expect(await liveRows()).toEqual([
      { employee_id: people.commercialDirector, role: 'BD_MANAGER' },
      { employee_id: people.opsDirector, role: 'BD_MANAGER' },
    ]);
  });

  it('may grant both roles to one person, but each only once at a time', async () => {
    await grant(people.officer, 'ASSOCIATE');
    await grant(people.officer, 'BD_MANAGER');

    const again = await send('POST', '/api/clients/roles', sysadmin(), {
      employeeId: people.officer,
      role: 'ASSOCIATE',
    });

    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'ClientsRoleAlreadyHeld' });
  });

  it('may grant a role to themselves', async () => {
    await grant(people.headOfHr, 'ASSOCIATE');

    expect(await liveRows()).toEqual([{ employee_id: people.headOfHr, role: 'ASSOCIATE' }]);
  });

  it('cannot grant a role to somebody who has left', async () => {
    const response = await send('POST', '/api/clients/roles', sysadmin(), {
      employeeId: people.leaver,
      role: 'ASSOCIATE',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'ClientsGranteeNotCurrent' });
    expect(await liveRows()).toEqual([]);
  });

  it('is told what to fix in a request that makes no sense', async () => {
    const noRole = await send('POST', '/api/clients/roles', sysadmin(), {
      employeeId: people.officer,
      role: 'VIEWER',
    });
    expect(noRole.status).toBe(400);
    expect(await noRole.json()).toMatchObject({ error: 'InvalidGrant', field: 'role' });

    const nobody = await send('POST', '/api/clients/roles', sysadmin(), { role: 'ASSOCIATE' });
    expect(nobody.status).toBe(400);
    expect(await nobody.json()).toMatchObject({ error: 'InvalidGrant', field: 'employeeId' });

    const noSuchPerson = await send('POST', '/api/clients/roles', sysadmin(), {
      employeeId: '987654321',
      role: 'ASSOCIATE',
    });
    expect(noSuchPerson.status).toBe(404);
  });

  it('ends a grant, which stays on the record as revoked by them', async () => {
    const id = await grant(people.officer, 'ASSOCIATE');

    const response = await send('DELETE', `/api/clients/roles/${id}`, sysadmin());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      endedBy: people.headOfHr,
      endedReason: 'REVOKED',
    });

    const { rows } = await admin.query('SELECT ended_by, ended_reason FROM clients_role');
    expect(rows).toEqual([{ ended_by: people.headOfHr, ended_reason: 'REVOKED' }]);

    /* And it may be granted again. */
    await grant(people.officer, 'ASSOCIATE');
  });

  it('cannot end a grant twice, or one that does not exist', async () => {
    const id = await grant(people.officer, 'ASSOCIATE');
    await send('DELETE', `/api/clients/roles/${id}`, sysadmin());

    const twice = await send('DELETE', `/api/clients/roles/${id}`, sysadmin());
    expect(twice.status).toBe(409);
    expect(await twice.json()).toMatchObject({ error: 'ClientsGrantAlreadyEnded' });

    expect((await send('DELETE', '/api/clients/roles/987654321', sysadmin())).status).toBe(404);
    expect((await send('DELETE', '/api/clients/roles/not-an-id', sysadmin())).status).toBe(404);
  });
});

/* ------------------------------------------------------------- everybody else */

describe('somebody who is not a System Administrator', () => {
  /* CLI 94, TDD 12.1. The BD manager cannot grant or end a role, their own included. */
  it('is refused openly, and told who can, when they hold a clients role', async () => {
    const theirs = await grant(people.commercialDirector, 'BD_MANAGER');
    const bdManager = { employeeId: people.commercialDirector };

    const attempts = [
      await send('GET', '/api/clients/roles', bdManager),
      await send('POST', '/api/clients/roles', bdManager, {
        employeeId: people.officer,
        role: 'ASSOCIATE',
      }),
      await send('POST', '/api/clients/roles', bdManager, {
        employeeId: people.commercialDirector,
        role: 'ASSOCIATE',
      }),
      await send('DELETE', `/api/clients/roles/${theirs}`, bdManager),
    ];

    for (const response of attempts) {
      expect(response.status).toBe(403);
      expect(((await response.json()) as { message: string }).message).toMatch(
        /system administrator/,
      );
    }

    expect(await liveRows()).toEqual([
      { employee_id: people.commercialDirector, role: 'BD_MANAGER' },
    ]);
    expect(denials.entries).toHaveLength(attempts.length);
  });

  it("cannot end somebody else's grant either, as BD manager or as associate", async () => {
    const associates = await grant(people.officer, 'ASSOCIATE');
    const bdManagers = await grant(people.commercialDirector, 'BD_MANAGER');

    const attempts = [
      await send('DELETE', `/api/clients/roles/${associates}`, {
        employeeId: people.commercialDirector,
      }),
      await send('DELETE', `/api/clients/roles/${bdManagers}`, { employeeId: people.officer }),
      await send('DELETE', `/api/clients/roles/${associates}`, { employeeId: people.officer }),
      await send(
        'POST',
        '/api/clients/roles',
        { employeeId: people.officer },
        {
          employeeId: people.officer,
          role: 'BD_MANAGER',
        },
      ),
    ];

    for (const response of attempts) {
      expect(response.status).toBe(403);
      expect(((await response.json()) as { message: string }).message).toMatch(
        /system administrator/,
      );
    }

    expect(await liveRows()).toEqual([
      { employee_id: people.officer, role: 'ASSOCIATE' },
      { employee_id: people.commercialDirector, role: 'BD_MANAGER' },
    ]);
  });

  /* NFR CLI SEC 04. Somebody with no clients role learns nothing, not even that a grant exists. */
  it('gets not found, for every route and a real id, when they hold no clients role', async () => {
    const real = await grant(people.officer, 'ASSOCIATE');
    const nobody = { employeeId: people.engineer };

    const attempts = [
      await send('GET', '/api/clients/roles', nobody),
      await send('POST', '/api/clients/roles', nobody, {
        employeeId: people.engineer,
        role: 'BD_MANAGER',
      }),
      /* A nonsense body answers the same, so the refusal comes before anything is read. */
      await send('POST', '/api/clients/roles', nobody, { role: 'NOT_A_ROLE' }),
      await send('DELETE', `/api/clients/roles/${real}`, nobody),
      await send('DELETE', '/api/clients/roles/987654321', nobody),
    ];

    const answers = await Promise.all(
      attempts.map(async (response) => [response.status, await response.json()]),
    );
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(answers[0][0]).toBe(404);

    expect(await liveRows()).toEqual([{ employee_id: people.officer, role: 'ASSOCIATE' }]);
  });
});

/* ------------------------------------------------------------ the portal home tile */

/* CLI 93, TDD 12.2. Asked of core, at /api/me/apps, so that clients itself answers nobody
   without a role with anything but a 404. */
describe('the clients tile on the portal home', () => {
  async function appsFor(as: Asker): Promise<string[]> {
    const response = await send('GET', '/api/me/apps', as);
    expect(response.status).toBe(200);

    return ((await response.json()) as { apps: string[] }).apps;
  }

  it('is shown to an associate, a BD manager and a System Administrator', async () => {
    await grant(people.officer, 'ASSOCIATE');
    await grant(people.commercialDirector, 'BD_MANAGER');

    expect(await appsFor({ employeeId: people.officer })).toEqual(['clients']);
    expect(await appsFor({ employeeId: people.commercialDirector })).toEqual(['clients']);
    expect(await appsFor(sysadmin())).toEqual(['clients']);
  });

  it('is not shown to somebody with no clients role, and is no refusal in the log', async () => {
    expect(await appsFor({ employeeId: people.engineer })).toEqual([]);
    expect(denials.entries).toEqual([]);
  });

  /* CLI 95's other half: ended is ended on the next look, not at the next sign in. */
  it('goes as soon as the grant is ended, and comes back when it is granted again', async () => {
    const id = await grant(people.officer, 'ASSOCIATE');
    expect(await appsFor({ employeeId: people.officer })).toEqual(['clients']);

    await send('DELETE', `/api/clients/roles/${id}`, sysadmin());
    expect(await appsFor({ employeeId: people.officer })).toEqual([]);

    await grant(people.officer, 'ASSOCIATE');
    expect(await appsFor({ employeeId: people.officer })).toEqual(['clients']);
  });
});

/* ------------------------------------------------- nothing, to somebody without a role */

/**
 * NFR CLI SEC 04, CLI 93, Clients TDD 15: "A person with no role: every endpoint returns 404,
 * including for real ids. Assert the whole list."
 *
 * The list is read from the router itself rather than written out here, so an endpoint added
 * later is in it without anybody remembering to add it, and the test fails if it answers
 * anything but what an address with nothing at it answers.
 */
describe('somebody with no clients role', () => {
  /** Every method and path the clients router answers, as Express holds them. */
  function everyRoute(): { method: string; path: string }[] {
    const stack = (clients as unknown as { stack: RouteLayer[] }).stack;

    return stack.flatMap((layer) =>
      layer.route === undefined
        ? []
        : Object.keys(layer.route.methods).map((method) => ({
            method: method.toUpperCase(),
            path: layer.route?.path ?? '',
          })),
    );
  }

  interface RouteLayer {
    route?: { path: string; methods: Record<string, boolean> };
  }

  it('finds the routes it is about to try', () => {
    expect(everyRoute()).toEqual(
      expect.arrayContaining([
        { method: 'GET', path: '/clients/roles' },
        { method: 'POST', path: '/clients/roles' },
        { method: 'DELETE', path: '/clients/roles/:id' },
      ]),
    );
  });

  it('gets what an address with nothing at it answers, from every route, for real ids', async () => {
    const real = await grant(people.officer, 'ASSOCIATE');
    const nobody = { employeeId: people.engineer };

    const tried = [
      ...everyRoute().map(({ method, path }) => ({
        method,
        /* Every parameter, a real id: the record exists, and they are not told. */
        path: `/api${path.replace(/:[A-Za-z]+/g, real)}`,
      })),
      /* And an address under clients with no route at all. */
      { method: 'GET', path: '/api/clients/no-such-thing' },
      { method: 'POST', path: '/api/clients/roles/extra/segments' },
    ];

    for (const { method, path } of tried) {
      const response = await send(
        method,
        path,
        nobody,
        method === 'GET'
          ? undefined
          : {
              employeeId: people.engineer,
              role: 'BD_MANAGER',
            },
      );

      expect({ method, path, status: response.status, body: await response.json() }).toEqual({
        method,
        path,
        status: 404,
        body: NO_SUCH_ROUTE,
      });
    }

    /* Identical to an address outside clients that has nothing at it. */
    const outside = await send('GET', '/api/nothing-is-here', nobody);
    expect([outside.status, await outside.json()]).toEqual([404, NO_SUCH_ROUTE]);

    /* Nothing changed, and every attempt on clients is in the denial log. */
    expect(await liveRows()).toEqual([{ employee_id: people.officer, role: 'ASSOCIATE' }]);
    expect(denials.entries).toHaveLength(tried.length);
    expect(denials.entries.every((entry) => entry.action === 'enter')).toBe(true);
  });

  /* The door lets a System Administrator through to the roles screen, and no further: every
     other question still refuses them, because they hold no clients role (TDD 12.1). */
  it('who is a System Administrator gets through the door, to the roles screen only', async () => {
    expect((await send('GET', '/api/clients/roles', sysadmin())).status).toBe(200);

    const nothingThere = await send('GET', '/api/clients/no-such-thing', sysadmin());
    expect([nothingThere.status, await nothingThere.json()]).toEqual([404, NO_SUCH_ROUTE]);
  });

  it('who is granted a role gets through on their next request, and not after it ends', async () => {
    const officer = { employeeId: people.officer };
    const nothing = '/api/clients/no-such-thing';

    /* Through the door, to an address with nothing behind it: the same 404, but no refusal. */
    const id = await grant(people.officer, 'ASSOCIATE');
    denials.clear();
    expect((await send('GET', nothing, officer)).status).toBe(404);
    expect(denials.entries).toEqual([]);

    await send('DELETE', `/api/clients/roles/${id}`, sysadmin());
    expect((await send('GET', nothing, officer)).status).toBe(404);
    expect(denials.entries.map((entry) => entry.action)).toEqual(['enter']);
  });
});
