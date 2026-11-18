/**
 * Database access for opportunities. #277, Clients SRS CLI 10 to CLI 17, TDD 4.2.
 *
 * Every write goes through `recording()`, so the audit trigger knows who made it (NFR CLI AUD
 * 01). Nothing here deletes; lms_app holds no DELETE on the table.
 */

import { type Kysely, sql } from 'kysely';
import type { Attribution } from '../../core/audit/audit.js';
import type { CalendarDate } from '../../core/calendar/time.js';
import type { Database } from '../../core/db/index.js';
import { recording } from '../../core/db/recording.js';
import { type Activity, newestFirst } from './activity.js';
import type {
  Currency,
  Money,
  NewOpportunity,
  Opportunity,
  OpportunityChange,
  Outcome,
  ValueChange,
  ValueSource,
  WaitingOnWhat,
} from './opportunity.js';
import { outcomeAt, type Stage, type StageChange } from './stage.js';

/** The unique index that holds a client to one open deal per product (CLI 11). */
const ONE_OPEN_PER_PRODUCT = 'uq_clients_opportunity_open';

/** The trigger that refuses a deal on a retired product (CLI 08). */
const RETIRED_PRODUCT = 'clients_product_takes_new_deals';

/** The trigger that keeps an ended deal as it ended (CLI 55, CLI 56). */
const ENDED_IS_FIXED = 'clients_opportunity_ended_is_fixed';

/** The trigger that settles the POC question once the contract is signed (CLI 19). */
const POC_DECISION_FIXED = 'clients_opportunity_poc_decision_fixed';

/** The internal debriefs an exit gives (CLI 53): what, when, and one for each person named. */
export interface Debriefs {
  description: string;
  dueOn: CalendarDate;
  ownerIds: readonly string[];
}

/** The triggers that take only a current reason from the list the ending is for (CLI 54). */
const REASON_FROM_ITS_LIST = 'clients_opportunity_reason_from_its_list';
const REASON_IN_USE = 'clients_opportunity_reason_in_use';

/** Refused by the database: the reason is on the other list, or retired. */
export class ReasonRefused extends Error {
  constructor() {
    super('The reason is not one a deal may end for now.');
    this.name = 'ReasonRefused';
  }
}

/** Refused by the database: the POC question is settled. */
export class PocDecisionSettled extends Error {
  constructor() {
    super('Whether the deal has a POC is settled.');
    this.name = 'PocDecisionSettled';
  }
}

/** The deal was not where the move started from: somebody moved it first. */
export class MovedMeanwhile extends Error {
  constructor() {
    super('The deal moved meanwhile.');
    this.name = 'MovedMeanwhile';
  }
}

/** Refused by the database: the client has an open deal for the product already. */
export class AlreadyOpen extends Error {
  constructor() {
    super('The client has an open deal for the product already.');
    this.name = 'AlreadyOpen';
  }
}

/** Refused by the database: the deal has ended, and is kept as it ended. */
export class Ended extends Error {
  constructor() {
    super('The deal has ended.');
    this.name = 'Ended';
  }
}

/** Refused by the database: the product, or its line, was retired. */
export class ProductRetired extends Error {
  constructor() {
    super('The product is retired.');
    this.name = 'ProductRetired';
  }
}

export class ClientsOpportunityRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async find(id: string): Promise<Opportunity | undefined> {
    const row = await this.query().where('o.id', '=', id).executeTakeFirst();

    return row === undefined ? undefined : opportunityFrom(row);
  }

  /** A client's deals: the open ones first, then the ended ones, each newest first. */
  async of(clientId: string): Promise<Opportunity[]> {
    const rows = await this.query()
      .where('o.client_id', '=', clientId)
      .orderBy(sql`o.outcome = 'OPEN'`, 'desc')
      .orderBy('o.id', 'desc')
      .execute();

    return rows.map(opportunityFrom);
  }

  /**
   * Records a new deal, open, owned by `ownerId`. A second open deal for the same client and
   * product, and one on a retired product, are refused by the database.
   */
  async create(by: Attribution, deal: NewOpportunity, ownerId: string): Promise<string> {
    try {
      return await recording(this.db, by, async (on) => {
        const row = await on
          .insertInto('clients_opportunity')
          .values({
            client_id: deal.clientId,
            product_id: deal.productId,
            owner_id: ownerId,
            value_minor: deal.value?.amountMinor ?? null,
            currency: deal.value?.currency ?? null,
            probability: deal.probability,
            close_half: deal.expectedClose?.half ?? null,
            close_year: deal.expectedClose?.year ?? null,
            waiting_on: deal.waitingOn?.on ?? null,
            waiting_note: deal.waitingOn?.note ?? null,
            stated_interest: deal.statedInterest,
            has_poc: deal.hasPoc,
          })
          .returning(['id', 'value_minor', 'currency', 'probability'])
          .executeTakeFirstOrThrow();

        /* Both its histories start with what it was opened with, in the same transaction: its
           figures, and Discovery (CLI 12, CLI 26). */
        await recordFigures(on, row.id, row, writerOf(by));
        await on
          .insertInto('clients_stage_change')
          .values({
            opportunity_id: row.id,
            from_stage: null,
            to_stage: 'DISCOVERY',
            to_outcome: 'OPEN',
            changed_by: writerOf(by),
          })
          .execute();

        return row.id;
      });
    } catch (error) {
      const constraint = (error as { constraint?: unknown }).constraint;

      if (constraint === ONE_OPEN_PER_PRODUCT) throw new AlreadyOpen();
      if (constraint === RETIRED_PRODUCT) throw new ProductRetired();
      throw error;
    }
  }

  /**
   * Changes what the edit asked to change, and nothing else. An ended deal is refused by the
   * database, whoever asks.
   *
   * The one place a deal's value and probability change (TDD 4.2): where either comes out
   * different from what it was, the figures as they now stand are added to its history in the
   * same transaction, so that the deal and its history never disagree. An edit that leaves both
   * as they were, a new expected close say, adds nothing.
   */
  async change(by: Attribution, id: string, change: OpportunityChange): Promise<void> {
    const values = {
      ...(change.value === undefined
        ? {}
        : {
            value_minor: change.value?.amountMinor ?? null,
            currency: change.value?.currency ?? null,
          }),
      ...(change.probability === undefined ? {} : { probability: change.probability }),
      ...(change.expectedClose === undefined
        ? {}
        : {
            close_half: change.expectedClose?.half ?? null,
            close_year: change.expectedClose?.year ?? null,
          }),
      ...(change.waitingOn === undefined
        ? {}
        : {
            waiting_on: change.waitingOn?.on ?? null,
            waiting_note: change.waitingOn?.note ?? null,
          }),
      ...(change.statedInterest === undefined ? {} : { stated_interest: change.statedInterest }),
      ...(change.hasPoc === undefined ? {} : { has_poc: change.hasPoc }),
    };

    if (Object.keys(values).length === 0) {
      return;
    }

    try {
      await recording(this.db, by, async (on) => {
        /* Locked, so that two edits at once each compare against what the other left. */
        const before = await on
          .selectFrom('clients_opportunity')
          .select(['value_minor', 'currency', 'probability'])
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst();

        const after = await on
          .updateTable('clients_opportunity')
          .set(values)
          .where('id', '=', id)
          .returning(['value_minor', 'currency', 'probability'])
          .executeTakeFirst();

        if (before !== undefined && after !== undefined && !sameFigures(before, after)) {
          await recordFigures(on, id, after, writerOf(by));
        }
      });
    } catch (error) {
      const constraint = (error as { constraint?: unknown }).constraint;

      if (constraint === ENDED_IS_FIXED) throw new Ended();
      if (constraint === POC_DECISION_FIXED) throw new PocDecisionSettled();
      throw error;
    }
  }

  /**
   * Moves a deal from one stage to another: the one way a deal's stage or outcome changes (TDD 3,
   * 5). The caller has decided the move may be made; the database refuses it anyway if not.
   *
   * In one transaction (TDD 5, step 7): the deal's stage, its outcome after (won at Live, CLI
   * 25), the day it ended where it did, a row in its stage history (CLI 26), and on a win, its
   * product added to what the client uses (CLI 04). Refused with {@link MovedMeanwhile} where the
   * deal is no longer at `from`, so a move decided on a stale look is never made.
   */
  async move(
    by: Attribution,
    id: string,
    move: { from: Stage; to: Stage; note: string | null },
    today: CalendarDate,
  ): Promise<void> {
    const outcome = outcomeAt(move.to);
    const changedBy = writerOf(by);

    try {
      await recording(this.db, by, async (on) => {
        const moved = await on
          .updateTable('clients_opportunity')
          .set({
            stage: move.to,
            outcome,
            ended_on: outcome === 'OPEN' ? null : today,
          })
          .where('id', '=', id)
          .where('stage', '=', move.from)
          .where('outcome', '=', 'OPEN')
          .returning(['client_id', 'product_id'])
          .executeTakeFirst();

        if (moved === undefined) {
          throw new MovedMeanwhile();
        }

        await on
          .insertInto('clients_stage_change')
          .values({
            opportunity_id: id,
            from_stage: move.from,
            to_stage: move.to,
            to_outcome: outcome,
            note: move.note,
            changed_by: changedBy,
          })
          .execute();

        if (outcome === 'WON') {
          await addWonProduct(on, moved.client_id, moved.product_id, id, today);
        }
      });
    } catch (error) {
      if ((error as { constraint?: unknown }).constraint === ENDED_IS_FIXED) throw new Ended();
      throw error;
    }
  }

  /**
   * Ends a deal without winning it, where it stands: lost before its POC starts, or exited from
   * a started POC (CLI 51, CLI 52). The other way, beside {@link move}, that a deal's outcome
   * changes, and only the stage service calls it (TDD 3).
   *
   * In one transaction: its outcome, the day it ended, why and any note, and a row in its stage
   * history from the stage it stood at to the same stage, with the note (CLI 26). Refused with
   * {@link MovedMeanwhile} where the deal is no longer open at `stage`, and with
   * {@link ReasonRefused} where the database will not take the reason.
   *
   * An exit's debriefs go in the same transaction (CLI 53), one next step for each person named,
   * so that a deal is never exited without them nor they written for a deal that was not.
   */
  async end(
    by: Attribution,
    id: string,
    ending: {
      stage: Stage;
      outcome: 'LOST' | 'EXITED';
      reasonId: string;
      note: string | null;
      debriefs?: Debriefs;
    },
    today: CalendarDate,
  ): Promise<void> {
    const changedBy = writerOf(by);

    try {
      await recording(this.db, by, async (on) => {
        const ended = await on
          .updateTable('clients_opportunity')
          .set({
            outcome: ending.outcome,
            ended_on: today,
            reason_id: ending.reasonId,
            end_note: ending.note,
          })
          .where('id', '=', id)
          .where('stage', '=', ending.stage)
          .where('outcome', '=', 'OPEN')
          .returning('client_id')
          .executeTakeFirst();

        if (ended === undefined) {
          throw new MovedMeanwhile();
        }

        await on
          .insertInto('clients_stage_change')
          .values({
            opportunity_id: id,
            from_stage: ending.stage,
            to_stage: ending.stage,
            to_outcome: ending.outcome,
            note: ending.note,
            changed_by: changedBy,
          })
          .execute();

        const debriefs = ending.debriefs;
        if (debriefs !== undefined && debriefs.ownerIds.length > 0) {
          await on
            .insertInto('clients_next_step')
            .values(
              debriefs.ownerIds.map((ownerId) => ({
                client_id: ended.client_id,
                opportunity_id: id,
                description: debriefs.description,
                due_on: debriefs.dueOn,
                owner_id: ownerId,
                source: 'DEBRIEF',
                created_by: changedBy,
              })),
            )
            .execute();
        }
      });
    } catch (error) {
      const constraint = (error as { constraint?: unknown }).constraint;

      if (constraint === ENDED_IS_FIXED) throw new Ended();
      if (constraint === REASON_FROM_ITS_LIST || constraint === REASON_IN_USE) {
        throw new ReasonRefused();
      }
      throw error;
    }
  }

  /**
   * Everything that has happened to a client's deals, open and ended, newest first: every stage
   * change and every change to a deal's value or chance of closing, each naming its deal. Read in
   * two queries, one per history, and put in order here.
   */
  async activityOf(clientId: string): Promise<Activity[]> {
    const [stages, values] = await Promise.all([
      this.db
        .selectFrom('clients_stage_change as s')
        .innerJoin('clients_opportunity as o', 'o.id', 's.opportunity_id')
        .innerJoin('clients_product as p', 'p.id', 'o.product_id')
        .innerJoin('employee as e', 'e.id', 's.changed_by')
        .select([
          'o.id as deal_id',
          'p.name as product_name',
          's.from_stage',
          's.to_stage',
          's.to_outcome',
          's.note',
          's.changed_at',
          'e.id as by_id',
          sql<string>`e.first_name || ' ' || e.last_name`.as('by_name'),
        ])
        .where('o.client_id', '=', clientId)
        .execute(),
      this.db
        .selectFrom('clients_value_change as v')
        .innerJoin('clients_opportunity as o', 'o.id', 'v.opportunity_id')
        .innerJoin('clients_product as p', 'p.id', 'o.product_id')
        .innerJoin('employee as e', 'e.id', 'v.changed_by')
        .select([
          'o.id as deal_id',
          'p.name as product_name',
          'v.value_minor',
          'v.currency',
          'v.probability',
          'v.source',
          'v.changed_at',
          'e.id as by_id',
          sql<string>`e.first_name || ' ' || e.last_name`.as('by_name'),
        ])
        .where('o.client_id', '=', clientId)
        /* Oldest first, so the first seen of each deal is what it was opened with. */
        .orderBy('v.changed_at')
        .orderBy('v.id')
        .execute(),
    ]);

    const opened = new Set<string>();

    return newestFirst([
      ...stages.map((row): Activity => ({
        kind: 'STAGE',
        deal: { id: row.deal_id, productName: row.product_name },
        fromStage: row.from_stage as Stage | null,
        toStage: row.to_stage as Stage,
        toOutcome: row.to_outcome as Outcome,
        note: row.note,
        by: { id: row.by_id, name: row.by_name },
        at: row.changed_at,
      })),
      ...values.map((row): Activity => {
        const opening = !opened.has(row.deal_id);
        opened.add(row.deal_id);

        return {
          kind: 'VALUE',
          deal: { id: row.deal_id, productName: row.product_name },
          value: moneyFrom(row),
          probability: row.probability,
          source: row.source as ValueSource,
          opening,
          by: { id: row.by_id, name: row.by_name },
          at: row.changed_at,
        };
      }),
    ]);
  }

  /** Every stage a deal has been at, newest first. The oldest is its opening, at Discovery. */
  async stages(id: string): Promise<StageChange[]> {
    const rows = await this.db
      .selectFrom('clients_stage_change as s')
      .innerJoin('employee as e', 'e.id', 's.changed_by')
      .select([
        's.from_stage',
        's.to_stage',
        's.to_outcome',
        's.note',
        's.changed_at',
        'e.id as changed_by',
        sql<string>`e.first_name || ' ' || e.last_name`.as('changed_by_name'),
      ])
      .where('s.opportunity_id', '=', id)
      .orderBy('s.changed_at', 'desc')
      .orderBy('s.id', 'desc')
      .execute();

    return rows.map((row) => ({
      fromStage: row.from_stage as Stage | null,
      toStage: row.to_stage as Stage,
      toOutcome: row.to_outcome as Outcome,
      note: row.note,
      changedBy: { id: row.changed_by, name: row.changed_by_name },
      changedAt: row.changed_at,
    }));
  }

  /** What a deal was worth and how likely to close, each time either changed, newest first. */
  async history(id: string): Promise<ValueChange[]> {
    const rows = await this.db
      .selectFrom('clients_value_change as v')
      .innerJoin('employee as e', 'e.id', 'v.changed_by')
      .select([
        'v.value_minor',
        'v.currency',
        'v.probability',
        'v.source',
        'v.changed_at',
        'e.id as changed_by',
        sql<string>`e.first_name || ' ' || e.last_name`.as('changed_by_name'),
      ])
      .where('v.opportunity_id', '=', id)
      .orderBy('v.changed_at', 'desc')
      .orderBy('v.id', 'desc')
      .execute();

    return rows.map((row) => ({
      value: moneyFrom(row),
      probability: row.probability,
      source: row.source as ValueSource,
      changedBy: { id: row.changed_by, name: row.changed_by_name },
      changedAt: row.changed_at,
    }));
  }

  private query() {
    return deals(this.db);
  }
}

/** A deal's figures, as its row and its history hold them. */
interface Figures {
  value_minor: string | null;
  currency: string | null;
  probability: number | null;
}

function sameFigures(one: Figures, other: Figures): boolean {
  return (
    one.value_minor === other.value_minor &&
    one.currency === other.currency &&
    one.probability === other.probability
  );
}

/**
 * Puts a won deal's product on what the client uses, from today, naming the deal (CLI 04, CLI
 * 25). Where the client used it once and stopped, it is started again from today, named as won
 * back by this deal; the audit log keeps the dates it had. Where they use it already, it is left
 * as it is.
 */
async function addWonProduct(
  on: Kysely<Database>,
  clientId: string,
  productId: string,
  dealId: string,
  today: CalendarDate,
): Promise<void> {
  await on
    .insertInto('clients_client_product')
    .values({ client_id: clientId, product_id: productId, since_on: today, won_by: dealId })
    .onConflict((conflict) =>
      conflict
        .columns(['client_id', 'product_id'])
        .doUpdateSet({ since_on: today, ended_on: null, won_by: dealId })
        .where('clients_client_product.ended_on', 'is not', null),
    )
    .execute();
}

/**
 * Adds the figures as they now stand to a deal's history: as an edit by a person, or as the
 * financials sent, naming the activity that sent them (#281).
 */
async function recordFigures(
  on: Kysely<Database>,
  id: string,
  figures: Figures,
  changedBy: string,
  financials: string | null = null,
): Promise<void> {
  await on
    .insertInto('clients_value_change')
    .values({
      opportunity_id: id,
      value_minor: figures.value_minor,
      currency: figures.currency,
      probability: figures.probability,
      source: financials === null ? 'MANUAL' : 'FINANCIALS',
      activity_id: financials,
      changed_by: changedBy,
    })
    .execute();
}

/**
 * Sets a deal's value from the financials sent on it, inside the transaction that logs or corrects
 * them, and adds it to the deal's history naming them (CLI 65, #281). Its chance of closing is left
 * as it is. Always a history row, even where the amount is what the deal already said: that the
 * financials confirmed it is part of the trail.
 *
 * TDD 4.2's one write path for a deal's figures, alongside {@link ClientsOpportunityRepository.change}.
 * Refused with {@link Ended} where the deal has ended, by the database, whoever asks.
 */
export async function setValueFromFinancials(
  on: Kysely<Database>,
  dealId: string,
  value: Money | null,
  financials: string,
  changedBy: string,
): Promise<void> {
  try {
    const after = await on
      .updateTable('clients_opportunity')
      .set({ value_minor: value?.amountMinor ?? null, currency: value?.currency ?? null })
      .where('id', '=', dealId)
      .returning(['value_minor', 'currency', 'probability'])
      .executeTakeFirstOrThrow();

    await recordFigures(on, dealId, after, changedBy, financials);
  } catch (error) {
    if ((error as { constraint?: unknown }).constraint === ENDED_IS_FIXED) throw new Ended();
    throw error;
  }
}

/**
 * What a deal was worth just before the financials first set it, for putting it back when they
 * turn out to have been something else, or for another deal (#281). Null where it had no value.
 */
export async function valueBeforeFinancials(
  on: Kysely<Database>,
  dealId: string,
  financials: string,
): Promise<Money | null> {
  const row = await on
    .selectFrom('clients_value_change as v')
    .select(['v.value_minor', 'v.currency', 'v.probability'])
    .where('v.opportunity_id', '=', dealId)
    .where(
      'v.id',
      '<',
      on
        .selectFrom('clients_value_change')
        .select((pick) => pick.fn.min('id').as('first'))
        .where('opportunity_id', '=', dealId)
        .where('activity_id', '=', financials),
    )
    .orderBy('v.id', 'desc')
    .limit(1)
    .executeTakeFirst();

  return row === undefined ? null : moneyFrom(row);
}

/** Who a change to a deal's figures is put down to: always a person (TDD 4.2's NOT NULL). */
function writerOf(by: Attribution): string {
  if (by.employeeId === null) {
    throw new Error("A deal's figures were changed by nobody.");
  }

  return by.employeeId;
}

function moneyFrom(row: Figures): Money | null {
  return row.value_minor === null || row.currency === null
    ? null
    : { amountMinor: Number(row.value_minor), currency: row.currency as Currency };
}

/** Every deal, with the names its page shows. */
function deals(db: Kysely<Database>) {
  return db
    .selectFrom('clients_opportunity as o')
    .innerJoin('clients_client as c', 'c.id', 'o.client_id')
    .innerJoin('clients_product as p', 'p.id', 'o.product_id')
    .innerJoin('clients_product_line as l', 'l.id', 'p.line_id')
    .innerJoin('employee as e', 'e.id', 'o.owner_id')
    .leftJoin('clients_reason as r', 'r.id', 'o.reason_id')
    .select([
      'o.id',
      'o.client_id',
      'c.name as client_name',
      'o.product_id',
      'p.name as product_name',
      'l.name as line_name',
      'o.owner_id',
      sql<string>`e.first_name || ' ' || e.last_name`.as('owner_name'),
      'o.stage',
      'o.outcome',
      'o.has_poc',
      'o.ended_on',
      'o.reason_id',
      'r.label as reason_label',
      'o.end_note',
      'o.value_minor',
      'o.currency',
      'o.probability',
      'o.close_half',
      'o.close_year',
      'o.waiting_on',
      'o.waiting_note',
      'o.stated_interest',
      'o.created_at',
    ]);
}

type Row = Awaited<ReturnType<ReturnType<typeof deals>['executeTakeFirstOrThrow']>>;

function opportunityFrom(row: Row): Opportunity {
  return {
    id: row.id,
    client: { id: row.client_id, name: row.client_name },
    product: { id: row.product_id, name: row.product_name, lineName: row.line_name },
    owner: { id: row.owner_id, name: row.owner_name },
    stage: row.stage as Stage,
    outcome: row.outcome as Outcome,
    hasPoc: row.has_poc,
    endedOn: row.ended_on,
    ending:
      row.reason_id === null || row.reason_label === null
        ? null
        : { reason: { id: row.reason_id, label: row.reason_label }, note: row.end_note },
    value:
      row.value_minor === null || row.currency === null
        ? null
        : { amountMinor: Number(row.value_minor), currency: row.currency as Currency },
    probability: row.probability,
    expectedClose:
      row.close_half === null || row.close_year === null
        ? null
        : { half: row.close_half as 'H1' | 'H2', year: row.close_year },
    waitingOn:
      row.waiting_on === null
        ? null
        : { on: row.waiting_on as WaitingOnWhat, note: row.waiting_note },
    statedInterest: row.stated_interest,
    createdAt: row.created_at,
  };
}
