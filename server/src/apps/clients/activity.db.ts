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
} from './logged-activity.js';
import {
  type NewNextStep,
  type NextStep,
  NextStepAlreadyClosed,
  NextStepNotClosed,
  type NextStepSource,
} from './next-step.js';

/** The trigger that fixes an activity 24 hours after it is logged (CLI 62). */
const FIXED_AFTER_A_DAY = 'clients_activity_fixed_after_a_day';

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
          logged_by: loggedBy,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

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
   */
  async correct(by: Attribution, id: string, change: ActivityChange): Promise<void> {
    const values = {
      ...(change.opportunityId === undefined ? {} : { opportunity_id: change.opportunityId }),
      ...(change.kind === undefined ? {} : { kind: change.kind }),
      ...(change.happenedOn === undefined ? {} : { happened_on: change.happenedOn }),
      ...(change.withWhom === undefined ? {} : { with_whom: change.withWhom }),
      ...(change.outcome === undefined ? {} : { outcome: change.outcome }),
    };

    if (Object.keys(values).length === 0) {
      return;
    }

    try {
      await recording(this.db, by, (on) =>
        on.updateTable('clients_activity').set(values).where('id', '=', id).execute(),
      );
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

function writerOf(by: Attribution): string {
  if (by.employeeId === null) {
    throw new Error('An activity was logged by nobody.');
  }

  return by.employeeId;
}
