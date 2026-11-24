/**
 * The days the clients morning notifications have run for. #290.
 *
 * Written by the system alone, once a run has finished, so nothing here goes through
 * `recording()`: there is nobody to attribute it to, and the table is not audited.
 */

import { type Kysely, sql } from 'kysely';
import type { CalendarDate } from '../../core/calendar/time.js';
import type { Database } from '../../core/db/index.js';

export class ClientsNotificationRunRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Whether the notifications have run for `day`. */
  async hasRunOn(day: CalendarDate): Promise<boolean> {
    const row = await this.db
      .selectFrom('clients_notification_run')
      .select('run_on')
      .where('run_on', '=', day)
      .executeTakeFirst();

    return row !== undefined;
  }

  /**
   * The days they ran for before `day`, latest first, back as far as the company calendar reads
   * holidays (400 days), which is as far as a catch-up can tell a working day from another.
   */
  async daysRunBefore(day: CalendarDate): Promise<CalendarDate[]> {
    const rows = await this.db
      .selectFrom('clients_notification_run')
      .select(sql<CalendarDate>`run_on::text`.as('run_on'))
      .where('run_on', '<', day)
      .where('run_on', '>=', sql<CalendarDate>`${day}::date - 400`)
      .orderBy('run_on', 'desc')
      .execute();

    return rows.map((row) => row.run_on);
  }

  /** Records that they have run for `day`. A second record of the same day is no change. */
  async record(day: CalendarDate): Promise<void> {
    await this.db
      .insertInto('clients_notification_run')
      .values({ run_on: day })
      .onConflict((conflict) => conflict.column('run_on').doNothing())
      .execute();
  }
}
