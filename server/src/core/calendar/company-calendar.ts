/**
 * The company's working days, read from the database. Clients TDD 6.4.
 *
 * The week is the default work pattern, which every database has exactly one of, and the
 * holidays are the public holiday calendar HR keeps (FR 22). Holidays are read here rather than
 * through leave, whose screens write them, because core may not import an app; the table is the
 * company's calendar, and reading it is not leave's business.
 */

import type { Kysely } from 'kysely';
import type { Database } from '../db/index.js';
import type { CalendarDate } from './time.js';
import { WorkPatternRepository } from './work-pattern/work-pattern.db.js';
import { addWorkingDays, type WorkingWeek } from './working-days.js';

export class CompanyCalendar {
  private readonly patterns: Pick<WorkPatternRepository, 'findDefault'>;

  constructor(private readonly db: Kysely<Database>) {
    this.patterns = new WorkPatternRepository(db);
  }

  /** The working day `count` working days after `day`, by the company's week and holidays. */
  async addWorkingDays(day: CalendarDate, count: number): Promise<CalendarDate> {
    return addWorkingDays(day, count, await this.weekFrom(day));
  }

  /**
   * The default week, and every holiday after `day`. Every one rather than a guessed window: the
   * calendar holds tens a year, and a window too short would count a holiday as a working day.
   */
  private async weekFrom(day: CalendarDate): Promise<WorkingWeek> {
    const [pattern, holidays] = await Promise.all([
      this.patterns.findDefault(),
      this.db
        .selectFrom('holiday')
        .select('holiday_date')
        .where('holiday_date', '>', day)
        .execute(),
    ]);

    if (pattern === undefined) {
      throw new Error('There is no default work pattern, so no working day can be counted.');
    }

    return {
      workingDays: pattern.workingDays,
      holidays: new Set(holidays.map((holiday) => holiday.holiday_date)),
    };
  }
}
