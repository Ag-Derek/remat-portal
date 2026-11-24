/**
 * Database access for the checklists themselves, as a BD manager keeps them on the setup screen.
 * #284, Clients SRS CLI 39, CLI 40, CLI 42, TDD 4.4.
 *
 * The template a deal's or POC's checks are copied from. Changing it changes no copy already
 * taken (CLI 40). Every write goes through `recording()`, so the audit trigger knows who made it
 * (NFR CLI AUD 01). Nothing is deleted: an item no longer wanted is retired.
 */

import { type Kysely, sql } from 'kysely';
import type { Attribution } from '../../core/audit/audit.js';
import type { CalendarDate } from '../../core/calendar/time.js';
import type { Database } from '../../core/db/index.js';
import { recording } from '../../core/db/recording.js';
import {
  CHECKLIST_GROUPS,
  type ChecklistGroup,
  type ChecklistItem,
  type ChecklistItemChange,
  ChecklistItemLabelTaken,
  ChecklistNotEmpty,
  type NewChecklistItem,
} from './checklist.js';

/** The unique index naming each item once in its group of a checklist. */
const ONE_PER_LABEL = 'uq_clients_checklist_item_label';

/** One checklist: a product line and a client type. */
export interface WhichChecklist {
  lineId: string;
  clientTypeId: string;
}

export class ClientsChecklistItemRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** A checklist's items, retired ones included, group by group in order. */
  async items(which: WhichChecklist): Promise<ChecklistItem[]> {
    const rows = await items(this.db)
      .where('line_id', '=', which.lineId)
      .where('client_type_id', '=', which.clientTypeId)
      .execute();

    return rows.map(itemFrom).sort(inItemOrder);
  }

  async find(id: string): Promise<ChecklistItem | undefined> {
    const row = await items(this.db).where('id', '=', id).executeTakeFirst();

    return row === undefined ? undefined : itemFrom(row);
  }

  /** Adds an item at the end of its group. */
  async add(by: Attribution, item: NewChecklistItem): Promise<ChecklistItem> {
    const id = await labelled(item.label, () =>
      recording(this.db, by, async (on) => {
        const row = await on
          .insertInto('clients_checklist_item')
          .columns(['line_id', 'client_type_id', 'grp', 'label', 'poc_only', 'sort'])
          .expression(
            on.selectNoFrom([
              sql<string>`${item.lineId}::bigint`.as('line_id'),
              sql<string>`${item.clientTypeId}::bigint`.as('client_type_id'),
              sql<string>`${item.group}`.as('grp'),
              sql<string>`${item.label}`.as('label'),
              sql<boolean>`${item.pocOnly}::boolean`.as('poc_only'),
              sql<number>`coalesce((SELECT max(sort) FROM clients_checklist_item
                                       WHERE line_id = ${item.lineId}
                                         AND client_type_id = ${item.clientTypeId}
                                         AND grp = ${item.group}), 0) + 1`.as('sort'),
            ]),
          )
          .returning('id')
          .executeTakeFirstOrThrow();

        return row.id;
      }),
    );

    const added = await this.find(id);
    if (added === undefined) {
      throw new Error('A checklist item went missing as it was added.');
    }
    return added;
  }

  /** New words, or whether it is for POC deals only, or both. */
  async change(by: Attribution, id: string, change: ChecklistItemChange): Promise<void> {
    const set = {
      ...(change.label === undefined ? {} : { label: change.label }),
      ...(change.pocOnly === undefined ? {} : { poc_only: change.pocOnly }),
    };
    if (Object.keys(set).length === 0) {
      return;
    }

    await labelled(change.label ?? '', () =>
      recording(this.db, by, (on) =>
        on.updateTable('clients_checklist_item').set(set).where('id', '=', id).execute(),
      ),
    );
  }

  /**
   * One place up or down its group, swapping with its neighbour; the group is numbered 1, 2, 3
   * afresh, so no two share a place. At the top or bottom already, nothing moves.
   */
  async move(by: Attribution, item: ChecklistItem, direction: 'UP' | 'DOWN'): Promise<void> {
    await recording(this.db, by, async (on) => {
      const group = await on
        .selectFrom('clients_checklist_item')
        .select(['id', 'sort'])
        .where('line_id', '=', item.lineId)
        .where('client_type_id', '=', item.clientTypeId)
        .where('grp', '=', item.group)
        .orderBy('sort')
        .orderBy('id')
        .forUpdate()
        .execute();

      const at = group.findIndex((row) => row.id === item.id);
      const to = direction === 'UP' ? at - 1 : at + 1;
      if (at < 0 || to < 0 || to >= group.length) {
        return;
      }

      const order = group.map((row) => row.id);
      [order[at], order[to]] = [order[to], order[at]];

      for (const [index, id] of order.entries()) {
        if (group.find((row) => row.id === id)?.sort !== index + 1) {
          await on
            .updateTable('clients_checklist_item')
            .set({ sort: index + 1 })
            .where('id', '=', id)
            .execute();
        }
      }
    });
  }

  /** Retires it today: copied onto nothing new. Already retired keeps the day it first was. */
  async retire(by: Attribution, id: string, today: CalendarDate): Promise<void> {
    await recording(this.db, by, (on) =>
      on
        .updateTable('clients_checklist_item')
        .set({ retired_on: today })
        .where('id', '=', id)
        .where('retired_on', 'is', null)
        .execute(),
    );
  }

  async restore(by: Attribution, id: string): Promise<void> {
    await recording(this.db, by, (on) =>
      on
        .updateTable('clients_checklist_item')
        .set({ retired_on: null })
        .where('id', '=', id)
        .where('retired_on', 'is not', null)
        .execute(),
    );
  }

  /**
   * Fills an empty checklist with a copy of another's items still in use, in their order, each
   * then its own (the user, 24 November 2026). Refused where it has any item, retired ones too.
   */
  async copy(by: Attribution, into: WhichChecklist, from: WhichChecklist): Promise<void> {
    await recording(this.db, by, async (on) => {
      /* Two people copying into it at once are judged one after the other. */
      await sql`SELECT pg_advisory_xact_lock(hashtext('clients_checklist'),
                  hashtext(${`${into.lineId}/${into.clientTypeId}`}))`.execute(on);

      const has = await on
        .selectFrom('clients_checklist_item')
        .select('id')
        .where('line_id', '=', into.lineId)
        .where('client_type_id', '=', into.clientTypeId)
        .limit(1)
        .executeTakeFirst();
      if (has !== undefined) {
        throw new ChecklistNotEmpty();
      }

      await on
        .insertInto('clients_checklist_item')
        .columns(['line_id', 'client_type_id', 'grp', 'label', 'poc_only', 'sort'])
        .expression(
          on
            .selectFrom('clients_checklist_item')
            .select([
              sql<string>`${into.lineId}::bigint`.as('line_id'),
              sql<string>`${into.clientTypeId}::bigint`.as('client_type_id'),
              'grp',
              'label',
              'poc_only',
              sql<number>`row_number() OVER (PARTITION BY grp ORDER BY sort, id)`.as('sort'),
            ])
            .where('line_id', '=', from.lineId)
            .where('client_type_id', '=', from.clientTypeId)
            .where('retired_on', 'is', null),
        )
        .execute();
    });
  }
}

function items(db: Kysely<Database>) {
  return db
    .selectFrom('clients_checklist_item')
    .select([
      'id',
      'line_id',
      'client_type_id',
      'grp',
      'label',
      'sort',
      'poc_only',
      sql<CalendarDate | null>`retired_on::text`.as('retired_on'),
    ]);
}

type ItemRow = Awaited<ReturnType<ReturnType<typeof items>['executeTakeFirstOrThrow']>>;

function itemFrom(row: ItemRow): ChecklistItem {
  return {
    id: row.id,
    lineId: row.line_id,
    clientTypeId: row.client_type_id,
    group: row.grp as ChecklistGroup,
    label: row.label,
    sort: row.sort,
    pocOnly: row.poc_only,
    retiredOn: row.retired_on,
  };
}

function inItemOrder(one: ChecklistItem, other: ChecklistItem): number {
  return (
    CHECKLIST_GROUPS.indexOf(one.group) - CHECKLIST_GROUPS.indexOf(other.group) ||
    one.sort - other.sort ||
    Number(one.id) - Number(other.id)
  );
}

/** Runs a write that names an item, answering a clash with another's words in a sentence. */
async function labelled<T>(label: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if ((error as { constraint?: unknown }).constraint === ONE_PER_LABEL) {
      throw new ChecklistItemLabelTaken(label);
    }
    throw error;
  }
}
