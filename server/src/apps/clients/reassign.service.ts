/**
 * A BD manager moving an open deal, or everything of one person's, to somebody else (#289, Clients
 * SRS CLI 92, CLI 96, TDD 11). Moving a client is its owner change on the client (ClientService);
 * moving a POC's CS lead alone is on the POC (PocService). What moves with each is in
 * reassign.db.ts.
 *
 * Only a BD manager moves anything (CLI 92), and only to somebody who could take it over: a
 * clients role, and at the company today (the user, 24 November 2026).
 */

import type { Actor } from '../../core/auth/actor.js';
import type { Guard } from '../../core/auth/policy.js';
import { accessOf } from './access.js';
import { fieldsOf } from './logged-activity.js';
import { OpportunityEnded, OpportunityNotFound } from './opportunity.js';
import { Ended, type ClientsOpportunityRepository } from './opportunity.db.js';
import { clientsPolicy } from './policy.js';
import { isAnId } from './product.js';
import type { ClientsReassignRepository, Moved } from './reassign.db.js';
import type { ClientsRoleRepository } from './role.db.js';
import { CANNOT_TAKE_OVER, canTakeOver, type ClientsStandings } from './standing.js';

/** A move that names nobody, or somebody who cannot take over. */
export class InvalidReassignment extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidReassignment';
    this.field = field;
  }
}

export class ReassignService {
  constructor(
    private readonly guard: Guard,
    private readonly grants: Pick<ClientsRoleRepository, 'rolesOf'>,
    private readonly opportunities: Pick<ClientsOpportunityRepository, 'find'>,
    private readonly reassign: Pick<ClientsReassignRepository, 'moveDeal' | 'moveAll'>,
    private readonly standings: Pick<ClientsStandings, 'of'>,
  ) {}

  /**
   * `{ ownerId }`: moves an open deal to them, with the old owner's open steps on it, and its POC's
   * lead where it is in one. A deal already theirs moves nothing.
   */
  async moveDeal(actor: Actor, dealId: string, body: unknown): Promise<void> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, dealId));

    const deal = isAnId(dealId) ? await this.opportunities.find(dealId) : undefined;
    if (deal === undefined) {
      throw new OpportunityNotFound();
    }
    this.guard.enforce(clientsPolicy.reassign(actor, access, 'deal', dealId));

    if (deal.outcome !== 'OPEN') {
      throw new OpportunityEnded(deal.product.name, deal.outcome);
    }

    const ownerId = await this.whoTakesOver(fieldsOf(body).ownerId, 'ownerId');

    try {
      await this.reassign.moveDeal(actor, dealId, ownerId);
    } catch (error) {
      /* It ended between the look and the move: say how. */
      if (error instanceof Ended) {
        const now = await this.opportunities.find(dealId);
        throw new OpportunityEnded(deal.product.name, now?.outcome ?? deal.outcome);
      }
      throw error;
    }
  }

  /**
   * `{ fromId, toId }`: moves every client `fromId` owns, every open deal and every running POC
   * they lead, to `toId`, all at once. From the dashboard's list of what needs reassigning, though
   * anybody's may be moved: somebody about to go on leave, say.
   */
  async moveAll(actor: Actor, body: unknown): Promise<Moved> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access));

    const fields = fieldsOf(body);
    const fromId = fields.fromId;
    if (typeof fromId !== 'string' || !isAnId(fromId)) {
      throw new InvalidReassignment('fromId', 'Choose whose things to move.');
    }
    this.guard.enforce(clientsPolicy.reassign(actor, access, 'client', fromId));

    const toId = await this.whoTakesOver(fields.toId, 'toId');
    if (toId === fromId) {
      throw new InvalidReassignment('toId', 'Choose somebody else to move them to.');
    }

    return this.reassign.moveAll(actor, fromId, toId);
  }

  /** The person named, where they could take things over. */
  private async whoTakesOver(value: unknown, field: string): Promise<string> {
    if (typeof value !== 'string' || !isAnId(value)) {
      throw new InvalidReassignment(field, 'Choose who to move it to.');
    }
    if (!(await canTakeOver(this.standings, value))) {
      throw new InvalidReassignment(field, CANNOT_TAKE_OVER);
    }

    return value;
  }
}
