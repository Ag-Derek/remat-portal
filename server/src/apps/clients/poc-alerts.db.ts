/**
 * The POC flags the morning alerts have told each person about. #290.
 *
 * Written by the system alone, so nothing here goes through `recording()`, and the table is not
 * audited. Nothing about the POC is changed.
 */

import type { Kysely } from 'kysely';
import type { CalendarDate } from '../../core/calendar/time.js';
import type { Database } from '../../core/db/index.js';
import { EmailOutboxRepository } from '../../core/notification/outbox.db.js';
import { type NewOutboxEmail, validateOutboxEmail } from '../../core/notification/outbox.js';
import { type FlagTold, toldToKeyOf } from './poc-alerts.js';

/** What became of one person's alert. */
export type AlertQueued = 'QUEUED' | 'ALREADY_QUEUED';

export class ClientsPocAlertRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** The flags on these POCs told to anybody, as `toldToKeyOf` keys. */
  async toldOf(pocIds: readonly string[]): Promise<Set<string>> {
    if (pocIds.length === 0) {
      return new Set();
    }

    const rows = await this.db
      .selectFrom('clients_poc_alert')
      .select(['poc_id', 'flag', 'since', 'recipient_id'])
      .where('poc_id', 'in', pocIds)
      .execute();

    return new Set(
      rows.map((row) =>
        toldToKeyOf(row.recipient_id, {
          pocId: row.poc_id,
          kind: row.flag as FlagTold['kind'],
          since: row.since,
        }),
      ),
    );
  }

  /**
   * Queues one person's alert email and records the flags it tells them, in one transaction
   * (task 4): both or neither. An email the outbox has already, by its dedupe key, still has its
   * flags recorded, which is what two runs at once need. Throws where it could not be queued, and
   * then nothing is recorded.
   */
  async queueWith(
    email: NewOutboxEmail,
    recipientId: string,
    flags: readonly FlagTold[],
    day: CalendarDate,
  ): Promise<AlertQueued> {
    return this.db.transaction().execute(async (trx) => {
      const queued = await new EmailOutboxRepository(trx).queue(validateOutboxEmail(email));

      if (flags.length > 0) {
        await trx
          .insertInto('clients_poc_alert')
          .values(
            flags.map((flag) => ({
              poc_id: flag.pocId,
              flag: flag.kind,
              since: flag.since,
              recipient_id: recipientId,
              alerted_on: day,
            })),
          )
          .onConflict((conflict) =>
            conflict.columns(['poc_id', 'flag', 'since', 'recipient_id']).doNothing(),
          )
          .execute();
      }

      return queued === undefined ? 'ALREADY_QUEUED' : 'QUEUED';
    });
  }
}
