/**
 * Database access for the lost and exit reasons. #279, Clients SRS CLI 54, TDD 4.5.
 *
 * Read here, and kept here by a BD manager through the setup service; ending a deal for one is
 * the opportunity repository's, which writes the deal and its history together. Every write goes
 * through `recording()`, so the audit trigger knows who made it (NFR CLI AUD 01).
 */

import { type Kysely, sql } from 'kysely';
import type { Attribution } from '../../core/audit/audit.js';
import type { CalendarDate } from '../../core/calendar/time.js';
import type { Database } from '../../core/db/index.js';
import { recording } from '../../core/db/recording.js';
import {
  type Reason,
  ReasonInUse,
  type ReasonInSetup,
  ReasonLabelTaken,
  type ReasonList,
} from './reason.js';

/** The unique index that names each reason once on its list. */
const ONE_PER_LABEL = 'uq_clients_reason_label';

/** The trigger that keeps a used reason's words. */
const WORDS_KEPT = 'clients_reason_words_kept_once_used';

/** The deal's foreign key to its reason, which keeps a used reason from being deleted. */
const KEPT_BY_ITS_DEALS = 'clients_opportunity_reason_id_fkey';

export class ClientsReasonRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Both lists, retired reasons included, each in the order its reasons were added. */
  async all(): Promise<Reason[]> {
    return (await this.inSetup()).map((reason) => ({
      id: reason.id,
      appliesTo: reason.appliesTo,
      label: reason.label,
      retiredOn: reason.retiredOn,
    }));
  }

  /** Both lists as the setup screen shows them: each reason, and whether a deal ended for it. */
  async inSetup(): Promise<ReasonInSetup[]> {
    const rows = await this.query().orderBy('r.applies_to').orderBy('r.id').execute();

    return rows.map(reasonFrom);
  }

  async find(id: string): Promise<ReasonInSetup | undefined> {
    const row = await this.query().where('r.id', '=', id).executeTakeFirst();

    return row === undefined ? undefined : reasonFrom(row);
  }

  async add(by: Attribution, appliesTo: ReasonList, label: string): Promise<ReasonInSetup> {
    const id = await labelled(appliesTo, label, () =>
      recording(this.db, by, async (on) => {
        const row = await on
          .insertInto('clients_reason')
          .values({ applies_to: appliesTo, label })
          .returning('id')
          .executeTakeFirstOrThrow();

        return row.id;
      }),
    );

    return { id, appliesTo, label, retiredOn: null, inUse: false };
  }

  /** New words for a reason no deal has ended for; refused by the database for one that has. */
  async reword(by: Attribution, reason: Reason, label: string): Promise<void> {
    try {
      await labelled(reason.appliesTo, label, () =>
        recording(this.db, by, (on) =>
          on.updateTable('clients_reason').set({ label }).where('id', '=', reason.id).execute(),
        ),
      );
    } catch (error) {
      if ((error as { constraint?: unknown }).constraint === WORDS_KEPT) {
        throw new ReasonInUse(reason.label, 'reword');
      }
      throw error;
    }
  }

  /** Retires a reason today. Already retired keeps the day it first was. */
  async retire(by: Attribution, id: string, today: CalendarDate): Promise<void> {
    await recording(this.db, by, (on) =>
      on
        .updateTable('clients_reason')
        .set({ retired_on: today })
        .where('id', '=', id)
        .where('retired_on', 'is', null)
        .execute(),
    );
  }

  async restore(by: Attribution, id: string): Promise<void> {
    await recording(this.db, by, (on) =>
      on
        .updateTable('clients_reason')
        .set({ retired_on: null })
        .where('id', '=', id)
        .where('retired_on', 'is not', null)
        .execute(),
    );
  }

  /** Deletes a reason no deal has ended for; refused by the database for one that has. */
  async delete(by: Attribution, reason: Reason): Promise<void> {
    try {
      await recording(this.db, by, (on) =>
        on.deleteFrom('clients_reason').where('id', '=', reason.id).execute(),
      );
    } catch (error) {
      if ((error as { constraint?: unknown }).constraint === KEPT_BY_ITS_DEALS) {
        throw new ReasonInUse(reason.label, 'delete');
      }
      throw error;
    }
  }

  private query() {
    return this.db
      .selectFrom('clients_reason as r')
      .select([
        'r.id',
        'r.applies_to',
        'r.label',
        'r.retired_on',
        sql<boolean>`EXISTS (SELECT 1 FROM clients_opportunity o WHERE o.reason_id = r.id)`.as(
          'in_use',
        ),
      ]);
  }
}

/** Runs a write that names a reason, turning words already on its list into the sentence. */
async function labelled<T>(appliesTo: ReasonList, label: string, write: () => Promise<T>) {
  try {
    return await write();
  } catch (error) {
    if ((error as { constraint?: unknown }).constraint === ONE_PER_LABEL) {
      throw new ReasonLabelTaken(appliesTo, label);
    }
    throw error;
  }
}

function reasonFrom(row: {
  id: string;
  applies_to: string;
  label: string;
  retired_on: string | null;
  in_use: boolean;
}): ReasonInSetup {
  return {
    id: row.id,
    appliesTo: row.applies_to as ReasonList,
    label: row.label,
    retiredOn: row.retired_on,
    inUse: row.in_use,
  };
}
