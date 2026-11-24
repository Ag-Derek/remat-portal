/**
 * Moving clients, open deals and running POCs to somebody else: a BD manager's (#289, Clients SRS
 * CLI 92, CLI 96). What moves with each, as the user decided on 24 November 2026:
 *
 * - **A client**: its owner, and the open next steps on it that are on no deal or POC and were
 *   the old owner's. Its deals stay with their owners: a client's deals may be different people's.
 * - **An open deal**: its owner; the open next steps on it the old owner held, not anybody else's;
 *   and, where it is in a POC, that POC's CS lead and open review meetings, so that the deal's
 *   owner and its CS lead stay one person. An ended deal is history, and the database refuses to
 *   change it.
 * - **A POC's CS lead**, on its own from the POC page: the lead and the open review meetings, as
 *   before (#285).
 * - **Everything of one person's**, from the dashboard: each of their clients, open deals and
 *   running POCs, each as above, in one transaction.
 *
 * Every write goes through `recording()`, so the audit triggers know who moved what (NFR CLI AUD
 * 01). Who may move, and to whom, is the service's to decide.
 */

import type { Kysely } from 'kysely';
import type { Attribution } from '../../core/audit/audit.js';
import type { Database } from '../../core/db/index.js';
import { recording } from '../../core/db/recording.js';
import { Ended } from './opportunity.db.js';

/** The trigger that keeps an ended deal as it ended (CLI 55, CLI 56). */
const ENDED_IS_FIXED = 'clients_opportunity_ended_is_fixed';

/** How many of each one move moved. */
export interface Moved {
  clients: number;
  deals: number;
  pocs: number;
}

export class ClientsReassignRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Moves an open deal, with what goes with it, to `toId`. Refused with {@link Ended} if ended. */
  async moveDeal(by: Attribution, dealId: string, toId: string): Promise<void> {
    try {
      await recording(this.db, by, (on) => moveDealWithin(on, dealId, toId));
    } catch (error) {
      if ((error as { constraint?: unknown }).constraint === ENDED_IS_FIXED) throw new Ended();
      throw error;
    }
  }

  /**
   * Moves every client `fromId` owns, every open deal, and every running POC they lead, to `toId`,
   * all or nothing. Says how many of each moved.
   */
  async moveAll(by: Attribution, fromId: string, toId: string): Promise<Moved> {
    return recording(this.db, by, async (on) => {
      const clients = await on
        .selectFrom('clients_client')
        .select('id')
        .where('owner_id', '=', fromId)
        .forUpdate()
        .execute();
      for (const client of clients) {
        await moveClientWithin(on, client.id, fromId, toId);
      }

      /* The running POCs that move: those they lead, and those on a deal of theirs, which a
         deal takes with it. Read before anything moves. */
      const pocs = await on
        .selectFrom('clients_poc as poc')
        .innerJoin('clients_opportunity as o', 'o.poc_id', 'poc.id')
        .select('poc.id')
        .distinct()
        .where('o.outcome', '=', 'OPEN')
        .where((eb) => eb.or([eb('poc.cs_lead_id', '=', fromId), eb('o.owner_id', '=', fromId)]))
        .execute();

      const deals = await on
        .selectFrom('clients_opportunity')
        .select('id')
        .where('owner_id', '=', fromId)
        .where('outcome', '=', 'OPEN')
        .forUpdate()
        .execute();
      for (const deal of deals) {
        await moveDealWithin(on, deal.id, toId);
      }
      /* Moving one twice moves nothing the second time. */
      for (const poc of pocs) {
        await moveLeadWithin(on, poc.id, toId);
      }

      return { clients: clients.length, deals: deals.length, pocs: pocs.length };
    });
  }
}

/**
 * A client's owner, and the old owner's open next steps on the client itself: not on a deal or a
 * POC, which move with those. Inside the caller's transaction.
 */
export async function moveClientWithin(
  on: Kysely<Database>,
  clientId: string,
  fromId: string,
  toId: string,
): Promise<void> {
  if (fromId === toId) {
    return;
  }

  await on
    .updateTable('clients_client')
    .set({ owner_id: toId })
    .where('id', '=', clientId)
    .execute();

  await on
    .updateTable('clients_next_step')
    .set({ owner_id: toId })
    .where('client_id', '=', clientId)
    .where('opportunity_id', 'is', null)
    .where('poc_id', 'is', null)
    .where('owner_id', '=', fromId)
    .where('done_at', 'is', null)
    .execute();
}

/**
 * An open deal's owner, the old owner's open steps on it, and its POC's lead where it has one.
 * Inside the caller's transaction; the database refuses an ended deal.
 */
async function moveDealWithin(on: Kysely<Database>, dealId: string, toId: string): Promise<void> {
  const deal = await on
    .selectFrom('clients_opportunity')
    .select(['owner_id', 'poc_id'])
    .where('id', '=', dealId)
    .forUpdate()
    .executeTakeFirstOrThrow();

  if (deal.owner_id !== toId) {
    await on
      .updateTable('clients_opportunity')
      .set({ owner_id: toId })
      .where('id', '=', dealId)
      .execute();

    /* Its review meetings are its POC's lead's, and follow the lead below. */
    await on
      .updateTable('clients_next_step')
      .set({ owner_id: toId })
      .where('opportunity_id', '=', dealId)
      .where('owner_id', '=', deal.owner_id)
      .where('source', '<>', 'REVIEW')
      .where('done_at', 'is', null)
      .execute();
  }

  if (deal.poc_id !== null) {
    await moveLeadWithin(on, deal.poc_id, toId);
  }
}

/** A POC's CS lead, and its open review meetings, which are the lead's to hold (#285). */
export async function moveLeadWithin(
  on: Kysely<Database>,
  pocId: string,
  toId: string,
): Promise<void> {
  await on
    .updateTable('clients_poc')
    .set({ cs_lead_id: toId })
    .where('id', '=', pocId)
    .where('cs_lead_id', '<>', toId)
    .execute();

  await on
    .updateTable('clients_next_step')
    .set({ owner_id: toId })
    .where('poc_id', '=', pocId)
    .where('source', '=', 'REVIEW')
    .where('done_at', 'is', null)
    .execute();
}
