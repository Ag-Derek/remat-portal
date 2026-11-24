/**
 * What the morning reminders read. #290.
 *
 * Reads and nothing else: a reminder never changes the thing it is about ("notifications never
 * change anything").
 */

import { type Kysely, sql } from 'kysely';
import type { CalendarDate } from '../../core/calendar/time.js';
import type { Database } from '../../core/db/index.js';
import type { Recipient } from './email.js';
import type { ReminderWindow, StepToRemind } from './reminders.js';

/** An open step, and the owner it would be sent to. */
export interface StepAndOwner {
  step: StepToRemind;
  owner: Recipient;
}

export class ClientsReminderRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Every open next step due in the window, whatever made it and whatever its deal's outcome. */
  async openStepsDueIn(window: ReminderWindow): Promise<StepAndOwner[]> {
    const rows = await this.db
      .selectFrom('clients_next_step as s')
      .innerJoin('clients_client as c', 'c.id', 's.client_id')
      .leftJoin('clients_opportunity as o', 'o.id', 's.opportunity_id')
      .leftJoin('clients_product as p', 'p.id', 'o.product_id')
      .innerJoin('employee as owner', 'owner.id', 's.owner_id')
      .select([
        's.id',
        'c.id as client_id',
        'c.name as client_name',
        'p.name as product_name',
        's.description',
        sql<CalendarDate>`s.due_on::text`.as('due_on'),
        'owner.id as owner_id',
        'owner.first_name as owner_first_name',
        'owner.work_email as owner_email',
      ])
      .where('s.done_at', 'is', null)
      .where('s.due_on', '>=', window.from)
      .where('s.due_on', '<', window.before)
      .orderBy('s.id')
      .execute();

    return rows.map((row) => ({
      step: {
        id: row.id,
        client: { id: row.client_id, name: row.client_name },
        productName: row.product_name,
        description: row.description,
        dueOn: row.due_on,
        ownerId: row.owner_id,
      },
      owner: { id: row.owner_id, firstName: row.owner_first_name, workEmail: row.owner_email },
    }));
  }
}
