import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * The two default reminder schedules, against a real database. #247, SRS CMP 31–33,
 * Compliance TDD 4.1 and 13.
 *
 *   **They are there on a migrated database**, one per kind, as CMP 32 and CMP 33 give them.
 *
 *   **They are oversight's to edit**, and the repair that puts a lost one back never
 *   overwrites an edit.
 *
 *   **They fit on an item**, which is where each is copied when an item is created.
 *
 * That the defaults are a migration's and not the fixture seed's is ../unit/migrations.test.ts.
 */

const testDatabaseUrl = await databaseForThisFile();

let admin: Client;
let hr: string;
let ops: string;

beforeAll(async () => {
  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const people = (await seed(admin)) as Record<string, string>;

  const { rows } = await admin.query<{ id: string }>(
    'SELECT id FROM employee WHERE id <> $1 ORDER BY id LIMIT 2',
    [people.ceo],
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

/** The constraint a statement was refused by, or null if it went in. */
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

async function defaults() {
  const { rows } = await admin.query(
    `SELECT kind, reminder_days_before, reminder_in_working_days, reminder_cadence
       FROM compliance_reminder_default ORDER BY kind`,
  );
  return rows;
}

async function ensure(): Promise<number> {
  const { rows } = await admin.query<{ given: number }>(
    'SELECT ensure_compliance_reminder_defaults() AS given',
  );
  return rows[0].given;
}

/* ------------------------------------------------------------------ as shipped */

describe('the defaults', () => {
  it('are one per kind, as CMP 32 and CMP 33 give them', async () => {
    expect(await defaults()).toEqual([
      {
        kind: 'EXPIRES',
        reminder_days_before: [90, 60, 30],
        reminder_in_working_days: false,
        reminder_cadence: 'WEEKLY',
      },
      {
        kind: 'RECURS',
        reminder_days_before: [5],
        reminder_in_working_days: true,
        reminder_cadence: 'NONE',
      },
    ]);
  });

  it('are for the two kinds there are, and no others', async () => {
    expect(
      await refusedBy(
        `INSERT INTO compliance_reminder_default
           (kind, reminder_days_before, reminder_in_working_days, reminder_cadence)
         VALUES ('LAPSES', '{30}', false, 'DAILY')`,
      ),
    ).toBe('compliance_reminder_default_kind_check');
  });
});

/* ------------------------------------------------------------- edited by oversight */

describe('a default edited', () => {
  const EDIT = `UPDATE compliance_reminder_default
                   SET reminder_days_before = $2, reminder_cadence = $3
                 WHERE kind = $1`;

  it('takes a schedule of its own', async () => {
    expect(await refusedBy(EDIT, ['EXPIRES', [120, 60, 14], 'DAILY'])).toBeNull();
  });

  /* TDD 7 reads the first offset as the point an item becomes due soon. */
  it('lists its offsets furthest first, each once', async () => {
    expect(await refusedBy(EDIT, ['EXPIRES', [30, 60, 90], 'WEEKLY'])).toBe(
      'default_reminders_are_days_before',
    );
    expect(await refusedBy(EDIT, ['EXPIRES', [60, 60], 'WEEKLY'])).toBe(
      'default_reminders_are_days_before',
    );
  });

  it('counts days before, never on or after', async () => {
    expect(await refusedBy(EDIT, ['RECURS', [5, 0], 'NONE'])).toBe(
      'default_reminders_are_days_before',
    );
    expect(await refusedBy(EDIT, ['RECURS', [5, null], 'NONE'])).toBe(
      'default_reminders_are_days_before',
    );
  });

  it('has a cadence the reminder job knows', async () => {
    expect(await refusedBy(EDIT, ['RECURS', [5], 'MONTHLY'])).toBe('default_cadence_known');
  });

  it('survives the repair that puts a lost default back', async () => {
    await admin.query(EDIT, ['EXPIRES', [60, 30], 'DAILY']);

    expect(await ensure()).toBe(0);
    expect((await defaults())[0]).toMatchObject({
      reminder_days_before: [60, 30],
      reminder_cadence: 'DAILY',
    });
  });

  it('is put back as shipped when it has been lost', async () => {
    await admin.query(`DELETE FROM compliance_reminder_default WHERE kind = 'RECURS'`);

    expect(await ensure()).toBe(1);
    expect((await defaults())[1]).toMatchObject({
      kind: 'RECURS',
      reminder_days_before: [5],
      reminder_cadence: 'NONE',
    });
  });
});

/* ------------------------------------------------------------- copied onto an item */

describe('an item', () => {
  /* What ItemService does when an item is created: the default for its kind, copied. */
  it('takes the default for its kind, column for column', async () => {
    const { rows } = await admin.query(
      `INSERT INTO compliance_item (name, kind, owner_id, backup_id, currency, cycle, due_day,
                                    reminder_days_before, reminder_in_working_days,
                                    reminder_cadence)
       SELECT 'PAYE return', kind, $1, $2, 'GHS', 'MONTHLY', 15,
              reminder_days_before, reminder_in_working_days, reminder_cadence
         FROM compliance_reminder_default WHERE kind = 'RECURS'
       RETURNING reminder_days_before, reminder_in_working_days, reminder_cadence`,
      [hr, ops],
    );

    expect(rows[0]).toEqual({
      reminder_days_before: [5],
      reminder_in_working_days: true,
      reminder_cadence: 'NONE',
    });
  });

  it('says whether its offsets count working days, because nothing assumes it', async () => {
    expect(
      await refusedBy(
        `INSERT INTO compliance_item (name, kind, owner_id, backup_id, currency,
                                      reminder_days_before, reminder_cadence)
         VALUES ('Fire certificate', 'EXPIRES', $1, $2, 'GHS', '{90,60,30}', 'WEEKLY')`,
        [hr, ops],
      ),
    ).toMatch(/reminder_in_working_days/);
  });

  it('keeps its offsets furthest first, as a default does', async () => {
    expect(
      await refusedBy(
        `INSERT INTO compliance_item (name, kind, owner_id, backup_id, currency,
                                      reminder_days_before, reminder_in_working_days,
                                      reminder_cadence)
         VALUES ('Fire certificate', 'EXPIRES', $1, $2, 'GHS', '{30,60,90}', false, 'WEEKLY')`,
        [hr, ops],
      ),
    ).toBe('item_reminders_are_days_before');
  });
});

/* ---------------------------------------------------------- what lms_app may do */

describe('the application role', () => {
  it('reads and edits the defaults, and neither adds nor removes one', async () => {
    const { rows } = await admin.query(
      `SELECT has_table_privilege('lms_app', 'compliance_reminder_default', 'SELECT') AS sel,
              has_table_privilege('lms_app', 'compliance_reminder_default', 'INSERT') AS ins,
              has_table_privilege('lms_app', 'compliance_reminder_default', 'UPDATE') AS upd,
              has_table_privilege('lms_app', 'compliance_reminder_default', 'DELETE') AS del`,
    );

    expect(rows[0]).toEqual({ sel: true, ins: false, upd: true, del: false });
  });

  it('cannot run the repair, which is an operator’s', async () => {
    const { rows } = await admin.query(
      `SELECT has_function_privilege('lms_app', 'ensure_compliance_reminder_defaults()',
                                     'EXECUTE') AS may`,
    );

    expect(rows[0].may).toBe(false);
  });
});
