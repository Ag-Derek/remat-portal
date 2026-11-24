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
    'TRUNCATE clients_client_product, clients_stage_change, clients_value_change, clients_next_step, ' +
      'clients_document, clients_activity, ' +
      'clients_poc_alert, clients_poc_action, clients_poc_health, clients_poc_usage, clients_tick, clients_check, ' +
      'clients_opportunity, clients_poc, clients_product, clients_checklist_item, ' +
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
    /* Past proposals, #281, are anybody's with a role, and not a System Administrator's alone. */
    expect(await viewsOf(bdManager)).toEqual([
      200,
      { setUp: true, manageRoles: false, pastProposals: true, pocs: true },
    ]);
    expect(await viewsOf(associate)).toEqual([
      200,
      { setUp: false, manageRoles: false, pastProposals: true, pocs: true },
    ]);
    expect(await viewsOf(sysadmin)).toEqual([
      200,
      { setUp: false, manageRoles: true, pastProposals: false, pocs: false },
    ]);
    expect(await viewsOf(nobody)).toEqual([404, NO_SUCH_ROUTE]);
  });
});

/* ------------------------------------------------------------------ checklists, #284 */

describe('a checklist', () => {
  interface ItemJson {
    id: string;
    group: string;
    label: string;
    sort: number;
    pocOnly: boolean;
    retiredOn: string | null;
  }

  let symphony: string;
  let federation: string;
  let types: Record<string, string>;

  beforeEach(async () => {
    symphony = await addLine('Symphony');
    federation = await addProduct(symphony, 'Federation');
    const { rows } = await admin.query<{ id: string; name: string }>(
      'SELECT id, name FROM clients_client_type',
    );
    types = Object.fromEntries(rows.map((row) => [row.name, row.id]));
  });

  function listOf(type: string): string {
    return `/api/clients/setup/checklists?lineId=${symphony}&clientTypeId=${types[type]}`;
  }

  async function itemsOf(type = 'Bank'): Promise<ItemJson[]> {
    const response = await app.send('GET', listOf(type), bdManager);
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: ItemJson[] }).items;
  }

  function add(group: string, label: string, extra: object = {}, type = 'Bank') {
    return app.send('POST', '/api/clients/setup/checklists/items', bdManager, {
      lineId: symphony,
      clientTypeId: types[type],
      group,
      label,
      ...extra,
    });
  }

  async function added(group: string, label: string, type = 'Bank'): Promise<string> {
    const response = await add(group, label, {}, type);
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  function itemPath(id: string, act = ''): string {
    return `/api/clients/setup/checklists/items/${id}${act === '' ? '' : `/${act}`}`;
  }

  const labelsOf = (items: ItemJson[]) => items.map((item) => `${item.group}: ${item.label}`);

  /* CLI 39, CLI 42, CLI 43. */
  it('starts empty, and is written item by item at the end of each group', async () => {
    expect(await itemsOf()).toEqual([]);

    await added('PRE_POC', 'Metrics agreed');
    await added('QUALIFICATION', 'Point person identified');
    await added('QUALIFICATION', 'Finance contact identified');

    expect(
      (await itemsOf()).map(({ group, label, sort, pocOnly }) => [group, label, sort, pocOnly]),
    ).toEqual([
      ['QUALIFICATION', 'Point person identified', 1, false],
      ['QUALIFICATION', 'Finance contact identified', 2, false],
      ['PRE_POC', 'Metrics agreed', 1, false],
    ]);
    expect(await itemsOf('Broker')).toEqual([]);
  });

  it('rewords, marks for POC deals only, and moves an item within its group', async () => {
    const a = await added('QUALIFICATION', 'A');
    await added('QUALIFICATION', 'B');
    const c = await added('QUALIFICATION', 'C');

    const up = await app.send('POST', itemPath(c, 'move'), bdManager, { direction: 'UP' });
    expect(up.status).toBe(204);
    /* At the top already, nothing moves. */
    await app.send('POST', itemPath(a, 'move'), bdManager, { direction: 'UP' });
    expect((await itemsOf()).map((item) => [item.label, item.sort])).toEqual([
      ['A', 1],
      ['C', 2],
      ['B', 3],
    ]);

    const changed = await app.send('PATCH', itemPath(a), bdManager, {
      label: '  Decision maker   committed ',
      pocOnly: true,
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      label: 'Decision maker committed',
      pocOnly: true,
    });
  });

  it('is told what to fix in an item that makes no sense, or that another says already', async () => {
    await added('QUALIFICATION', 'Point person identified');

    expect(await (await add('PRE_POC', 'Pricing shared', { pocOnly: true })).json()).toMatchObject({
      error: 'InvalidChecklistItem',
      field: 'pocOnly',
    });
    expect((await add('MIDPOINT', 'Day 60 review')).status).toBe(400);
    expect((await add('QUALIFICATION', '   ')).status).toBe(400);

    const taken = await add('QUALIFICATION', ' point PERSON identified ');
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({
      error: 'ChecklistItemLabelTaken',
      message: '"point PERSON identified" is in this part of the checklist already.',
      field: 'label',
    });
    /* The same words in another part, or on another checklist, are fine. */
    expect((await add('PRE_POC', 'Point person identified')).status).toBe(201);
    expect((await add('QUALIFICATION', 'Point person identified', {}, 'Broker')).status).toBe(201);
  });

  /* CLI 40: a deal is judged by its copy, so the editor changes only deals copied after. */
  it('retires and restores, never deletes, and changes only deals copied after', async () => {
    const point = await added('QUALIFICATION', 'Point person identified');
    const finance = await added('QUALIFICATION', 'Finance contact identified');

    const client = await app.send('POST', '/api/clients/clients', bdManager, {
      name: 'ADB',
      typeId: types.Bank,
    });
    const clientId = ((await client.json()) as { id: string }).id;

    async function aDealAtQualification(): Promise<string> {
      const opened = await app.send('POST', '/api/clients/opportunities', bdManager, {
        clientId,
        productId: federation,
      });
      expect(opened.status).toBe(201);
      const { id } = (await opened.json()) as { id: string };
      await app.send('POST', `/api/clients/opportunities/${id}/stage`, bdManager, {
        toStage: 'QUALIFICATION',
      });
      return id;
    }

    async function checksOf(deal: string): Promise<string[]> {
      const response = await app.send(
        'GET',
        `/api/clients/opportunities/${deal}/checks`,
        bdManager,
      );
      return ((await response.json()) as { checks: { label: string }[] }).checks.map(
        (check) => check.label,
      );
    }

    const before = await aDealAtQualification();

    await app.send('PATCH', itemPath(point), bdManager, { label: 'Point person named' });
    expect((await app.send('POST', itemPath(finance, 'retire'), bdManager)).status).toBe(204);
    expect((await itemsOf()).find((item) => item.id === finance)?.retiredOn).toBe(PINNED_DATE);

    expect(await checksOf(before)).toEqual([
      'Point person identified',
      'Finance contact identified',
    ]);

    /* Lost, so the product is free for a new deal, copied now. */
    const { rows } = await admin.query<{ id: string }>(
      `SELECT id FROM clients_reason WHERE applies_to = 'LOST' AND retired_on IS NULL LIMIT 1`,
    );
    const lost = await app.send('POST', `/api/clients/opportunities/${before}/lose`, bdManager, {
      reasonId: rows[0].id,
    });
    expect(lost.status).toBe(200);
    expect(await checksOf(await aDealAtQualification())).toEqual(['Point person named']);

    await app.send('POST', itemPath(finance, 'restore'), bdManager);
    expect((await itemsOf()).find((item) => item.id === finance)?.retiredOn).toBeNull();
  });

  /* The user, 24 November 2026: an empty checklist filled from another, then its own. */
  it('fills an empty checklist with a copy of another, and refuses one with items', async () => {
    await added('QUALIFICATION', 'Decision maker committed');
    const retired = await added('PRE_POC', 'Signed agreement');
    await app.send('POST', itemPath(retired, 'retire'), bdManager);
    await added('PRE_POC', 'Metrics agreed');

    const copy = (into: string, from: string) =>
      app.send('POST', '/api/clients/setup/checklists/copy', bdManager, {
        lineId: symphony,
        clientTypeId: types[into],
        fromLineId: symphony,
        fromClientTypeId: types[from],
      });

    const copied = await copy('Microfinance institution', 'Bank');
    expect(copied.status).toBe(200);
    expect(labelsOf(((await copied.json()) as { items: ItemJson[] }).items)).toEqual([
      'QUALIFICATION: Decision maker committed',
      'PRE_POC: Metrics agreed',
    ]);

    expect(await (await copy('Microfinance institution', 'Bank')).json()).toMatchObject({
      error: 'ChecklistNotEmpty',
    });
    expect((await copy('Bank', 'Bank')).status).toBe(400);

    /* Its own now: changing the copy leaves the one it came from as it was. */
    const [first] = await itemsOf('Microfinance institution');
    await app.send('PATCH', itemPath(first.id), bdManager, { label: 'Board member committed' });
    expect(labelsOf(await itemsOf())).toContain('QUALIFICATION: Decision maker committed');
  });

  /* CLI 42, NFR CLI AUD 01. */
  it("is a BD manager's alone to read or change, and every change is in the audit log", async () => {
    const item = await added('QUALIFICATION', 'Point person identified');

    expect((await app.send('GET', listOf('Bank'), associate)).status).toBe(403);
    expect((await app.send('POST', itemPath(item, 'retire'), associate)).status).toBe(403);
    expect((await app.send('GET', listOf('Bank'), nobody)).status).toBe(404);

    await app.send('POST', itemPath(item, 'retire'), bdManager);
    const { rows } = await admin.query(
      `SELECT action, actor_employee_id FROM audit_log
        WHERE entity = 'clients_checklist_item' AND entity_id = $1 ORDER BY id`,
      [item],
    );
    expect(rows).toEqual([
      { action: 'CREATE', actor_employee_id: people.commercialDirector },
      { action: 'UPDATE', actor_employee_id: people.commercialDirector },
    ]);
  });
});
