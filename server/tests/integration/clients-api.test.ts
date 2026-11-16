import type { Kysely } from 'kysely';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { PINNED_DATE } from '../setup/pinned-date.js';
import { seed } from '../../seeds/seed.mjs';
import { type Database, databaseFor } from '../../src/core/db/index.js';
import { NO_SUCH_ROUTE } from '../../src/core/http/problems.js';
import { ClientsRoleRepository } from '../../src/apps/clients/role.db.js';
import { type Asker, type ClientsApp, startClientsApp } from '../support/clients-app.js';
import { recordingDenials } from '../support/recording-denials.js';

/**
 * Clients themselves, over HTTP against a real database. #276, Clients SRS CLI 02, CLI 05, NFR
 * CLI AUD 01.
 */

const testDatabaseUrl = await databaseForThisFile();

const denials = recordingDenials();

let db: Kysely<Database>;
let admin: Client;
let app: ClientsApp;
let people: Record<string, string>;
/** Client type ids by name, as migrated. */
let types: Record<string, string>;

let bdManager: Asker;
let associate: Asker;
let sysadmin: Asker;
let nobody: Asker;

interface ClientJson {
  id: string;
  name: string;
  type: { id: string; name: string };
  owner: { id: string; name: string };
  note: string | null;
  createdAt: string;
}

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);
  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();
  app = await startClientsApp(db, denials);
});

beforeEach(async () => {
  /* The seed empties clients with the employees they belong to. */
  people = (await seed(admin)) as Record<string, string>;

  const grants = new ClientsRoleRepository(db);
  await grants.grant(people.commercialDirector, 'BD_MANAGER', people.headOfHr, 'them');
  await grants.grant(people.officer, 'ASSOCIATE', people.headOfHr, 'them');

  bdManager = { employeeId: people.commercialDirector };
  associate = { employeeId: people.officer };
  sysadmin = { employeeId: people.headOfHr, sysAdmin: true };
  nobody = { employeeId: people.engineer };

  /* The seed leaves client types alone, so these tests put back the five as migrated. */
  await admin.query(
    `DELETE FROM clients_client_type
      WHERE name NOT IN ('Bank', 'Broker', 'Microfinance institution', 'Digital lender', 'DFI')`,
  );
  await admin.query('UPDATE clients_client_type SET retired_on = NULL');

  const { rows } = await admin.query<{ id: string; name: string }>(
    'SELECT id, name FROM clients_client_type',
  );
  types = Object.fromEntries(rows.map((row) => [row.name, row.id]));
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

async function create(as: Asker, body: unknown): Promise<globalThis.Response> {
  return app.send('POST', '/api/clients/clients', as, body);
}

async function created(as: Asker, body: unknown): Promise<ClientJson> {
  const response = await create(as, body);
  expect(response.status).toBe(201);

  return (await response.json()) as ClientJson;
}

async function clientCount(): Promise<number> {
  return (await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM clients_client')).rows[0]
    .n;
}

describe('creating a client', () => {
  it('may be done by an associate, who becomes its owner', async () => {
    const adb = await created(associate, {
      name: 'ADB',
      typeId: types.Bank,
      note: 'Agricultural Development Bank',
    });

    expect(adb).toMatchObject({
      name: 'ADB',
      type: { id: types.Bank, name: 'Bank' },
      owner: { id: people.officer, name: await nameOf(people.officer) },
      note: 'Agricultural Development Bank',
    });
    expect(Date.parse(adb.createdAt)).not.toBeNaN();
  });

  it('may be done by a BD manager, who becomes its owner', async () => {
    const client = await created(bdManager, { name: 'Fidelity Securities', typeId: types.Broker });

    expect(client.owner.id).toBe(people.commercialDirector);
  });

  /* Whoever asks is the owner; moving it to somebody else is another request. */
  it('makes whoever asks the owner, whatever owner the request names', async () => {
    const client = await created(associate, {
      name: 'ADB',
      typeId: types.Bank,
      ownerId: people.commercialDirector,
    });

    expect(client.owner.id).toBe(people.officer);
  });

  it('is read back as it was created', async () => {
    const client = await created(associate, { name: 'ADB', typeId: types.Bank });

    const response = await app.send('GET', `/api/clients/clients/${client.id}`, bdManager);
    expect([response.status, await response.json()]).toEqual([
      200,
      { ...client, may: { change: true, reassign: true, contribute: true } },
    ]);
  });

  it('keeps the name as typed, trimmed and with single spaces', async () => {
    const client = await created(associate, {
      name: '  Agricultural   Development Bank ',
      typeId: types.Bank,
    });

    expect(client.name).toBe('Agricultural Development Bank');
  });

  /* Shown as missing, not as a blank. */
  it('has no note where none was given, or only spaces were', async () => {
    expect((await created(associate, { name: 'ADB', typeId: types.Bank })).note).toBeNull();
    expect(
      (await created(associate, { name: 'Ecobank', typeId: types.Bank, note: '   ' })).note,
    ).toBeNull();
  });

  it('may be of a type added since the migration', async () => {
    const insurer = (
      await admin.query<{ id: string }>(
        `INSERT INTO clients_client_type (name) VALUES ('Insurer') RETURNING id`,
      )
    ).rows[0].id;

    expect((await created(associate, { name: 'Enterprise Life', typeId: insurer })).type).toEqual({
      id: insurer,
      name: 'Insurer',
    });
  });

  it('is named in the audit log as who did it', async () => {
    const client = await created(associate, { name: 'ADB', typeId: types.Bank });

    const { rows } = await admin.query(
      `SELECT action, entity_id, actor_employee_id FROM audit_log
        WHERE entity = 'clients_client' ORDER BY id`,
    );
    expect(rows).toEqual([
      { action: 'CREATE', entity_id: client.id, actor_employee_id: people.officer },
    ]);
  });
});

/* CLI 02. Done when: creating a duplicate client name is refused. */
describe('a client already recorded', () => {
  it('is refused, naming the client as it is recorded', async () => {
    await created(associate, { name: 'ADB', typeId: types.Bank });

    for (const name of ['ADB', ' adb', 'Adb  ']) {
      const response = await create(bdManager, { name, typeId: types.DFI });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'ClientAlreadyRecorded',
        message:
          'ADB is already a client. Each client is recorded once, so add to that one instead.',
        field: 'name',
      });
    }

    expect(await clientCount()).toBe(1);
  });

  it('is refused however the name is spaced', async () => {
    await created(associate, { name: 'Agricultural Development Bank', typeId: types.Bank });

    const response = await create(associate, {
      name: 'agricultural  development\tbank',
      typeId: types.Bank,
    });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { message: string }).message).toMatch(
      /^Agricultural Development Bank is already a client/,
    );
  });
});

describe('a request that makes no sense', () => {
  async function refusal(body: unknown): Promise<unknown> {
    const response = await create(associate, body);

    return [response.status, (await response.json()) as unknown];
  }

  it('is told which field to fix, and records nothing', async () => {
    expect(await refusal({ name: '  ', typeId: types.Bank })).toEqual([
      400,
      { error: 'InvalidClient', message: 'Give the client a name.', field: 'name' },
    ]);
    expect(await refusal({ name: 'x'.repeat(121), typeId: types.Bank })).toMatchObject([
      400,
      { field: 'name' },
    ]);
    expect(await refusal({ name: 'ADB' })).toMatchObject([400, { field: 'typeId' }]);
    expect(await refusal({ name: 'ADB', typeId: 'BANK' })).toMatchObject([
      400,
      { field: 'typeId' },
    ]);
    expect(await refusal({ name: 'ADB', typeId: '987654321' })).toMatchObject([
      400,
      { field: 'typeId' },
    ]);
    expect(
      await refusal({ name: 'ADB', typeId: types.Bank, note: 'x'.repeat(2001) }),
    ).toMatchObject([400, { field: 'note' }]);
    expect(await refusal({ name: 'ADB', typeId: types.Bank, note: 7 })).toMatchObject([
      400,
      { field: 'note' },
    ]);
    expect(await refusal({})).toMatchObject([400, { field: 'name' }]);

    expect(await clientCount()).toBe(0);
  });

  it('takes no new client of a retired type, and says which', async () => {
    await admin.query(
      `UPDATE clients_client_type SET retired_on = '2026-10-01' WHERE name = 'Broker'`,
    );

    expect(await refusal({ name: 'Fidelity Securities', typeId: types.Broker })).toEqual([
      400,
      {
        error: 'InvalidClient',
        message: 'Broker is no longer offered for new clients. Choose another type.',
        field: 'typeId',
      },
    ]);
  });

  it('finds no client at an id that is not one', async () => {
    for (const id of ['987654321', 'not-an-id']) {
      const response = await app.send('GET', `/api/clients/clients/${id}`, associate);

      expect([response.status, await response.json()]).toMatchObject([
        404,
        { error: 'ClientNotFound' },
      ]);
    }
  });
});

/* CLI 05, #276. Only the owner or a BD manager changes a client's name, type, owner or note. */
describe('changing a client', () => {
  /** An associate who neither owns the client nor manages anybody. */
  let colleague: Asker;
  let adb: ClientJson;

  beforeEach(async () => {
    await new ClientsRoleRepository(db).grant(
      people.opsDirector,
      'ASSOCIATE',
      people.headOfHr,
      'them',
    );
    colleague = { employeeId: people.opsDirector };
    adb = await created(associate, { name: 'ADB', typeId: types.Bank, note: 'From the summit' });
  });

  async function change(as: Asker, body: unknown): Promise<globalThis.Response> {
    return app.send('PATCH', `/api/clients/clients/${adb.id}`, as, body);
  }

  async function changed(as: Asker, body: unknown): Promise<ClientJson> {
    const response = await change(as, body);
    expect(response.status).toBe(200);

    return (await response.json()) as ClientJson;
  }

  async function asItIs(): Promise<unknown> {
    return (await admin.query('SELECT name, type_id, owner_id, note FROM clients_client')).rows;
  }

  it('may be done by its owner: name, type and note', async () => {
    expect(
      await changed(associate, {
        name: 'Agricultural  Development Bank ',
        typeId: types.DFI,
        note: 'State owned',
      }),
    ).toMatchObject({
      name: 'Agricultural Development Bank',
      type: { id: types.DFI, name: 'DFI' },
      owner: { id: people.officer },
      note: 'State owned',
    });
  });

  it('changes only what the request names', async () => {
    expect(await changed(associate, { note: 'Visit in March' })).toMatchObject({
      name: 'ADB',
      type: { id: types.Bank },
      note: 'Visit in March',
    });
  });

  /* Shown as missing afterwards, not as a blank. */
  it('takes the note away when it is given as nothing', async () => {
    expect((await changed(associate, { note: null })).note).toBeNull();
    await changed(associate, { note: 'Back again' });
    expect((await changed(associate, { note: '  ' })).note).toBeNull();
  });

  it('may be done by a BD manager, to a client they do not own', async () => {
    expect((await changed(bdManager, { name: 'ADB Ghana' })).name).toBe('ADB Ghana');
  });

  /* CLI 92, #276. */
  it('is moved to somebody else with a role by a BD manager', async () => {
    expect((await changed(bdManager, { ownerId: people.opsDirector })).owner).toEqual({
      id: people.opsDirector,
      name: await nameOf(people.opsDirector),
    });

    /* The new owner may change it now; the old one may not. */
    expect((await change(colleague, { note: 'Mine now' })).status).toBe(200);
    expect((await change(associate, { note: 'Still mine?' })).status).toBe(403);
  });

  it('is not moved by its owner, who is told to ask a BD manager, and nothing changes', async () => {
    const before = await asItIs();

    const response = await change(associate, { ownerId: people.opsDirector, note: 'Yours now' });

    expect([response.status, await response.json()]).toEqual([
      403,
      { error: 'NotAuthorised', message: 'Only a BD manager can move a client.' },
    ]);
    expect(await asItIs()).toEqual(before);
  });

  it('is left with its owner when the owner names themself', async () => {
    expect((await changed(associate, { ownerId: people.officer, note: 'Same' })).note).toBe('Same');
  });

  it('is not moved to somebody with no clients role', async () => {
    const response = await change(bdManager, { ownerId: people.engineer });

    expect([response.status, await response.json()]).toEqual([
      400,
      {
        error: 'InvalidClient',
        message:
          'Whoever looks after a client needs a role in clients. Choose somebody who has one.',
        field: 'ownerId',
      },
    ]);
    expect((await change(bdManager, { ownerId: '987654321' })).status).toBe(400);
  });

  it('is refused to another associate, who is told whose it is', async () => {
    const before = await asItIs();

    for (const body of [
      { name: 'Not ADB' },
      { typeId: types.DFI },
      { ownerId: people.opsDirector },
      { note: null },
    ]) {
      const response = await change(colleague, body);

      expect([response.status, await response.json()]).toEqual([
        403,
        {
          error: 'NotAuthorised',
          message: `This client is ${await nameOf(people.officer)}'s. Only they or a BD manager can change it.`,
        },
      ]);
    }
    expect(await asItIs()).toEqual(before);
  });

  /* CLI 02. */
  it('is not renamed into another client', async () => {
    await created(bdManager, { name: 'Ecobank', typeId: types.Bank });

    const response = await change(associate, { name: ' ecobank' });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { message: string }).message).toMatch(
      /^Ecobank is already a client/,
    );
  });

  it('may be renamed into the same name, differently cased', async () => {
    expect((await changed(associate, { name: 'adb' })).name).toBe('adb');
  });

  it('keeps a type since retired, and is moved onto none', async () => {
    await admin.query(`UPDATE clients_client_type SET retired_on = '2026-10-01' WHERE id = $1`, [
      types.Bank,
    ]);

    expect((await changed(associate, { typeId: types.Bank, note: 'Still a bank' })).note).toBe(
      'Still a bank',
    );

    await changed(associate, { typeId: types.DFI });
    expect((await change(associate, { typeId: types.Bank })).status).toBe(400);
  });

  it('is told what to fix in a change that makes no sense', async () => {
    expect(await (await change(associate, { name: '' })).json()).toMatchObject({ field: 'name' });
    expect(await (await change(associate, { typeId: 'x' })).json()).toMatchObject({
      field: 'typeId',
    });
    expect(await (await change(associate, { ownerId: 4 })).json()).toMatchObject({
      field: 'ownerId',
    });
  });

  it('is written to the audit log as who did it', async () => {
    await changed(bdManager, { name: 'ADB Ghana' });

    const { rows } = await admin.query(
      `SELECT action, actor_employee_id FROM audit_log
        WHERE entity = 'clients_client' ORDER BY id`,
    );
    expect(rows).toEqual([
      { action: 'CREATE', actor_employee_id: people.officer },
      { action: 'UPDATE', actor_employee_id: people.commercialDirector },
    ]);
  });

  it('finds no client at an id that is not one', async () => {
    const response = await app.send('PATCH', '/api/clients/clients/987654321', bdManager, {
      name: 'X',
    });

    expect(response.status).toBe(404);
  });
});

/* CLI 03, CLI 05, #276. Contacts with name, job title, email and phone, editable by anyone with a role. */
describe('a contact', () => {
  /** An associate who does not own the client. */
  let colleague: Asker;
  let adb: ClientJson;

  interface ContactJson {
    id: string;
    clientId: string;
    name: string;
    jobTitle: string | null;
    email: string | null;
    phone: string | null;
    createdAt: string;
    removedAt: string | null;
  }

  beforeEach(async () => {
    await new ClientsRoleRepository(db).grant(
      people.opsDirector,
      'ASSOCIATE',
      people.headOfHr,
      'them',
    );
    colleague = { employeeId: people.opsDirector };
    adb = await created(associate, { name: 'ADB', typeId: types.Bank });
  });

  async function add(as: Asker, body: unknown, clientId = adb.id): Promise<globalThis.Response> {
    return app.send('POST', `/api/clients/clients/${clientId}/contacts`, as, body);
  }

  async function added(as: Asker, body: unknown): Promise<ContactJson> {
    const response = await add(as, body);
    expect(response.status).toBe(201);

    return (await response.json()) as ContactJson;
  }

  async function contactsOfAdb(): Promise<ContactJson[]> {
    const response = await app.send('GET', `/api/clients/clients/${adb.id}`, associate);

    return ((await response.json()) as { contacts: ContactJson[] }).contacts;
  }

  it('is added with a name, job title, email and phone, and shows on the client', async () => {
    const ama = await added(associate, {
      name: 'Ama Owusu',
      jobTitle: 'Head of IT',
      email: 'ama.owusu@adb.com.gh',
      phone: '+233 30 278 3111',
    });

    expect(ama).toMatchObject({
      clientId: adb.id,
      name: 'Ama Owusu',
      jobTitle: 'Head of IT',
      email: 'ama.owusu@adb.com.gh',
      phone: '+233 30 278 3111',
      removedAt: null,
    });
    expect(await contactsOfAdb()).toEqual([ama]);
  });

  /* Shown as missing, not as a blank. */
  it('needs only a name; whatever else is not known is null', async () => {
    expect(
      await added(associate, { name: 'Kofi Mensah', jobTitle: ' ', email: '', phone: null }),
    ).toMatchObject({ name: 'Kofi Mensah', jobTitle: null, email: null, phone: null });
  });

  it('is added by anybody with a role, not only the owner', async () => {
    await added(colleague, { name: 'Kofi Mensah' });
    await added(bdManager, { name: 'Esi Boateng' });

    expect((await contactsOfAdb()).map((contact) => contact.name)).toEqual([
      'Esi Boateng',
      'Kofi Mensah',
    ]);
  });

  it('is corrected by anybody with a role, only in what the request names', async () => {
    const ama = await added(associate, { name: 'Ama Owusu', jobTitle: 'Head of IT' });

    const response = await app.send('PATCH', `/api/clients/contacts/${ama.id}`, colleague, {
      jobTitle: 'Chief Technology Officer',
      phone: '030 278 3111',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      name: 'Ama Owusu',
      jobTitle: 'Chief Technology Officer',
      phone: '030 278 3111',
      email: null,
    });
  });

  it('has a detail taken away when it is given as nothing', async () => {
    const ama = await added(associate, { name: 'Ama Owusu', email: 'ama@adb.com.gh' });

    const response = await app.send('PATCH', `/api/clients/contacts/${ama.id}`, bdManager, {
      email: null,
    });

    expect(((await response.json()) as ContactJson).email).toBeNull();
  });

  it('is removed, and kept on the client marked removed, then brought back', async () => {
    const ama = await added(associate, { name: 'Ama Owusu' });

    const removing = await app.send('POST', `/api/clients/contacts/${ama.id}/remove`, colleague);
    expect(removing.status).toBe(204);

    const [removed] = await contactsOfAdb();
    expect(removed.name).toBe('Ama Owusu');
    expect(Date.parse(removed.removedAt ?? '')).not.toBeNaN();

    /* Removing again keeps the moment it first was. */
    await app.send('POST', `/api/clients/contacts/${ama.id}/remove`, associate);
    expect((await contactsOfAdb())[0].removedAt).toBe(removed.removedAt);

    await app.send('POST', `/api/clients/contacts/${ama.id}/restore`, associate);
    expect((await contactsOfAdb())[0].removedAt).toBeNull();
  });

  it('is not corrected while removed', async () => {
    const ama = await added(associate, { name: 'Ama Owusu' });
    await app.send('POST', `/api/clients/contacts/${ama.id}/remove`, associate);

    const response = await app.send('PATCH', `/api/clients/contacts/${ama.id}`, associate, {
      phone: '030 000 0000',
    });

    expect([response.status, await response.json()]).toEqual([
      409,
      {
        error: 'ContactRemoved',
        message:
          'Ama Owusu has been removed as a contact. Bring them back first to change their details.',
      },
    ]);
  });

  it('is told what to fix in a request that makes no sense', async () => {
    const refusals: [unknown, string][] = [
      [{ name: '  ' }, 'name'],
      [{ name: 'x'.repeat(121) }, 'name'],
      [{ name: 'Ama', email: 'ama at adb' }, 'email'],
      [{ name: 'Ama', email: 'ama@adb' }, 'email'],
      [{ name: 'Ama', phone: 'call reception' }, 'phone'],
      [{ name: 'Ama', phone: '12345' }, 'phone'],
      [{ name: 'Ama', jobTitle: 7 }, 'jobTitle'],
    ];

    for (const [body, field] of refusals) {
      const response = await add(associate, body);

      expect([response.status, await response.json()]).toMatchObject([
        400,
        { error: 'InvalidContact', field },
      ]);
    }
    expect(await contactsOfAdb()).toEqual([]);
  });

  it('is added to no client that is not there, and no contact is found that is not', async () => {
    expect((await add(associate, { name: 'Ama' }, '987654321')).status).toBe(404);

    for (const [method, path] of [
      ['PATCH', '/api/clients/contacts/987654321'],
      ['POST', '/api/clients/contacts/987654321/remove'],
      ['POST', '/api/clients/contacts/not-an-id/restore'],
    ]) {
      const response = await app.send(method, path, associate, { name: 'Ama' });
      expect([response.status, await response.json()]).toMatchObject([
        404,
        { error: 'ContactNotFound' },
      ]);
    }
  });

  it('is written to the audit log as who did it', async () => {
    const ama = await added(associate, { name: 'Ama Owusu' });
    await app.send('PATCH', `/api/clients/contacts/${ama.id}`, colleague, { jobTitle: 'CTO' });
    await app.send('POST', `/api/clients/contacts/${ama.id}/remove`, bdManager);

    const { rows } = await admin.query(
      `SELECT action, actor_employee_id FROM audit_log
        WHERE entity = 'clients_contact' ORDER BY id`,
    );
    expect(rows).toEqual([
      { action: 'CREATE', actor_employee_id: people.officer },
      { action: 'UPDATE', actor_employee_id: people.opsDirector },
      { action: 'UPDATE', actor_employee_id: people.commercialDirector },
    ]);
  });

  it('is refused silently to anybody with no clients role', async () => {
    const ama = await added(associate, { name: 'Ama Owusu' });

    for (const as of [nobody, sysadmin]) {
      for (const response of [
        await add(as, { name: 'Kofi' }),
        await app.send('PATCH', `/api/clients/contacts/${ama.id}`, as, { name: 'Kofi' }),
        await app.send('POST', `/api/clients/contacts/${ama.id}/remove`, as),
        await app.send('POST', `/api/clients/contacts/${ama.id}/restore`, as),
      ]) {
        expect(response.status).toBe(404);
      }
    }
    expect(await contactsOfAdb()).toEqual([ama]);
  });
});

/* CLI 04, #276. The products a client already uses, each with the date it started. */
describe('a product a client uses', () => {
  let adb: ClientJson;
  /** Product ids by name, as migrated. */
  let products: Record<string, string>;

  interface InUseJson {
    productId: string;
    productName: string;
    lineName: string;
    sinceOn: string;
    endedOn: string | null;
    wonBy: string | null;
  }

  beforeEach(async () => {
    /* The seed leaves products alone; a test that retires one puts it back here. */
    await admin.query('UPDATE clients_product SET retired_on = NULL');
    await admin.query('UPDATE clients_product_line SET retired_on = NULL');

    const { rows } = await admin.query<{ id: string; name: string }>(
      'SELECT id, name FROM clients_product',
    );
    products = Object.fromEntries(rows.map((row) => [row.name, row.id]));
    adb = await created(associate, { name: 'ADB', typeId: types.Bank });
  });

  async function add(as: Asker, body: unknown, clientId = adb.id): Promise<globalThis.Response> {
    return app.send('POST', `/api/clients/clients/${clientId}/products`, as, body);
  }

  async function added(as: Asker, body: unknown): Promise<InUseJson> {
    const response = await add(as, body);
    expect(response.status).toBe(201);

    return (await response.json()) as InUseJson;
  }

  async function change(productId: string, body: unknown, as = associate) {
    return app.send('PATCH', `/api/clients/clients/${adb.id}/products/${productId}`, as, body);
  }

  async function productsOfAdb(): Promise<InUseJson[]> {
    const response = await app.send('GET', `/api/clients/clients/${adb.id}`, associate);

    return ((await response.json()) as { products: InUseJson[] }).products;
  }

  it('is added with the day it started, and shows on the client with its line', async () => {
    const credit = await added(associate, {
      productId: products.CreditStudio,
      sinceOn: '2024-03-01',
    });

    expect(credit).toEqual({
      productId: products.CreditStudio,
      productName: 'CreditStudio',
      lineName: 'Dura Capital',
      sinceOn: '2024-03-01',
      endedOn: null,
      wonBy: null,
    });
    expect(await productsOfAdb()).toEqual([credit]);
  });

  it('is added by anybody with a role, and listed by product name', async () => {
    await added(bdManager, { productId: products.OnboardStudio, sinceOn: '2023-06-15' });
    await added(associate, { productId: products.CreditStudio, sinceOn: PINNED_DATE });

    expect((await productsOfAdb()).map((one) => one.productName)).toEqual([
      'CreditStudio',
      'OnboardStudio',
    ]);
  });

  it('is on a client once, and says so by name', async () => {
    await added(associate, { productId: products.CreditStudio, sinceOn: '2024-03-01' });

    const response = await add(bdManager, {
      productId: products.CreditStudio,
      sinceOn: '2025-01-01',
    });

    expect([response.status, await response.json()]).toEqual([
      409,
      {
        error: 'ProductAlreadyInUse',
        message:
          'ADB already has CreditStudio. Change its dates there rather than adding it again.',
        field: 'productId',
      },
    ]);
    expect(await productsOfAdb()).toHaveLength(1);
  });

  it('is not a retired product, nor one in a retired line', async () => {
    await admin.query(`UPDATE clients_product SET retired_on = '2026-01-01' WHERE name = 'ALM'`);
    await admin.query(
      `UPDATE clients_product_line SET retired_on = '2026-01-01' WHERE name = 'AIC One'`,
    );

    for (const name of ['ALM', 'ComplyOn']) {
      const response = await add(associate, { productId: products[name], sinceOn: '2024-03-01' });

      expect([response.status, await response.json()]).toEqual([
        400,
        {
          error: 'InvalidProductInUse',
          message: `${name} is retired, so it is not added to clients any more.`,
          field: 'productId',
        },
      ]);
    }
  });

  it('keeps a product retired since it was added', async () => {
    await added(associate, { productId: products.ALM, sinceOn: '2024-03-01' });
    await admin.query(`UPDATE clients_product SET retired_on = '2026-01-01' WHERE name = 'ALM'`);

    expect((await productsOfAdb()).map((one) => one.productName)).toEqual(['ALM']);
    expect((await change(products.ALM, { endedOn: '2026-06-30' })).status).toBe(200);
  });

  it('is told what to fix in a request that makes no sense', async () => {
    const refusals: [unknown, string][] = [
      [{ sinceOn: '2024-03-01' }, 'productId'],
      [{ productId: 'CreditStudio', sinceOn: '2024-03-01' }, 'productId'],
      [{ productId: '987654321', sinceOn: '2024-03-01' }, 'productId'],
      [{ productId: products.CreditStudio }, 'sinceOn'],
      [{ productId: products.CreditStudio, sinceOn: '2024-02-30' }, 'sinceOn'],
      [{ productId: products.CreditStudio, sinceOn: '1 March 2024' }, 'sinceOn'],
      /* Today is 2026-10-30. */
      [{ productId: products.CreditStudio, sinceOn: '2026-10-31' }, 'sinceOn'],
    ];

    for (const [body, field] of refusals) {
      const response = await add(associate, body);

      expect([response.status, await response.json()]).toMatchObject([
        400,
        { error: 'InvalidProductInUse', field },
      ]);
    }
    expect(await productsOfAdb()).toEqual([]);
  });

  describe('its dates', () => {
    beforeEach(async () => {
      await added(associate, { productId: products.CreditStudio, sinceOn: '2024-03-01' });
    });

    it('are corrected by anybody with a role, only as the request names', async () => {
      const response = await change(products.CreditStudio, { sinceOn: '2024-01-15' }, bdManager);

      expect([response.status, await response.json()]).toMatchObject([
        200,
        { sinceOn: '2024-01-15', endedOn: null },
      ]);
    });

    /* Marked, not taken off, so the page still says what they once had. */
    it('end when the client stops using it, which is kept on the client', async () => {
      await change(products.CreditStudio, { endedOn: '2026-06-30' });

      expect(await productsOfAdb()).toMatchObject([
        { productName: 'CreditStudio', sinceOn: '2024-03-01', endedOn: '2026-06-30' },
      ]);
    });

    it('resume when the end date is taken away', async () => {
      await change(products.CreditStudio, { endedOn: '2026-06-30' });
      await change(products.CreditStudio, { endedOn: null });

      expect((await productsOfAdb())[0].endedOn).toBeNull();
    });

    it('do not end before they start, nor in the future', async () => {
      for (const [body, field] of [
        [{ endedOn: '2024-02-01' }, 'endedOn'],
        [{ sinceOn: '2026-07-01', endedOn: '2026-06-30' }, 'endedOn'],
        [{ endedOn: '2026-11-01' }, 'endedOn'],
        [{ sinceOn: 'soon' }, 'sinceOn'],
      ] as const) {
        const response = await change(products.CreditStudio, body);

        expect([response.status, await response.json()]).toMatchObject([400, { field }]);
      }

      await change(products.CreditStudio, { endedOn: '2026-06-30' });
      const response = await change(products.CreditStudio, { sinceOn: '2026-07-01' });
      expect([response.status, await response.json()]).toMatchObject([400, { field: 'endedOn' }]);
    });

    it('are of no product the client does not have', async () => {
      for (const productId of [products.OnboardStudio, '987654321', 'x']) {
        const response = await change(productId, { endedOn: '2026-06-30' });

        expect([response.status, await response.json()]).toMatchObject([
          404,
          { error: 'ProductInUseNotFound' },
        ]);
      }
    });

    it('are written to the audit log as who did it', async () => {
      await change(products.CreditStudio, { endedOn: '2026-06-30' }, bdManager);

      const { rows } = await admin.query(
        `SELECT action, actor_employee_id FROM audit_log
          WHERE entity = 'clients_client_product' ORDER BY id`,
      );
      expect(rows).toEqual([
        { action: 'CREATE', actor_employee_id: people.officer },
        { action: 'UPDATE', actor_employee_id: people.commercialDirector },
      ]);
    });
  });

  it('is chosen from the products still offered, by line', async () => {
    await admin.query(`UPDATE clients_product SET retired_on = '2026-01-01' WHERE name = 'ALM'`);
    await admin.query(
      `UPDATE clients_product_line SET retired_on = '2026-01-01' WHERE name = 'AIC One'`,
    );

    const response = await app.send('GET', '/api/clients/products', associate);
    const { products: offered } = (await response.json()) as {
      products: { name: string; lineName: string }[];
    };

    expect(offered.map((one) => `${one.lineName}: ${one.name}`)).toEqual([
      'Dura Capital: CreditStudio',
      'Dura Capital: MicroStudio',
      'Dura Capital: OnboardStudio',
      'Riskflow: Treasury',
      'Symphony: Cloud9',
      'Symphony: Federation',
      'Symphony: Messaging',
    ]);
  });

  it('is added to no client that is not there', async () => {
    const response = await add(
      associate,
      { productId: products.CreditStudio, sinceOn: '2024-03-01' },
      '987654321',
    );

    expect([response.status, await response.json()]).toMatchObject([
      404,
      { error: 'ClientNotFound' },
    ]);
  });

  it('is refused silently to anybody with no clients role', async () => {
    await added(associate, { productId: products.CreditStudio, sinceOn: '2024-03-01' });

    for (const as of [nobody, sysadmin]) {
      for (const response of [
        await add(as, { productId: products.OnboardStudio, sinceOn: '2024-03-01' }),
        await change(products.CreditStudio, { endedOn: '2026-06-30' }, as),
        await add(as, { productId: products.OnboardStudio, sinceOn: '2024-03-01' }, '987654321'),
      ]) {
        expect(response.status).toBe(404);
      }
    }
    expect(await productsOfAdb()).toMatchObject([{ productName: 'CreditStudio', endedOn: null }]);
  });
});

describe('the clients list', () => {
  it('is every client by name, whatever its case, with its type and owner', async () => {
    await created(bdManager, { name: 'ecobank', typeId: types.Bank });
    await created(associate, { name: 'ADB', typeId: types.DFI });

    const response = await app.send('GET', '/api/clients/clients', associate);

    expect([response.status, await response.json()]).toEqual([
      200,
      {
        clients: [
          {
            id: expect.any(String),
            name: 'ADB',
            type: { id: types.DFI, name: 'DFI' },
            owner: { id: people.officer, name: await nameOf(people.officer) },
          },
          {
            id: expect.any(String),
            name: 'ecobank',
            type: { id: types.Bank, name: 'Bank' },
            owner: { id: people.commercialDirector, name: await nameOf(people.commercialDirector) },
          },
        ],
      },
    ]);
  });

  it('is empty before anybody has added a client', async () => {
    expect(await (await app.send('GET', '/api/clients/clients', associate)).json()).toEqual({
      clients: [],
    });
  });
});

/* The screen offers only what the server would allow; the server refuses the rest anyway. */
describe('what a client page says its reader may do', () => {
  async function mayOn(as: Asker, clientId: string): Promise<unknown> {
    const response = await app.send('GET', `/api/clients/clients/${clientId}`, as);

    return ((await response.json()) as { may: unknown }).may;
  }

  it('is everything for a BD manager, change for its owner, and adding for anybody', async () => {
    await new ClientsRoleRepository(db).grant(
      people.opsDirector,
      'ASSOCIATE',
      people.headOfHr,
      'them',
    );
    const adb = await created(associate, { name: 'ADB', typeId: types.Bank });

    expect(await mayOn(bdManager, adb.id)).toEqual({
      change: true,
      reassign: true,
      contribute: true,
    });
    expect(await mayOn(associate, adb.id)).toEqual({
      change: true,
      reassign: false,
      contribute: true,
    });
    expect(await mayOn({ employeeId: people.opsDirector }, adb.id)).toEqual({
      change: false,
      reassign: false,
      contribute: true,
    });
  });
});

describe('whom a client may be moved to', () => {
  it('is everybody holding a clients role, by surname, and nobody else', async () => {
    const response = await app.send('GET', '/api/clients/holders', associate);
    const { people: holders } = (await response.json()) as { people: { id: string }[] };

    expect(holders.map((one) => one.id).sort()).toEqual(
      [people.commercialDirector, people.officer].sort(),
    );
  });
});

describe('client types', () => {
  it('are offered to anybody with a role, by name', async () => {
    for (const as of [associate, bdManager]) {
      const response = await app.send('GET', '/api/clients/client-types', as);
      const { types: offered } = (await response.json()) as { types: { name: string }[] };

      expect(offered.map((type) => type.name)).toEqual([
        'Bank',
        'Broker',
        'DFI',
        'Digital lender',
        'Microfinance institution',
      ]);
    }
  });
});

describe('anybody with no clients role', () => {
  async function attempts(as: Asker): Promise<globalThis.Response[]> {
    const existing = (
      await admin.query<{ id: string }>(
        `INSERT INTO clients_client (name, type_id, owner_id) VALUES ('ADB', $1, $2) RETURNING id`,
        [types.Bank, people.officer],
      )
    ).rows[0].id;

    return [
      await create(as, { name: 'Ecobank', typeId: types.Bank }),
      await app.send('GET', `/api/clients/clients/${existing}`, as),
      await app.send('PATCH', `/api/clients/clients/${existing}`, as, { name: 'Not ADB' }),
      /* A client that is not there answers as one that is, so ids say nothing. */
      await app.send('PATCH', '/api/clients/clients/987654321', as, { name: 'Not ADB' }),
      await app.send('GET', '/api/clients/client-types', as),
      await app.send('GET', '/api/clients/clients', as),
      await app.send('GET', '/api/clients/holders', as),
      await app.send('GET', '/api/clients/products', as),
    ];
  }

  it('gets nothing at that address', async () => {
    for (const response of await attempts(nobody)) {
      expect([response.status, await response.json()]).toEqual([404, NO_SUCH_ROUTE]);
    }
    expect(await clientCount()).toBe(1);
  });

  /* Through the door for the roles screen, and no further. */
  it('is refused silently as a System Administrator', async () => {
    for (const response of await attempts(sysadmin)) {
      expect(response.status).toBe(404);
    }
    expect(await clientCount()).toBe(1);
  });
});
