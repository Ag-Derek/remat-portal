/**
 * Moving a deal up and down the ladder. #278, Clients SRS CLI 18 to CLI 26, TDD 3, TDD 5.
 *
 * The only way a deal's stage or outcome changes (TDD 3): nothing else in clients updates either,
 * and the repository's `move` is the one write that does. The database holds the same ladder
 * whoever writes, so a path that forgot a rule here would still be refused there.
 *
 * Moves made by hand come through {@link StageService.move}, and a deal marked lost through
 * {@link StageService.lose} (#279), which ends it where it stands. A deal with a POC goes into it as
 * its contract is signed, by the same move (#285): signing starts the POC. Out of it, its POC
 * decides, through `stage-for-poc.ts`, which only the POC service may call (TDD 5).
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
import {
  type ClientsOpportunityRepository,
  Ended,
  MovedMeanwhile,
  ReasonRefused,
} from './opportunity.db.js';
import { viewOf } from './opportunity.service.js';
import { decisionDateOf, type NewPoc } from './poc.js';
import { clientsPolicy } from './policy.js';
import { isAnId } from './product.js';
import { type Reason, type ReasonList, readLoss, refusalOfReason } from './reason.js';
import type { ClientsReasonRepository } from './reason.db.js';
import type { ClientsRoleRepository } from './role.db.js';
import {
  readStageMove,
  refusalOfLoss,
  refusalOfMove,
  type StageChange,
  StageMovedMeanwhile,
} from './stage.js';

export class StageService {
  constructor(
    private readonly guard: Guard,
    private readonly grants: Pick<ClientsRoleRepository, 'rolesOf'>,
    private readonly opportunities: Pick<
      ClientsOpportunityRepository,
      'find' | 'move' | 'end' | 'stages'
    >,
    /** The lost and exit reasons a deal ends for (#279). */
    private readonly lists: Pick<ClientsReasonRepository, 'all' | 'find'>,
    /** The company's today, which an ended deal is dated (CLI 25). */
    private readonly today: () => CalendarDate = () => currentDate(),
  ) {}

  /**
   * Marks a deal lost: `{ reasonId, note? }` (CLI 51). Its owner's or a BD manager's (CLI 13),
   * at any stage before its POC starts; a deal in its POC ends converted or exited instead (CLI
   * 52). The reason is from the lost list, and not retired (CLI 54). It stays at the stage it
   * reached, which is how far it came (TDD 1, principle 2).
   */
  async lose(actor: Actor, id: string, body: unknown): Promise<DealView> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const deal = await this.opportunityOrRefuse(id);
    this.guard.enforce(clientsPolicy.changeDeal(actor, access, deal));

    if (deal.outcome !== 'OPEN') {
      throw new OpportunityEnded(deal.product.name, deal.outcome);
    }

    const refusal = refusalOfLoss(deal);
    if (refusal !== null) {
      throw refusal;
    }

    const loss = readLoss(body);
    const notOffered = refusalOfReason(await this.lists.find(loss.reasonId), 'LOST');
    if (notOffered !== null) {
      throw notOffered;
    }

    try {
      await this.opportunities.end(
        actor,
        id,
        { stage: deal.stage, outcome: 'LOST', reasonId: loss.reasonId, note: loss.note },
        this.today(),
      );
    } catch (error) {
      if (error instanceof MovedMeanwhile) throw new StageMovedMeanwhile();
      if (error instanceof Ended) {
        const now = await this.opportunityOrRefuse(id);
        throw new OpportunityEnded(now.product.name, now.outcome);
      }
      /* Retired between the look and the write. */
      if (error instanceof ReasonRefused) {
        throw refusalOfReason(await this.lists.find(loss.reasonId), 'LOST') ?? error;
      }
      throw error;
    }

    return viewOf(actor, access, await this.opportunityOrRefuse(id));
  }

  /**
   * The reasons a deal may end for now, on each list, in the order they were added: what the
   * screen offers when a deal is lost or a POC exited (CLI 51, CLI 52). Anybody with a role's,
   * since anybody with a role may end their own deals. Retired reasons are left out; the deals
   * that ended for them still name them.
   */
  async reasons(actor: Actor): Promise<Record<ReasonList, Reason[]>> {
    this.guard.enforce(clientsPolicy.read(actor, await accessOf(actor, this.grants)));

    const current = (await this.lists.all()).filter((reason) => reason.retiredOn === null);

    return {
      LOST: current.filter((reason) => reason.appliesTo === 'LOST'),
      EXITED: current.filter((reason) => reason.appliesTo === 'EXITED'),
    };
  }

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

    const today = this.today();

    try {
      await this.opportunities.move(
        actor,
        id,
        { from: deal.stage, to: move.toStage, note: move.note },
        today,
        move.toStage === 'CONTRACT_SIGNED' && deal.hasPoc === true
          ? pocStartedBySigning(deal, today)
          : undefined,
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

/**
 * The POC a deal's signing starts (#285): that day, decided ten weeks later (CLI 31), and run by
 * the deal's owner (the user, #279), whether or not they still hold a clients role. One who does
 * not is flagged as needing reassignment rather than refused (the user, 19 November 2026, CLI 96).
 */
function pocStartedBySigning(deal: Opportunity, today: CalendarDate): NewPoc {
  return { csLeadId: deal.owner.id, startedOn: today, decisionOn: decisionDateOf(today) };
}
