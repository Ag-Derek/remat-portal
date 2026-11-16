/**
 * Database access for a client's contacts. #276, Clients SRS CLI 03, CLI 05.
 *
 * Every write goes through `recording()`, so the audit trigger knows who made it (NFR CLI AUD
 * 01). Nothing here deletes; a contact is removed by a date, and lms_app holds no DELETE.
 */

import { type Kysely, type Selectable, sql } from 'kysely';
import type { Attribution } from '../../core/audit/audit.js';
import type { Database } from '../../core/db/index.js';
import { recording } from '../../core/db/recording.js';
import type { ClientsContactTable } from '../../core/db/schema.js';
import type { Contact, ContactChange, NewContact } from './contact.js';

export class ClientsContactRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** A client's contacts by name, removed ones included and marked. */
  async of(clientId: string): Promise<Contact[]> {
    const rows = await this.db
      .selectFrom('clients_contact')
      .selectAll()
      .where('client_id', '=', clientId)
      .orderBy('name')
      .orderBy('id')
      .execute();

    return rows.map(contactFrom);
  }

  async find(id: string): Promise<Contact | undefined> {
    const row = await this.db
      .selectFrom('clients_contact')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : contactFrom(row);
  }

  async add(by: Attribution, clientId: string, contact: NewContact): Promise<Contact> {
    return recording(this.db, by, async (on) =>
      contactFrom(
        await on
          .insertInto('clients_contact')
          .values({
            client_id: clientId,
            name: contact.name,
            job_title: contact.jobTitle,
            email: contact.email,
            phone: contact.phone,
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      ),
    );
  }

  /** Changes what the request asked to change and nothing else. */
  async change(by: Attribution, id: string, change: ContactChange): Promise<void> {
    const values = {
      ...(change.name === undefined ? {} : { name: change.name }),
      ...(change.jobTitle === undefined ? {} : { job_title: change.jobTitle }),
      ...(change.email === undefined ? {} : { email: change.email }),
      ...(change.phone === undefined ? {} : { phone: change.phone }),
    };

    if (Object.keys(values).length === 0) {
      return;
    }

    await recording(this.db, by, (on) =>
      on.updateTable('clients_contact').set(values).where('id', '=', id).execute(),
    );
  }

  /**
   * Removes a contact now, by the database's clock, which also stamped when they were added.
   * Already removed keeps the moment it first was.
   */
  async remove(by: Attribution, id: string): Promise<void> {
    await recording(this.db, by, (on) =>
      on
        .updateTable('clients_contact')
        .set({ removed_at: sql<Date>`now()` })
        .where('id', '=', id)
        .where('removed_at', 'is', null)
        .execute(),
    );
  }

  async restore(by: Attribution, id: string): Promise<void> {
    await recording(this.db, by, (on) =>
      on
        .updateTable('clients_contact')
        .set({ removed_at: null })
        .where('id', '=', id)
        .where('removed_at', 'is not', null)
        .execute(),
    );
  }
}

function contactFrom(row: Selectable<ClientsContactTable>): Contact {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    jobTitle: row.job_title,
    email: row.email,
    phone: row.phone,
    createdAt: row.created_at,
    removedAt: row.removed_at,
  };
}
