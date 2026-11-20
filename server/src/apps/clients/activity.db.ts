/**
 * Database access for activities and next steps. #280, Clients SRS CLI 58 to CLI 64, TDD 4.5.
 *
 * Every write goes through `recording()`, so the audit trigger on activities knows who made it.
 * Nothing here deletes: an activity is fixed a day after it is logged, which the table's trigger
 * holds, and a next step is closed rather than removed.
 */

import { type Kysely, sql } from 'kysely';
import type { Attribution } from '../../core/audit/audit.js';
import type { CalendarDate } from '../../core/calendar/time.js';
import type { Database } from '../../core/db/index.js';
import { recording } from '../../core/db/recording.js';
import {
  type ActivityChange,
  type ActivityKind,
  ActivityLocked,
  type DealNamed,
  type LoggedActivity,
  type NewActivity,
  type PastProposal,
  type ProposalFilters,
  SENT_ON_A_DEAL,
} from './logged-activity.js';
import {
  type NewNextStep,
  type NextStep,
  NextStepAlreadyClosed,
  NextStepNotClosed,
  type NextStepSource,
} from './next-step.js';
import type { Person } from './client.js';
import type { Currency, Money, Outcome } from './opportunity.js';
import { setValueFromFinancials, valueBeforeFinancials } from './opportunity.db.js';

/** The trigger that fixes an activity 24 hours after it is logged (CLI 62). */
const FIXED_AFTER_A_DAY = 'clients_activity_fixed_after_a_day';

/** A deal a proposal or the financials are sent on, as the service checks it (#281). */
export interface DealSentOn extends DealNamed {
  owner: Person;
  outcome: Outcome;
}

/** A step to write: what, by when, and whose, settled by the service. */
export interface StepToWrite {
  description: string;
  dueOn: CalendarDate;
  ownerId: string;
}

export class ClientsActivityRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** One of a client's deals, open or ended, by id; undefined where it is not one of theirs. */
  async dealOf(clientId: string, dealId: string): Promise<DealNamed | undefined> {
    const row = await this.db
      .selectFrom('clients_opportunity as o')
      .innerJoin('clients_product as p', 'p.id', 'o.product_id')
      .select(['o.id', 'p.name as product_name'])
      .where('o.id', '=', dealId)
      .where('o.client_id', '=', clientId)
      .executeTakeFirst();

    return row === undefined ? undefined : { id: row.id, productName: row.product_name };
  }

  /**
   * One of a client's deals as a proposal or the financials need it: whose it is, to ask whether
   * the person sending may, and whether it is still open (#281).
   */
  async dealSentOn(clientId: string, dealId: string): Promise<DealSentOn | undefined> {
    const row = await this.db
      .selectFrom('clients_opportunity as o')
      .innerJoin('clients_product as p', 'p.id', 'o.product_id')
      .innerJoin('employee as e', 'e.id', 'o.owner_id')
      .select([
        'o.id',
        'o.outcome',
        'p.name as product_name',
        'e.id as owner_id',
        sql<string>`e.first_name || ' ' || e.last_name`.as('owner_name'),
      ])
      .where('o.id', '=', dealId)
      .where('o.client_id', '=', clientId)
      .executeTakeFirst();

    return row === undefined
      ? undefined
      : {
          id: row.id,
          productName: row.product_name,
          owner: { id: row.owner_id, name: row.owner_name },
          outcome: row.outcome as Outcome,
        };
  }

  /**
   * Logs an activity, and the next step offered with it where there is one, in one transaction:
   * the step names the activity, and is about the same deal (CLI 63).
   */
  async log(
    by: Attribution,
    activity: NewActivity,
    step: StepToWrite | null,
  ): Promise<{ activityId: string; stepId: string | null }> {
    const loggedBy = writerOf(by);

    return recording(this.db, by, async (on) => {
      const logged = await on
        .insertInto('clients_activity')
        .values({
          client_id: activity.clientId,
          opportunity_id: activity.opportunityId,
          kind: activity.kind,
          happened_on: activity.happenedOn,
          with_whom: activity.withWhom,
          outcome: activity.outcome,
          amount_minor: activity.amount?.amountMinor ?? null,
          currency: activity.amount?.currency ?? null,
          logged_by: loggedBy,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      /* CLI 65, #281: the financials' amount becomes the deal's value, the earlier one kept in its
         history, in this same transaction. */
      if (activity.kind === 'FINANCIALS' && activity.opportunityId !== null) {
        await setValueFromFinancials(
          on,
          activity.opportunityId,
          activity.amount,
          logged.id,
          loggedBy,
        );
      }

      if (step === null) {
        return { activityId: logged.id, stepId: null };
      }

      const made = await on
        .insertInto('clients_next_step')
        .values({
          client_id: activity.clientId,
          opportunity_id: activity.opportunityId,
          description: step.description,
          due_on: step.dueOn,
          owner_id: step.ownerId,
          source: 'ACTIVITY',
          from_activity: logged.id,
          created_by: loggedBy,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      return { activityId: logged.id, stepId: made.id };
    });
  }

  /**
   * Corrects what the request asked to correct. Refused with {@link ActivityLocked} where the
   * table's trigger finds it more than a day old, which is how a correction that raced the
   * 24 hours, or came by another way, is still refused.
   *
   * Where the financials are corrected, the deals' values follow in the same transaction, each
   * with a row in its history naming them (#281): a deal they no longer set goes back to what it
   * was worth before they first set it, and the deal they now set takes their amount.
   */
  async correct(by: Attribution, id: string, change: ActivityChange): Promise<void> {
    const values = {
      ...(change.opportunityId === undefined ? {} : { opportunity_id: change.opportunityId }),
      ...(change.kind === undefined ? {} : { kind: change.kind }),
      ...(change.happenedOn === undefined ? {} : { happened_on: change.happenedOn }),
      ...(change.withWhom === undefined ? {} : { with_whom: change.withWhom }),
      ...(change.outcome === undefined ? {} : { outcome: change.outcome }),
      ...(change.amount === undefined
        ? {}
        : {
            amount_minor: change.amount?.amountMinor ?? null,
            currency: change.amount?.currency ?? null,
          }),
    };

    if (Object.keys(values).length === 0) {
      return;
    }

    const changedBy = writerOf(by);

    try {
      await recording(this.db, by, async (on) => {
        const before = await on
          .selectFrom('clients_activity')
          .select(['kind', 'opportunity_id', 'amount_minor', 'currency'])
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirstOrThrow();

        const after = await on
          .updateTable('clients_activity')
          .set(values)
          .where('id', '=', id)
          .returning(['kind', 'opportunity_id', 'amount_minor', 'currency'])
          .executeTakeFirstOrThrow();

        const wasFinancials = before.kind === 'FINANCIALS' && before.opportunity_id !== null;
        const isFinancials = after.kind === 'FINANCIALS' && after.opportunity_id !== null;
        const sameDeal = before.opportunity_id === after.opportunity_id;

        if (wasFinancials && before.opportunity_id !== null && !(isFinancials && sameDeal)) {
          await setValueFromFinancials(
            on,
            before.opportunity_id,
            await valueBeforeFinancials(on, before.opportunity_id, id),
            id,
            changedBy,
          );
        }

        if (
          isFinancials &&
          after.opportunity_id !== null &&
          (!wasFinancials ||
            !sameDeal ||
            before.amount_minor !== after.amount_minor ||
            before.currency !== after.currency)
        ) {
          await setValueFromFinancials(
            on,
            after.opportunity_id,
            moneyOf(after.amount_minor, after.currency),
            id,
            changedBy,
          );
        }
      });
    } catch (error) {
      if ((error as { constraint?: unknown }).constraint === FIXED_AFTER_A_DAY) {
        throw new ActivityLocked();
      }
      throw error;
    }
  }

  /** Adds a step on its own (CLI 63), whose `ownerId` the service has settled. */
  async addStep(by: Attribution, step: NewNextStep & { ownerId: string }): Promise<string> {
    const createdBy = writerOf(by);

    return recording(this.db, by, async (on) => {
      const made = await on
        .insertInto('clients_next_step')
        .values({
          client_id: step.clientId,
          opportunity_id: step.opportunityId,
          description: step.description,
          due_on: step.dueOn,
          owner_id: step.ownerId,
          source: 'MANUAL',
          created_by: createdBy,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      return made.id;
    });
  }

  /**
   * Closes a step, as whoever closes it, now (CLI 64). Only an open one: two closing it at once,
   * the second is refused with {@link NextStepAlreadyClosed}.
   */
  async close(by: Attribution, id: string): Promise<void> {
    const closedBy = writerOf(by);

    const closed = await recording(this.db, by, (on) =>
      on
        .updateTable('clients_next_step')
        .set({ done_at: sql<Date>`now()`, done_by: closedBy })
        .where('id', '=', id)
        .where('done_at', 'is', null)
        .executeTakeFirst(),
    );

    if (closed.numUpdatedRows === 0n) {
      throw new NextStepAlreadyClosed();
    }
  }

  /** Opens a closed step again (#280). Only a closed one. */
  async reopen(by: Attribution, id: string): Promise<void> {
    const reopened = await recording(this.db, by, (on) =>
      on
        .updateTable('clients_next_step')
        .set({ done_at: null, done_by: null })
        .where('id', '=', id)
        .where('done_at', 'is not', null)
        .executeTakeFirst(),
    );

    if (reopened.numUpdatedRows === 0n) {
      throw new NextStepNotClosed();
    }
  }

  /**
   * Proposals and financials sent, at every client, the latest first by the day each was sent
   * (CLI 66, #281): by the client's type as it is now, and the deal's product. Each with its files
   * still on, in two round trips whatever the count, at the size the department is (SRS 2.3 item 4).
   */
  async proposals(filters: ProposalFilters): Promise<PastProposal[]> {
    let query = this.db
      .selectFrom('clients_activity as a')
      .innerJoin('clients_client as c', 'c.id', 'a.client_id')
      .innerJoin('clients_client_type as t', 't.id', 'c.type_id')
      .innerJoin('clients_opportunity as o', 'o.id', 'a.opportunity_id')
      .innerJoin('clients_product as p', 'p.id', 'o.product_id')
      .innerJoin('clients_product_line as l', 'l.id', 'p.line_id')
      .innerJoin('employee as e', 'e.id', 'a.logged_by')
      .select([
        'a.id',
        'a.kind',
        sql<CalendarDate>`a.happened_on::text`.as('happened_on'),
        'a.with_whom',
        'a.outcome',
        'a.amount_minor',
        'a.currency',
        'c.id as client_id',
        'c.name as client_name',
        't.id as type_id',
        't.name as type_name',
        'o.id as deal_id',
        'p.name as product_name',
        'l.name as line_name',
        'e.id as logged_by',
        sql<string>`e.first_name || ' ' || e.last_name`.as('logged_by_name'),
      ])
      .where('a.kind', 'in', filters.kind === null ? [...SENT_ON_A_DEAL] : [filters.kind]);

    if (filters.typeId !== null) query = query.where('c.type_id', '=', filters.typeId);
    if (filters.productId !== null) query = query.where('o.product_id', '=', filters.productId);

    const rows = await query
      .orderBy('a.happened_on', 'desc')
      .orderBy('a.logged_at', 'desc')
      .orderBy('a.id', 'desc')
      .execute();

    const files =
      rows.length === 0
        ? []
        : await this.db
            .selectFrom('clients_document')
            .select([
              'id',
              'activity_id',
              'original_filename',
              'content_type',
              'size_bytes',
              'scan_status',
            ])
            .where(
              'activity_id',
              'in',
              rows.map((row) => row.id),
            )
            .where('removed_at', 'is', null)
            .orderBy('uploaded_at')
            .orderBy('id')
            .execute();

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as PastProposal['kind'],
      happenedOn: row.happened_on,
      client: {
        id: row.client_id,
        name: row.client_name,
        type: { id: row.type_id, name: row.type_name },
      },
      deal: { id: row.deal_id, productName: row.product_name, lineName: row.line_name },
      amount: moneyOf(row.amount_minor, row.currency),
      withWhom: row.with_whom,
      outcome: row.outcome,
      loggedBy: { id: row.logged_by, name: row.logged_by_name },
      files: files
        .filter((file) => file.activity_id === row.id)
        .map((file) => ({
          id: file.id,
          filename: file.original_filename,
          contentType: file.content_type,
          sizeBytes: Number(file.size_bytes),
          downloadable: file.scan_status === 'CLEAN',
        })),
    }));
  }

  /** Every activity logged at a client, in no order; the Activity section orders them. */
  async activitiesOf(clientId: string): Promise<LoggedActivity[]> {
    const rows = await activities(this.db).where('a.client_id', '=', clientId).execute();

    return rows.map(activityFrom);
  }

  /**
   * A client's next steps: open ones first, soonest due first, then closed ones, the last closed
   * first (CLI 63, CLI 64).
   */
  async stepsOf(clientId: string): Promise<NextStep[]> {
    const rows = await steps(this.db)
      .where('s.client_id', '=', clientId)
      .orderBy(sql`s.done_at IS NOT NULL`)
      .orderBy(sql`CASE WHEN s.done_at IS NULL THEN s.due_on END`)
      .orderBy('s.done_at', 'desc')
      .orderBy('s.id')
      .execute();

    return rows.map(stepFrom);
  }

  async findActivity(id: string): Promise<LoggedActivity | undefined> {
    const row = await activities(this.db).where('a.id', '=', id).executeTakeFirst();

    return row === undefined ? undefined : activityFrom(row);
  }

  async findStep(id: string): Promise<NextStep | undefined> {
    const row = await steps(this.db).where('s.id', '=', id).executeTakeFirst();

    return row === undefined ? undefined : stepFrom(row);
  }
}

/** Every activity, with its deal's product and who logged it. */
function activities(db: Kysely<Database>) {
  return db
    .selectFrom('clients_activity as a')
    .leftJoin('clients_opportunity as o', 'o.id', 'a.opportunity_id')
    .leftJoin('clients_product as p', 'p.id', 'o.product_id')
    .innerJoin('employee as e', 'e.id', 'a.logged_by')
    .select([
      'a.id',
      'a.client_id',
      'a.kind',
      sql<CalendarDate>`a.happened_on::text`.as('happened_on'),
      'a.with_whom',
      'a.outcome',
      'a.amount_minor',
      'a.currency',
      'a.poc_id',
      'a.review_kind',
      'a.dm_attended',
      'a.logged_at',
      'o.id as deal_id',
      'p.name as product_name',
      'e.id as logged_by',
      sql<string>`e.first_name || ' ' || e.last_name`.as('logged_by_name'),
    ]);
}

type ActivityRow = Awaited<ReturnType<ReturnType<typeof activities>['executeTakeFirstOrThrow']>>;

function activityFrom(row: ActivityRow): LoggedActivity {
  return {
    id: row.id,
    clientId: row.client_id,
    deal: dealFrom(row.deal_id, row.product_name),
    kind: row.kind as ActivityKind,
    happenedOn: row.happened_on,
    withWhom: row.with_whom,
    outcome: row.outcome,
    amount: moneyOf(row.amount_minor, row.currency),
    review:
      row.poc_id === null || row.review_kind === null || row.dm_attended === null
        ? null
        : {
            pocId: row.poc_id,
            kind: row.review_kind as 'DAY7' | 'WEEK6' | 'WEEK9',
            dmAttended: row.dm_attended,
          },
    loggedBy: { id: row.logged_by, name: row.logged_by_name },
    loggedAt: row.logged_at,
  };
}

/** Every next step, with its deal's product, whose it is, who made it and who closed it. */
function steps(db: Kysely<Database>) {
  return db
    .selectFrom('clients_next_step as s')
    .leftJoin('clients_opportunity as o', 'o.id', 's.opportunity_id')
    .leftJoin('clients_product as p', 'p.id', 'o.product_id')
    .innerJoin('employee as owner', 'owner.id', 's.owner_id')
    .innerJoin('employee as maker', 'maker.id', 's.created_by')
    .leftJoin('employee as closer', 'closer.id', 's.done_by')
    .select([
      's.id',
      's.client_id',
      's.description',
      sql<CalendarDate>`s.due_on::text`.as('due_on'),
      's.source',
      's.from_activity',
      's.done_at',
      's.created_at',
      'o.id as deal_id',
      'p.name as product_name',
      'owner.id as owner_id',
      sql<string>`owner.first_name || ' ' || owner.last_name`.as('owner_name'),
      'maker.id as created_by',
      sql<string>`maker.first_name || ' ' || maker.last_name`.as('created_by_name'),
      'closer.id as done_by',
      sql<string | null>`closer.first_name || ' ' || closer.last_name`.as('done_by_name'),
    ]);
}

type StepRow = Awaited<ReturnType<ReturnType<typeof steps>['executeTakeFirstOrThrow']>>;

function stepFrom(row: StepRow): NextStep {
  return {
    id: row.id,
    clientId: row.client_id,
    deal: dealFrom(row.deal_id, row.product_name),
    description: row.description,
    dueOn: row.due_on,
    owner: { id: row.owner_id, name: row.owner_name },
    source: row.source as NextStepSource,
    fromActivity: row.from_activity,
    done:
      row.done_at === null || row.done_by === null || row.done_by_name === null
        ? null
        : { at: row.done_at, by: { id: row.done_by, name: row.done_by_name } },
    createdBy: { id: row.created_by, name: row.created_by_name },
    createdAt: row.created_at,
  };
}

function dealFrom(id: string | null, productName: string | null): DealNamed | null {
  return id === null || productName === null ? null : { id, productName };
}

/** An amount as the table holds it, BIGINT as text, or null where there is none. */
function moneyOf(amountMinor: string | null, currency: string | null): Money | null {
  return amountMinor === null || currency === null
    ? null
    : { amountMinor: Number(amountMinor), currency: currency as Currency };
}

function writerOf(by: Attribution): string {
  if (by.employeeId === null) {
    throw new Error('An activity was logged by nobody.');
  }

  return by.employeeId;
}
