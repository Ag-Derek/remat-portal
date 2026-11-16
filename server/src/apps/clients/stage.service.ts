/**
 * Moving a deal up and down the ladder. #278, Clients SRS CLI 18 to CLI 26, TDD 3, TDD 5.
 *
 * The only way a deal's stage or outcome changes (TDD 3): nothing else in clients updates either,
 * and the repository's `move` is the one write that does. The database holds the same ladder
 * whoever writes, so a path that forgot a rule here would still be refused there.
 *
 * Moves made by hand come through {@link StageService.move}. The POC moving its deals in and out
 * of the POC stage will come through a method of its own, which only the POC service calls (TDD
 * 5), rather than through a flag on a request anybody could send.
 */

import type { Actor } from '../../core/auth/actor.js';
import type { Guard } from '../../core/auth/policy.js';
import { type CalendarDate, currentDate } from '../../core/calendar/time.js';
import { accessOf } from './access.js';
import {
  type DealView,
  type Opportunity,
  OpportunityEnded,
  OpportunityNotFound,
} from './opportunity.js';
import { type ClientsOpportunityRepository, Ended, MovedMeanwhile } from './opportunity.db.js';
import { viewOf } from './opportunity.service.js';
import { clientsPolicy } from './policy.js';
import { isAnId } from './product.js';
import type { ClientsRoleRepository } from './role.db.js';
import { readStageMove, refusalOfMove, type StageChange, StageMovedMeanwhile } from './stage.js';

export class StageService {
  constructor(
    private readonly guard: Guard,
    private readonly grants: Pick<ClientsRoleRepository, 'rolesOf'>,
    private readonly opportunities: Pick<ClientsOpportunityRepository, 'find' | 'move' | 'stages'>,
    /** The company's today, which a won deal is dated (CLI 25). */
    private readonly today: () => CalendarDate = () => currentDate(),
  ) {}

  /**
   * Moves a deal to another stage by hand: `{ toStage, note? }`. Its owner's or a BD manager's
   * (CLI 13); anybody else with a role is told whose it is.
   *
   * Forward by one stage or several (CLI 20), back with a note before Contract signed and never
   * after (CLI 21), to Contract signed only with the POC question answered (CLI 19), and to Live
   * only from Contract signed with no POC (CLI 24), which wins it (CLI 25). Never into or out of
   * a POC: its POC does that. Each refusal says what is in the way.
   */
  async move(actor: Actor, id: string, body: unknown): Promise<DealView> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const deal = await this.opportunityOrRefuse(id);
    this.guard.enforce(clientsPolicy.changeDeal(actor, access, deal));

    if (deal.outcome !== 'OPEN') {
      throw new OpportunityEnded(deal.product.name, deal.outcome);
    }

    const move = readStageMove(body);
    const refusal = refusalOfMove(deal, move);
    if (refusal !== null) {
      throw refusal;
    }

    try {
      await this.opportunities.move(
        actor,
        id,
        { from: deal.stage, to: move.toStage, note: move.note },
        this.today(),
      );
    } catch (error) {
      if (error instanceof MovedMeanwhile) throw new StageMovedMeanwhile();
      if (error instanceof Ended) {
        const now = await this.opportunityOrRefuse(id);
        throw new OpportunityEnded(now.product.name, now.outcome);
      }
      throw error;
    }

    return viewOf(actor, access, await this.opportunityOrRefuse(id));
  }

  /**
   * Every stage a deal has been at, newest first, with who moved it, when, and why where they
   * said (CLI 26). Anybody with a role's, as the deal is (CLI 90).
   */
  async stages(actor: Actor, id: string): Promise<StageChange[]> {
    this.guard.enforce(clientsPolicy.read(actor, await accessOf(actor, this.grants), id));

    await this.opportunityOrRefuse(id);

    return this.opportunities.stages(id);
  }

  private async opportunityOrRefuse(id: string): Promise<Opportunity> {
    const found = isAnId(id) ? await this.opportunities.find(id) : undefined;

    if (found === undefined) {
      throw new OpportunityNotFound();
    }

    return found;
  }
}
