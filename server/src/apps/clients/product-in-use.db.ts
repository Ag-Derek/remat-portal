/**
 * Database access for the products a client already uses. #276, Clients SRS CLI 04, TDD 4.1.
 *
 * Every write goes through `recording()`, so the audit trigger knows who made it (NFR CLI AUD
 * 01). Nothing here deletes; a client that stops using a product is given an end date.
 */

import type { Kysely } from 'kysely';
import type { Attribution } from '../../core/audit/audit.js';
import type { Database } from '../../core/db/index.js';
import { recording } from '../../core/db/recording.js';
import type { NewProductInUse, ProductInUse, ProductInUseChange } from './product-in-use.js';

/** A product as adding it to a client needs it. */
export interface OfferedProduct {
  id: string;
  name: string;
  /** It, or its line, is retired. */
  retired: boolean;
}

/** The unique index that holds each product to once per client. */
const ONCE_PER_CLIENT = 'uq_clients_client_product';

/** Refused as already there, by the unique index. */
export class AlreadyThere extends Error {
  constructor() {
    super('The product is on this client already.');
    this.name = 'AlreadyThere';
  }
}

export class ClientsProductInUseRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Everything a client uses or has used, by product name. */
  async of(clientId: string): Promise<ProductInUse[]> {
    return this.query().where('cp.client_id', '=', clientId).execute();
  }

  async find(clientId: string, productId: string): Promise<ProductInUse | undefined> {
    return this.query()
      .where('cp.client_id', '=', clientId)
      .where('cp.product_id', '=', productId)
      .executeTakeFirst();
  }

  /**
   * Every product that may still be added to a client, neither it nor its line retired, by line
   * and then by name: what the form offers.
   */
  async offered(): Promise<{ id: string; name: string; lineName: string }[]> {
    return this.db
      .selectFrom('clients_product as p')
      .innerJoin('clients_product_line as l', 'l.id', 'p.line_id')
      .select(['p.id', 'p.name', 'l.name as lineName'])
      .where('p.retired_on', 'is', null)
      .where('l.retired_on', 'is', null)
      .orderBy('l.name')
      .orderBy('p.name')
      .execute();
  }

  /** A product, and whether it or its line is retired. */
  async product(id: string): Promise<OfferedProduct | undefined> {
    const row = await this.db
      .selectFrom('clients_product as p')
      .innerJoin('clients_product_line as l', 'l.id', 'p.line_id')
      .select(['p.id', 'p.name', 'p.retired_on', 'l.retired_on as line_retired_on'])
      .where('p.id', '=', id)
      .executeTakeFirst();

    return row === undefined
      ? undefined
      : {
          id: row.id,
          name: row.name,
          retired: row.retired_on !== null || row.line_retired_on !== null,
        };
  }

  /** Adds a product by hand. One already on the client is refused by the database. */
  async add(by: Attribution, clientId: string, product: NewProductInUse): Promise<void> {
    try {
      await recording(this.db, by, (on) =>
        on
          .insertInto('clients_client_product')
          .values({ client_id: clientId, product_id: product.productId, since_on: product.sinceOn })
          .execute(),
      );
    } catch (error) {
      if ((error as { constraint?: unknown }).constraint === ONCE_PER_CLIENT) {
        throw new AlreadyThere();
      }
      throw error;
    }
  }

  /** Changes the dates the request asked to change, and nothing else. */
  async change(
    by: Attribution,
    clientId: string,
    productId: string,
    change: ProductInUseChange,
  ): Promise<void> {
    const values = {
      ...(change.sinceOn === undefined ? {} : { since_on: change.sinceOn }),
      ...(change.endedOn === undefined ? {} : { ended_on: change.endedOn }),
    };

    if (Object.keys(values).length === 0) {
      return;
    }

    await recording(this.db, by, (on) =>
      on
        .updateTable('clients_client_product')
        .set(values)
        .where('client_id', '=', clientId)
        .where('product_id', '=', productId)
        .execute(),
    );
  }

  private query() {
    return this.db
      .selectFrom('clients_client_product as cp')
      .innerJoin('clients_product as p', 'p.id', 'cp.product_id')
      .innerJoin('clients_product_line as l', 'l.id', 'p.line_id')
      .select([
        'cp.product_id as productId',
        'p.name as productName',
        'l.name as lineName',
        'cp.since_on as sinceOn',
        'cp.ended_on as endedOn',
        'cp.won_by as wonBy',
      ])
      .orderBy('p.name');
  }
}
