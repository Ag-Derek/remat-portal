/**
 * Database access for notes on a client. #278.
 *
 * Every write goes through `recording()`, so the audit trigger knows who made it (NFR CLI AUD
 * 01). Nothing here deletes; a note is archived instead.
 */

import { type Kysely, sql } from 'kysely';
import type { Attribution } from '../../core/audit/audit.js';
import type { Database } from '../../core/db/index.js';
import { recording } from '../../core/db/recording.js';
import type { ClientNote, NewNote, NoteChange } from './note.js';

export class ClientsNoteRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** A client's notes, newest first, archived ones included. */
  async of(clientId: string): Promise<ClientNote[]> {
    const rows = await notes(this.db)
      .where('n.client_id', '=', clientId)
      .orderBy('n.written_at', 'desc')
      .orderBy('n.id', 'desc')
      .execute();

    return rows.map(noteFrom);
  }

  /** One note, and the client it is on. */
  async find(id: string): Promise<(ClientNote & { clientId: string }) | undefined> {
    const row = await notes(this.db).where('n.id', '=', id).executeTakeFirst();

    return row === undefined ? undefined : { ...noteFrom(row), clientId: row.client_id };
  }

  async add(by: Attribution, clientId: string, note: NewNote, writtenBy: string): Promise<string> {
    return recording(this.db, by, async (on) => {
      const row = await on
        .insertInto('clients_client_note')
        .values({
          client_id: clientId,
          heading: note.heading,
          body: note.body,
          written_by: writtenBy,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      return row.id;
    });
  }

  /** Changes what the request asked to change, and marks when. */
  async change(by: Attribution, id: string, change: NoteChange): Promise<void> {
    const values = {
      ...(change.heading === undefined ? {} : { heading: change.heading }),
      ...(change.body === undefined ? {} : { body: change.body }),
    };

    if (Object.keys(values).length === 0) {
      return;
    }

    await recording(this.db, by, (on) =>
      on
        .updateTable('clients_client_note')
        .set({ ...values, edited_at: sql<Date>`now()` })
        .where('id', '=', id)
        .execute(),
    );
  }

  /** Archives it, or brings it back. Archiving one already archived keeps when it first was. */
  async archive(by: Attribution, id: string, archived: boolean): Promise<void> {
    await recording(this.db, by, (on) =>
      on
        .updateTable('clients_client_note')
        .set({ archived_at: archived ? sql<Date>`coalesce(archived_at, now())` : null })
        .where('id', '=', id)
        .execute(),
    );
  }
}

/** Every note, with the name of whoever wrote it. */
function notes(db: Kysely<Database>) {
  return db
    .selectFrom('clients_client_note as n')
    .innerJoin('employee as e', 'e.id', 'n.written_by')
    .select([
      'n.id',
      'n.client_id',
      'n.heading',
      'n.body',
      'n.written_at',
      'n.edited_at',
      'n.archived_at',
      'e.id as written_by',
      sql<string>`e.first_name || ' ' || e.last_name`.as('written_by_name'),
    ]);
}

type Row = Awaited<ReturnType<ReturnType<typeof notes>['executeTakeFirstOrThrow']>>;

function noteFrom(row: Row): ClientNote {
  return {
    id: row.id,
    heading: row.heading,
    body: row.body,
    writtenBy: { id: row.written_by, name: row.written_by_name },
    writtenAt: row.written_at,
    editedAt: row.edited_at,
    archivedAt: row.archived_at,
  };
}
