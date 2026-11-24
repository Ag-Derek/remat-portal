/**
 * Database access for a deal's and a POC's checks and their ticks. #284, Clients SRS CLI 40, CLI
 * 41, TDD 4.4.
 *
 * The checks themselves are copied by the database as a deal first leaves Discovery or a POC is
 * made, and only read here. A tick is written once and kept; a check's latest tick is its state.
 */

import { type Kysely, sql } from 'kysely';
import type { Attribution } from '../../core/audit/audit.js';
import type { Database } from '../../core/db/index.js';
import { recording } from '../../core/db/recording.js';
import {
  type Check,
  type ChecklistGroup,
  type ChecklistOwner,
  inChecklistOrder,
  type Tick,
  TickUnchanged,
} from './checklist.js';
import type { Outcome } from './opportunity.js';

/** The trigger refusing a tick that changes nothing. */
const TICK_CHANGES = 'clients_tick_changes';

/** The trigger refusing a tick once the deal or POC has ended. */
const WHILE_OPEN = 'clients_tick_while_open';

/** Whose checks they are, as ticking them needs it. */
export interface ChecklistSubject extends ChecklistOwner {
  /** The deal's product, or the product of the POC's deal. */
  productName: string;
  /** The deal's outcome, or the POC's deal's, which is how the POC ended. */
  outcome: Outcome;
  /** The deal's owner; for a POC, its deal's. */
  dealOwner: { id: string; name: string };
  /** A POC's CS lead; null on a deal. */
  csLead: { id: string; name: string } | null;
}

/** The deal or POC ended between the look and the tick. */
export class ChecklistClosed extends Error {
  constructor() {
    super('The deal or POC has ended.');
    this.name = 'ChecklistClosed';
  }
}

export class ClientsCheckRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** A deal, as its checks need it; undefined if there is none. */
  async dealSubject(dealId: string): Promise<ChecklistSubject | undefined> {
    const row = await this.db
      .selectFrom('clients_opportunity as o')
      .innerJoin('clients_product as p', 'p.id', 'o.product_id')
      .innerJoin('employee as owner', 'owner.id', 'o.owner_id')
      .select([
        'o.id',
        'o.outcome',
        'p.name as product_name',
        'owner.id as owner_id',
        sql<string>`owner.first_name || ' ' || owner.last_name`.as('owner_name'),
      ])
      .where('o.id', '=', dealId)
      .executeTakeFirst();

    return row === undefined
      ? undefined
      : {
          on: 'DEAL',
          id: row.id,
          productName: row.product_name,
          outcome: row.outcome as Outcome,
          dealOwner: { id: row.owner_id, name: row.owner_name },
          csLead: null,
        };
  }

  /** A POC, as its checks need it, with its one deal; undefined if there is none. */
  async pocSubject(pocId: string): Promise<ChecklistSubject | undefined> {
    const row = await this.db
      .selectFrom('clients_poc as poc')
      .innerJoin('clients_opportunity as o', 'o.poc_id', 'poc.id')
      .innerJoin('clients_product as p', 'p.id', 'o.product_id')
      .innerJoin('employee as owner', 'owner.id', 'o.owner_id')
      .innerJoin('employee as lead', 'lead.id', 'poc.cs_lead_id')
      .select([
        'poc.id',
        'o.outcome',
        'p.name as product_name',
        'owner.id as owner_id',
        sql<string>`owner.first_name || ' ' || owner.last_name`.as('owner_name'),
        'lead.id as lead_id',
        sql<string>`lead.first_name || ' ' || lead.last_name`.as('lead_name'),
      ])
      .where('poc.id', '=', pocId)
      .executeTakeFirst();

    return row === undefined
      ? undefined
      : {
          on: 'POC',
          id: row.id,
          productName: row.product_name,
          outcome: row.outcome as Outcome,
          dealOwner: { id: row.owner_id, name: row.owner_name },
          csLead: { id: row.lead_id, name: row.lead_name },
        };
  }

  /** A deal's or POC's checks, each with its latest tick, in their groups' order. */
  async checksOf(owner: ChecklistOwner): Promise<Check[]> {
    const rows = await checks(this.db)
      .where(owner.on === 'DEAL' ? 'k.opportunity_id' : 'k.poc_id', '=', owner.id)
      .execute();

    return rows.map(checkFrom).sort(inChecklistOrder);
  }

  /** One check, and whose it is; undefined if there is none. */
  async find(checkId: string): Promise<{ check: Check; owner: ChecklistOwner } | undefined> {
    const row = await checks(this.db).where('k.id', '=', checkId).executeTakeFirst();

    if (row === undefined) {
      return undefined;
    }

    return {
      check: checkFrom(row),
      owner:
        row.opportunity_id !== null
          ? { on: 'DEAL', id: row.opportunity_id }
          : { on: 'POC', id: row.poc_id as string },
    };
  }

  /**
   * Ticks or unticks it, adding to its history (CLI 41). The database refuses a tick that
   * changes nothing, judging two people ticking at once one after the other, and one on a deal or
   * POC that has ended.
   */
  async tick(by: Attribution, check: Check, ticked: boolean): Promise<void> {
    if (by.employeeId === null) {
      throw new Error('A check was ticked by nobody.');
    }
    const tickedBy = by.employeeId;

    try {
      await recording(this.db, by, async (on) => {
        await on
          .insertInto('clients_tick')
          .values({ check_id: check.id, ticked, ticked_by: tickedBy })
          .execute();
      });
    } catch (error) {
      const constraint = (error as { constraint?: unknown }).constraint;

      if (constraint === TICK_CHANGES) throw new TickUnchanged(check.label, ticked);
      if (constraint === WHILE_OPEN) throw new ChecklistClosed();
      throw error;
    }
  }

  /** Every tick and untick of it, the latest first. */
  async ticks(checkId: string): Promise<Tick[]> {
    const rows = await this.db
      .selectFrom('clients_tick as t')
      .innerJoin('employee as e', 'e.id', 't.ticked_by')
      .select([
        't.ticked',
        't.ticked_at',
        'e.id as by_id',
        sql<string>`e.first_name || ' ' || e.last_name`.as('by_name'),
      ])
      .where('t.check_id', '=', checkId)
      .orderBy('t.ticked_at', 'desc')
      .orderBy('t.id', 'desc')
      .execute();

    return rows.map((row) => ({
      ticked: row.ticked,
      by: { id: row.by_id, name: row.by_name },
      at: row.ticked_at,
    }));
  }
}

/** Every check, with its latest tick and who made it, where it has one. */
function checks(db: Kysely<Database>) {
  return db
    .selectFrom('clients_check as k')
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom('clients_tick as t')
          .innerJoin('employee as e', 'e.id', 't.ticked_by')
          .select([
            't.ticked',
            't.ticked_at',
            'e.id as by_id',
            sql<string>`e.first_name || ' ' || e.last_name`.as('by_name'),
          ])
          .whereRef('t.check_id', '=', 'k.id')
          .orderBy('t.ticked_at', 'desc')
          .orderBy('t.id', 'desc')
          .limit(1)
          .as('latest'),
      (join) => join.onTrue(),
    )
    .select([
      'k.id',
      'k.opportunity_id',
      'k.poc_id',
      'k.grp',
      'k.label',
      'k.poc_only',
      'k.sort',
      'latest.ticked',
      'latest.ticked_at',
      'latest.by_id',
      'latest.by_name',
    ]);
}

type CheckRow = Awaited<ReturnType<ReturnType<typeof checks>['executeTakeFirstOrThrow']>>;

function checkFrom(row: CheckRow): Check {
  const latest =
    row.ticked === null || row.ticked_at === null || row.by_id === null || row.by_name === null
      ? null
      : { ticked: row.ticked, by: { id: row.by_id, name: row.by_name }, at: row.ticked_at };

  return {
    id: row.id,
    group: row.grp as ChecklistGroup,
    label: row.label,
    pocOnly: row.poc_only,
    sort: row.sort,
    ticked: latest?.ticked ?? false,
    latest,
  };
}
