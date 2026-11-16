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
 * Products and lines, kept by a BD manager, over HTTP against a real database. #293, Clients
 * SRS CLI 07, CLI 08, NFR CLI AUD 01. Today is pinned at 2026-10-30.
 */

const testDatabaseUrl = await databaseForThisFile();

const denials = recordingDenials();

let db: Kysely<Database>;
let admin: Client;
let app: ClientsApp;
let people: Record<string, string>;

/** Who is asking: a BD manager, an associate, a System Administrator, somebody with no role. */
let bdManager: Asker;
let associate: Asker;
let sysadmin: Asker;
let nobody: Asker;

interface Line {
  id: string;
  name: string;
  retiredOn: string | null;
  products: { id: string; lineId: string; name: string; retiredOn: string | null }[];
}

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);
  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();
  app = await startClientsApp(db, denials);
});

beforeEach(async () => {
  /* Whatever lines a migration seeded, these tests start from none. */
  await admin.query(
    'TRUNCATE clients_client_product, clients_value_change, clients_opportunity, clients_product, ' +
      'clients_product_line RESTART IDENTITY',
  );
  people = (await seed(admin)) as Record<string, string>;

  const grants = new ClientsRoleRepository(db);
  await grants.grant(people.commercialDirector, 'BD_MANAGER', people.headOfHr, 'them');
  await grants.grant(people.officer, 'ASSOCIATE', people.headOfHr, 'them');

  bdManager = { employeeId: people.commercialDirector };
  associate = { employeeId: people.officer };
  sysadmin = { employeeId: people.headOfHr, sysAdmin: true };
  nobody = { employeeId: people.engineer };
  denials.clear();
});

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await admin?.end();
});

async function lines(): Promise<Line[]> {
  const response = await app.send('GET', '/api/clients/setup/products', bdManager);
  expect(response.status).toBe(200);

  return ((await response.json()) as { lines: Line[] }).lines;
}

async function addLine(name: string): Promise<string> {
  const response = await app.send('POST', '/api/clients/setup/lines', bdManager, { name });
  expect(response.status).toBe(201);

  return ((await response.json()) as { id: string }).id;
}

async function addProduct(lineId: string, name: string): Promise<string> {
  const response = await app.send('POST', '/api/clients/setup/products', bdManager, {
    lineId,
    name,
  });
  expect(response.status).toBe(201);

  return ((await response.json()) as { id: string }).id;
}

/** The lines as names, each with its products' names, retired ones marked. */
async function shape(): Promise<string[][]> {
  const mark = (name: string, retiredOn: string | null) =>
    retiredOn === null ? name : `${name} (retired ${retiredOn})`;

  return (await lines()).map((line) => [
    mark(line.name, line.retiredOn),
    ...line.products.map((product) => mark(product.name, product.retiredOn)),
  ]);
}

describe('a BD manager', () => {
  /* Done when: the BD manager can add a new product without a developer, and every product
     shows under its line. */
  it('adds lines and products, and sees every product under its line', async () => {
    const symphony = await addLine('Symphony');
    const dura = await addLine('Dura Capital');
    await addProduct(symphony, 'Symphony Messaging');
    await addProduct(dura, 'OnboardStudio');
    await addProduct(dura, 'CreditStudio');
    await addProduct(symphony, 'Symphony Federation');

    /* Lines by name, and each line's products by name. */
    expect(await shape()).toEqual([
      ['Dura Capital', 'CreditStudio', 'OnboardStudio'],
      ['Symphony', 'Symphony Federation', 'Symphony Messaging'],
    ]);
  });

  it('is named in the audit log as who did it', async () => {
    const line = await addLine('Riskflow');
    await addProduct(line, 'Riskflow');

    const { rows } = await admin.query(
      `SELECT entity, action, actor_employee_id FROM audit_log
        WHERE entity LIKE 'clients_product%' ORDER BY id`,
    );
    expect(rows).toEqual([
      {
        entity: 'clients_product_line',
        action: 'CREATE',
        actor_employee_id: people.commercialDirector,
      },
      { entity: 'clients_product', action: 'CREATE', actor_employee_id: people.commercialDirector },
    ]);
  });

  it('renames a line and a product', async () => {
    const line = await addLine('Symphony');
    const product = await addProduct(line, 'Messaging');

    expect(
      (
        await app.send('PATCH', `/api/clients/setup/lines/${line}`, bdManager, {
          name: 'Symphony Suite',
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await app.send('PATCH', `/api/clients/setup/products/${product}`, bdManager, {
          name: '  Symphony Messaging ',
        })
      ).status,
    ).toBe(204);

    expect(await shape()).toEqual([['Symphony Suite', 'Symphony Messaging']]);
  });

  it('cannot use a name twice, whatever its case or spacing', async () => {
    const line = await addLine('Cloud9');
    const product = await addProduct(line, 'Cloud9');
    await addProduct(line, 'Cloud9 Mobile');

    const taken = [
      await app.send('POST', '/api/clients/setup/lines', bdManager, { name: ' cloud9 ' }),
      await app.send('POST', '/api/clients/setup/products', bdManager, {
        lineId: line,
        name: 'CLOUD9',
      }),
      await app.send('PATCH', `/api/clients/setup/products/${product}`, bdManager, {
        name: 'cloud9 mobile',
      }),
    ];

    for (const response of taken) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'ClientsNameTaken' });
    }
  });

  it('is told what to fix in a request that makes no sense', async () => {
    const line = await addLine('Symphony');

    const blank = await app.send('POST', '/api/clients/setup/lines', bdManager, { name: '  ' });
    expect(blank.status).toBe(400);
    expect(await blank.json()).toMatchObject({ error: 'InvalidProductSetup', field: 'name' });

    const tooLong = await app.send('POST', '/api/clients/setup/products', bdManager, {
      lineId: line,
      name: 'x'.repeat(81),
    });
    expect(await tooLong.json()).toMatchObject({ field: 'name' });

    const noLine = await app.send('POST', '/api/clients/setup/products', bdManager, {
      name: 'Orphan',
    });
    expect(noLine.status).toBe(400);
    expect(await noLine.json()).toMatchObject({ field: 'lineId' });

    expect(
      (
        await app.send('POST', '/api/clients/setup/products', bdManager, {
          lineId: '987654321',
          name: 'Nowhere',
        })
      ).status,
    ).toBe(404);
    expect(
      (await app.send('POST', '/api/clients/setup/products/not-an-id/retire', bdManager)).status,
    ).toBe(404);
  });
});

describe('retiring and restoring', () => {
  it('retires a product today, and keeps it on the page marked retired', async () => {
    const line = await addLine('Symphony');
    const product = await addProduct(line, 'Symphony Messaging');

    expect(
      (await app.send('POST', `/api/clients/setup/products/${product}/retire`, bdManager)).status,
    ).toBe(204);

    expect(await shape()).toEqual([['Symphony', `Symphony Messaging (retired ${PINNED_DATE})`]]);
  });

  it('retires a line with every product in it still taking deals, keeping earlier dates', async () => {
    const dura = await addLine('Dura Capital');
    const micro = await addProduct(dura, 'MicroStudio');
    await addProduct(dura, 'OnboardStudio');
    await admin.query(`UPDATE clients_product SET retired_on = '2026-01-15' WHERE id = $1`, [
      micro,
    ]);

    await app.send('POST', `/api/clients/setup/lines/${dura}/retire`, bdManager);

    expect(await shape()).toEqual([
      [
        `Dura Capital (retired ${PINNED_DATE})`,
        'MicroStudio (retired 2026-01-15)',
        `OnboardStudio (retired ${PINNED_DATE})`,
      ],
    ]);
  });

  it('takes no new product into a retired line, nor restores one into it', async () => {
    const line = await addLine('AIC One');
    const product = await addProduct(line, 'AIC One');
    await app.send('POST', `/api/clients/setup/lines/${line}/retire`, bdManager);

    const adding = await app.send('POST', '/api/clients/setup/products', bdManager, {
      lineId: line,
      name: 'AIC Two',
    });
    expect(adding.status).toBe(409);
    expect(await adding.json()).toMatchObject({ error: 'ClientsLineRetired' });

    const restoring = await app.send(
      'POST',
      `/api/clients/setup/products/${product}/restore`,
      bdManager,
    );
    expect(restoring.status).toBe(409);
    expect(((await restoring.json()) as { message: string }).message).toMatch(
      /Restore the line first/,
    );
  });

  it('restores a line on its own, and then each product', async () => {
    const line = await addLine('Riskflow');
    const product = await addProduct(line, 'Riskflow');
    await app.send('POST', `/api/clients/setup/lines/${line}/retire`, bdManager);

    await app.send('POST', `/api/clients/setup/lines/${line}/restore`, bdManager);
    expect(await shape()).toEqual([['Riskflow', `Riskflow (retired ${PINNED_DATE})`]]);

    await app.send('POST', `/api/clients/setup/products/${product}/restore`, bdManager);
    expect(await shape()).toEqual([['Riskflow', 'Riskflow']]);
  });

  it('never deletes: a retired product is still there, with its history', async () => {
    const line = await addLine('Cloud9');
    const product = await addProduct(line, 'Cloud9');
    await app.send('POST', `/api/clients/setup/products/${product}/retire`, bdManager);

    const { rows } = await admin.query('SELECT count(*)::int AS n FROM clients_product');
    expect(rows[0].n).toBe(1);
  });
});

describe('anybody who is not a BD manager', () => {
  async function attempts(as: Asker): Promise<globalThis.Response[]> {
    const line = (
      await admin.query<{ id: string }>(
        `INSERT INTO clients_product_line (name) VALUES ('Symphony') RETURNING id`,
      )
    ).rows[0].id;
    const product = (
      await admin.query<{ id: string }>(
        `INSERT INTO clients_product (line_id, name) VALUES ($1, 'Messaging') RETURNING id`,
        [line],
      )
    ).rows[0].id;

    return [
      await app.send('GET', '/api/clients/setup/products', as),
      await app.send('POST', '/api/clients/setup/lines', as, { name: 'Cloud9' }),
      await app.send('POST', '/api/clients/setup/products', as, { lineId: line, name: 'Fed' }),
      await app.send('PATCH', `/api/clients/setup/lines/${line}`, as, { name: 'X' }),
      await app.send('PATCH', `/api/clients/setup/products/${product}`, as, { name: 'X' }),
      await app.send('POST', `/api/clients/setup/lines/${line}/retire`, as),
      await app.send('POST', `/api/clients/setup/lines/${line}/restore`, as),
      await app.send('POST', `/api/clients/setup/products/${product}/retire`, as),
      await app.send('POST', `/api/clients/setup/products/${product}/restore`, as),
    ];
  }

  async function unchanged(): Promise<void> {
    const { rows } = await admin.query(
      `SELECT l.name AS line, l.retired_on AS line_retired, p.name AS product, p.retired_on
         FROM clients_product_line l JOIN clients_product p ON p.line_id = l.id`,
    );
    expect(rows).toEqual([
      { line: 'Symphony', line_retired: null, product: 'Messaging', retired_on: null },
    ]);
  }

  it('is refused openly as an associate, and told to ask a BD manager', async () => {
    for (const response of await attempts(associate)) {
      expect(response.status).toBe(403);
      expect(((await response.json()) as { message: string }).message).toMatch(/BD manager/);
    }
    await unchanged();
  });

  /* A System Administrator gets through the door for the roles screen, and no further. */
  it('is refused silently as a System Administrator with no clients role', async () => {
    for (const response of await attempts(sysadmin)) {
      expect(response.status).toBe(404);
    }
    await unchanged();
  });

  it('gets nothing at that address with no clients role at all', async () => {
    for (const response of await attempts(nobody)) {
      expect([response.status, await response.json()]).toEqual([404, NO_SUCH_ROUTE]);
    }
    await unchanged();
  });
});

/* #276. The kinds of institution a client may be, kept by a BD manager rather than fixed. */
describe('client types', () => {
  interface TypeJson {
    id: string;
    name: string;
    retiredOn: string | null;
  }

  beforeEach(async () => {
    /* The seed empties clients but leaves types: put back the five as migrated. */
    await admin.query(
      `DELETE FROM clients_client_type
        WHERE name NOT IN ('Bank', 'Broker', 'Microfinance institution', 'Digital lender', 'DFI')`,
    );
    await admin.query('UPDATE clients_client_type SET retired_on = NULL');
  });

  async function types(): Promise<TypeJson[]> {
    const response = await app.send('GET', '/api/clients/setup/client-types', bdManager);
    expect(response.status).toBe(200);

    return ((await response.json()) as { types: TypeJson[] }).types;
  }

  async function typeId(name: string): Promise<string> {
    return (await types()).find((type) => type.name === name)?.id ?? '';
  }

  it('starts as the five, and takes another from a BD manager', async () => {
    const response = await app.send('POST', '/api/clients/setup/client-types', bdManager, {
      name: '  Insurance   company ',
    });

    expect([response.status, await response.json()]).toMatchObject([
      201,
      { name: 'Insurance company', retiredOn: null },
    ]);
    expect((await types()).map((type) => type.name)).toEqual([
      'Bank',
      'Broker',
      'DFI',
      'Digital lender',
      'Insurance company',
      'Microfinance institution',
    ]);
  });

  it('names each once, whatever its case or spacing', async () => {
    for (const response of [
      await app.send('POST', '/api/clients/setup/client-types', bdManager, { name: ' bank' }),
      await app.send('PATCH', `/api/clients/setup/client-types/${await typeId('DFI')}`, bdManager, {
        name: 'BROKER',
      }),
    ]) {
      expect([response.status, await response.json()]).toMatchObject([
        409,
        { error: 'ClientsNameTaken' },
      ]);
    }
  });

  it('is renamed, retired today and restored', async () => {
    const dfi = await typeId('DFI');

    await app.send('PATCH', `/api/clients/setup/client-types/${dfi}`, bdManager, {
      name: 'Development finance institution',
    });
    await app.send('POST', `/api/clients/setup/client-types/${dfi}/retire`, bdManager);

    expect((await types()).find((type) => type.id === dfi)).toEqual({
      id: dfi,
      name: 'Development finance institution',
      retiredOn: PINNED_DATE,
    });

    await app.send('POST', `/api/clients/setup/client-types/${dfi}/restore`, bdManager);
    expect((await types()).find((type) => type.id === dfi)?.retiredOn).toBeNull();
  });

  it('is told what to fix, and finds no type that is not there', async () => {
    const blank = await app.send('POST', '/api/clients/setup/client-types', bdManager, {
      name: ' ',
    });
    expect([blank.status, await blank.json()]).toMatchObject([400, { field: 'name' }]);

    const tooLong = await app.send('POST', '/api/clients/setup/client-types', bdManager, {
      name: 'x'.repeat(61),
    });
    expect(tooLong.status).toBe(400);

    for (const id of ['987654321', 'not-an-id']) {
      expect(
        (await app.send('POST', `/api/clients/setup/client-types/${id}/retire`, bdManager)).status,
      ).toBe(404);
    }
  });

  it('is refused openly to an associate, and silently to anybody with no role', async () => {
    const bank = await typeId('Bank');
    const attempts = async (as: Asker) => [
      await app.send('GET', '/api/clients/setup/client-types', as),
      await app.send('POST', '/api/clients/setup/client-types', as, { name: 'Insurer' }),
      await app.send('PATCH', `/api/clients/setup/client-types/${bank}`, as, { name: 'X' }),
      await app.send('POST', `/api/clients/setup/client-types/${bank}/retire`, as),
      await app.send('POST', `/api/clients/setup/client-types/${bank}/restore`, as),
    ];

    for (const response of await attempts(associate)) {
      expect(response.status).toBe(403);
    }
    for (const as of [sysadmin, nobody]) {
      for (const response of await attempts(as)) {
        expect(response.status).toBe(404);
      }
    }
    expect((await types()).map((type) => [type.name, type.retiredOn])).toContainEqual([
      'Bank',
      null,
    ]);
  });
});

describe('which parts of clients a person has', () => {
  async function viewsOf(as: Asker): Promise<unknown> {
    const response = await app.send('GET', '/api/clients/me', as);

    return [response.status, await response.json()];
  }

  it('is setup for a BD manager, roles for a System Administrator, and neither for an associate', async () => {
    expect(await viewsOf(bdManager)).toEqual([200, { setUp: true, manageRoles: false }]);
    expect(await viewsOf(associate)).toEqual([200, { setUp: false, manageRoles: false }]);
    expect(await viewsOf(sysadmin)).toEqual([200, { setUp: false, manageRoles: true }]);
    expect(await viewsOf(nobody)).toEqual([404, NO_SUCH_ROUTE]);
  });
});
