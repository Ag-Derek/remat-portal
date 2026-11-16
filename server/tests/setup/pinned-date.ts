import { pinCurrentDate } from '../../src/core/calendar/time.js';

/**
 * The day the integration suite is having, whatever day it runs.
 *
 * The fixtures book leave on dates in 2026, and the services judge notice, whether leave has
 * started and which year it is against today. Read off the real clock, a suite passes on the
 * afternoon it was written and fails the week after, when a week it books has started, or in
 * December, when "three weeks ahead" is next year and the holidays have not been gazetted.
 *
 * A Friday, and the last day the whole suite was green against the real clock.
 *
 * Only the calendar is pinned. Instants are still `new Date()` and the database's `now()`, so
 * a test about when something happened, or about a code that runs out, is unaffected. The
 * database's `current_date` cannot be pinned from here either, so a file that tests a trigger
 * reading it lets the pin go with `pinCurrentDate(null)` and works from the real day.
 */
export const PINNED_DATE = '2026-10-30';

pinCurrentDate(PINNED_DATE);
