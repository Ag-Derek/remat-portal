/**
 * Database access for clients and client types. #276, Clients SRS CLI 02, CLI 05.
 *
 * Every write goes through `recording()`, so the audit trigger knows who made it (NFR CLI AUD
 * 01). Nothing here deletes; lms_app holds no DELETE on either table.
 */

import { type Kysely, type Selectable, sql } from 'kysely';
import type { Attribution } from '../../core/audit/audit.js';
import type { Database } from '../../core/db/index.js';
import { recording } from '../../core/db/recording.js';
import type { CalendarDate } from '../../core/calendar/time.js';
import type { ClientsClientTypeTable } from '../../core/db/schema.js';
import {
  type Client,
  ClientAlreadyRecorded,
  type ClientChange,
  type ClientSummary,
  type ClientType,
  type NewClient,
  type Person,
} from './client.js';
import { ClientsNameTaken } from './product.js';

/** The unique index that holds each client to one row, whatever its case or spacing. */
const ONE_CLIENT_PER_NAME = 'uq_clients_client_name';
const ONE_TYPE_PER_NAME = 'uq_clients_client_type_name';

export class ClientsClientRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Every client type by name, retired ones included. */
  async types(): Promise<ClientType[]> {
    const rows = await this.db
      .selectFrom('clients_client_type')
      .selectAll()
      .orderBy('name')
      .execute();

    return rows.map(typeFrom);
  }

  async findType(id: string): Promise<ClientType | undefined> {
    const row = await this.db
      .selectFrom('clients_client_type')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : typeFrom(row);
  }

  /**
   * One client, with its type's and owner's names. Its contacts, products and deals are other
   * repositories'.
   */
  async find(
    id: string,
  ): Promise<Omit<Client, 'contacts' | 'products' | 'opportunities'> | undefined> {
    const row = await this.db
      .selectFrom('clients_client as c')
      .innerJoin('clients_client_type as t', 't.id', 'c.type_id')
      .innerJoin('employee as e', 'e.id', 'c.owner_id')
      .select([
        'c.id',
        'c.name',
        'c.note',
        'c.created_at',
        't.id as type_id',
        't.name as type_name',
        'e.id as owner_id',
        sql<string>`e.first_name || ' ' || e.last_name`.as('owner_name'),
      ])
      .where('c.id', '=', id)
      .executeTakeFirst();

    return row === undefined
      ? undefined
      : {
          id: row.id,
          name: row.name,
          type: { id: row.type_id, name: row.type_name },
          owner: { id: row.owner_id, name: row.owner_name },
          note: row.note,
          createdAt: row.created_at,
        };
  }

  /**
   * Records a new client, owned by `ownerId`. A name another client already has, whatever its
   * case or spacing, is refused by the database and answered with that client's name.
   */
  async create(by: Attribution, client: NewClient, ownerId: string): Promise<string> {
    try {
      return await recording(this.db, by, async (on) => {
        const row = await on
          .insertInto('clients_client')
          .values({
            name: client.name,
            type_id: client.typeId,
            owner_id: ownerId,
            note: client.note,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        return row.id;
      });
    } catch (error) {
      throw await this.alreadyRecorded(error, client.name);
    }
  }

  /**
   * Changes what the request asked to change and nothing else. A name another client already
   * has is refused as it is on creating one.
   */
  async change(by: Attribution, id: string, change: ClientChange): Promise<void> {
    const values = {
      ...(change.name === undefined ? {} : { name: change.name }),
      ...(change.typeId === undefined ? {} : { type_id: change.typeId }),
      ...(change.ownerId === undefined ? {} : { owner_id: change.ownerId }),
      ...(change.note === undefined ? {} : { note: change.note }),
    };

    if (Object.keys(values).length === 0) {
      return;
    }

    try {
      await recording(this.db, by, (on) =>
        on.updateTable('clients_client').set(values).where('id', '=', id).execute(),
      );
    } catch (error) {
      throw await this.alreadyRecorded(error, change.name ?? '');
    }
  }

  /** Every client by name, with its type's and owner's names: the clients list. */
  async list(): Promise<ClientSummary[]> {
    const rows = await this.db
      .selectFrom('clients_client as c')
      .innerJoin('clients_client_type as t', 't.id', 'c.type_id')
      .innerJoin('employee as e', 'e.id', 'c.owner_id')
      .select([
        'c.id',
        'c.name',
        't.id as type_id',
        't.name as type_name',
        'e.id as owner_id',
        sql<string>`e.first_name || ' ' || e.last_name`.as('owner_name'),
      ])
      .orderBy(sql`lower(c.name)`)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: { id: row.type_id, name: row.type_name },
      owner: { id: row.owner_id, name: row.owner_name },
    }));
  }

  /** Everybody holding a clients role today, by surname: whom a client may be moved to. */
  async holders(): Promise<Person[]> {
    const rows = await this.db
      .selectFrom('employee as e')
      .select(['e.id', sql<string>`e.first_name || ' ' || e.last_name`.as('name')])
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('clients_role as r')
            .select('r.id')
            .whereRef('r.employee_id', '=', 'e.id')
            .where('r.ended_at', 'is', null),
        ),
      )
      .orderBy('e.last_name')
      .orderBy('e.first_name')
      .execute();

    return rows.map((row) => ({ id: row.id, name: row.name }));
  }

  /* -------------------------------------------------- client types, a BD manager's */

  async addType(by: Attribution, name: string): Promise<ClientType> {
    return typeNamed(name, () =>
      recording(this.db, by, async (on) =>
        typeFrom(
          await on
            .insertInto('clients_client_type')
            .values({ name })
            .returningAll()
            .executeTakeFirstOrThrow(),
        ),
      ),
    );
  }

  async renameType(by: Attribution, id: string, name: string): Promise<void> {
    await typeNamed(name, () =>
      recording(this.db, by, (on) =>
        on.updateTable('clients_client_type').set({ name }).where('id', '=', id).execute(),
      ),
    );
  }

  /** Retires a type today. Already retired keeps the day it first was. */
  async retireType(by: Attribution, id: string, on: CalendarDate): Promise<void> {
    await recording(this.db, by, (db) =>
      db
        .updateTable('clients_client_type')
        .set({ retired_on: on })
        .where('id', '=', id)
        .where('retired_on', 'is', null)
        .execute(),
    );
  }

  async restoreType(by: Attribution, id: string): Promise<void> {
    await recording(this.db, by, (db) =>
      db
        .updateTable('clients_client_type')
        .set({ retired_on: null })
        .where('id', '=', id)
        .where('retired_on', 'is not', null)
        .execute(),
    );
  }

  /** The sentence for a name already taken, or the error as it was. */
  private async alreadyRecorded(error: unknown, name: string): Promise<unknown> {
    if ((error as { constraint?: unknown }).constraint !== ONE_CLIENT_PER_NAME) {
      return error;
    }

    const existing = await this.db
      .selectFrom('clients_client')
      .select('name')
      .where(sql<string>`clients_name_key(name)`, '=', sql<string>`clients_name_key(${name})`)
      .executeTakeFirst();

    return new ClientAlreadyRecorded(existing?.name ?? name);
  }
}

/** Runs a write that names a type, turning a name already taken into the sentence for it. */
async function typeNamed<T>(name: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if ((error as { constraint?: unknown }).constraint === ONE_TYPE_PER_NAME) {
      throw new ClientsNameTaken('client type', name);
    }
    throw error;
  }
}

function typeFrom(row: Selectable<ClientsClientTypeTable>): ClientType {
  return { id: row.id, name: row.name, retiredOn: row.retired_on };
}
