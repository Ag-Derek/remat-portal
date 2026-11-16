import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * The clients tables, against a real database. #274, Clients TDD 4.8 and 14.
 *
 * Only what the schema decides on its own. So far that is the roles: who holds which, who
 * granted it and when, ended rather than deleted, and what lms_app may change.
 */

const testDatabaseUrl = await databaseForThisFile();

let admin: Client;
let sysadmin: string;
let ama: string;
let kofi: string;

const TABLES = [
  'clients_role',
  'clients_product_line',
  'clients_product',
  'clients_client_type',
  'clients_client',
  'clients_contact',
  'clients_client_product',
  'clients_opportunity',
  'clients_value_change',
];

/** A client nobody else in a test has, owned by `owner`. */
async function aClient(owner: string, name = 'Testbank'): Promise<string> {
  return (
    await admin.query<{ id: string }>(
      `INSERT INTO clients_client (name, type_id, owner_id)
       SELECT $1, id, $2 FROM clients_client_type WHERE name = 'Bank' RETURNING id`,
      [name, owner],
    )
  ).rows[0].id;
}

beforeAll(async () => {
  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const people = (await seed(admin)) as Record<string, string>;
  sysadmin = people.ceo;

  const { rows } = await admin.query<{ id: string }>(
    'SELECT id FROM employee WHERE id <> $1 ORDER BY id LIMIT 2',
    [sysadmin],
  );
  [ama, kofi] = rows.map((row) => row.id);
});

afterAll(async () => {
  await admin?.end();
});

/* Each test in a transaction of its own, rolled back afterwards, which is also what lets a
   refused statement be undone to a savepoint. */
beforeEach(async () => {
  await admin.query('BEGIN');
  return async () => {
    await admin.query('ROLLBACK');
  };
});

/** The constraint or index a statement was refused by, or null if it went in. */
async function refusedBy(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await admin.query('SAVEPOINT attempt');
    await admin.query(sql, params);
    await admin.query('RELEASE SAVEPOINT attempt');
    return null;
  } catch (error) {
    await admin.query('ROLLBACK TO SAVEPOINT attempt').catch(() => undefined);
    return (error as { constraint?: string }).constraint ?? String(error);
  }
}

/* ---------------------------------------------------------------------- roles */

describe('a role', () => {
  const GRANT = `INSERT INTO clients_role (employee_id, role, granted_by)
                 VALUES ($1, $2, $3) RETURNING id`;

  /** Ends a grant as somebody, for a reason. */
  async function end(id: string, reason = 'REVOKED', by: string | null = sysadmin): Promise<void> {
    await admin.query(
      `UPDATE clients_role SET ended_at = now(), ended_by = $2, ended_reason = $3 WHERE id = $1`,
      [id, by, reason],
    );
  }

  it('records who holds it, who granted it and when', async () => {
    const { rows } = await admin.query<{ granted_at: Date }>(
      `INSERT INTO clients_role (employee_id, role, granted_by)
       VALUES ($1, 'ASSOCIATE', $2) RETURNING employee_id, role, granted_by, granted_at`,
      [ama, sysadmin],
    );

    expect(rows[0]).toMatchObject({ employee_id: ama, role: 'ASSOCIATE', granted_by: sysadmin });
    expect(rows[0].granted_at).toBeInstanceOf(Date);
  });

  it('is granted by somebody', async () => {
    expect(await refusedBy(GRANT, [ama, 'ASSOCIATE', null])).toMatch(/granted_by/);
  });

  it('is only BD manager or associate', async () => {
    expect(await refusedBy(GRANT, [ama, 'VIEWER', sysadmin])).toBe('clients_role_role_check');
    expect(await refusedBy(GRANT, [ama, 'BD_MANAGER', sysadmin])).toBeNull();
    expect(await refusedBy(GRANT, [kofi, 'ASSOCIATE', sysadmin])).toBeNull();
  });

  /* #274. Not SRS CLI 89: there is no limit of one, because the department will grow. */
  it('may be BD manager for several people at once', async () => {
    expect(await refusedBy(GRANT, [ama, 'BD_MANAGER', sysadmin])).toBeNull();
    expect(await refusedBy(GRANT, [kofi, 'BD_MANAGER', sysadmin])).toBeNull();

    const { rows } = await admin.query<{ count: string }>(
      `SELECT count(*) FROM clients_role WHERE role = 'BD_MANAGER' AND ended_at IS NULL`,
    );
    expect(rows[0].count).toBe('2');
  });

  it('is held once at a time, and granted again once ended', async () => {
    const { rows } = await admin.query<{ id: string }>(GRANT, [ama, 'ASSOCIATE', sysadmin]);

    expect(await refusedBy(GRANT, [ama, 'ASSOCIATE', sysadmin])).toBe('uq_clients_role_live');

    await end(rows[0].id);

    expect(await refusedBy(GRANT, [ama, 'ASSOCIATE', sysadmin])).toBeNull();
  });

  it('ends revoked or because its holder left, and says which', async () => {
    const { rows } = await admin.query<{ id: string }>(GRANT, [kofi, 'ASSOCIATE', sysadmin]);
    const END = `UPDATE clients_role SET ended_at = now(), ended_by = $2, ended_reason = $3
                  WHERE id = $1`;

    expect(await refusedBy(END, [rows[0].id, sysadmin, null])).toBe(
      'clients_role_ends_with_a_reason',
    );
    expect(await refusedBy(END, [rows[0].id, sysadmin, 'RETIRED'])).toBe(
      'clients_role_ending_known',
    );
    expect(
      await refusedBy(`UPDATE clients_role SET ended_reason = 'LEFT' WHERE id = $1`, [rows[0].id]),
    ).toBe('clients_role_ends_with_a_reason');
  });

  /* CLI 95. Leaving ends a grant with nobody behind it; withdrawing one is somebody's act. */
  it('is revoked by somebody, but may end with nobody when its holder left', async () => {
    const { rows } = await admin.query<{ id: string }>(GRANT, [kofi, 'ASSOCIATE', sysadmin]);
    const END = `UPDATE clients_role SET ended_at = now(), ended_by = NULL, ended_reason = $2
                  WHERE id = $1`;

    expect(await refusedBy(END, [rows[0].id, 'REVOKED'])).toBe('clients_role_revoked_by_someone');
    expect(await refusedBy(END, [rows[0].id, 'LEFT'])).toBeNull();
  });

  it('ends after it was granted', async () => {
    const { rows } = await admin.query<{ id: string }>(GRANT, [kofi, 'ASSOCIATE', sysadmin]);

    expect(
      await refusedBy(
        `UPDATE clients_role
            SET ended_at = granted_at - interval '1 day', ended_by = $2, ended_reason = 'REVOKED'
          WHERE id = $1`,
        [rows[0].id, sysadmin],
      ),
    ).toBe('clients_role_ends_after_granted');
  });

  it('keeps its history: an ended grant is still there', async () => {
    const { rows } = await admin.query<{ id: string }>(GRANT, [ama, 'ASSOCIATE', sysadmin]);

    await end(rows[0].id);
    await admin.query(GRANT, [ama, 'ASSOCIATE', sysadmin]);

    const history = await admin.query<{ ended_reason: string | null }>(
      `SELECT ended_reason FROM clients_role WHERE employee_id = $1 ORDER BY id`,
      [ama],
    );
    expect(history.rows).toEqual([{ ended_reason: 'REVOKED' }, { ended_reason: null }]);
  });

  it('is found by person, among the live grants', async () => {
    const { rows } = await admin.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_clients_role_person'`,
    );

    expect(rows[0]?.indexdef).toMatch(
      /ON public\.clients_role USING btree \(employee_id\) WHERE \(ended_at IS NULL\)/,
    );
  });
});

/* ---------------------------------------------------------- lines and products, #293 */

describe('a product line and its products', () => {
  /* Names no seeded line or product has, so these tests stand whatever the seed holds. */
  const LINE = `INSERT INTO clients_product_line (name) VALUES ($1) RETURNING id`;
  const PRODUCT = `INSERT INTO clients_product (line_id, name) VALUES ($1, $2) RETURNING id`;

  async function aLine(name = 'Testline'): Promise<string> {
    return (await admin.query<{ id: string }>(LINE, [name])).rows[0].id;
  }

  it('puts every product in exactly one line that exists', async () => {
    const line = await aLine();

    expect(await refusedBy(PRODUCT, [line, 'Testproduct'])).toBeNull();
    expect(await refusedBy(PRODUCT, [null, 'Lineless'])).toMatch(/line_id/);
    expect(await refusedBy(PRODUCT, ['987654321', 'Nowhere'])).toBe('clients_product_line_id_fkey');
  });

  it('names each once, ignoring case and surrounding spaces', async () => {
    const line = await aLine();

    expect(await refusedBy(LINE, ['  testLINE '])).toBe('uq_clients_line_name');
    expect(await refusedBy(PRODUCT, [line, 'Testproduct'])).toBeNull();
    expect(await refusedBy(PRODUCT, [line, 'TESTPRODUCT  '])).toBe('uq_clients_product_name');
  });

  it('may give a product the name of its line, as Cloud9 and Riskflow are', async () => {
    const line = await aLine();

    expect(await refusedBy(PRODUCT, [line, 'Testline'])).toBeNull();
  });

  it('is never nameless', async () => {
    const line = await aLine();

    expect(await refusedBy(LINE, ['   '])).toBe('clients_line_named');
    expect(await refusedBy(PRODUCT, [line, ''])).toBe('clients_product_named');
  });

  it('is written to the audit log by the database, with who did it', async () => {
    await admin.query(
      `SELECT set_config('lms.audit.actor', 'employee 7', true),
              set_config('lms.audit.actor_employee_id', $1, true)`,
      [sysadmin],
    );
    const line = await aLine();
    const { rows } = await admin.query<{ id: string }>(PRODUCT, [line, 'Testproduct']);
    await admin.query(`UPDATE clients_product SET retired_on = '2026-11-09' WHERE id = $1`, [
      rows[0].id,
    ]);

    const log = await admin.query(
      `SELECT entity, action, entity_id, actor_employee_id FROM audit_log
        WHERE entity IN ('clients_product_line', 'clients_product') ORDER BY id`,
    );
    expect(log.rows).toEqual([
      {
        entity: 'clients_product_line',
        action: 'CREATE',
        entity_id: line,
        actor_employee_id: sysadmin,
      },
      {
        entity: 'clients_product',
        action: 'CREATE',
        entity_id: rows[0].id,
        actor_employee_id: sysadmin,
      },
      {
        entity: 'clients_product',
        action: 'UPDATE',
        entity_id: rows[0].id,
        actor_employee_id: sysadmin,
      },
    ]);
  });
});

/* ------------------------------------------- a retired product takes no new deals, #293 */

/* CLI 08. Written by #293 before there were deals, and attached to them by #277. */
describe('a retired product', () => {
  const DEAL = `INSERT INTO clients_opportunity (client_id, product_id, owner_id)
                VALUES ($2, $1, $3) RETURNING id`;

  let client: string;

  /** A deal on the product, at the test's client. */
  function deal(product: string): Promise<string | null> {
    return refusedBy(DEAL, [product, client, ama]);
  }

  beforeEach(async () => {
    client = await aClient(ama);
  });

  async function aProduct(
    line = 'Dealline',
    product = 'Dealproduct',
  ): Promise<{ line: string; product: string }> {
    const lineId = (
      await admin.query<{ id: string }>(
        'INSERT INTO clients_product_line (name) VALUES ($1) RETURNING id',
        [line],
      )
    ).rows[0].id;
    const productId = (
      await admin.query<{ id: string }>(
        'INSERT INTO clients_product (line_id, name) VALUES ($1, $2) RETURNING id',
        [lineId, product],
      )
    ).rows[0].id;

    return { line: lineId, product: productId };
  }

  async function retire(table: 'clients_product' | 'clients_product_line', id: string) {
    await admin.query(`UPDATE ${table} SET retired_on = '2026-10-30' WHERE id = $1`, [id]);
  }

  it('takes new deals while it is not retired', async () => {
    const { product } = await aProduct();

    expect(await deal(product)).toBeNull();
  });

  it('takes no new deal once retired, and says so by name', async () => {
    const { product } = await aProduct();
    await retire('clients_product', product);

    expect(await deal(product)).toBe('clients_product_takes_new_deals');

    await admin.query('SAVEPOINT why');
    await expect(admin.query(DEAL, [product, client, ama])).rejects.toThrow(
      'Dealproduct is retired, so it takes no new deals.',
    );
    await admin.query('ROLLBACK TO SAVEPOINT why');
  });

  it('takes no new deal while its line is retired, even if restored by hand', async () => {
    const { line, product } = await aProduct();
    await retire('clients_product_line', line);

    expect(await deal(product)).toBe('clients_product_takes_new_deals');
  });

  it('keeps every deal it already had, which carries on and can still be changed', async () => {
    const { product } = await aProduct();
    const id = (await admin.query<{ id: string }>(DEAL, [product, client, ama])).rows[0].id;
    await retire('clients_product', product);

    expect(
      await refusedBy("UPDATE clients_opportunity SET waiting_on = 'SIGNATURE' WHERE id = $1", [
        id,
      ]),
    ).toBeNull();
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS n FROM clients_opportunity WHERE product_id = $1',
          [product],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it('takes no deal moved onto it from another product', async () => {
    const live = await aProduct('Liveline', 'Liveproduct');
    const id = (await admin.query<{ id: string }>(DEAL, [live.product, client, ama])).rows[0].id;
    const old = (
      await admin.query<{ id: string }>(
        "INSERT INTO clients_product (line_id, name, retired_on) VALUES ($1, 'Oldproduct', '2026-01-01') RETURNING id",
        [live.line],
      )
    ).rows[0].id;

    expect(
      await refusedBy('UPDATE clients_opportunity SET product_id = $2 WHERE id = $1', [id, old]),
    ).toBe('clients_product_takes_new_deals');
  });
});

/* --------------------------------------------------- the lines sold today, #293 */

describe('the product lines as migrated', () => {
  it('are the four lines sold today, each product in its line', async () => {
    const { rows } = await admin.query<{ line: string; product: string }>(
      `SELECT l.name AS line, p.name AS product
         FROM clients_product_line l JOIN clients_product p ON p.line_id = l.id
        WHERE l.retired_on IS NULL AND p.retired_on IS NULL`,
    );
    const byLine: Record<string, string[]> = {};
    for (const { line, product } of rows) (byLine[line] ??= []).push(product);
    for (const products of Object.values(byLine)) products.sort();

    expect(byLine).toEqual({
      Symphony: ['Cloud9', 'Federation', 'Messaging'],
      'Dura Capital': ['CreditStudio', 'MicroStudio', 'OnboardStudio'],
      Riskflow: ['ALM', 'Treasury'],
      'AIC One': [
        'ComplyOn',
        'EngageNet',
        'Orcaa.ai',
        'Proba Analytics',
        'Proba Workflows',
        'X-Verdict',
      ],
    });
  });
});

/* ------------------------------------------------------------------ a client, #276 */

describe('a client type', () => {
  const TYPE = `INSERT INTO clients_client_type (name) VALUES ($1) RETURNING id`;

  it('starts as the five kinds of institution the department sells to today', async () => {
    const { rows } = await admin.query<{ name: string }>(
      'SELECT name FROM clients_client_type WHERE retired_on IS NULL ORDER BY name',
    );

    expect(rows.map((row) => row.name)).toEqual([
      'Bank',
      'Broker',
      'DFI',
      'Digital lender',
      'Microfinance institution',
    ]);
  });

  /* #276: a kind the department starts selling to needs no migration. */
  it('takes others, each named once ignoring case and surrounding spaces', async () => {
    expect(await refusedBy(TYPE, ['Insurer'])).toBeNull();
    expect(await refusedBy(TYPE, ['  insurer '])).toBe('uq_clients_client_type_name');
    expect(await refusedBy(TYPE, ['BANK'])).toBe('uq_clients_client_type_name');
  });

  it('is never nameless', async () => {
    expect(await refusedBy(TYPE, ['  '])).toBe('clients_client_type_named');
  });
});

describe('a client', () => {
  const CLIENT = `INSERT INTO clients_client (name, type_id, owner_id, note)
                  VALUES ($1, $2, $3, $4) RETURNING id`;

  let bank: string;

  beforeEach(async () => {
    bank = (
      await admin.query<{ id: string }>(`SELECT id FROM clients_client_type WHERE name = 'Bank'`)
    ).rows[0].id;
  });

  it('records its name, type, owner and note, and when it was created', async () => {
    const { rows } = await admin.query(
      `INSERT INTO clients_client (name, type_id, owner_id, note)
       VALUES ('Testbank', $1, $2, 'Met at the fintech summit')
       RETURNING name, type_id, owner_id, note, created_at`,
      [bank, ama],
    );

    expect(rows[0]).toMatchObject({
      name: 'Testbank',
      type_id: bank,
      owner_id: ama,
      note: 'Met at the fintech summit',
    });
    expect(rows[0].created_at).toBeInstanceOf(Date);
  });

  it('is of a type that exists', async () => {
    expect(await refusedBy(CLIENT, ['Testbank', null, ama, null])).toMatch(/type_id/);
    expect(await refusedBy(CLIENT, ['Testbank', '987654321', ama, null])).toBe(
      'clients_client_type_id_fkey',
    );
  });

  it('may be of a type added since', async () => {
    const insurer = (
      await admin.query<{ id: string }>(
        `INSERT INTO clients_client_type (name) VALUES ('Insurer') RETURNING id`,
      )
    ).rows[0].id;

    expect(await refusedBy(CLIENT, ['Testinsurer', insurer, ama, null])).toBeNull();
  });

  /* CLI 02. Done when: creating a duplicate client name is refused. */
  it('is recorded once, whatever the case or spacing of its name', async () => {
    expect(await refusedBy(CLIENT, ['Agricultural Development Bank', bank, ama, null])).toBeNull();

    for (const same of [
      'agricultural development bank',
      '  AGRICULTURAL DEVELOPMENT BANK ',
      'Agricultural  Development   Bank',
      'Agricultural\tDevelopment\nBank',
    ]) {
      expect(await refusedBy(CLIENT, [same, bank, kofi, null])).toBe('uq_clients_client_name');
    }

    /* Another name altogether, which merely contains the first, is another client. */
    expect(
      await refusedBy(CLIENT, ['Agricultural Development Bank Ghana', bank, ama, null]),
    ).toBeNull();
  });

  it('is refused the name of another client when renamed into it', async () => {
    await admin.query(CLIENT, ['ADB', bank, ama, null]);
    const { rows } = await admin.query<{ id: string }>(CLIENT, ['Ecobank', bank, ama, null]);

    expect(
      await refusedBy(`UPDATE clients_client SET name = ' adb' WHERE id = $1`, [rows[0].id]),
    ).toBe('uq_clients_client_name');
  });

  it('compares names through one function, which the index uses', async () => {
    const { rows } = await admin.query<{ key: string }>(
      `SELECT clients_name_key(E'  Agricultural \\t Development  BANK\\n') AS key`,
    );
    expect(rows[0].key).toBe('agricultural development bank');

    const index = await admin.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_clients_client_name'`,
    );
    expect(index.rows[0]?.indexdef).toMatch(/UNIQUE INDEX .* \(clients_name_key\(/);
  });

  it('is named, and owned by somebody who exists', async () => {
    expect(await refusedBy(CLIENT, ['  ', bank, ama, null])).toBe('clients_client_named');
    expect(await refusedBy(CLIENT, ['\t\n', bank, ama, null])).toBe('clients_client_named');
    expect(await refusedBy(CLIENT, ['Testbank', bank, null, null])).toMatch(/owner_id/);
    expect(await refusedBy(CLIENT, ['Testbank', bank, '987654321', null])).toBe(
      'clients_client_owner_id_fkey',
    );
  });

  /* Missing is null, never an empty string, so the screen can say it is missing. */
  it('has no note rather than a blank one', async () => {
    expect(await refusedBy(CLIENT, ['Testbank', bank, ama, '  '])).toBe(
      'clients_client_note_not_blank',
    );
    expect(await refusedBy(CLIENT, ['Testbank', bank, ama, null])).toBeNull();
  });

  it('is written to the audit log by the database, with who did it', async () => {
    await admin.query(
      `SELECT set_config('lms.audit.actor', 'employee 7', true),
              set_config('lms.audit.actor_employee_id', $1, true)`,
      [ama],
    );
    const { rows } = await admin.query<{ id: string }>(CLIENT, ['Testbank', bank, ama, null]);
    await admin.query('UPDATE clients_client SET owner_id = $2 WHERE id = $1', [rows[0].id, kofi]);

    const log = await admin.query(
      `SELECT action, entity_id, actor_employee_id FROM audit_log
        WHERE entity = 'clients_client' ORDER BY id`,
    );
    expect(log.rows).toEqual([
      { action: 'CREATE', entity_id: rows[0].id, actor_employee_id: ama },
      { action: 'UPDATE', entity_id: rows[0].id, actor_employee_id: ama },
    ]);
  });

  it('is found by owner', async () => {
    const { rows } = await admin.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_clients_client_owner'`,
    );

    expect(rows[0]?.indexdef).toMatch(/ON public\.clients_client USING btree \(owner_id\)/);
  });
});

/* ------------------------------------------------------------ a contact, #276 */

describe('a contact', () => {
  const CONTACT = `INSERT INTO clients_contact (client_id, name, job_title, email, phone)
                   VALUES ($1, $2, $3, $4, $5) RETURNING id`;

  let adb: string;

  beforeEach(async () => {
    adb = (
      await admin.query<{ id: string }>(
        `INSERT INTO clients_client (name, type_id, owner_id)
         SELECT 'Testbank', id, $1 FROM clients_client_type WHERE name = 'Bank' RETURNING id`,
        [ama],
      )
    ).rows[0].id;
  });

  it('records a name, job title, email and phone at one client', async () => {
    const { rows } = await admin.query(
      `INSERT INTO clients_contact (client_id, name, job_title, email, phone)
       VALUES ($1, 'Ama Owusu', 'Head of IT', 'ama@testbank.com', '+233 30 000 0000')
       RETURNING client_id, name, job_title, email, phone, created_at, removed_at`,
      [adb],
    );

    expect(rows[0]).toMatchObject({
      client_id: adb,
      name: 'Ama Owusu',
      job_title: 'Head of IT',
      email: 'ama@testbank.com',
      phone: '+233 30 000 0000',
      removed_at: null,
    });
    expect(rows[0].created_at).toBeInstanceOf(Date);
  });

  it('needs only a name and a client that exists', async () => {
    expect(await refusedBy(CONTACT, [adb, 'Kofi Mensah', null, null, null])).toBeNull();
    expect(await refusedBy(CONTACT, [adb, ' \t', null, null, null])).toBe('clients_contact_named');
    expect(await refusedBy(CONTACT, ['987654321', 'Kofi', null, null, null])).toBe(
      'clients_contact_client_id_fkey',
    );
  });

  /* Missing is null, never an empty string, so the screen can say it is missing. */
  it('has no job title, email or phone rather than a blank one', async () => {
    expect(await refusedBy(CONTACT, [adb, 'Kofi', ' ', null, null])).toBe(
      'clients_contact_job_title_not_blank',
    );
    expect(await refusedBy(CONTACT, [adb, 'Kofi', null, '', null])).toBe(
      'clients_contact_email_not_blank',
    );
    expect(await refusedBy(CONTACT, [adb, 'Kofi', null, null, '  '])).toBe(
      'clients_contact_phone_not_blank',
    );
  });

  it('is removed after it was added, and kept', async () => {
    const { rows } = await admin.query<{ id: string }>(CONTACT, [adb, 'Kofi', null, null, null]);

    expect(
      await refusedBy(
        `UPDATE clients_contact SET removed_at = created_at - interval '1 day' WHERE id = $1`,
        [rows[0].id],
      ),
    ).toBe('clients_contact_removed_after_added');
    expect(
      await refusedBy('UPDATE clients_contact SET removed_at = now() WHERE id = $1', [rows[0].id]),
    ).toBeNull();
  });

  it('is written to the audit log by the database', async () => {
    const { rows } = await admin.query<{ id: string }>(CONTACT, [adb, 'Kofi', null, null, null]);

    const log = await admin.query(
      `SELECT action, entity_id FROM audit_log WHERE entity = 'clients_contact' ORDER BY id`,
    );
    expect(log.rows).toEqual([{ action: 'CREATE', entity_id: rows[0].id }]);
  });
});

/* ------------------------------------------------ a product a client uses, #276 */

describe('a product a client uses', () => {
  const IN_USE = `INSERT INTO clients_client_product (client_id, product_id, since_on, ended_on)
                  VALUES ($1, $2, $3, $4) RETURNING id`;

  let adb: string;
  let creditStudio: string;

  beforeEach(async () => {
    adb = (
      await admin.query<{ id: string }>(
        `INSERT INTO clients_client (name, type_id, owner_id)
         SELECT 'Testbank', id, $1 FROM clients_client_type WHERE name = 'Bank' RETURNING id`,
        [ama],
      )
    ).rows[0].id;
    creditStudio = (
      await admin.query<{ id: string }>(
        `SELECT id FROM clients_product WHERE name = 'CreditStudio'`,
      )
    ).rows[0].id;
  });

  it('records the day it started, and that nothing won it yet', async () => {
    const { rows } = await admin.query(
      `INSERT INTO clients_client_product (client_id, product_id, since_on)
       VALUES ($1, $2, '2024-03-01') RETURNING since_on::text, ended_on, won_by`,
      [adb, creditStudio],
    );

    expect(rows[0]).toEqual({ since_on: '2024-03-01', ended_on: null, won_by: null });
  });

  it('needs a start date, a client and a product that exist', async () => {
    expect(await refusedBy(IN_USE, [adb, creditStudio, null, null])).toMatch(/since_on/);
    expect(await refusedBy(IN_USE, ['987654321', creditStudio, '2024-03-01', null])).toBe(
      'clients_client_product_client_id_fkey',
    );
    expect(await refusedBy(IN_USE, [adb, '987654321', '2024-03-01', null])).toBe(
      'clients_client_product_product_id_fkey',
    );
  });

  it('is on a client once', async () => {
    expect(await refusedBy(IN_USE, [adb, creditStudio, '2024-03-01', null])).toBeNull();
    expect(await refusedBy(IN_USE, [adb, creditStudio, '2025-01-01', null])).toBe(
      'uq_clients_client_product',
    );
  });

  it('ends on or after the day it started', async () => {
    expect(await refusedBy(IN_USE, [adb, creditStudio, '2024-03-01', '2024-02-28'])).toBe(
      'clients_client_product_ends_after_it_starts',
    );
    expect(await refusedBy(IN_USE, [adb, creditStudio, '2024-03-01', '2024-03-01'])).toBeNull();
  });

  it('is written to the audit log by the database', async () => {
    const { rows } = await admin.query<{ id: string }>(IN_USE, [
      adb,
      creditStudio,
      '2024-03-01',
      null,
    ]);

    const log = await admin.query(
      `SELECT action, entity_id FROM audit_log
        WHERE entity = 'clients_client_product' ORDER BY id`,
    );
    expect(log.rows).toEqual([{ action: 'CREATE', entity_id: rows[0].id }]);
  });
});

/* --------------------------------------------------------- an opportunity, #277 */

describe('an opportunity', () => {
  const DEAL = `INSERT INTO clients_opportunity
                  (client_id, product_id, owner_id, value_minor, currency, probability,
                   close_half, close_year, waiting_on, waiting_note, stated_interest)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`;

  let adb: string;
  let creditStudio: string;

  /** The parameters for a deal worth GHS 125,000 at 40%, closing in the first half of 2027. */
  function aDeal(change: Partial<Record<string, unknown>> = {}): unknown[] {
    const deal = {
      client: adb,
      product: creditStudio,
      owner: ama,
      valueMinor: 12_500_000,
      currency: 'GHS',
      probability: 40,
      closeHalf: 'H1',
      closeYear: 2027,
      waitingOn: 'PROPOSAL_RESPONSE',
      waitingNote: 'Their board meets on the 20th',
      statedInterest: 'Wants SME lending off spreadsheets',
      ...change,
    };

    return [
      deal.client,
      deal.product,
      deal.owner,
      deal.valueMinor,
      deal.currency,
      deal.probability,
      deal.closeHalf,
      deal.closeYear,
      deal.waitingOn,
      deal.waitingNote,
      deal.statedInterest,
    ];
  }

  /** Nothing known but its client, product and owner. */
  const BARE = {
    valueMinor: null,
    currency: null,
    probability: null,
    closeHalf: null,
    closeYear: null,
    waitingOn: null,
    waitingNote: null,
    statedInterest: null,
  };

  /**
   * What refused a deal with this change, or null if it went in, in which case it is ended at
   * once: a client has one open deal per product (CLI 11), and each check here is about one field.
   */
  async function attempt(change: Partial<Record<string, unknown>>): Promise<string | null> {
    const refused = await refusedBy(DEAL, aDeal(change));

    if (refused === null) {
      await admin.query(
        `UPDATE clients_opportunity SET outcome = 'LOST' WHERE client_id = $1 AND outcome = 'OPEN'`,
        [adb],
      );
    }

    return refused;
  }

  beforeEach(async () => {
    adb = await aClient(ama);
    creditStudio = (
      await admin.query<{ id: string }>(
        `SELECT id FROM clients_product WHERE name = 'CreditStudio'`,
      )
    ).rows[0].id;
  });

  /* CLI 10. */
  it('records a client, product, owner, value and currency, probability, expected close, waiting on and stated interest', async () => {
    const { rows } = await admin.query(
      `${DEAL.replace('RETURNING id', '')}
       RETURNING client_id, product_id, owner_id, value_minor, currency, probability,
                 close_half, close_year, waiting_on, waiting_note, stated_interest, outcome,
                 created_at`,
      aDeal(),
    );

    expect(rows[0]).toMatchObject({
      client_id: adb,
      product_id: creditStudio,
      owner_id: ama,
      value_minor: '12500000',
      currency: 'GHS',
      probability: 40,
      close_half: 'H1',
      close_year: 2027,
      waiting_on: 'PROPOSAL_RESPONSE',
      waiting_note: 'Their board meets on the 20th',
      stated_interest: 'Wants SME lending off spreadsheets',
      outcome: 'OPEN',
    });
    expect(rows[0].created_at).toBeInstanceOf(Date);
  });

  it('is for a client and a product that exist, and owned by somebody who does', async () => {
    expect(await attempt({ client: '987654321' })).toBe('clients_opportunity_client_id_fkey');
    expect(await attempt({ product: '987654321' })).toBe('clients_opportunity_product_id_fkey');
    expect(await attempt({ owner: '987654321' })).toBe('clients_opportunity_owner_id_fkey');
    expect(await attempt({ owner: null })).toMatch(/owner_id/);
  });

  /* CLI 06, CLI 10. Everything else is optional, and missing is null rather than nought. */
  it('needs nothing but its client, product and owner', async () => {
    expect(await attempt(BARE)).toBeNull();
  });

  /* CLI 74, TDD 8. */
  it('is worth an amount in cedis or dollars, never one without the other', async () => {
    expect(await attempt({ currency: 'USD' })).toBeNull();
    expect(await attempt({ valueMinor: 0 })).toBeNull();
    expect(await attempt({ valueMinor: -100 })).toBe('clients_opportunity_value_not_negative');
    expect(await attempt({ currency: 'EUR' })).toBe('clients_opportunity_currency_known');
    expect(await attempt({ currency: null })).toBe('clients_opportunity_value_pair');
    expect(await attempt({ valueMinor: null })).toBe('clients_opportunity_value_pair');
  });

  /* CLI 14. */
  it('has a probability that is a percentage', async () => {
    expect(await attempt({ probability: 0 })).toBeNull();
    expect(await attempt({ probability: 100 })).toBeNull();
    expect(await attempt({ probability: 101 })).toBe(
      'clients_opportunity_probability_a_percentage',
    );
    expect(await attempt({ probability: -1 })).toBe('clients_opportunity_probability_a_percentage');
  });

  /* CLI 15. */
  it('is expected to close in a half, H1 or H2, of a year', async () => {
    expect(await attempt({ closeHalf: 'H2', closeYear: 2030 })).toBeNull();
    expect(await attempt({ closeHalf: 'H3' })).toBe('clients_opportunity_close_half_known');
    expect(await attempt({ closeYear: 27 })).toBe('clients_opportunity_close_year_plausible');
    expect(await attempt({ closeHalf: null })).toBe('clients_opportunity_close_pair');
    expect(await attempt({ closeYear: null })).toBe('clients_opportunity_close_pair');
  });

  /* CLI 16. */
  it('waits on one of the six things, and says what when it is "other"', async () => {
    for (const on of ['DEMO', 'PROPOSAL_RESPONSE', 'PAPERWORK', 'SIGNATURE', 'CLIENT_DECISION']) {
      expect(await attempt({ waitingOn: on, waitingNote: null })).toBeNull();
    }
    expect(await attempt({ waitingOn: 'OTHER', waitingNote: 'BoG' })).toBeNull();
    expect(await attempt({ waitingOn: 'OTHER', waitingNote: null })).toBe(
      'clients_opportunity_other_has_a_note',
    );
    expect(await attempt({ waitingOn: 'LUNCH' })).toBe('clients_opportunity_waiting_on_known');
    expect(await attempt({ waitingOn: null })).toBe('clients_opportunity_note_is_about_waiting');
  });

  /* CLI 06. Missing is null, never an empty string, so the screen can say it is missing. */
  it('has no waiting note or stated interest rather than a blank one', async () => {
    expect(await attempt({ waitingNote: '  ' })).toBe('clients_opportunity_waiting_note_not_blank');
    expect(await attempt({ statedInterest: '' })).toBe(
      'clients_opportunity_stated_interest_not_blank',
    );
  });

  it('starts open, and ends only won, lost or exited', async () => {
    for (const outcome of ['WON', 'LOST', 'EXITED']) {
      const { rows } = await admin.query<{ id: string; outcome: string }>(
        `${DEAL.replace('RETURNING id', '')} RETURNING id, outcome`,
        aDeal(),
      );
      expect(rows[0].outcome).toBe('OPEN');

      expect(
        await refusedBy('UPDATE clients_opportunity SET outcome = $2 WHERE id = $1', [
          rows[0].id,
          outcome,
        ]),
      ).toBeNull();
    }

    const { rows } = await admin.query<{ id: string }>(DEAL, aDeal());
    expect(
      await refusedBy(`UPDATE clients_opportunity SET outcome = 'PAUSED' WHERE id = $1`, [
        rows[0].id,
      ]),
    ).toBe('clients_opportunity_outcome_known');
  });

  /* CLI 11, AC L01. Done when: a second open CreditStudio deal for the same client is refused. */
  it('is the only open one for its client and product', async () => {
    expect(await refusedBy(DEAL, aDeal())).toBeNull();

    expect(await refusedBy(DEAL, aDeal())).toBe('uq_clients_opportunity_open');
    /* Whoever opens it, and whatever is said about it. */
    expect(await refusedBy(DEAL, aDeal({ ...BARE, owner: kofi }))).toBe(
      'uq_clients_opportunity_open',
    );
  });

  it('leaves the client free to open deals for other products, and other clients this one', async () => {
    const onboardStudio = (
      await admin.query<{ id: string }>(
        `SELECT id FROM clients_product WHERE name = 'OnboardStudio'`,
      )
    ).rows[0].id;
    const ecobank = await aClient(kofi, 'Ecobank');
    await admin.query(DEAL, aDeal());

    expect(await refusedBy(DEAL, aDeal({ product: onboardStudio }))).toBeNull();
    expect(await refusedBy(DEAL, aDeal({ client: ecobank }))).toBeNull();
  });

  /* CLI 11, CLI 56: a second may be opened once the first has ended, which stays as it was. */
  it('may be opened again once the last one has ended, however it ended', async () => {
    for (const outcome of ['WON', 'LOST', 'EXITED']) {
      const { rows } = await admin.query<{ id: string }>(DEAL, aDeal());
      await admin.query('UPDATE clients_opportunity SET outcome = $2 WHERE id = $1', [
        rows[0].id,
        outcome,
      ]);
    }

    expect(await refusedBy(DEAL, aDeal())).toBeNull();

    const { rows } = await admin.query<{ outcome: string }>(
      'SELECT outcome FROM clients_opportunity WHERE client_id = $1 ORDER BY id',
      [adb],
    );
    expect(rows.map((row) => row.outcome)).toEqual(['WON', 'LOST', 'EXITED', 'OPEN']);
  });

  /* CLI 55, CLI 56. An ended deal stays as it ended, and is never reopened, whatever writes the
     row: the stage service and the import included. */
  it('is kept as it ended: never reopened, and nothing about it changed', async () => {
    const { rows } = await admin.query<{ id: string }>(DEAL, aDeal());
    await admin.query(`UPDATE clients_opportunity SET outcome = 'LOST' WHERE id = $1`, [
      rows[0].id,
    ]);

    for (const change of [
      `outcome = 'OPEN'`,
      `outcome = 'WON'`,
      'probability = 90',
      'value_minor = NULL, currency = NULL',
      `waiting_on = 'SIGNATURE', waiting_note = NULL`,
      'owner_id = owner_id',
    ]) {
      expect(
        await refusedBy(`UPDATE clients_opportunity SET ${change} WHERE id = $1`, [rows[0].id]),
      ).toBe('clients_opportunity_ended_is_fixed');
    }

    await admin.query('SAVEPOINT why');
    await expect(
      admin.query('UPDATE clients_opportunity SET probability = 90 WHERE id = $1', [rows[0].id]),
    ).rejects.toThrow('This deal has ended, so it is kept as it ended and is not changed.');
    await admin.query('ROLLBACK TO SAVEPOINT why');
  });

  /* CLI 13. An open deal's figures and words change, as often as they need to. */
  it('is changed while it is open', async () => {
    const { rows } = await admin.query<{ id: string }>(DEAL, aDeal());

    expect(
      await refusedBy(
        `UPDATE clients_opportunity
            SET value_minor = 7560000, currency = 'USD', probability = 60, close_half = 'H2',
                waiting_on = NULL, waiting_note = NULL, stated_interest = NULL
          WHERE id = $1`,
        [rows[0].id],
      ),
    ).toBeNull();
  });

  /* TDD 4.1: the deal that won a product a client uses. */
  it('is what a product a client uses names as having won it', async () => {
    const { rows } = await admin.query<{ id: string }>(DEAL, aDeal());
    const IN_USE = `INSERT INTO clients_client_product (client_id, product_id, since_on, won_by)
                    VALUES ($1, $2, '2027-03-01', $3)`;

    expect(await refusedBy(IN_USE, [adb, creditStudio, '987654321'])).toBe(
      'clients_client_product_won_by_fkey',
    );
    expect(await refusedBy(IN_USE, [adb, creditStudio, rows[0].id])).toBeNull();
  });

  it('is written to the audit log by the database, with who did it', async () => {
    await admin.query(
      `SELECT set_config('lms.audit.actor', 'employee 7', true),
              set_config('lms.audit.actor_employee_id', $1, true)`,
      [ama],
    );
    const { rows } = await admin.query<{ id: string }>(DEAL, aDeal());
    await admin.query('UPDATE clients_opportunity SET owner_id = $2 WHERE id = $1', [
      rows[0].id,
      kofi,
    ]);

    const log = await admin.query(
      `SELECT action, entity_id, actor_employee_id FROM audit_log
        WHERE entity = 'clients_opportunity' ORDER BY id`,
    );
    expect(log.rows).toEqual([
      { action: 'CREATE', entity_id: rows[0].id, actor_employee_id: ama },
      { action: 'UPDATE', entity_id: rows[0].id, actor_employee_id: ama },
    ]);
  });

  /* TDD 4.2's idx_opp_owner, and a client page's deals. */
  it("is found by client, and among somebody's open deals by owner", async () => {
    const { rows } = await admin.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'clients_opportunity' AND indexname LIKE 'idx_%' ORDER BY indexname`,
    );

    expect(rows.map((row) => row.indexdef)).toEqual([
      expect.stringMatching(/USING btree \(client_id\)$/),
      expect.stringMatching(/USING btree \(owner_id\) WHERE \(\(outcome\)::text = 'OPEN'/),
    ]);
  });
});

/* ------------------------------------------------- a deal's past values, #277 */

describe("a deal's value history", () => {
  const CHANGE = `INSERT INTO clients_value_change
                    (opportunity_id, value_minor, currency, probability, source, activity_id,
                     changed_by)
                  VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`;

  let deal: string;

  /** The parameters for a change to USD 75,600 at 60%, made by hand by the deal's owner. */
  function aChange(change: Partial<Record<string, unknown>> = {}): unknown[] {
    const row = {
      deal,
      valueMinor: 7_560_000,
      currency: 'USD',
      probability: 60,
      source: 'MANUAL',
      activity: null,
      by: ama,
      ...change,
    };

    return [
      row.deal,
      row.valueMinor,
      row.currency,
      row.probability,
      row.source,
      row.activity,
      row.by,
    ];
  }

  beforeEach(async () => {
    const client = await aClient(ama);
    deal = (
      await admin.query<{ id: string }>(
        `INSERT INTO clients_opportunity (client_id, product_id, owner_id)
         SELECT $1, id, $2 FROM clients_product WHERE name = 'CreditStudio' RETURNING id`,
        [client, ama],
      )
    ).rows[0].id;
  });

  it('records the figures as they stood, who changed them and when', async () => {
    const { rows } = await admin.query(
      `${CHANGE.replace('RETURNING id', '')}
       RETURNING opportunity_id, value_minor, currency, probability, source, changed_by,
                 changed_at`,
      aChange(),
    );

    expect(rows[0]).toMatchObject({
      opportunity_id: deal,
      value_minor: '7560000',
      currency: 'USD',
      probability: 60,
      source: 'MANUAL',
      changed_by: ama,
    });
    expect(rows[0].changed_at).toBeInstanceOf(Date);
  });

  it('is of a deal that exists, changed by somebody who does', async () => {
    expect(await refusedBy(CHANGE, aChange({ deal: '987654321' }))).toBe(
      'clients_value_change_opportunity_id_fkey',
    );
    expect(await refusedBy(CHANGE, aChange({ by: null }))).toMatch(/changed_by/);
  });

  /* What was missing then is missing in the row too. */
  it('holds no more than the deal itself could have held', async () => {
    expect(
      await refusedBy(CHANGE, aChange({ valueMinor: null, currency: null, probability: null })),
    ).toBeNull();
    expect(await refusedBy(CHANGE, aChange({ currency: null }))).toBe(
      'clients_value_change_value_pair',
    );
    expect(await refusedBy(CHANGE, aChange({ currency: 'EUR' }))).toBe(
      'clients_value_change_currency_known',
    );
    expect(await refusedBy(CHANGE, aChange({ valueMinor: -1 }))).toBe(
      'clients_value_change_value_not_negative',
    );
    expect(await refusedBy(CHANGE, aChange({ probability: 101 }))).toBe(
      'clients_value_change_probability_a_percentage',
    );
  });

  it('says what changed them, and a proposal names the activity that sent it', async () => {
    for (const source of ['MANUAL', 'CONVERSION', 'IMPORT']) {
      expect(await refusedBy(CHANGE, aChange({ source }))).toBeNull();
    }
    expect(await refusedBy(CHANGE, aChange({ source: 'GUESS' }))).toBe(
      'clients_value_change_source_known',
    );
    expect(await refusedBy(CHANGE, aChange({ source: 'PROPOSAL' }))).toBe(
      'clients_value_change_proposal_names_it',
    );
    expect(await refusedBy(CHANGE, aChange({ source: 'PROPOSAL', activity: '7' }))).toBeNull();
    expect(await refusedBy(CHANGE, aChange({ activity: '7' }))).toBe(
      'clients_value_change_proposal_names_it',
    );
  });

  /* NFR CLI REC 01. Whoever writes: these run as the owner, which privileges alone would let. */
  it('is never changed or deleted once written', async () => {
    const { rows } = await admin.query<{ id: string }>(CHANGE, aChange());

    for (const statement of [
      'UPDATE clients_value_change SET probability = 90 WHERE id = $1',
      'DELETE FROM clients_value_change WHERE id = $1',
    ]) {
      await admin.query('SAVEPOINT attempt');
      await expect(admin.query(statement, [rows[0].id])).rejects.toThrow(
        /clients_value_change are never (changed once written|deleted)/,
      );
      await admin.query('ROLLBACK TO SAVEPOINT attempt');
    }
  });

  /* NFR CLI AUD 02: its own record, not a second copy in the audit log. */
  it('is not written to the audit log', async () => {
    await admin.query(CHANGE, aChange());

    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE entity = 'clients_value_change'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('is found by deal, in the order it happened', async () => {
    const { rows } = await admin.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_clients_value_change_deal'`,
    );

    expect(rows[0]?.indexdef).toMatch(/USING btree \(opportunity_id, changed_at\)/);
  });
});

/* ---------------------------------------------------------- what lms_app may do */

describe('the application role', () => {
  it('deletes nothing in clients', async () => {
    const { rows } = await admin.query<{ table: string }>(
      `SELECT t AS table FROM unnest($1::text[]) AS t
        WHERE has_table_privilege('lms_app', t, 'DELETE')
           OR has_table_privilege('lms_app', t, 'TRUNCATE')`,
      [TABLES],
    );

    expect(rows).toEqual([]);
  });

  it('reads and appends to every table', async () => {
    const { rows } = await admin.query<{ table: string }>(
      `SELECT t AS table FROM unnest($1::text[]) AS t
        WHERE NOT has_table_privilege('lms_app', t, 'SELECT')
           OR NOT has_table_privilege('lms_app', t, 'INSERT')`,
      [TABLES],
    );

    expect(rows).toEqual([]);
  });

  /* A grant is ended and nothing else; a line or product is renamed and retired, and a product
     never changes line; a client keeps when it was created. No table may be updated whole. */
  it('changes only the columns each table is meant to change', async () => {
    const { rows } = await admin.query<{ table: string }>(
      `SELECT t AS table FROM unnest($1::text[]) AS t
        WHERE has_table_privilege('lms_app', t, 'UPDATE')`,
      [TABLES],
    );
    expect(rows).toEqual([]);

    const columns = await admin.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.column_privileges
        WHERE grantee = 'lms_app' AND privilege_type = 'UPDATE' AND table_name = ANY($1)
        ORDER BY table_name, column_name`,
      [TABLES],
    );
    expect(columns.rows).toEqual([
      { table_name: 'clients_client', column_name: 'name' },
      { table_name: 'clients_client', column_name: 'note' },
      { table_name: 'clients_client', column_name: 'owner_id' },
      { table_name: 'clients_client', column_name: 'type_id' },
      { table_name: 'clients_client_product', column_name: 'ended_on' },
      { table_name: 'clients_client_product', column_name: 'since_on' },
      { table_name: 'clients_client_type', column_name: 'name' },
      { table_name: 'clients_client_type', column_name: 'retired_on' },
      { table_name: 'clients_contact', column_name: 'email' },
      { table_name: 'clients_contact', column_name: 'job_title' },
      { table_name: 'clients_contact', column_name: 'name' },
      { table_name: 'clients_contact', column_name: 'phone' },
      { table_name: 'clients_contact', column_name: 'removed_at' },
      /* #277, CLI 13. A deal's figures and words; never its client, product or outcome. */
      { table_name: 'clients_opportunity', column_name: 'close_half' },
      { table_name: 'clients_opportunity', column_name: 'close_year' },
      { table_name: 'clients_opportunity', column_name: 'currency' },
      { table_name: 'clients_opportunity', column_name: 'probability' },
      { table_name: 'clients_opportunity', column_name: 'stated_interest' },
      { table_name: 'clients_opportunity', column_name: 'value_minor' },
      { table_name: 'clients_opportunity', column_name: 'waiting_note' },
      { table_name: 'clients_opportunity', column_name: 'waiting_on' },
      { table_name: 'clients_product', column_name: 'name' },
      { table_name: 'clients_product', column_name: 'retired_on' },
      { table_name: 'clients_product_line', column_name: 'name' },
      { table_name: 'clients_product_line', column_name: 'retired_on' },
      { table_name: 'clients_role', column_name: 'ended_at' },
      { table_name: 'clients_role', column_name: 'ended_by' },
      { table_name: 'clients_role', column_name: 'ended_reason' },
    ]);
  });
});
