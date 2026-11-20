import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { seed } from '../../seeds/seed.mjs';
import { intoItsPocWithin } from '../support/clients-poc.js';

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
  'clients_stage_change',
  'clients_client_note',
  'clients_reason',
  'clients_next_step',
  'clients_activity',
  'clients_document',
  'clients_poc',
  'clients_poc_health',
  'clients_poc_action',
  'clients_poc_usage',
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

/** An open CreditStudio deal for `client`, owned by `owner`. */
async function aDeal(client: string, owner: string): Promise<string> {
  return (
    await admin.query<{ id: string }>(
      `INSERT INTO clients_opportunity (client_id, product_id, owner_id)
       SELECT $1, id, $2 FROM clients_product WHERE name = 'CreditStudio' RETURNING id`,
      [client, owner],
    )
  ).rows[0].id;
}

/** A POC for the client and line of `deal`, run by its owner, started today (#285). */
async function aPocFor(deal: string): Promise<string> {
  return (
    await admin.query<{ id: string }>(
      `INSERT INTO clients_poc
              (client_id, line_id, client_type_id, cs_lead_id, started_on, decision_on, created_by)
       SELECT o.client_id, p.line_id, c.type_id, o.owner_id, CURRENT_DATE, CURRENT_DATE + 70,
              o.owner_id
         FROM clients_opportunity o
         JOIN clients_product p ON p.id = o.product_id
         JOIN clients_client c ON c.id = o.client_id
        WHERE o.id = $1
       RETURNING id`,
      [deal],
    )
  ).rows[0].id;
}

/** A call with `client` yesterday, logged just now by `by`. */
async function anActivity(client: string, by: string): Promise<string> {
  return (
    await admin.query<{ id: string }>(
      `INSERT INTO clients_activity (client_id, kind, happened_on, logged_by)
       VALUES ($1, 'CALL', CURRENT_DATE - 1, $2) RETURNING id`,
      [client, by],
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
  const CLIENT = `INSERT INTO clients_client (name, type_id, owner_id)
                  VALUES ($1, $2, $3) RETURNING id`;

  let bank: string;

  beforeEach(async () => {
    bank = (
      await admin.query<{ id: string }>(`SELECT id FROM clients_client_type WHERE name = 'Bank'`)
    ).rows[0].id;
  });

  /* Its notes are a table of their own since #278: see "a note on a client". */
  it('records its name, type and owner, and when it was created', async () => {
    const { rows } = await admin.query(
      `INSERT INTO clients_client (name, type_id, owner_id)
       VALUES ('Testbank', $1, $2)
       RETURNING name, type_id, owner_id, created_at`,
      [bank, ama],
    );

    expect(rows[0]).toMatchObject({ name: 'Testbank', type_id: bank, owner_id: ama });
    expect(rows[0].created_at).toBeInstanceOf(Date);
  });

  it('is of a type that exists', async () => {
    expect(await refusedBy(CLIENT, ['Testbank', null, ama])).toMatch(/type_id/);
    expect(await refusedBy(CLIENT, ['Testbank', '987654321', ama])).toBe(
      'clients_client_type_id_fkey',
    );
  });

  it('may be of a type added since', async () => {
    const insurer = (
      await admin.query<{ id: string }>(
        `INSERT INTO clients_client_type (name) VALUES ('Insurer') RETURNING id`,
      )
    ).rows[0].id;

    expect(await refusedBy(CLIENT, ['Testinsurer', insurer, ama])).toBeNull();
  });

  /* CLI 02. Done when: creating a duplicate client name is refused. */
  it('is recorded once, whatever the case or spacing of its name', async () => {
    expect(await refusedBy(CLIENT, ['Agricultural Development Bank', bank, ama])).toBeNull();

    for (const same of [
      'agricultural development bank',
      '  AGRICULTURAL DEVELOPMENT BANK ',
      'Agricultural  Development   Bank',
      'Agricultural\tDevelopment\nBank',
    ]) {
      expect(await refusedBy(CLIENT, [same, bank, kofi])).toBe('uq_clients_client_name');
    }

    /* Another name altogether, which merely contains the first, is another client. */
    expect(await refusedBy(CLIENT, ['Agricultural Development Bank Ghana', bank, ama])).toBeNull();
  });

  it('is refused the name of another client when renamed into it', async () => {
    await admin.query(CLIENT, ['ADB', bank, ama]);
    const { rows } = await admin.query<{ id: string }>(CLIENT, ['Ecobank', bank, ama]);

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
    expect(await refusedBy(CLIENT, ['  ', bank, ama])).toBe('clients_client_named');
    expect(await refusedBy(CLIENT, ['\t\n', bank, ama])).toBe('clients_client_named');
    expect(await refusedBy(CLIENT, ['Testbank', bank, null])).toMatch(/owner_id/);
    expect(await refusedBy(CLIENT, ['Testbank', bank, '987654321'])).toBe(
      'clients_client_owner_id_fkey',
    );
  });

  it('is written to the audit log by the database, with who did it', async () => {
    await admin.query(
      `SELECT set_config('lms.audit.actor', 'employee 7', true),
              set_config('lms.audit.actor_employee_id', $1, true)`,
      [ama],
    );
    const { rows } = await admin.query<{ id: string }>(CLIENT, ['Testbank', bank, ama]);
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
        `UPDATE clients_opportunity SET outcome = 'LOST', ended_on = CURRENT_DATE,
                reason_id = (SELECT min(id) FROM clients_reason WHERE applies_to = 'LOST')
          WHERE client_id = $1 AND outcome = 'OPEN'`,
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

  /** Ends a deal as `outcome` says, by the shortest way the ladder allows (#278). */
  async function endAs(id: string, outcome: string): Promise<string | null> {
    if (outcome === 'WON') {
      await admin.query(
        `UPDATE clients_opportunity SET has_poc = false, stage = 'CONTRACT_SIGNED' WHERE id = $1`,
        [id],
      );

      return refusedBy(
        `UPDATE clients_opportunity SET stage = 'LIVE', outcome = 'WON', ended_on = CURRENT_DATE
          WHERE id = $1`,
        [id],
      );
    }

    /* #279. Exited only from a started POC, with a reason and which products it ran on. */
    if (outcome === 'EXITED') {
      await intoItsPocWithin(admin, id);

      return refusedBy(
        `UPDATE clients_opportunity SET outcome = 'EXITED', ended_on = CURRENT_DATE,
                reason_id = (SELECT min(id) FROM clients_reason WHERE applies_to = 'EXITED'),
                end_note = 'Ran on CreditStudio'
          WHERE id = $1`,
        [id],
      );
    }

    /* #279. Lost, with a reason from the lost list; anything else is refused as it would be. */
    return refusedBy(
      `UPDATE clients_opportunity SET outcome = $2::text, ended_on = CURRENT_DATE,
              reason_id = CASE WHEN $2::text = 'LOST'
                               THEN (SELECT min(id) FROM clients_reason WHERE applies_to = 'LOST')
                          END
        WHERE id = $1`,
      [id, outcome],
    );
  }

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

      expect(await endAs(rows[0].id, outcome)).toBeNull();
    }

    const { rows } = await admin.query<{ id: string }>(DEAL, aDeal());
    expect(
      await refusedBy(
        `UPDATE clients_opportunity SET outcome = 'PAUSED', ended_on = CURRENT_DATE WHERE id = $1`,
        [rows[0].id],
      ),
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
      expect(await endAs(rows[0].id, outcome)).toBeNull();
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
    expect(await endAs(rows[0].id, 'LOST')).toBeNull();

    for (const change of [
      `outcome = 'OPEN', ended_on = NULL`,
      `stage = 'QUALIFICATION'`,
      'has_poc = true',
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
      /* #279. Deals ended for a reason, which the reports count and a reason's use is told by. */
      expect.stringMatching(/USING btree \(reason_id\) WHERE \(reason_id IS NOT NULL\)/),
      /* #278. Open deals at each stage, which the pipeline counts. */
      expect.stringMatching(/USING btree \(stage\) WHERE \(\(outcome\)::text = 'OPEN'/),
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

  /* The financials, which #281 put where TDD 4.2's proposal was, name the activity that sent
     them; clients-proposals-api.test.ts writes one that does. */
  it('says what changed them, and the financials name the activity that sent them', async () => {
    for (const source of ['MANUAL', 'CONVERSION', 'IMPORT']) {
      expect(await refusedBy(CHANGE, aChange({ source }))).toBeNull();
    }
    for (const source of ['GUESS', 'PROPOSAL']) {
      expect(await refusedBy(CHANGE, aChange({ source }))).toBe(
        'clients_value_change_source_known',
      );
    }
    expect(await refusedBy(CHANGE, aChange({ source: 'FINANCIALS' }))).toBe(
      'clients_value_change_financials_name_them',
    );
    expect(await refusedBy(CHANGE, aChange({ activity: '7' }))).toBe(
      'clients_value_change_financials_name_them',
    );
    expect(await refusedBy(CHANGE, aChange({ source: 'FINANCIALS', activity: '7' }))).toBe(
      'clients_value_change_from_an_activity',
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

/* ------------------------------------------------------ a deal's stage, #278 */

/* The ladder, held by the database whoever writes (TDD 4.2, "the constraints are the ladder").
   Every refusal here is written to the row directly, as the issue's last task asks: the service
   says no first, and these say no to whatever gets past it. */
describe('a deal on the ladder', () => {
  let deal: string;

  /** Sets columns on the deal, and says what refused it, or null. */
  function set(assignments: string): Promise<string | null> {
    return refusedBy(`UPDATE clients_opportunity SET ${assignments} WHERE id = $1`, [deal]);
  }

  /** The deal's stage, outcome, POC answer and end, as they now stand. */
  async function standing() {
    const { rows } = await admin.query<{
      stage: string;
      outcome: string;
      has_poc: boolean | null;
      ended_on: string | null;
    }>('SELECT stage, outcome, has_poc, ended_on::text FROM clients_opportunity WHERE id = $1', [
      deal,
    ]);

    return rows[0];
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

  /* CLI 12, CLI 19. */
  it('starts at Discovery, open, with the POC question unanswered', async () => {
    expect(await standing()).toEqual({
      stage: 'DISCOVERY',
      outcome: 'OPEN',
      has_poc: null,
      ended_on: null,
    });
  });

  /* CLI 12. Whoever writes, the import included: it opens each deal and then moves it. */
  it('cannot be opened anywhere but Discovery, open', async () => {
    const OPEN_AT = `INSERT INTO clients_opportunity (client_id, product_id, owner_id, stage, has_poc)
                     SELECT $1, id, $2, $3, false FROM clients_product WHERE name = 'Cloud9'`;
    const client = await aClient(kofi, 'Ecobank');

    expect(await refusedBy(OPEN_AT, [client, kofi, 'PROPOSAL'])).toBe(
      'clients_opportunity_starts_at_discovery',
    );
    expect(
      await refusedBy(
        `INSERT INTO clients_opportunity (client_id, product_id, owner_id, outcome, ended_on)
         SELECT $1, id, $2, 'LOST', CURRENT_DATE FROM clients_product WHERE name = 'Cloud9'`,
        [client, kofi],
      ),
    ).toBe('clients_opportunity_starts_at_discovery');
    expect(await refusedBy(OPEN_AT, [client, kofi, 'DISCOVERY'])).toBeNull();
  });

  /* CLI 18. Fixed, and not data. */
  it('is at one of the seven stages', async () => {
    expect(await set(`stage = 'PILOT', has_poc = false`)).toBe('clients_opportunity_stage_known');
  });

  /* CLI 20, CLI 21. Forward by one or several; back before Contract signed. The note a move back
     needs is the stage history's to hold, below. */
  it('moves forward one stage or several, and back before Contract signed', async () => {
    expect(await set(`stage = 'QUALIFICATION'`)).toBeNull();
    expect(await set(`stage = 'NEGOTIATION'`)).toBeNull();
    expect(await set(`stage = 'PROPOSAL'`)).toBeNull();
    expect(await set(`stage = 'DISCOVERY'`)).toBeNull();
    expect((await standing()).stage).toBe('DISCOVERY');
  });

  /* CLI 19, TDD's opp_poc_decided, HAS_POC_REQUIRED. */
  it('needs the POC question answered before Contract signed', async () => {
    expect(await set(`stage = 'CONTRACT_SIGNED'`)).toBe('clients_opportunity_poc_decided');
    expect(await set(`stage = 'CONTRACT_SIGNED', has_poc = false`)).toBeNull();
  });

  /* CLI 19, HAS_POC_FIXED. Changed as often as it needs to be until then, unanswered again
     included. */
  it('settles the POC question once the contract is signed', async () => {
    for (const answer of ['true', 'false', 'NULL', 'true']) {
      expect(await set(`has_poc = ${answer}`)).toBeNull();
    }
    expect(await set(`stage = 'CONTRACT_SIGNED'`)).toBeNull();

    expect(await set('has_poc = false')).toBe('clients_opportunity_poc_decision_fixed');
    expect(await set('has_poc = NULL')).toBe('clients_opportunity_poc_decision_fixed');
    /* Setting it to what it is already is no change. */
    expect(await set('has_poc = true')).toBeNull();
  });

  /* CLI 21, NO_BACKWARD, AC L06. */
  it('never moves back from Contract signed onward', async () => {
    expect(await set(`stage = 'CONTRACT_SIGNED', has_poc = true`)).toBeNull();

    for (const back of ['NEGOTIATION', 'PROPOSAL', 'DISCOVERY']) {
      expect(await set(`stage = '${back}'`)).toBe('clients_opportunity_no_way_back');
    }

    expect(await set(`stage = 'POC', poc_id = ${await aPocFor(deal)}`)).toBeNull();
    expect(await set(`stage = 'CONTRACT_SIGNED'`)).toBe('clients_opportunity_no_way_back');
  });

  /* CLI 24, CLI 25, AC L04. Done when: a deal without a POC goes from Discovery to Live and
     shows as won. */
  it('with no POC, goes from Contract signed to Live, and is won on the day', async () => {
    expect(await set(`stage = 'CONTRACT_SIGNED', has_poc = false`)).toBeNull();
    expect(await set(`stage = 'LIVE', outcome = 'WON', ended_on = '2026-11-11'`)).toBeNull();

    expect(await standing()).toEqual({
      stage: 'LIVE',
      outcome: 'WON',
      has_poc: false,
      ended_on: '2026-11-11',
    });
  });

  /* CLI 25, TDD's opp_won_is_live. A signed contract is not a win. */
  it('is won at Live and nowhere else, and Live is always won', async () => {
    expect(await set(`stage = 'CONTRACT_SIGNED', has_poc = false`)).toBeNull();

    expect(await set(`outcome = 'WON', ended_on = CURRENT_DATE`)).toBe(
      'clients_opportunity_won_is_live',
    );
    expect(await set(`stage = 'LIVE'`)).toBe('clients_opportunity_won_is_live');
    /* #279. Lost at Live is refused by TDD's opp_lost_shape too, which is checked first. */
    expect(
      await set(
        `stage = 'LIVE', outcome = 'LOST', ended_on = CURRENT_DATE,
         reason_id = (SELECT min(id) FROM clients_reason WHERE applies_to = 'LOST')`,
      ),
    ).toBe('clients_opportunity_lost_shape');
  });

  /* CLI 24. Live comes after the contract is signed, never before it. */
  it('never goes live from before Contract signed', async () => {
    expect(await set(`stage = 'NEGOTIATION', has_poc = false`)).toBeNull();

    expect(await set(`stage = 'LIVE', outcome = 'WON', ended_on = CURRENT_DATE`)).toBe(
      'clients_opportunity_live_after_signing',
    );
  });

  /* CLI 24, AC L05, POC_DECIDES. Done when: moving a POC deal to Live by hand is refused. A deal
     with a POC never skips it. */
  it('with a POC, goes live only from its POC', async () => {
    expect(await set(`stage = 'CONTRACT_SIGNED', has_poc = true`)).toBeNull();

    expect(await set(`stage = 'LIVE', outcome = 'WON', ended_on = CURRENT_DATE`)).toBe(
      'clients_opportunity_live_after_signing',
    );

    expect(await set(`stage = 'POC', poc_id = ${await aPocFor(deal)}`)).toBeNull();
    expect(await set(`stage = 'LIVE', outcome = 'WON', ended_on = CURRENT_DATE`)).toBeNull();
  });

  /* TDD 5, step 5, and half of TDD's opp_poc_stage. Only a deal with a POC is ever in one, and it
     enters it from Contract signed. */
  it('enters POC from Contract signed, and only with a POC', async () => {
    expect(await set(`stage = 'NEGOTIATION', has_poc = true`)).toBeNull();
    expect(await set(`stage = 'POC'`)).toBe('clients_opportunity_poc_after_signing');

    expect(await set(`has_poc = false, stage = 'CONTRACT_SIGNED'`)).toBeNull();
    expect(await set(`stage = 'POC'`)).toBe('clients_opportunity_poc_stage_has_poc');
  });

  /* CLI 25, TDD's opp_ended_shape. */
  it('says when it ended, and an open one has not', async () => {
    expect(await set(`outcome = 'LOST'`)).toBe('clients_opportunity_ended_shape');
    expect(await set('ended_on = CURRENT_DATE')).toBe('clients_opportunity_ended_shape');
    expect(
      await set(
        `outcome = 'LOST', ended_on = CURRENT_DATE,
         reason_id = (SELECT min(id) FROM clients_reason WHERE applies_to = 'LOST')`,
      ),
    ).toBeNull();
  });
});

/* --------------------------------------------------- ending without winning, #279 */

describe('a deal that ends without winning', () => {
  let deal: string;
  let lostFor: Record<string, string>;
  let exitedFor: Record<string, string>;

  function set(assignments: string): Promise<string | null> {
    return refusedBy(`UPDATE clients_opportunity SET ${assignments} WHERE id = $1`, [deal]);
  }

  /** Ends the deal as lost, for a reason, with whatever else is given. */
  function loseFor(reasonId: string | null, more = ''): Promise<string | null> {
    return refusedBy(
      `UPDATE clients_opportunity
          SET outcome = 'LOST', ended_on = CURRENT_DATE, reason_id = $2 ${more}
        WHERE id = $1`,
      [deal, reasonId],
    );
  }

  function exitFor(reasonId: string | null, note: string | null): Promise<string | null> {
    return refusedBy(
      `UPDATE clients_opportunity
          SET outcome = 'EXITED', ended_on = CURRENT_DATE, reason_id = $2, end_note = $3
        WHERE id = $1`,
      [deal, reasonId, note],
    );
  }

  async function intoItsPoc(): Promise<void> {
    await intoItsPocWithin(admin, deal);
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

    const { rows } = await admin.query<{ id: string; applies_to: string; label: string }>(
      'SELECT id, applies_to, label FROM clients_reason',
    );
    lostFor = Object.fromEntries(
      rows.filter((row) => row.applies_to === 'LOST').map((row) => [row.label, row.id]),
    );
    exitedFor = Object.fromEntries(
      rows.filter((row) => row.applies_to === 'EXITED').map((row) => [row.label, row.id]),
    );
  });

  /* CLI 54, TDD 14. A starter set on each list, for the BD manager to edit. */
  it('has a starter set of reasons on each list', () => {
    expect(Object.keys(lostFor)).toContain('Chose a competitor');
    expect(Object.keys(exitedFor)).toContain('Client withdrew');
  });

  /* CLI 51, TDD's opp_lost_shape, REASON_REQUIRED. */
  it('is lost only with a reason, and a note if one is given', async () => {
    expect(await loseFor(null)).toBe('clients_opportunity_lost_shape');
    expect(await loseFor(lostFor.Price, `, end_note = '  '`)).toBe(
      'clients_opportunity_end_note_not_blank',
    );
    expect(await loseFor(lostFor.Price, `, end_note = 'Went with the incumbent'`)).toBeNull();
  });

  /* CLI 51. Any time before its POC starts, Contract signed with a POC included. */
  it('is lost before its POC starts, and not after', async () => {
    await intoItsPoc();

    expect(await loseFor(lostFor.Price)).toBe('clients_opportunity_lost_shape');
  });

  /* Signing starts the POC (#285), so a deal with one is never lost at Contract signed, even
     signed and lost in one go; one with no POC is. */
  it('is lost from Contract signed only where there is no POC', async () => {
    expect(await set(`has_poc = false, stage = 'CONTRACT_SIGNED'`)).toBeNull();
    expect(await loseFor(lostFor.Price)).toBeNull();
  });

  it('is not lost from Contract signed with a POC, which signing started', async () => {
    expect(await set(`has_poc = true, stage = 'CONTRACT_SIGNED'`)).toBeNull();
    expect(await loseFor(lostFor.Price)).toBeNull();

    expect(
      await refusedBy('SET CONSTRAINTS clients_opportunity_signing_starts_its_poc IMMEDIATE'),
    ).toBe('clients_opportunity_signing_starts_its_poc');
  });

  /* CLI 52, TDD's opp_exit_shape. Only from a started POC, with a reason and which products. */
  it('is exited only from a started POC, with a reason and which products it ran on', async () => {
    expect(await exitFor(exitedFor['Client withdrew'], 'Ran on CreditStudio')).toBe(
      'clients_opportunity_exit_shape',
    );

    await intoItsPoc();
    expect(await exitFor(null, 'Ran on CreditStudio')).toBe('clients_opportunity_exit_shape');
    expect(await exitFor(exitedFor['Client withdrew'], null)).toBe(
      'clients_opportunity_exit_shape',
    );
    expect(await exitFor(exitedFor['Client withdrew'], 'Ran on CreditStudio')).toBeNull();
  });

  /* CLI 51, CLI 52. A lost deal takes a lost reason, an exited one an exit reason. */
  it('takes a reason from the list for how it ended', async () => {
    expect(await loseFor(exitedFor['Client withdrew'])).toBe(
      'clients_opportunity_reason_from_its_list',
    );

    await intoItsPoc();
    expect(await exitFor(lostFor.Price, 'Ran on CreditStudio')).toBe(
      'clients_opportunity_reason_from_its_list',
    );
  });

  /* CLI 54. Retired is given to no new deal, and kept by those that ended for it. */
  it('takes no retired reason, and keeps one retired after it ended', async () => {
    await admin.query(`UPDATE clients_reason SET retired_on = CURRENT_DATE WHERE id = $1`, [
      lostFor.Price,
    ]);
    expect(await loseFor(lostFor.Price)).toBe('clients_opportunity_reason_in_use');

    expect(await loseFor(lostFor['No budget'])).toBeNull();
    await admin.query(`UPDATE clients_reason SET retired_on = CURRENT_DATE WHERE id = $1`, [
      lostFor['No budget'],
    ]);
    const { rows } = await admin.query<{ reason_id: string }>(
      'SELECT reason_id FROM clients_opportunity WHERE id = $1',
      [deal],
    );
    expect(rows[0].reason_id).toBe(lostFor['No budget']);
  });

  /* A reason and a closing note belong only to a deal that ended without winning. */
  it('has no reason or closing note while open, or once won', async () => {
    expect(await set(`reason_id = ${lostFor.Price}`)).toBe(
      'clients_opportunity_reason_only_when_ended',
    );
    expect(await set(`end_note = 'Early days'`)).toBe(
      'clients_opportunity_end_note_only_when_ended',
    );

    expect(await set(`has_poc = false, stage = 'CONTRACT_SIGNED'`)).toBeNull();
    expect(
      await set(`stage = 'LIVE', outcome = 'WON', ended_on = CURRENT_DATE, end_note = 'Signed up'`),
    ).toBe('clients_opportunity_end_note_only_when_ended');
  });

  /* CLI 55. Kept as it ended: its reason and note included. */
  it('keeps its reason and note as they were', async () => {
    expect(await loseFor(lostFor.Price, `, end_note = 'Too dear'`)).toBeNull();

    expect(await set(`reason_id = ${lostFor['Not a fit']}`)).toBe(
      'clients_opportunity_ended_is_fixed',
    );
    expect(await set(`end_note = 'Something else'`)).toBe('clients_opportunity_ended_is_fixed');
  });

  /* The history holds no ending the deal itself could not have had. */
  it('is in the history only as it could have happened', async () => {
    const ENDING = `INSERT INTO clients_stage_change
                      (opportunity_id, from_stage, to_stage, to_outcome, changed_by)
                    VALUES ($1, $2, $2, $3, $4)`;

    expect(await refusedBy(ENDING, [deal, 'POC', 'LOST', ama])).toBe(
      'clients_stage_change_lost_before_poc',
    );
    expect(await refusedBy(ENDING, [deal, 'NEGOTIATION', 'EXITED', ama])).toBe(
      'clients_stage_change_exited_from_poc',
    );
    expect(await refusedBy(ENDING, [deal, 'NEGOTIATION', 'LOST', ama])).toBeNull();
    expect(await refusedBy(ENDING, [deal, 'POC', 'EXITED', ama])).toBeNull();
  });
});

/* ------------------------------------------------------------- the reason lists, #279 */

describe('a lost or exit reason', () => {
  /** Ends a new deal lost for this reason, so that a deal names it. */
  async function lostFor(reasonId: string): Promise<void> {
    const client = await aClient(ama, `Bank ${reasonId}`);
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO clients_opportunity (client_id, product_id, owner_id)
       SELECT $1, id, $2 FROM clients_product WHERE name = 'CreditStudio' RETURNING id`,
      [client, ama],
    );
    await admin.query(
      `UPDATE clients_opportunity SET outcome = 'LOST', ended_on = CURRENT_DATE, reason_id = $2
        WHERE id = $1`,
      [rows[0].id, reasonId],
    );
  }

  /* CLI 54, #279. In use, it is kept as it was: not reworded, not deleted. Retired, yes. */
  it('is kept as it was once a deal has ended for it, and may still be retired', async () => {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO clients_reason (applies_to, label) VALUES ('LOST', 'Board said no') RETURNING id`,
    );
    const id = rows[0].id;
    await lostFor(id);

    expect(
      await refusedBy(`UPDATE clients_reason SET label = 'Board said not yet' WHERE id = $1`, [id]),
    ).toBe('clients_reason_words_kept_once_used');
    expect(await refusedBy('DELETE FROM clients_reason WHERE id = $1', [id])).toBe(
      'clients_opportunity_reason_id_fkey',
    );
    expect(
      await refusedBy('UPDATE clients_reason SET retired_on = CURRENT_DATE WHERE id = $1', [id]),
    ).toBeNull();
    expect(
      await refusedBy('UPDATE clients_reason SET retired_on = NULL WHERE id = $1', [id]),
    ).toBeNull();
  });

  /* #279. Unused, it may be reworded and deleted: a typo just added, say. */
  it('may be reworded and deleted while no deal has ended for it', async () => {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO clients_reason (applies_to, label) VALUES ('LOST', 'Bord said no') RETURNING id`,
    );

    expect(
      await refusedBy(`UPDATE clients_reason SET label = 'Board said no' WHERE id = $1`, [
        rows[0].id,
      ]),
    ).toBeNull();
    expect(await refusedBy('DELETE FROM clients_reason WHERE id = $1', [rows[0].id])).toBeNull();
  });

  const REASON = 'INSERT INTO clients_reason (applies_to, label) VALUES ($1, $2) RETURNING id';

  /* CLI 54. */
  it('is on one of the two lists, and says something', async () => {
    expect(await refusedBy(REASON, ['PAUSED', 'Board said no'])).toBe(
      'clients_reason_applies_to_known',
    );
    expect(await refusedBy(REASON, ['LOST', '  '])).toBe('clients_reason_labelled');
    expect(await refusedBy(REASON, ['LOST', 'Board said no'])).toBeNull();
  });

  it('is named once on its list, ignoring case and spaces, and may be on both', async () => {
    expect(await refusedBy(REASON, ['LOST', ' price '])).toBe('uq_clients_reason_label');
    expect(await refusedBy(REASON, ['EXITED', 'Price'])).toBeNull();
  });

  /* NFR CLI AUD 01. */
  it('is audited', async () => {
    const { rows } = await admin.query<{ id: string }>(REASON, ['LOST', 'Board said no']);
    await admin.query(`UPDATE clients_reason SET retired_on = CURRENT_DATE WHERE id = $1`, [
      rows[0].id,
    ]);

    const audit = await admin.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity = 'clients_reason' AND entity_id = $1
        ORDER BY id`,
      [rows[0].id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(['CREATE', 'UPDATE']);
  });
});

/* -------------------------------------------------------------- an activity, #280 */

describe('an activity', () => {
  const ACTIVITY = `INSERT INTO clients_activity
                      (client_id, opportunity_id, kind, happened_on, with_whom, outcome, logged_by)
                    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`;
  let client: string;
  let deal: string;

  /** An activity's values, with `change` over the top. */
  function anActivityOf(change: Partial<Record<string, unknown>> = {}): unknown[] {
    const activity = {
      client,
      deal,
      kind: 'MEETING',
      happenedOn: '2026-11-12',
      withWhom: 'Ama Owusu (CCO) and their IT lead',
      outcome: 'Wants the archive shown to compliance before the proposal',
      by: kofi,
      ...change,
    };

    return [
      activity.client,
      activity.deal,
      activity.kind,
      activity.happenedOn,
      activity.withWhom,
      activity.outcome,
      activity.by,
    ];
  }

  /** An activity logged `hoursAgo` hours ago. Only a migration or a test can backdate one. */
  async function loggedHoursAgo(hoursAgo: number): Promise<string> {
    return (
      await admin.query<{ id: string }>(
        `INSERT INTO clients_activity (client_id, kind, happened_on, logged_by, logged_at)
         VALUES ($1, 'CALL', CURRENT_DATE - 2, $2, now() - make_interval(hours => $3))
         RETURNING id`,
        [client, kofi, hoursAgo],
      )
    ).rows[0].id;
  }

  beforeEach(async () => {
    client = await aClient(ama);
    deal = await aDeal(client, ama);
  });

  /* CLI 58, TDD 4.5. */
  it('records what, when, with whom, what came of it, about which deal, and who logged it', async () => {
    const { rows } = await admin.query(
      `${ACTIVITY.replace('RETURNING id', '')}
       RETURNING client_id, opportunity_id, kind, happened_on::text, with_whom, outcome,
                 logged_by, logged_at`,
      anActivityOf(),
    );

    expect(rows[0]).toMatchObject({
      client_id: client,
      opportunity_id: deal,
      kind: 'MEETING',
      happened_on: '2026-11-12',
      with_whom: 'Ama Owusu (CCO) and their IT lead',
      outcome: 'Wants the archive shown to compliance before the proposal',
      logged_by: kofi,
    });
    expect(rows[0].logged_at).toBeInstanceOf(Date);
  });

  /* CLI 59. A review comes with the POC (#285). The financials also need their amount, which
     clients-proposals-api.test.ts holds the table to (#281). */
  it('is a call, a meeting, a demo, a proposal, the financials, a review or a note', async () => {
    for (const kind of ['CALL', 'MEETING', 'DEMO', 'PROPOSAL', 'NOTE']) {
      expect(await refusedBy(ACTIVITY, anActivityOf({ kind }))).toBeNull();
    }
    /* A known kind, refused here only for saying nothing of the amount. */
    expect(await refusedBy(ACTIVITY, anActivityOf({ kind: 'FINANCIALS' }))).toBe(
      'clients_activity_financials_say_what_and_for_which_deal',
    );
    /* #285. A known kind, refused here only for saying nothing of which review it was. */
    expect(await refusedBy(ACTIVITY, anActivityOf({ kind: 'REVIEW' }))).toBe(
      'clients_activity_review_says_which_and_who_came',
    );
    expect(await refusedBy(ACTIVITY, anActivityOf({ kind: 'EMAIL' }))).toBe(
      'clients_activity_kind_known',
    );
  });

  /* CLI 58: the client, and only optionally the deal, who it was with and what came of it. */
  it("needs only its kind, its day and its client, and says nothing it doesn't mean", async () => {
    expect(
      await refusedBy(ACTIVITY, anActivityOf({ deal: null, withWhom: null, outcome: null })),
    ).toBeNull();
    expect(await refusedBy(ACTIVITY, anActivityOf({ happenedOn: null }))).toMatch(/happened_on/);
    expect(await refusedBy(ACTIVITY, anActivityOf({ withWhom: ' ' }))).toBe(
      'clients_activity_with_whom_not_blank',
    );
    expect(await refusedBy(ACTIVITY, anActivityOf({ withWhom: 'x'.repeat(201) }))).toMatch(
      /too long/,
    );
    expect(await refusedBy(ACTIVITY, anActivityOf({ outcome: '  ' }))).toBe(
      'clients_activity_outcome_not_blank',
    );
  });

  /* CLI 61. The service refuses a day after today; the table takes any day it is given. */
  it('happened on any day, however long ago', async () => {
    expect(await refusedBy(ACTIVITY, anActivityOf({ happenedOn: '2019-03-01' }))).toBeNull();
  });

  /* #280. Never another client's deal; an ended one of its own is allowed (CLI 55). */
  it("is about one of its own client's deals", async () => {
    const othersDeal = await aDeal(await aClient(kofi, 'Otherbank'), kofi);

    expect(await refusedBy(ACTIVITY, anActivityOf({ deal: othersDeal }))).toBe(
      'clients_activity_deal_is_the_clients',
    );
    expect(
      await refusedBy('UPDATE clients_activity SET opportunity_id = $2 WHERE id = $1', [
        (await admin.query<{ id: string }>(ACTIVITY, anActivityOf())).rows[0].id,
        othersDeal,
      ]),
    ).toBe('clients_activity_deal_is_the_clients');
  });

  /* CLI 62, TDD 4.5. */
  it('may be corrected within 24 hours of being logged', async () => {
    const id = await loggedHoursAgo(23);

    expect(
      await refusedBy(
        `UPDATE clients_activity SET kind = 'MEETING', outcome = 'Agreed a demo' WHERE id = $1`,
        [id],
      ),
    ).toBeNull();
  });

  /* CLI 62, CLI 57, TDD 4.5. A correction after that is a further note. */
  it('is fixed after 24 hours, against a change or a removal alike', async () => {
    const id = await loggedHoursAgo(25);

    expect(
      await refusedBy(`UPDATE clients_activity SET outcome = 'Agreed a demo' WHERE id = $1`, [id]),
    ).toBe('clients_activity_fixed_after_a_day');
    expect(await refusedBy('DELETE FROM clients_activity WHERE id = $1', [id])).toBe(
      'clients_activity_fixed_after_a_day',
    );
  });

  /* What it said before each correction. */
  it('is audited', async () => {
    const { rows } = await admin.query<{ id: string }>(ACTIVITY, anActivityOf());
    await admin.query(`UPDATE clients_activity SET outcome = 'Agreed a demo' WHERE id = $1`, [
      rows[0].id,
    ]);

    const audit = await admin.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity = 'clients_activity' AND entity_id = $1
        ORDER BY id`,
      [rows[0].id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(['CREATE', 'UPDATE']);
  });

  /* TDD's idx_act_client. */
  it("is found among a client's activity by the day it happened", async () => {
    const { rows } = await admin.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_clients_activity_client'`,
    );

    expect(rows[0].indexdef).toContain('USING btree (client_id, happened_on DESC)');
  });
});

/* ------------------------------------------------------------ a next step, #279 */

describe('a next step', () => {
  const STEP = `INSERT INTO clients_next_step
                  (client_id, opportunity_id, description, due_on, owner_id, source, created_by,
                   from_activity)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`;
  let client: string;
  let deal: string;
  let call: string;

  /** A step's values, with `change` over the top. */
  function aStep(change: Partial<Record<string, unknown>> = {}): unknown[] {
    const step = {
      client,
      deal,
      description: 'Internal debrief on the Testbank CreditStudio POC exit',
      dueOn: '2026-11-23',
      owner: ama,
      source: 'DEBRIEF',
      by: kofi,
      activity: null,
      ...change,
    };

    return [
      step.client,
      step.deal,
      step.description,
      step.dueOn,
      step.owner,
      step.source,
      step.by,
      step.activity,
    ];
  }

  beforeEach(async () => {
    client = await aClient(ama);
    deal = await aDeal(client, ama);
    call = await anActivity(client, kofi);
  });

  /* CLI 53, TDD 4.5. */
  it('records what, by when, whose, from what, and who made it, open', async () => {
    const { rows } = await admin.query(
      `${STEP.replace('RETURNING id', '')}
       RETURNING client_id, opportunity_id, description, due_on::text, owner_id, source,
                 done_at, done_by, created_by, created_at`,
      aStep(),
    );

    expect(rows[0]).toMatchObject({
      client_id: client,
      opportunity_id: deal,
      due_on: '2026-11-23',
      owner_id: ama,
      source: 'DEBRIEF',
      done_at: null,
      done_by: null,
      created_by: kofi,
    });
    expect(rows[0].created_at).toBeInstanceOf(Date);
  });

  it('comes from an activity, a review, a debrief, or by hand', async () => {
    /* A review step names its POC and which review, which 'a POC' below covers (#285). */
    expect(await refusedBy(STEP, aStep({ source: 'REVIEW' }))).toBe(
      'clients_next_step_review_names_its_poc',
    );
    for (const source of ['DEBRIEF', 'MANUAL']) {
      expect(await refusedBy(STEP, aStep({ source }))).toBeNull();
    }
    expect(await refusedBy(STEP, aStep({ source: 'ACTIVITY', activity: call }))).toBeNull();
    expect(await refusedBy(STEP, aStep({ source: 'REMINDER' }))).toBe(
      'clients_next_step_source_known',
    );
  });

  /* #280, CLI 63, TDD 4.5's from_activity. */
  it('names the activity it was offered with, and only then', async () => {
    expect(await refusedBy(STEP, aStep({ source: 'ACTIVITY' }))).toBe(
      'clients_next_step_activity_names_its_activity',
    );
    expect(await refusedBy(STEP, aStep({ source: 'MANUAL', activity: call }))).toBe(
      'clients_next_step_activity_names_its_activity',
    );
  });

  /* #280. Never another client's activity or deal. */
  it("is on its own client's activity and deal", async () => {
    const other = await aClient(kofi, 'Otherbank');

    expect(
      await refusedBy(
        STEP,
        aStep({ source: 'ACTIVITY', activity: await anActivity(other, kofi), deal: null }),
      ),
    ).toBe('clients_next_step_activity_is_the_clients');
    expect(await refusedBy(STEP, aStep({ deal: await aDeal(other, kofi) }))).toBe(
      'clients_next_step_deal_is_the_clients',
    );
  });

  it('says what happens next, and when, and whose it is', async () => {
    expect(await refusedBy(STEP, aStep({ description: '  ' }))).toBe('clients_next_step_described');
    expect(await refusedBy(STEP, aStep({ description: 'x'.repeat(301) }))).toMatch(/too long/);
    expect(await refusedBy(STEP, aStep({ dueOn: null }))).toMatch(/due_on/);
    expect(await refusedBy(STEP, aStep({ owner: null }))).toMatch(/owner_id/);
    expect(await refusedBy(STEP, aStep({ owner: '987654321' }))).toBe(
      'clients_next_step_owner_id_fkey',
    );
  });

  /* Beyond TDD 4.5: a debrief is about the deal that was exited. Other steps may be the client's. */
  it("is about a deal where it is a debrief, and may be the client's otherwise", async () => {
    expect(await refusedBy(STEP, aStep({ deal: null }))).toBe(
      'clients_next_step_debrief_names_its_deal',
    );
    expect(await refusedBy(STEP, aStep({ deal: null, source: 'MANUAL' }))).toBeNull();
  });

  /* TDD's step_done_pair. */
  it('is done with who did it, or not at all', async () => {
    const { rows } = await admin.query<{ id: string }>(STEP, aStep());

    expect(
      await refusedBy('UPDATE clients_next_step SET done_at = now() WHERE id = $1', [rows[0].id]),
    ).toBe('clients_next_step_done_pair');
    expect(
      await refusedBy('UPDATE clients_next_step SET done_at = now(), done_by = $2 WHERE id = $1', [
        rows[0].id,
        ama,
      ]),
    ).toBeNull();
  });

  /* #280. Reopening clears who closed it and when; the log keeps them. */
  it('is audited, so a close survives the step being reopened', async () => {
    const { rows } = await admin.query<{ id: string }>(STEP, aStep());
    const id = rows[0].id;
    await admin.query('UPDATE clients_next_step SET done_at = now(), done_by = $2 WHERE id = $1', [
      id,
      ama,
    ]);
    await admin.query('UPDATE clients_next_step SET done_at = NULL, done_by = NULL WHERE id = $1', [
      id,
    ]);

    const audit = await admin.query<{ action: string; done_by: string | null }>(
      `SELECT action, after ->> 'done_by' AS done_by FROM audit_log
        WHERE entity = 'clients_next_step' AND entity_id = $1 ORDER BY id`,
      [id],
    );
    expect(audit.rows).toEqual([
      { action: 'CREATE', done_by: null },
      { action: 'UPDATE', done_by: ama },
      { action: 'UPDATE', done_by: null },
    ]);
  });

  /* TDD's idx_step_open. */
  it("is found among somebody's open steps by when it falls due", async () => {
    const { rows } = await admin.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_clients_next_step_open'`,
    );

    expect(rows[0].indexdef).toContain('USING btree (owner_id, due_on) WHERE (done_at IS NULL)');
  });
});

/* -------------------------------------------------------------------- POCs, #285 */

describe('a POC', () => {
  const POC = `INSERT INTO clients_poc
                 (client_id, line_id, client_type_id, cs_lead_id, started_on, decision_on,
                  created_by)
               SELECT $1, l.id, t.id, $2, $3::date, $4::date, $5
                 FROM clients_product_line l, clients_client_type t
                WHERE l.name = $6 AND t.name = 'Bank'
               RETURNING id`;
  let client: string;
  let deal: string;

  function set(assignments: string): Promise<string | null> {
    return refusedBy(`UPDATE clients_opportunity SET ${assignments} WHERE id = $1`, [deal]);
  }

  /** The commit's verdict on the deal as it now stands, without committing. */
  function atCommit(): Promise<string | null> {
    return refusedBy('SET CONSTRAINTS clients_opportunity_signing_starts_its_poc IMMEDIATE');
  }

  beforeEach(async () => {
    client = await aClient(ama);
    deal = await aDeal(client, ama);
  });

  /* TDD 4.3, CLI 29, CLI 30, CLI 31. */
  it('records its client, line, client type, CS lead, start, decision date and maker', async () => {
    const { rows } = await admin.query<{ id: string }>(POC, [
      client,
      ama,
      '2026-11-02',
      '2027-01-11',
      kofi,
      'Symphony',
    ]);

    const { rows: stored } = await admin.query(
      `SELECT poc.client_id, l.name AS line, t.name AS client_type, poc.cs_lead_id,
              poc.started_on::text, poc.decision_on::text, poc.created_by
         FROM clients_poc poc
         JOIN clients_product_line l ON l.id = poc.line_id
         JOIN clients_client_type t ON t.id = poc.client_type_id
        WHERE poc.id = $1`,
      [rows[0].id],
    );
    expect(stored[0]).toEqual({
      client_id: client,
      line: 'Symphony',
      client_type: 'Bank',
      cs_lead_id: ama,
      started_on: '2026-11-02',
      decision_on: '2027-01-11',
      created_by: kofi,
    });
  });

  /* CLI 31, AC L09. Done when: a POC starting 2 November has a decision date of 11 January. */
  it('is decided ten weeks after it starts', async () => {
    for (const decision of ['2027-01-10', '2027-01-12', '2026-11-02']) {
      expect(await refusedBy(POC, [client, ama, '2026-11-02', decision, ama, 'Symphony'])).toBe(
        'clients_poc_ten_weeks',
      );
    }
    expect(
      await refusedBy(POC, [client, ama, '2026-11-02', '2027-01-11', ama, 'Symphony']),
    ).toBeNull();
  });

  /* TDD's opp_poc_stage. A deal in its POC names it. */
  it('is named by every deal in it', async () => {
    expect(await set(`has_poc = true, stage = 'CONTRACT_SIGNED'`)).toBeNull();

    expect(await set(`stage = 'POC'`)).toBe('clients_opportunity_poc_stage_names_its_poc');
    expect(await set(`stage = 'POC', poc_id = ${await aPocFor(deal)}`)).toBeNull();
  });

  /* CLI 27. Only a deal with a POC is in one, and only once its contract is signed, which is what
     starts it (#285). */
  it('covers only deals with a POC, once their contract is signed', async () => {
    const poc = await aPocFor(deal);

    expect(await set(`has_poc = true, stage = 'NEGOTIATION', poc_id = ${poc}`)).toBe(
      'clients_opportunity_in_a_poc_once_signed',
    );
    expect(await set(`has_poc = false, stage = 'CONTRACT_SIGNED', poc_id = ${poc}`)).toBe(
      'clients_opportunity_in_a_poc_has_one',
    );
  });

  /* CLI 27, TDD 4.3. For the deal's own client and its product's line. */
  it('covers only deals of its own client and line', async () => {
    const elsewhere = await aClient(ama, 'Otherbank');
    const otherClient = (
      await admin.query<{ id: string }>(POC, [
        elsewhere,
        ama,
        '2026-11-02',
        '2027-01-11',
        ama,
        'Dura Capital',
      ])
    ).rows[0].id;
    const otherLine = (
      await admin.query<{ id: string }>(POC, [
        client,
        ama,
        '2026-11-02',
        '2027-01-11',
        ama,
        'Symphony',
      ])
    ).rows[0].id;
    expect(await set(`has_poc = true, stage = 'CONTRACT_SIGNED'`)).toBeNull();

    /* The deal is CreditStudio, in Dura Capital. */
    for (const poc of [otherClient, otherLine]) {
      expect(await set(`stage = 'POC', poc_id = ${poc}`)).toBe(
        'clients_opportunity_poc_same_client_and_line',
      );
    }
  });

  /* CLI 27. A deal is in one POC, and stays in it. */
  it('keeps the deals it covers', async () => {
    expect(await set(`has_poc = true, stage = 'CONTRACT_SIGNED'`)).toBeNull();
    expect(await set(`stage = 'POC', poc_id = ${await aPocFor(deal)}`)).toBeNull();

    expect(await set(`poc_id = ${await aPocFor(deal)}`)).toBe('clients_opportunity_poc_kept');
    expect(await set('poc_id = NULL')).toBe('clients_opportunity_poc_kept');
  });

  /* The user, 19 November 2026: signing the contract starts the POC, so a deal with one is never
     left at Contract signed. Judged at the commit, so that it may pass through on its way in. */
  it('is started by the signing, the deal never left at Contract signed', async () => {
    expect(await set(`has_poc = true, stage = 'CONTRACT_SIGNED'`)).toBeNull();
    expect(await atCommit()).toBe('clients_opportunity_signing_starts_its_poc');

    expect(await set(`stage = 'POC', poc_id = ${await aPocFor(deal)}`)).toBeNull();
    expect(await atCommit()).toBeNull();
  });

  it('leaves a deal with no POC at Contract signed', async () => {
    expect(await set(`has_poc = false, stage = 'CONTRACT_SIGNED'`)).toBeNull();
    expect(await atCommit()).toBeNull();
  });

  /* The user, 20 November 2026, over CLI 27's "one or more": one deal per POC. */
  it('covers one deal', async () => {
    const poc = await aPocFor(deal);
    expect(await set(`has_poc = true, stage = 'CONTRACT_SIGNED'`)).toBeNull();
    expect(await set(`stage = 'POC', poc_id = ${poc}`)).toBeNull();

    const sameClient = await admin.query<{ id: string }>(
      `INSERT INTO clients_opportunity (client_id, product_id, owner_id)
       SELECT $1, id, $2 FROM clients_product WHERE name = 'MicroStudio' RETURNING id`,
      [client, ama],
    );
    const second = sameClient.rows[0].id;
    await admin.query(
      `UPDATE clients_opportunity SET has_poc = true, stage = 'CONTRACT_SIGNED' WHERE id = $1`,
      [second],
    );
    expect(
      await refusedBy(`UPDATE clients_opportunity SET stage = 'POC', poc_id = $2 WHERE id = $1`, [
        second,
        poc,
      ]),
    ).toBe('uq_clients_opportunity_one_per_poc');
  });

  /* CLI 33, TDD 4.5. A review step names its POC, of its own client, and which review it is. */
  it('gives review steps that name it and which review they are', async () => {
    const poc = await aPocFor(deal);
    const STEP = `INSERT INTO clients_next_step
                    (client_id, opportunity_id, poc_id, review_kind, description, due_on,
                     owner_id, source, created_by)
                  VALUES ($1, $2, $3, $4, 'Day 7 showcase', '2026-11-09', $5, $6, $5)`;

    expect(await refusedBy(STEP, [client, deal, poc, 'DAY7', ama, 'REVIEW'])).toBeNull();
    expect(await refusedBy(STEP, [client, deal, poc, 'DAY8', ama, 'REVIEW'])).toBe(
      'clients_next_step_review_kind_known',
    );
    expect(await refusedBy(STEP, [client, deal, null, 'DAY7', ama, 'REVIEW'])).toBe(
      'clients_next_step_review_names_its_poc',
    );
    expect(await refusedBy(STEP, [client, deal, poc, 'DAY7', ama, 'MANUAL'])).toBe(
      'clients_next_step_review_names_its_poc',
    );
    expect(
      await refusedBy(STEP, [await aClient(ama, 'Thirdbank'), null, poc, 'DAY7', ama, 'REVIEW']),
    ).toBe('clients_next_step_poc_is_the_clients');
  });

  /* CLI 34, TDD's act_review. A review meeting says which, about which POC and deal, and whether
     the senior decision maker came. */
  it('has review meetings that say which, and whether the decision maker came', async () => {
    const poc = await aPocFor(deal);
    const REVIEW = `INSERT INTO clients_activity
                      (client_id, opportunity_id, poc_id, kind, review_kind, dm_attended,
                       happened_on, logged_by)
                    VALUES ($1, $2, $3, 'REVIEW', $4, $5, CURRENT_DATE, $6)`;

    expect(await refusedBy(REVIEW, [client, deal, poc, 'WEEK6', false, ama])).toBeNull();
    expect(await refusedBy(REVIEW, [client, deal, poc, 'WEEK6', null, ama])).toBe(
      'clients_activity_review_says_which_and_who_came',
    );
    expect(await refusedBy(REVIEW, [client, deal, null, 'WEEK6', true, ama])).toBe(
      'clients_activity_review_says_which_and_who_came',
    );
    expect(await refusedBy(REVIEW, [client, null, poc, 'WEEK6', true, ama])).toBe(
      'clients_activity_review_names_its_deal',
    );
    expect(await refusedBy(REVIEW, [client, deal, poc, 'WEEK7', true, ama])).toBe(
      'clients_activity_review_kind_known',
    );
  });

  /* CLI 29, CLI 92. Moved by a BD manager, an open review step follows the CS lead; no other step
     changes hands. */
  it('takes only its open review steps along when its CS lead moves', async () => {
    const poc = await aPocFor(deal);
    const { rows } = await admin.query<{ id: string; source: string }>(
      `INSERT INTO clients_next_step
              (client_id, opportunity_id, poc_id, review_kind, description, due_on, owner_id,
               source, created_by)
       VALUES ($1, $2, $3, 'DAY7', 'Day 7 showcase', '2026-11-09', $4, 'REVIEW', $4),
              ($1, $2, NULL, NULL, 'Send the deck', '2026-11-09', $4, 'MANUAL', $4)
       RETURNING id, source`,
      [client, deal, poc, ama],
    );
    const review = rows.find((row) => row.source === 'REVIEW')!.id;
    const manual = rows.find((row) => row.source === 'MANUAL')!.id;
    const MOVE = 'UPDATE clients_next_step SET owner_id = $2 WHERE id = $1';

    expect(await refusedBy(MOVE, [review, kofi])).toBe(
      'clients_next_step_owner_moves_with_its_poc',
    );

    await admin.query('UPDATE clients_poc SET cs_lead_id = $2 WHERE id = $1', [poc, kofi]);
    expect(await refusedBy(MOVE, [review, kofi])).toBeNull();
    expect(await refusedBy(MOVE, [manual, kofi])).toBe(
      'clients_next_step_owner_moves_with_its_poc',
    );
  });

  /* NFR CLI AUD 01, TDD 13. */
  it('is written to the audit log by the database', async () => {
    const poc = await aPocFor(deal);
    await admin.query('UPDATE clients_poc SET cs_lead_id = $2 WHERE id = $1', [poc, kofi]);

    const audit = await admin.query<{ action: string; lead: string }>(
      `SELECT action, after ->> 'cs_lead_id' AS lead FROM audit_log
        WHERE entity = 'clients_poc' AND entity_id = $1 ORDER BY id`,
      [poc],
    );
    expect(audit.rows).toEqual([
      { action: 'CREATE', lead: ama },
      { action: 'UPDATE', lead: kofi },
    ]);
  });
});

describe("a POC's health", () => {
  const HEALTH = `INSERT INTO clients_poc_health (poc_id, health, note, set_by)
                  VALUES ($1, $2, $3, $4) RETURNING id`;
  let poc: string;

  /** The commit's verdict on the POCs made so far, without committing. */
  function atCommit(): Promise<string | null> {
    return refusedBy('SET CONSTRAINTS clients_poc_has_a_health IMMEDIATE');
  }

  beforeEach(async () => {
    poc = await aPocFor(await aDeal(await aClient(ama), ama));
  });

  /* The user, 20 November 2026. A POC has a health from the transaction that makes it. */
  it('is had by every POC from the start, On Track', async () => {
    expect(await atCommit()).toBe('clients_poc_has_a_health');

    expect(await refusedBy(HEALTH, [poc, 'AT_RISK', null, ama])).toBe(
      'clients_poc_health_starts_on_track',
    );
    expect(await refusedBy(HEALTH, [poc, 'ON_TRACK', null, ama])).toBeNull();
    expect(await atCommit()).toBeNull();
  });

  /* CLI 35. */
  it('records the health, the note, who set it and when', async () => {
    await admin.query(HEALTH, [poc, 'ON_TRACK', null, ama]);
    const { rows } = await admin.query(
      `${HEALTH.replace('RETURNING id', '')} RETURNING poc_id, health, note, set_by, set_at`,
      [poc, 'AT_RISK', 'Usage has dropped', kofi],
    );

    expect(rows[0]).toMatchObject({
      poc_id: poc,
      health: 'AT_RISK',
      note: 'Usage has dropped',
      set_by: kofi,
    });
    expect(rows[0].set_at).toBeInstanceOf(Date);
  });

  it('is On Track, At Risk or Stalled, with a note that says something if any', async () => {
    await admin.query(HEALTH, [poc, 'ON_TRACK', null, ama]);

    expect(await refusedBy(HEALTH, [poc, 'GREEN', null, ama])).toBe('clients_poc_health_known');
    expect(await refusedBy(HEALTH, [poc, 'STALLED', ' ', ama])).toBe(
      'clients_poc_health_note_not_blank',
    );
    expect(await refusedBy(HEALTH, [poc, 'STALLED', null, '987654321'])).toBe(
      'clients_poc_health_set_by_fkey',
    );
  });

  /* The user, 20 November 2026. Each row is a change. */
  it('changes with every row', async () => {
    await admin.query(HEALTH, [poc, 'ON_TRACK', null, ama]);

    expect(await refusedBy(HEALTH, [poc, 'ON_TRACK', null, ama])).toBe(
      'clients_poc_health_changes',
    );
    expect(await refusedBy(HEALTH, [poc, 'AT_RISK', null, ama])).toBeNull();
    expect(await refusedBy(HEALTH, [poc, 'AT_RISK', null, kofi])).toBe(
      'clients_poc_health_changes',
    );
    expect(await refusedBy(HEALTH, [poc, 'ON_TRACK', null, ama])).toBeNull();
  });

  /* NFR CLI REC 01. */
  it('is never changed or deleted once written', async () => {
    const { rows } = await admin.query<{ id: string }>(HEALTH, [poc, 'ON_TRACK', null, ama]);

    for (const statement of [
      `UPDATE clients_poc_health SET note = 'later' WHERE id = $1`,
      'DELETE FROM clients_poc_health WHERE id = $1',
    ]) {
      await admin.query('SAVEPOINT attempt');
      await expect(admin.query(statement, [rows[0].id])).rejects.toThrow(
        /clients_poc_health are never (changed once written|deleted)/,
      );
      await admin.query('ROLLBACK TO SAVEPOINT attempt');
    }
  });

  /* NFR CLI AUD 02. */
  it('is not written to the audit log', async () => {
    await admin.query(HEALTH, [poc, 'ON_TRACK', null, ama]);

    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE entity = 'clients_poc_health'`,
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('a corrective action', () => {
  const HEALTH = `INSERT INTO clients_poc_health (poc_id, health, set_by)
                  VALUES ($1, $2, $3) RETURNING id`;
  const ACTION = `INSERT INTO clients_poc_action (poc_id, health_id, body, logged_by)
                  VALUES ($1, $2, $3, $4) RETURNING id`;
  let poc: string;
  let onTrack: string;

  async function healthOf(id: string, health: string): Promise<string> {
    return (await admin.query<{ id: string }>(HEALTH, [id, health, ama])).rows[0].id;
  }

  beforeEach(async () => {
    poc = await aPocFor(await aDeal(await aClient(ama), ama));
    onTrack = await healthOf(poc, 'ON_TRACK');
  });

  /* The SOPs, the user on 20 November 2026. */
  it('records what is being done, the At Risk it answers, who and when', async () => {
    const atRisk = await healthOf(poc, 'AT_RISK');
    const { rows } = await admin.query(
      `${ACTION.replace('RETURNING id', '')} RETURNING poc_id, health_id, body, logged_by, logged_at`,
      [poc, atRisk, 'Weekly call with the CCO', kofi],
    );

    expect(rows[0]).toMatchObject({
      poc_id: poc,
      health_id: atRisk,
      body: 'Weekly call with the CCO',
      logged_by: kofi,
    });
    expect(rows[0].logged_at).toBeInstanceOf(Date);
  });

  /* At Risk asks for a corrective action and Stalled for a reset, only while it is the health. */
  it("answers the POC's health now, and only At Risk or Stalled", async () => {
    expect(await refusedBy(ACTION, [poc, onTrack, 'Something', ama])).toBe(
      'clients_poc_action_answers_the_current_health',
    );

    const atRisk = await healthOf(poc, 'AT_RISK');
    expect(await refusedBy(ACTION, [poc, atRisk, 'Something', ama])).toBeNull();
    expect(await refusedBy(ACTION, [poc, atRisk, 'Something more', ama])).toBeNull();

    const stalled = await healthOf(poc, 'STALLED');
    expect(await refusedBy(ACTION, [poc, atRisk, 'Too late', ama])).toBe(
      'clients_poc_action_answers_the_current_health',
    );
    expect(await refusedBy(ACTION, [poc, stalled, 'A reset', ama])).toBeNull();
  });

  it("answers its own POC's health, and says something", async () => {
    const other = await aPocFor(await aDeal(await aClient(ama, 'Otherbank'), ama));
    await healthOf(other, 'ON_TRACK');
    const atRisk = await healthOf(poc, 'AT_RISK');

    /* The trigger, which runs first, refuses it; the foreign key holds behind it. */
    expect(await refusedBy(ACTION, [other, atRisk, 'Something', ama])).toBe(
      'clients_poc_action_answers_the_current_health',
    );
    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conname = 'clients_poc_action_health_is_the_pocs' AND contype = 'f'`,
    );
    expect(rows[0].n).toBe(1);
    expect(await refusedBy(ACTION, [poc, atRisk, '  ', ama])).toBe(
      'clients_poc_action_says_something',
    );
  });

  /* NFR CLI REC 01. */
  it('is never changed or deleted once written', async () => {
    const atRisk = await healthOf(poc, 'AT_RISK');
    const { rows } = await admin.query<{ id: string }>(ACTION, [poc, atRisk, 'Something', ama]);

    for (const statement of [
      `UPDATE clients_poc_action SET body = 'later' WHERE id = $1`,
      'DELETE FROM clients_poc_action WHERE id = $1',
    ]) {
      await admin.query('SAVEPOINT attempt');
      await expect(admin.query(statement, [rows[0].id])).rejects.toThrow(
        /clients_poc_action are never (changed once written|deleted)/,
      );
      await admin.query('ROLLBACK TO SAVEPOINT attempt');
    }
  });

  /* NFR CLI AUD 02. */
  it('is not written to the audit log', async () => {
    await admin.query(ACTION, [poc, await healthOf(poc, 'AT_RISK'), 'Something', ama]);

    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE entity = 'clients_poc_action'`,
    );
    expect(rows[0].n).toBe(0);
  });
});

describe("a POC's usage", () => {
  const USAGE = `INSERT INTO clients_poc_usage (poc_id, measured_on, enrolled, active, recorded_by)
                 VALUES ($1, $2::date, $3, $4, $5) RETURNING id`;
  let poc: string;

  /** The parameters for 28 of 64 active today, recorded by Ama. */
  function aReading(change: Partial<Record<string, unknown>> = {}): unknown[] {
    const row = { on: 'CURRENT_DATE', enrolled: 64, active: 28, by: ama, ...change };
    return [poc, row.on === 'CURRENT_DATE' ? today : row.on, row.enrolled, row.active, row.by];
  }

  let today: string;

  beforeEach(async () => {
    poc = await aPocFor(await aDeal(await aClient(ama), ama));
    today = (await admin.query<{ d: string }>('SELECT CURRENT_DATE::text AS d')).rows[0].d;
  });

  /* #286. Two counts and a day; the percentage is never stored. */
  it('records the day, enrolled and active, who recorded it and when, and no percentage', async () => {
    const { rows } = await admin.query(
      `${USAGE.replace('RETURNING id', '')}
       RETURNING poc_id, measured_on::text, enrolled, active, recorded_by, recorded_at`,
      aReading(),
    );

    expect(rows[0]).toMatchObject({
      poc_id: poc,
      measured_on: today,
      enrolled: 64,
      active: 28,
      recorded_by: ama,
    });
    expect(rows[0].recorded_at).toBeInstanceOf(Date);

    const { rows: columns } = await admin.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'clients_poc_usage' AND column_name LIKE '%percent%'`,
    );
    expect(columns).toEqual([]);
  });

  it('has somebody enrolled, and no more active than enrolled', async () => {
    expect(await refusedBy(USAGE, aReading({ enrolled: 0, active: 0 }))).toBe(
      'clients_poc_usage_someone_enrolled',
    );
    expect(await refusedBy(USAGE, aReading({ active: 65 }))).toBe(
      'clients_poc_usage_active_of_enrolled',
    );
    expect(await refusedBy(USAGE, aReading({ active: -1 }))).toBe(
      'clients_poc_usage_active_of_enrolled',
    );
    expect(await refusedBy(USAGE, aReading({ active: 64 }))).toBeNull();
    expect(await refusedBy(USAGE, aReading({ active: 0 }))).toBeNull();
  });

  it('is for a day the POC had started', async () => {
    expect(await refusedBy(USAGE, aReading({ on: '2020-01-01' }))).toBe(
      'clients_poc_usage_during_the_poc',
    );
  });

  /* The user, 20 November 2026. A day may be recorded again; both are kept. */
  it('may be recorded again for the same day', async () => {
    expect(await refusedBy(USAGE, aReading())).toBeNull();
    expect(await refusedBy(USAGE, aReading({ active: 30 }))).toBeNull();
  });

  /* NFR CLI REC 01. */
  it('is never changed or deleted once written', async () => {
    const { rows } = await admin.query<{ id: string }>(USAGE, aReading());

    for (const statement of [
      'UPDATE clients_poc_usage SET active = 1 WHERE id = $1',
      'DELETE FROM clients_poc_usage WHERE id = $1',
    ]) {
      await admin.query('SAVEPOINT attempt');
      await expect(admin.query(statement, [rows[0].id])).rejects.toThrow(
        /clients_poc_usage are never (changed once written|deleted)/,
      );
      await admin.query('ROLLBACK TO SAVEPOINT attempt');
    }
  });

  /* NFR CLI AUD 02. */
  it('is not written to the audit log', async () => {
    await admin.query(USAGE, aReading());

    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE entity = 'clients_poc_usage'`,
    );
    expect(rows[0].n).toBe(0);
  });
});

describe("a deal's stage history", () => {
  const CHANGE = `INSERT INTO clients_stage_change
                    (opportunity_id, from_stage, to_stage, to_outcome, note, changed_by)
                  VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`;

  let deal: string;

  /** The parameters for a move from Discovery to Proposal, open, by the deal's owner. */
  function aMove(change: Partial<Record<string, unknown>> = {}): unknown[] {
    const row = {
      deal,
      from: 'DISCOVERY',
      to: 'PROPOSAL',
      outcome: 'OPEN',
      note: null,
      by: ama,
      ...change,
    };

    return [row.deal, row.from, row.to, row.outcome, row.note, row.by];
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

  /* CLI 26. */
  it('records where a deal moved from and to, its outcome after, the note, who and when', async () => {
    const { rows } = await admin.query(
      `${CHANGE.replace('RETURNING id', '')}
       RETURNING opportunity_id, from_stage, to_stage, to_outcome, note, changed_by, changed_at`,
      aMove({ from: 'NEGOTIATION', to: 'QUALIFICATION', note: 'Their CFO left; starting over' }),
    );

    expect(rows[0]).toMatchObject({
      opportunity_id: deal,
      from_stage: 'NEGOTIATION',
      to_stage: 'QUALIFICATION',
      to_outcome: 'OPEN',
      note: 'Their CFO left; starting over',
      changed_by: ama,
    });
    expect(rows[0].changed_at).toBeInstanceOf(Date);
  });

  it('is of a deal that exists, moved by somebody who does', async () => {
    expect(await refusedBy(CHANGE, aMove({ deal: '987654321' }))).toBe(
      'clients_stage_change_opportunity_id_fkey',
    );
    expect(await refusedBy(CHANGE, aMove({ by: null }))).toMatch(/changed_by/);
  });

  /* CLI 12. */
  it('starts with the deal opened at Discovery, open', async () => {
    expect(await refusedBy(CHANGE, aMove({ from: null, to: 'DISCOVERY' }))).toBeNull();
    expect(await refusedBy(CHANGE, aMove({ from: null, to: 'PROPOSAL' }))).toBe(
      'clients_stage_change_opens_at_discovery',
    );
  });

  /* CLI 21, NOTE_REQUIRED, AC L07. A move back says why; a move forward may. */
  it('holds the note a move back needs', async () => {
    const back = { from: 'PROPOSAL', to: 'QUALIFICATION' };

    expect(await refusedBy(CHANGE, aMove(back))).toBe('clients_stage_change_back_has_a_note');
    expect(await refusedBy(CHANGE, aMove({ ...back, note: '  ' }))).toBe(
      'clients_stage_change_note_not_blank',
    );
    expect(await refusedBy(CHANGE, aMove({ ...back, note: 'Scope changed' }))).toBeNull();
    expect(await refusedBy(CHANGE, aMove({ note: 'Proposal sent today' }))).toBeNull();
    expect(await refusedBy(CHANGE, aMove())).toBeNull();
  });

  it('holds no more than the deal itself could have', async () => {
    expect(await refusedBy(CHANGE, aMove({ to: 'PILOT' }))).toBe(
      'clients_stage_change_stages_known',
    );
    expect(await refusedBy(CHANGE, aMove({ from: 'PILOT' }))).toBe(
      'clients_stage_change_stages_known',
    );
    expect(await refusedBy(CHANGE, aMove({ outcome: 'PAUSED' }))).toBe(
      'clients_stage_change_outcome_known',
    );
    expect(await refusedBy(CHANGE, aMove({ outcome: 'WON' }))).toBe(
      'clients_stage_change_won_is_live',
    );
    expect(
      await refusedBy(CHANGE, aMove({ from: 'CONTRACT_SIGNED', to: 'LIVE', outcome: 'WON' })),
    ).toBeNull();
  });

  /* NFR CLI REC 01. Whoever writes: these run as the owner, which privileges alone would let. */
  it('is never changed or deleted once written', async () => {
    const { rows } = await admin.query<{ id: string }>(CHANGE, aMove());

    for (const statement of [
      `UPDATE clients_stage_change SET to_stage = 'LIVE' WHERE id = $1`,
      'DELETE FROM clients_stage_change WHERE id = $1',
    ]) {
      await admin.query('SAVEPOINT attempt');
      await expect(admin.query(statement, [rows[0].id])).rejects.toThrow(
        /clients_stage_change are never (changed once written|deleted)/,
      );
      await admin.query('ROLLBACK TO SAVEPOINT attempt');
    }
  });

  /* NFR CLI AUD 02. */
  it('is not written to the audit log', async () => {
    await admin.query(CHANGE, aMove());

    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE entity = 'clients_stage_change'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('is found by deal, in the order it happened', async () => {
    const { rows } = await admin.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_clients_stage_change_deal'`,
    );

    expect(rows[0]?.indexdef).toMatch(/USING btree \(opportunity_id, changed_at\)/);
  });
});

/* --------------------------------------------------- notes on a client, #278 */

describe('a note on a client', () => {
  const NOTE = `INSERT INTO clients_client_note (client_id, heading, body, written_by)
                VALUES ($1, $2, $3, $4) RETURNING id`;

  let client: string;

  beforeEach(async () => {
    client = await aClient(ama);
  });

  it('records its client, heading, words, writer, and when it was written', async () => {
    const { rows } = await admin.query(
      `${NOTE.replace('RETURNING id', '')}
       RETURNING client_id, heading, body, written_by, written_at, edited_at, archived_at`,
      [client, 'How they buy', 'Through a tender, every March.', ama],
    );

    expect(rows[0]).toMatchObject({
      client_id: client,
      heading: 'How they buy',
      body: 'Through a tender, every March.',
      written_by: ama,
      edited_at: null,
      archived_at: null,
    });
    expect(rows[0].written_at).toBeInstanceOf(Date);
  });

  it('is on a client that exists, by somebody who does', async () => {
    expect(await refusedBy(NOTE, ['987654321', 'A', 'B', ama])).toBe(
      'clients_client_note_client_id_fkey',
    );
    expect(await refusedBy(NOTE, [client, 'A', 'B', null])).toMatch(/written_by/);
  });

  it('has a heading and words, never blank ones', async () => {
    expect(await refusedBy(NOTE, [client, '  ', 'B', ama])).toBe(
      'clients_client_note_heading_not_blank',
    );
    expect(await refusedBy(NOTE, [client, 'A', '   ', ama])).toBe(
      'clients_client_note_body_not_blank',
    );
    expect(await refusedBy(NOTE, [client, null, 'B', ama])).toMatch(/heading/);
  });

  it('may be one of many on the same client', async () => {
    for (const heading of ['How they buy', 'Who signs off', 'How they buy']) {
      expect(await refusedBy(NOTE, [client, heading, 'Something', ama])).toBeNull();
    }
  });

  it('is written to the audit log by the database, with who did it', async () => {
    await admin.query(
      `SELECT set_config('lms.audit.actor', 'employee 7', true),
              set_config('lms.audit.actor_employee_id', $1, true)`,
      [ama],
    );
    const { rows } = await admin.query<{ id: string }>(NOTE, [client, 'A', 'B', ama]);
    await admin.query('UPDATE clients_client_note SET archived_at = now() WHERE id = $1', [
      rows[0].id,
    ]);

    const log = await admin.query(
      `SELECT action, entity_id FROM audit_log
        WHERE entity = 'clients_client_note' ORDER BY id`,
    );
    expect(log.rows).toEqual([
      { action: 'CREATE', entity_id: rows[0].id },
      { action: 'UPDATE', entity_id: rows[0].id },
    ]);
  });
});

/* ---------------------------------------------------------- what lms_app may do */

describe('the application role', () => {
  /* #279, CLI 54: but for a reason no deal has ended for, which the deal's foreign key holds. */
  it('deletes nothing in clients but an unused reason', async () => {
    const { rows } = await admin.query<{ table: string }>(
      `SELECT t AS table FROM unnest($1::text[]) AS t
        WHERE has_table_privilege('lms_app', t, 'DELETE')
           OR has_table_privilege('lms_app', t, 'TRUNCATE')`,
      [TABLES],
    );

    expect(rows).toEqual([{ table: 'clients_reason' }]);
    expect(
      (
        await admin.query(
          `SELECT has_table_privilege('lms_app', 'clients_reason', 'TRUNCATE') AS t`,
        )
      ).rows[0].t,
    ).toBe(false);
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
      /* #280, CLI 62. An activity corrected within its day; never its client, logger or when.
         A proposal's amount too (#281). */
      { table_name: 'clients_activity', column_name: 'amount_minor' },
      { table_name: 'clients_activity', column_name: 'currency' },
      { table_name: 'clients_activity', column_name: 'happened_on' },
      { table_name: 'clients_activity', column_name: 'kind' },
      { table_name: 'clients_activity', column_name: 'opportunity_id' },
      { table_name: 'clients_activity', column_name: 'outcome' },
      { table_name: 'clients_activity', column_name: 'with_whom' },
      { table_name: 'clients_client', column_name: 'name' },
      { table_name: 'clients_client', column_name: 'owner_id' },
      { table_name: 'clients_client', column_name: 'type_id' },
      /* #278. A note's words, and its archiving; never its client, writer or when. */
      { table_name: 'clients_client_note', column_name: 'archived_at' },
      { table_name: 'clients_client_note', column_name: 'body' },
      { table_name: 'clients_client_note', column_name: 'edited_at' },
      { table_name: 'clients_client_note', column_name: 'heading' },
      { table_name: 'clients_client_product', column_name: 'ended_on' },
      { table_name: 'clients_client_product', column_name: 'since_on' },
      /* #278, CLI 25. A won deal starts again a product the client had stopped. */
      { table_name: 'clients_client_product', column_name: 'won_by' },
      { table_name: 'clients_client_type', column_name: 'name' },
      { table_name: 'clients_client_type', column_name: 'retired_on' },
      { table_name: 'clients_contact', column_name: 'email' },
      { table_name: 'clients_contact', column_name: 'job_title' },
      { table_name: 'clients_contact', column_name: 'name' },
      { table_name: 'clients_contact', column_name: 'phone' },
      { table_name: 'clients_contact', column_name: 'removed_at' },
      /* #281. A document's scan verdict, and its being taken off; nothing else about it. */
      { table_name: 'clients_document', column_name: 'removed_at' },
      { table_name: 'clients_document', column_name: 'removed_by' },
      { table_name: 'clients_document', column_name: 'scan_signature' },
      { table_name: 'clients_document', column_name: 'scan_status' },
      { table_name: 'clients_document', column_name: 'scanned_at' },
      { table_name: 'clients_document', column_name: 'scanned_by' },
      /* #280, CLI 64. A step closed, by whom and when; never what, when due or whose. */
      { table_name: 'clients_next_step', column_name: 'done_at' },
      { table_name: 'clients_next_step', column_name: 'done_by' },
      /* #285. An open review step follows its POC to a new CS lead. */
      { table_name: 'clients_next_step', column_name: 'owner_id' },
      /* #277, CLI 13. A deal's figures and words; never its client, product or outcome. */
      { table_name: 'clients_opportunity', column_name: 'close_half' },
      { table_name: 'clients_opportunity', column_name: 'close_year' },
      { table_name: 'clients_opportunity', column_name: 'currency' },
      /* #279. Why it was lost or exited, and what was said, written as it ends. */
      { table_name: 'clients_opportunity', column_name: 'end_note' },
      /* #278. Its stage, its outcome and the day it ended, moved by the stage service, and
         whether it will have a POC. */
      { table_name: 'clients_opportunity', column_name: 'ended_on' },
      { table_name: 'clients_opportunity', column_name: 'has_poc' },
      { table_name: 'clients_opportunity', column_name: 'outcome' },
      /* #285. The POC it is put in as its contract is signed, once. */
      { table_name: 'clients_opportunity', column_name: 'poc_id' },
      { table_name: 'clients_opportunity', column_name: 'probability' },
      { table_name: 'clients_opportunity', column_name: 'reason_id' },
      { table_name: 'clients_opportunity', column_name: 'stage' },
      { table_name: 'clients_opportunity', column_name: 'stated_interest' },
      { table_name: 'clients_opportunity', column_name: 'value_minor' },
      { table_name: 'clients_opportunity', column_name: 'waiting_note' },
      { table_name: 'clients_opportunity', column_name: 'waiting_on' },
      /* #285. A POC's CS lead, moved by a BD manager. */
      { table_name: 'clients_poc', column_name: 'cs_lead_id' },
      { table_name: 'clients_product', column_name: 'name' },
      { table_name: 'clients_product', column_name: 'retired_on' },
      { table_name: 'clients_product_line', column_name: 'name' },
      { table_name: 'clients_product_line', column_name: 'retired_on' },
      /* #279. A reason is renamed and retired; which list it is on never changes. */
      { table_name: 'clients_reason', column_name: 'label' },
      { table_name: 'clients_reason', column_name: 'retired_on' },
      { table_name: 'clients_role', column_name: 'ended_at' },
      { table_name: 'clients_role', column_name: 'ended_by' },
      { table_name: 'clients_role', column_name: 'ended_reason' },
    ]);
  });
});
