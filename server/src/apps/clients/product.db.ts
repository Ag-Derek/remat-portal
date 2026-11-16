/**
 * Database access for product lines and products. #293, Clients TDD 4.1.
 *
 * Every write goes through `recording()`, so the audit trigger on both tables knows who made it
 * (NFR CLI AUD 01). Nothing here deletes; lms_app holds no DELETE on either table.
 */

import type { Kysely, Selectable } from 'kysely';
import type { Attribution } from '../../core/audit/audit.js';
import type { CalendarDate } from '../../core/calendar/time.js';
import type { Database } from '../../core/db/index.js';
import { recording } from '../../core/db/recording.js';
import type { ClientsProductLineTable, ClientsProductTable } from '../../core/db/schema.js';
import { ClientsNameTaken, type Product, type ProductLine } from './product.js';

/** The unique indexes that hold each name to one row, ignoring case and spaces. */
const NAME_TAKEN: Readonly<Record<string, 'line' | 'product'>> = {
  uq_clients_line_name: 'line',
  uq_clients_product_name: 'product',
};

export class ClientsProductRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Every line with its products, both by name, retired ones included. */
  async lines(): Promise<ProductLine[]> {
    const [lines, products] = await Promise.all([
      this.db.selectFrom('clients_product_line').selectAll().orderBy('name').execute(),
      this.db.selectFrom('clients_product').selectAll().orderBy('name').execute(),
    ]);

    return lines.map((line) => ({
      ...lineFrom(line),
      products: products.filter((one) => one.line_id === line.id).map(productFrom),
    }));
  }

  async findLine(id: string): Promise<ProductLine | undefined> {
    return (await this.lines()).find((line) => line.id === id);
  }

  async findProduct(id: string): Promise<Product | undefined> {
    const row = await this.db
      .selectFrom('clients_product')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : productFrom(row);
  }

  async addLine(by: Attribution, name: string): Promise<ProductLine> {
    return named(name, () =>
      recording(this.db, by, async (on) => {
        const row = await on
          .insertInto('clients_product_line')
          .values({ name })
          .returningAll()
          .executeTakeFirstOrThrow();

        return { ...lineFrom(row), products: [] };
      }),
    );
  }

  async addProduct(by: Attribution, lineId: string, name: string): Promise<Product> {
    return named(name, () =>
      recording(this.db, by, async (on) =>
        productFrom(
          await on
            .insertInto('clients_product')
            .values({ line_id: lineId, name })
            .returningAll()
            .executeTakeFirstOrThrow(),
        ),
      ),
    );
  }

  /** Renames a line. False where there is no such line. */
  async renameLine(by: Attribution, id: string, name: string): Promise<boolean> {
    return named(name, () =>
      recording(this.db, by, async (on) => {
        const result = await on
          .updateTable('clients_product_line')
          .set({ name })
          .where('id', '=', id)
          .executeTakeFirst();

        return result.numUpdatedRows > 0n;
      }),
    );
  }

  async renameProduct(by: Attribution, id: string, name: string): Promise<boolean> {
    return named(name, () =>
      recording(this.db, by, async (on) => {
        const result = await on
          .updateTable('clients_product')
          .set({ name })
          .where('id', '=', id)
          .executeTakeFirst();

        return result.numUpdatedRows > 0n;
      }),
    );
  }

  /**
   * Retires a line and, with it, every product in it still taking deals, on the same day and in
   * one transaction: a line that takes no new deals cannot hold a product that does. Retiring
   * what is already retired changes nothing, so the day it first stopped is kept.
   */
  async retireLine(by: Attribution, id: string, on: CalendarDate): Promise<void> {
    await recording(this.db, by, async (db) => {
      await db
        .updateTable('clients_product_line')
        .set({ retired_on: on })
        .where('id', '=', id)
        .where('retired_on', 'is', null)
        .execute();

      await db
        .updateTable('clients_product')
        .set({ retired_on: on })
        .where('line_id', '=', id)
        .where('retired_on', 'is', null)
        .execute();
    });
  }

  /** Retires one product. Already retired keeps the day it first was. */
  async retireProduct(by: Attribution, id: string, on: CalendarDate): Promise<void> {
    await recording(this.db, by, (db) =>
      db
        .updateTable('clients_product')
        .set({ retired_on: on })
        .where('id', '=', id)
        .where('retired_on', 'is', null)
        .execute(),
    );
  }

  /**
   * Brings a line back. Its products stay as they are, each restored on its own: the line may
   * have been retired with some of them already retired for reasons of their own.
   */
  async restoreLine(by: Attribution, id: string): Promise<void> {
    await recording(this.db, by, (db) =>
      db
        .updateTable('clients_product_line')
        .set({ retired_on: null })
        .where('id', '=', id)
        .where('retired_on', 'is not', null)
        .execute(),
    );
  }

  async restoreProduct(by: Attribution, id: string): Promise<void> {
    await recording(this.db, by, (db) =>
      db
        .updateTable('clients_product')
        .set({ retired_on: null })
        .where('id', '=', id)
        .where('retired_on', 'is not', null)
        .execute(),
    );
  }
}

/** Runs a write that sets a name, turning a name already taken into the sentence for it. */
async function named<T>(name: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const what = NAME_TAKEN[String((error as { constraint?: unknown }).constraint)];

    if (what !== undefined) {
      throw new ClientsNameTaken(what, name);
    }
    throw error;
  }
}

function lineFrom(row: Selectable<ClientsProductLineTable>): Omit<ProductLine, 'products'> {
  return { id: row.id, name: row.name, retiredOn: row.retired_on };
}

function productFrom(row: Selectable<ClientsProductTable>): Product {
  return { id: row.id, lineId: row.line_id, name: row.name, retiredOn: row.retired_on };
}
