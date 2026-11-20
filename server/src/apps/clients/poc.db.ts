/**
 * Database access for POCs. #285, Clients SRS CLI 27 to CLI 34, TDD 4.3, TDD 6.
 *
 * A POC is made by the stage service as its deal's contract is signed (opportunity.db.ts), with
 * its review steps. Here: reading them, recording a review meeting, and moving the CS lead. Every
 * write goes through `recording()`, so the audit triggers know who made it. Nothing is deleted.
 */

import { type Kysely, sql } from 'kysely';
import type { Attribution } from '../../core/audit/audit.js';
import type { CalendarDate } from '../../core/calendar/time.js';
import type { Database } from '../../core/db/index.js';
import { recording } from '../../core/db/recording.js';
import type { Outcome } from './opportunity.js';
import {
  type Poc,
  type ReviewHeld,
  type ReviewKind,
  type ReviewRecorded,
  type ReviewStep,
  rescheduledReviewOf,
} from './poc.js';
import type { Stage } from './stage.js';

export class ClientsPocRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Every POC whose deal is still in it, the soonest to be decided first (CLI 101). */
  async running(): Promise<Poc[]> {
    const rows = await pocs(this.db)
      .where('o.outcome', '=', 'OPEN')
      .orderBy('poc.decision_on')
      .orderBy('poc.id')
      .execute();

    return rows.map(pocFrom);
  }

  async find(id: string): Promise<Poc | undefined> {
    const row = await pocs(this.db).where('poc.id', '=', id).executeTakeFirst();

    return row === undefined ? undefined : pocFrom(row);
  }

  /** Its review steps, open and closed, in the order they fall due (CLI 33, CLI 100). */
  async reviewSteps(pocId: string): Promise<ReviewStep[]> {
    const rows = await this.db
      .selectFrom('clients_next_step as s')
      .innerJoin('employee as owner', 'owner.id', 's.owner_id')
      .leftJoin('employee as closer', 'closer.id', 's.done_by')
      .select([
        's.id',
        's.review_kind',
        's.description',
        sql<CalendarDate>`s.due_on::text`.as('due_on'),
        's.done_at',
        'owner.id as owner_id',
        sql<string>`owner.first_name || ' ' || owner.last_name`.as('owner_name'),
        'closer.id as done_by',
        sql<string | null>`closer.first_name || ' ' || closer.last_name`.as('done_by_name'),
      ])
      .where('s.poc_id', '=', pocId)
      .where('s.source', '=', 'REVIEW')
      .orderBy('s.due_on')
      .orderBy('s.id')
      .execute();

    return rows.map((row) => ({
      id: row.id,
      kind: row.review_kind as ReviewKind,
      description: row.description,
      dueOn: row.due_on,
      owner: { id: row.owner_id, name: row.owner_name },
      done:
        row.done_at === null || row.done_by === null || row.done_by_name === null
          ? null
          : { at: row.done_at, by: { id: row.done_by, name: row.done_by_name } },
    }));
  }

  /** The review meetings recorded on it, the latest held first (CLI 34). */
  async reviewsHeld(pocId: string): Promise<ReviewHeld[]> {
    const rows = await this.db
      .selectFrom('clients_activity as a')
      .innerJoin('employee as e', 'e.id', 'a.logged_by')
      .select([
        'a.id',
        'a.review_kind',
        sql<CalendarDate>`a.happened_on::text`.as('held_on'),
        'a.dm_attended',
        'a.with_whom',
        'a.outcome',
        'a.logged_at',
        'e.id as logged_by',
        sql<string>`e.first_name || ' ' || e.last_name`.as('logged_by_name'),
      ])
      .where('a.poc_id', '=', pocId)
      .where('a.kind', '=', 'REVIEW')
      .orderBy('a.happened_on', 'desc')
      .orderBy('a.id', 'desc')
      .execute();

    return rows.map((row) => ({
      id: row.id,
      kind: row.review_kind as ReviewKind,
      heldOn: row.held_on,
      dmAttended: row.dm_attended === true,
      withWhom: row.with_whom,
      outcome: row.outcome,
      loggedBy: { id: row.logged_by, name: row.logged_by_name },
      loggedAt: row.logged_at,
    }));
  }

  /**
   * Records a review meeting, in one transaction (CLI 34, the user, 20 November 2026): the
   * activity, about the POC's deal; that review's open step closed, by whoever recorded it; and,
   * where the senior decision maker was not there, a replacement for the CS lead due seven days
   * after the meeting.
   */
  async recordReview(by: Attribution, poc: Poc, review: ReviewRecorded): Promise<string> {
    const recordedBy = writerOf(by);

    return recording(this.db, by, async (on) => {
      const logged = await on
        .insertInto('clients_activity')
        .values({
          client_id: poc.client.id,
          opportunity_id: poc.deal.id,
          poc_id: poc.id,
          kind: 'REVIEW',
          review_kind: review.kind,
          dm_attended: review.dmAttended,
          happened_on: review.heldOn,
          with_whom: review.withWhom,
          outcome: review.outcome,
          logged_by: recordedBy,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await on
        .updateTable('clients_next_step')
        .set({ done_at: sql<Date>`now()`, done_by: recordedBy })
        .where('poc_id', '=', poc.id)
        .where('source', '=', 'REVIEW')
        .where('review_kind', '=', review.kind)
        .where('done_at', 'is', null)
        .execute();

      if (!review.dmAttended) {
        const again = rescheduledReviewOf(review.kind, review.heldOn, {
          clientName: poc.client.name,
          productName: poc.deal.productName,
        });

        await on
          .insertInto('clients_next_step')
          .values({
            client_id: poc.client.id,
            opportunity_id: poc.deal.id,
            poc_id: poc.id,
            review_kind: review.kind,
            description: again.description,
            due_on: again.dueOn,
            owner_id: poc.csLead.id,
            source: 'REVIEW',
            created_by: recordedBy,
          })
          .execute();
      }

      return logged.id;
    });
  }

  /**
   * Hands the POC to another CS lead, and its open review steps with it, in one transaction (CLI
   * 29, CLI 92, the user, 20 November 2026). The audit trigger on clients_poc keeps who it was.
   */
  async moveLead(by: Attribution, pocId: string, employeeId: string): Promise<void> {
    await recording(this.db, by, async (on) => {
      await on
        .updateTable('clients_poc')
        .set({ cs_lead_id: employeeId })
        .where('id', '=', pocId)
        .executeTakeFirstOrThrow();

      await on
        .updateTable('clients_next_step')
        .set({ owner_id: employeeId })
        .where('poc_id', '=', pocId)
        .where('source', '=', 'REVIEW')
        .where('done_at', 'is', null)
        .execute();
    });
  }
}

/** Every POC, with its client, line, deal, CS lead, and whether the CS lead holds a role. */
function pocs(db: Kysely<Database>) {
  return db
    .selectFrom('clients_poc as poc')
    .innerJoin('clients_client as c', 'c.id', 'poc.client_id')
    .innerJoin('clients_client_type as t', 't.id', 'poc.client_type_id')
    .innerJoin('clients_product_line as l', 'l.id', 'poc.line_id')
    .innerJoin('clients_opportunity as o', 'o.poc_id', 'poc.id')
    .innerJoin('clients_product as p', 'p.id', 'o.product_id')
    .innerJoin('employee as owner', 'owner.id', 'o.owner_id')
    .innerJoin('employee as lead', 'lead.id', 'poc.cs_lead_id')
    .select([
      'poc.id',
      'c.id as client_id',
      'c.name as client_name',
      't.name as client_type',
      'l.name as line_name',
      'o.id as deal_id',
      'p.name as product_name',
      'o.stage',
      'o.outcome',
      'owner.id as owner_id',
      sql<string>`owner.first_name || ' ' || owner.last_name`.as('owner_name'),
      'lead.id as lead_id',
      sql<string>`lead.first_name || ' ' || lead.last_name`.as('lead_name'),
      sql<boolean>`EXISTS (SELECT 1 FROM clients_role r
                            WHERE r.employee_id = poc.cs_lead_id AND r.ended_at IS NULL)`.as(
        'lead_holds_a_role',
      ),
      sql<CalendarDate>`poc.started_on::text`.as('started_on'),
      sql<CalendarDate>`poc.decision_on::text`.as('decision_on'),
    ]);
}

type PocRow = Awaited<ReturnType<ReturnType<typeof pocs>['executeTakeFirstOrThrow']>>;

function pocFrom(row: PocRow): Poc {
  return {
    id: row.id,
    client: { id: row.client_id, name: row.client_name, type: row.client_type },
    lineName: row.line_name,
    deal: {
      id: row.deal_id,
      productName: row.product_name,
      stage: row.stage as Stage,
      outcome: row.outcome as Outcome,
      owner: { id: row.owner_id, name: row.owner_name },
    },
    csLead: { id: row.lead_id, name: row.lead_name },
    csLeadHoldsARole: row.lead_holds_a_role,
    startedOn: row.started_on,
    decisionOn: row.decision_on,
  };
}

function writerOf(by: Attribution): string {
  if (by.employeeId === null) {
    throw new Error('A POC was changed by nobody.');
  }

  return by.employeeId;
}
