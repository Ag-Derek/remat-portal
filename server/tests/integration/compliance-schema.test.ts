import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * The seven compliance tables, against a real database. #245, Compliance TDD 4 and 13.
 *
 * Only what the schema decides on its own: the shape of an item and of an obligation, the
 * uniquenesses the services and jobs lean on, amounts with their currency, roles ended rather
 * than deleted, and what lms_app may change. What may never be rewritten is #246's.
 */

const testDatabaseUrl = await databaseForThisFile();

let admin: Client;
let ceo: string;
let hr: string;
let ops: string;

const TABLES = [
  'compliance_item',
  'compliance_obligation',
  'compliance_completion',
  'compliance_reversal',
  'compliance_document',
  'compliance_reminder_sent',
  'compliance_role',
];

beforeAll(async () => {
  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const people = (await seed(admin)) as Record<string, string>;
  ceo = people.ceo;

  const { rows } = await admin.query<{ id: string }>(
    'SELECT id FROM employee WHERE id <> $1 ORDER BY id LIMIT 2',
    [ceo],
  );
  [hr, ops] = rows.map((row) => row.id);
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

/** An item with these columns, the rest those of a permit HR owns and Operations backs up. */
function item(columns: Record<string, unknown> = {}): [string, unknown[]] {
  const row: Record<string, unknown> = {
    name: 'Fire certificate',
    kind: 'EXPIRES',
    owner_id: hr,
    backup_id: ops,
    currency: 'GHS',
    reminder_days_before: [90, 60, 30],
    reminder_in_working_days: false,
    reminder_cadence: 'WEEKLY',
    ...columns,
  };
  const names = Object.keys(row);

  return [
    `INSERT INTO compliance_item (${names.join(', ')})
     VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(row),
  ];
}

const PAYE = {
  name: 'PAYE return',
  kind: 'RECURS',
  cycle: 'MONTHLY',
  due_day: 15,
  reminder_days_before: [5],
  reminder_in_working_days: true,
  reminder_cadence: 'NONE',
};

async function anItem(columns: Record<string, unknown> = {}): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(...item(columns));
  return rows[0].id;
}

/** An obligation with these columns, on `itemId`. */
function obligation(itemId: string, columns: Record<string, unknown> = {}): [string, unknown[]] {
  const row: Record<string, unknown> = { item_id: itemId, ...columns };
  const names = Object.keys(row);

  return [
    `INSERT INTO compliance_obligation (${names.join(', ')})
     VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(row),
  ];
}

const OCTOBER = {
  period_label: 'October 2026',
  period_start: '2026-10-01',
  period_end: '2026-10-31',
  nominal_due_on: '2026-11-15',
  due_on: '2026-11-13',
};

const EXPIRY = { nominal_due_on: '2027-03-31', due_on: '2027-03-31' };

async function anObligation(itemId: string, columns: Record<string, unknown>): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(...obligation(itemId, columns));
  return rows[0].id;
}

/* ------------------------------------------------------------------- an item */

describe('an item', () => {
  it('has an owner and a backup who are two people', async () => {
    expect(await refusedBy(...item({ backup_id: hr }))).toBe('item_owner_not_backup');
  });

  it('is the shape of its kind', async () => {
    expect(await refusedBy(...item({ cycle: 'MONTHLY', due_day: 15 }))).toBe('item_kind_shape');
    expect(await refusedBy(...item({ ...PAYE, due_day: null }))).toBe('item_kind_shape');

    expect(await refusedBy(...item())).toBeNull();
    expect(await refusedBy(...item(PAYE))).toBeNull();
  });

  it('falls due in a month of its own if it is annual, and only then', async () => {
    expect(await refusedBy(...item({ ...PAYE, cycle: 'ANNUAL' }))).toBe('item_annual_has_month');
    expect(await refusedBy(...item({ ...PAYE, due_month: 4 }))).toBe('item_annual_has_month');
    expect(await refusedBy(...item({ ...PAYE, cycle: 'ANNUAL', due_month: 4 }))).toBeNull();
  });

  it('is retired with a reason, by somebody', async () => {
    const permit = await anItem();
    const retire = `UPDATE compliance_item
                       SET retired_on = $2, retired_reason = $3, retired_by = $4
                     WHERE id = $1`;

    expect(await refusedBy(retire, [permit, '2026-11-05', null, ceo])).toBe('item_retired_shape');
    expect(await refusedBy(retire, [permit, '2026-11-05', 'Site closed', null])).toBe(
      'item_retired_by_someone',
    );
    expect(await refusedBy(retire, [permit, '2026-11-05', ' ', ceo])).toBe(
      'item_retired_by_someone',
    );
    expect(await refusedBy(retire, [permit, '2026-11-05', 'Site closed', ceo])).toBeNull();
  });

  it('is in cedis or dollars', async () => {
    expect(await refusedBy(...item({ currency: 'EUR' }))).toBe('compliance_item_currency_check');
  });
});

/* -------------------------------------------------------------- an obligation */

describe('an obligation', () => {
  it('needs a date exactly when it has none', async () => {
    const permit = await anItem();

    expect(await refusedBy(...obligation(permit, { status: 'OPEN' }))).toBe('ob_needs_date');
    expect(await refusedBy(...obligation(permit, { ...EXPIRY, status: 'NEEDS_DATE' }))).toBe(
      'ob_needs_date',
    );
    expect(await refusedBy(...obligation(permit, { status: 'NEEDS_DATE' }))).toBeNull();
  });

  /* So an item still waiting for its first date can be retired. */
  it('may be cancelled without ever having had a date', async () => {
    const permit = await anItem();
    const waiting = await anObligation(permit, { status: 'NEEDS_DATE' });

    expect(
      await refusedBy(`UPDATE compliance_obligation SET status = 'CANCELLED' WHERE id = $1`, [
        waiting,
      ]),
    ).toBeNull();
  });

  it('has its two dates together', async () => {
    const permit = await anItem();

    expect(await refusedBy(...obligation(permit, { due_on: '2027-03-31' }))).toBe(
      'ob_dates_together',
    );
  });

  it('has a whole period or none, running forwards', async () => {
    const paye = await anItem(PAYE);

    /* Dated as if unmoved, so that the missing label is the only thing wrong with it. */
    expect(
      await refusedBy(
        ...obligation(paye, { ...OCTOBER, period_label: null, due_on: OCTOBER.nominal_due_on }),
      ),
    ).toBe('ob_period_shape');
    expect(
      await refusedBy(
        ...obligation(paye, { ...OCTOBER, period_start: '2026-10-31', period_end: '2026-10-01' }),
      ),
    ).toBe('ob_period_forwards');
  });

  /* CMP 14 and CMP 15: a filing deadline comes forward off a weekend, a permit's date does not. */
  it('moves off a weekend only if it is a filing', async () => {
    const permit = await anItem();
    const paye = await anItem(PAYE);

    expect(
      await refusedBy(
        ...obligation(permit, { nominal_due_on: '2027-03-28', due_on: '2027-03-26' }),
      ),
    ).toBe('ob_expiry_never_moves');
    expect(await refusedBy(...obligation(paye, OCTOBER))).toBeNull();
  });

  it('is one outstanding at a time for an expiring item, dated or not', async () => {
    const permit = await anItem();
    const first = await anObligation(permit, { status: 'NEEDS_DATE' });

    expect(await refusedBy(...obligation(permit, EXPIRY))).toBe('uq_expiring_one_open');

    await admin.query(
      `UPDATE compliance_obligation
          SET status = 'CLOSED', nominal_due_on = '2026-12-31', due_on = '2026-12-31'
        WHERE id = $1`,
      [first],
    );

    expect(await refusedBy(...obligation(permit, EXPIRY))).toBeNull();
  });

  it('is once per period for a recurring item, filed or not', async () => {
    const paye = await anItem(PAYE);
    const october = await anObligation(paye, OCTOBER);

    expect(await refusedBy(...obligation(paye, OCTOBER))).toBe('uq_period_once');

    await admin.query(`UPDATE compliance_obligation SET status = 'CLOSED' WHERE id = $1`, [
      october,
    ]);

    expect(await refusedBy(...obligation(paye, OCTOBER))).toBe('uq_period_once');

    /* November is its own period, whatever became of October. */
    expect(
      await refusedBy(
        ...obligation(paye, {
          period_label: 'November 2026',
          period_start: '2026-11-01',
          period_end: '2026-11-30',
          nominal_due_on: '2026-12-15',
          due_on: '2026-12-15',
        }),
      ),
    ).toBeNull();
  });

  /* #254: retiring cancels the period, and bringing the item back creates it afresh. */
  it('frees its period when cancelled, so a retired item can be brought back', async () => {
    const paye = await anItem(PAYE);
    const october = await anObligation(paye, OCTOBER);

    await admin.query(`UPDATE compliance_obligation SET status = 'CANCELLED' WHERE id = $1`, [
      october,
    ]);

    expect(await refusedBy(...obligation(paye, OCTOBER))).toBeNull();
  });
});

/* ---------------------------------------------------- completions and reversals */

describe('a completion', () => {
  const COMPLETE = `
    INSERT INTO compliance_completion (obligation_id, completed_on, amount_minor, currency,
                                       recorded_by)
    VALUES ($1, '2026-11-10', $2, $3, $4)
    RETURNING id, amount_minor, currency, days_late`;

  it('is one that stands per obligation, and a reversed one stops counting', async () => {
    const october = await anObligation(await anItem(PAYE), OCTOBER);
    const { rows } = await admin.query<{ id: string }>(COMPLETE, [october, 120000, 'GHS', hr]);

    expect(await refusedBy(COMPLETE, [october, 120000, 'GHS', ops])).toBe('uq_one_live_completion');

    await admin.query('UPDATE compliance_completion SET reversed_at = now() WHERE id = $1', [
      rows[0].id,
    ]);

    expect(await refusedBy(COMPLETE, [october, 125000, 'GHS', hr])).toBeNull();
  });

  it('keeps an amount in minor units, always with its currency', async () => {
    const october = await anObligation(await anItem(PAYE), OCTOBER);

    expect(await refusedBy(COMPLETE, [october, 120000, null, hr])).toBe('completion_amount_pair');
    expect(await refusedBy(COMPLETE, [october, null, 'GHS', hr])).toBe('completion_amount_pair');
    expect(await refusedBy(COMPLETE, [october, 120000, 'EUR', hr])).toBe(
      'compliance_completion_currency_check',
    );
    expect(await refusedBy(COMPLETE, [october, -1, 'GHS', hr])).toBe(
      'completion_amount_not_negative',
    );

    /* Beyond an INTEGER's reach, which is about twenty one million cedis. */
    const { rows } = await admin.query(COMPLETE, [october, '9000000000000', 'USD', hr]);
    expect(rows[0]).toMatchObject({ amount_minor: '9000000000000', currency: 'USD', days_late: 0 });
  });

  it('is reversed once, and for a reason', async () => {
    const october = await anObligation(await anItem(PAYE), OCTOBER);
    const { rows } = await admin.query<{ id: string }>(COMPLETE, [october, null, null, hr]);
    const REVERSE = `INSERT INTO compliance_reversal (completion_id, reason, reversed_by)
                     VALUES ($1, $2, $3)`;

    expect(await refusedBy(REVERSE, [rows[0].id, '  ', ceo])).toBe(
      'compliance_reversal_reason_check',
    );
    expect(await refusedBy(REVERSE, [rows[0].id, 'Recorded on the wrong month', ceo])).toBeNull();
    expect(await refusedBy(REVERSE, [rows[0].id, 'Again', ceo])).toBe(
      'compliance_reversal_completion_id_key',
    );
  });
});

/* ------------------------------------------------------------------ documents */

describe('a document', () => {
  it('has no file_deleted_at, because nothing purges it', async () => {
    const { rows } = await admin.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'compliance_document' AND column_name = 'file_deleted_at'`,
    );

    expect(rows).toEqual([]);
  });
});

/* ------------------------------------------------------------ the reminder ledger */

describe('the reminder ledger', () => {
  /* NFR CMP REL 01: the job run twice in a day sends once. */
  it('holds one reminder of a kind per obligation per day', async () => {
    const october = await anObligation(await anItem(PAYE), OCTOBER);
    const SENT = `INSERT INTO compliance_reminder_sent (obligation_id, sent_for_date, kind)
                  VALUES ($1, '2026-11-06', $2)`;

    expect(await refusedBy(SENT, [october, 'OFFSET'])).toBeNull();
    expect(await refusedBy(SENT, [october, 'OFFSET'])).toBe('compliance_reminder_sent_pkey');
    expect(await refusedBy(SENT, [october, 'ESCALATION'])).toBeNull();
  });
});

/* ---------------------------------------------------------------------- roles */

describe('a role', () => {
  const GRANT = `INSERT INTO compliance_role (employee_id, role, granted_by)
                 VALUES ($1, $2, $3) RETURNING id`;

  it('is held once at a time, and granted again once ended', async () => {
    const { rows } = await admin.query<{ id: string }>(GRANT, [hr, 'OVERSIGHT', ceo]);

    expect(await refusedBy(GRANT, [hr, 'OVERSIGHT', ceo])).toBe('uq_role_live');
    expect(await refusedBy(GRANT, [hr, 'VIEWER', ceo])).toBeNull();

    await admin.query(
      `UPDATE compliance_role SET ended_at = now(), ended_by = $2, ended_reason = 'REVOKED'
        WHERE id = $1`,
      [rows[0].id, ceo],
    );

    expect(await refusedBy(GRANT, [hr, 'OVERSIGHT', ceo])).toBeNull();
  });

  it('is only oversight or viewer', async () => {
    expect(await refusedBy(GRANT, [hr, 'OWNER', ceo])).toBe('compliance_role_role_check');
  });

  it('ends revoked or because its holder left, and says which', async () => {
    const { rows } = await admin.query<{ id: string }>(GRANT, [ops, 'VIEWER', ceo]);
    const END = `UPDATE compliance_role SET ended_at = now(), ended_reason = $2 WHERE id = $1`;

    expect(await refusedBy(END, [rows[0].id, null])).toBe('role_ends_with_a_reason');
    expect(await refusedBy(END, [rows[0].id, 'RETIRED'])).toBe('role_ending_known');
    expect(await refusedBy(END, [rows[0].id, 'LEFT'])).toBeNull();
  });

  it('is found by person, among the live grants', async () => {
    const { rows } = await admin.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_role_person'`,
    );

    expect(rows[0]?.indexdef).toMatch(
      /ON public\.compliance_role USING btree \(employee_id\) WHERE \(ended_at IS NULL\)/,
    );
  });
});

/* ---------------------------------------------------------- what lms_app may do */

describe('the application role', () => {
  it('deletes nothing in compliance', async () => {
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

  it('updates only an item, an obligation, a reversal mark and the end of a role', async () => {
    const { rows } = await admin.query<{ table: string }>(
      `SELECT t AS table FROM unnest($1::text[]) AS t
        WHERE has_table_privilege('lms_app', t, 'UPDATE')
        ORDER BY t`,
      [TABLES],
    );
    expect(rows.map((row) => row.table)).toEqual(['compliance_item', 'compliance_obligation']);

    const columns = await admin.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.column_privileges
        WHERE grantee = 'lms_app' AND privilege_type = 'UPDATE'
          AND table_name IN ('compliance_completion', 'compliance_role')
        ORDER BY table_name, column_name`,
    );
    expect(columns.rows).toEqual([
      { table_name: 'compliance_completion', column_name: 'reversed_at' },
      { table_name: 'compliance_role', column_name: 'ended_at' },
      { table_name: 'compliance_role', column_name: 'ended_by' },
      { table_name: 'compliance_role', column_name: 'ended_reason' },
    ]);
  });
});
