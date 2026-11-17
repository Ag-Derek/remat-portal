import type { Kysely } from 'kysely';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { seed } from '../../seeds/seed.mjs';
import { CompanyCalendar } from '../../src/core/calendar/company-calendar.js';
import { type Database, databaseFor } from '../../src/core/db/index.js';

/**
 * The company's working days, read from the default work pattern and the public holiday
 * calendar. Clients TDD 6.4. The counting itself is ../unit/working-days.test.ts.
 *
 * November 2026: Monday the 16th, Friday the 20th.
 */

const testDatabaseUrl = await databaseForThisFile();

let db: Kysely<Database>;
let admin: Client;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);
  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();
});

beforeEach(async () => {
  await seed(admin);
  await admin.query(`DELETE FROM holiday WHERE holiday_date >= '2026-11-01'`);
});

afterAll(async () => {
  await db?.destroy();
  await admin?.end();
});

async function holiday(day: string): Promise<void> {
  await admin.query('INSERT INTO holiday (name, holiday_date) VALUES ($1, $2)', [
    `Holiday on ${day}`,
    day,
  ]);
}

describe("the company's working days", () => {
  it('are its default week: five on from a Monday is the Monday after', async () => {
    expect(await new CompanyCalendar(db).addWorkingDays('2026-11-16', 5)).toBe('2026-11-23');
  });

  it('skip its public holidays', async () => {
    await holiday('2026-11-18');
    await holiday('2026-11-23');

    expect(await new CompanyCalendar(db).addWorkingDays('2026-11-16', 5)).toBe('2026-11-25');
  });

  it('ignore holidays on or before the day counted from', async () => {
    await holiday('2026-11-16');

    expect(await new CompanyCalendar(db).addWorkingDays('2026-11-16', 1)).toBe('2026-11-17');
  });

  it('follow the default week when it changes', async () => {
    await admin.query(
      `UPDATE work_pattern_day SET is_working_day = true
        WHERE day_of_week = 6
          AND work_pattern_id = (SELECT id FROM work_pattern WHERE is_default)`,
    );

    expect(await new CompanyCalendar(db).addWorkingDays('2026-11-20', 1)).toBe('2026-11-21');
  });
});
