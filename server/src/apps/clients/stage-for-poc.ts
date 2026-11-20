/**
 * The stage service's other half: the moves only a deal's POC makes. #279, Clients SRS CLI 24,
 * CLI 48 to CLI 52, TDD 3, TDD 5.
 *
 * A deal in a started POC ends one of two ways, converted or exited (CLI 52). It is never marked
 * lost ({@link refusalOfLoss}) and never moved by hand ({@link refusalOfMove}); its POC ending
 * decides (CLI 48). So these are not on {@link StageService}, which every route may reach, and
 * not behind a flag on a request anybody could send (TDD 5). They are here, and
 * .dependency-cruiser.cjs (`clients-poc-moves-only-from-the-poc`) lets nothing in clients import
 * this module but the POC service (#287). That is TDD 5's "StageService checks the
 * caller": the caller is checked when the code is built rather than when it runs.
 *
 * Nothing here asks who may: the POC service asks `clientsPolicy.updatePoc` first, since ending a
 * POC is its CS lead's or a BD manager's (CLI 35, TDD 12.1), whoever owns the deals it covers.
 *
 * The database holds the same rules whoever writes: only a deal in its POC is exited
 * (`clients_opportunity_exit_shape`), and goes live from there only as a win
 * (`clients_opportunity_live_after_signing`, `clients_opportunity_won_is_live`).
 */

import type { Actor } from '../../core/auth/actor.js';
import type { CompanyCalendar } from '../../core/calendar/company-calendar.js';
import { type CalendarDate, currentDate } from '../../core/calendar/time.js';
import type { EmployeeRepository } from '../../core/organisation/employee/employee.db.js';
import {
  type Money,
  type Opportunity,
  OpportunityEnded,
  OpportunityNotFound,
} from './opportunity.js';
import {
  type ClientsOpportunityRepository,
  type Debriefs,
  Ended,
  MovedMeanwhile,
  ReasonRefused,
} from './opportunity.db.js';
import { isAnId } from './product.js';
import { readExit, refusalOfReason } from './reason.js';
import type { ClientsReasonRepository } from './reason.db.js';
import type { ClientsRoleRepository } from './role.db.js';
import { StageMovedMeanwhile } from './stage.js';

/** How long after an exit its debrief falls due, in working days (CLI 53). */
export const DEBRIEF_AFTER_WORKING_DAYS = 5;

/** How a deal in its POC ended (CLI 48). */
export type PocOutcome = 'CONVERTED' | 'EXITED';

export class StageForPoc {
  constructor(
    private readonly opportunities: Pick<ClientsOpportunityRepository, 'find' | 'move' | 'end'>,
    /** The exit reasons a deal ends for (CLI 54). */
    private readonly reasons: Pick<ClientsReasonRepository, 'find'>,
    /** Who holds the BD manager role today, one of whom runs an exit's debrief (CLI 53). */
    private readonly grants: Pick<ClientsRoleRepository, 'live'>,
    /** Whose line manager the associate's is, who runs the debrief (CLI 53, #279). */
    private readonly employees: Pick<EmployeeRepository, 'findById'>,
    /** The company's working days, which the debrief falls five of after the exit (TDD 6.4). */
    private readonly calendar: Pick<CompanyCalendar, 'addWorkingDays'>,
    /** The company's today, which an ended deal is dated (CLI 25). */
    private readonly today: () => CalendarDate = () => currentDate(),
  ) {}

  /**
   * The POC converted for this deal (CLI 48, CLI 49): to Live from its POC, which wins it and adds
   * its product to what the client uses (CLI 25), as a move to Live by hand does without a POC.
   * Given `revaluedTo`, its value is revised as it converts (CLI 49, #287), the old value kept in
   * its history and the new one put down to the conversion.
   */
  async convert(actor: Actor, id: string, revaluedTo?: Money): Promise<Opportunity> {
    await this.inItsPoc(id);

    await this.ending(id, () =>
      this.opportunities.move(
        actor,
        id,
        { from: 'POC', to: 'LIVE', note: null },
        this.today(),
        undefined,
        revaluedTo,
      ),
    );

    return this.dealOrRefuse(id);
  }

  /**
   * The POC exited for this deal (CLI 48, CLI 52): it ends exited, still at POC, which is how far it
   * came, with why and which products the POC ran on.
   *
   * `{ reasonId, note }` as the POC service's request gave it, and read here, so that whoever asks
   * for an exit is held to the same rule: a reason from the exit list that is not retired (CLI 54),
   * and a note saying which products the POC ran on (CLI 52), each refused in a sentence naming
   * the field to fix.
   *
   * And it gives the BD manager an internal debrief: a next step due five working days after the
   * exit, by the company's week and public holidays (CLI 53, AC L16). See {@link debriefersOf}
   * for which BD manager.
   */
  async exit(actor: Actor, id: string, asked: unknown): Promise<Opportunity> {
    const deal = await this.inItsPoc(id);
    const exit = readExit(asked);
    const today = this.today();

    const notOffered = refusalOfReason(await this.reasons.find(exit.reasonId), 'EXITED');
    if (notOffered !== null) {
      throw notOffered;
    }

    const debriefs = await this.debriefsOf(actor, deal, today);

    try {
      await this.ending(id, () =>
        this.opportunities.end(
          actor,
          id,
          {
            stage: deal.stage,
            outcome: 'EXITED',
            reasonId: exit.reasonId,
            note: exit.note,
            debriefs,
          },
          today,
        ),
      );
    } catch (error) {
      /* Retired between the look and the write. */
      if (error instanceof ReasonRefused) {
        throw refusalOfReason(await this.reasons.find(exit.reasonId), 'EXITED') ?? error;
      }
      throw error;
    }

    return this.dealOrRefuse(id);
  }

  /** An exit's debriefs: what, when, and whose (CLI 53). */
  private async debriefsOf(
    actor: Actor,
    deal: Opportunity,
    today: CalendarDate,
  ): Promise<Debriefs> {
    return {
      description: `Internal debrief on the ${deal.client.name} ${deal.product.name} POC exit`,
      dueOn: await this.calendar.addWorkingDays(today, DEBRIEF_AFTER_WORKING_DAYS),
      ownerIds: await this.debriefersOf(actor, deal),
    };
  }

  /**
   * Who runs the debrief (CLI 53, "the BD manager"). Clients allows several BD managers (#274),
   * so the user chose (#279): the line manager of the deal's owner, where that line manager holds
   * the BD manager role, as every customer success associate's does. A deal's owner is always
   * the CS lead of its POC, the user says, so the owner is who ran it.
   *
   * Access to clients is granted, not read from the reporting line (SRS 2.1), so a line manager
   * without the role could not open the debrief they were given. Where the line manager is not a
   * BD manager, or there is none, it goes to every BD manager instead, so that it lands with
   * somebody who can see it; and where nobody holds the role today, to whoever exited the POC,
   * so that the debrief the POC SOP asks for is never lost. Both as the user approved (#279).
   */
  private async debriefersOf(actor: Actor, deal: Opportunity): Promise<string[]> {
    const [owner, grants] = await Promise.all([
      this.employees.findById(deal.owner.id),
      this.grants.live(),
    ]);
    const bdManagers = [
      ...new Set(
        grants.filter((grant) => grant.role === 'BD_MANAGER').map((grant) => grant.employeeId),
      ),
    ];
    const lineManager = owner?.managerId ?? null;

    if (lineManager !== null && bdManagers.includes(lineManager)) {
      return [lineManager];
    }
    if (bdManagers.length > 0) {
      return bdManagers;
    }

    return actor.employeeId === null ? [] : [actor.employeeId];
  }

  /** The deal, open and in a started POC; or why not. */
  private async inItsPoc(id: string): Promise<Opportunity> {
    const deal = await this.dealOrRefuse(id);

    if (deal.outcome !== 'OPEN') {
      throw new OpportunityEnded(deal.product.name, deal.outcome);
    }
    if (deal.stage !== 'POC') {
      throw new NotInItsPoc(deal.product.name);
    }

    return deal;
  }

  /** Makes the write, saying in a sentence why the database refused it, where it did. */
  private async ending(id: string, write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (error) {
      if (error instanceof MovedMeanwhile) throw new StageMovedMeanwhile();
      if (error instanceof Ended) {
        const now = await this.dealOrRefuse(id);
        throw new OpportunityEnded(now.product.name, now.outcome);
      }
      throw error;
    }
  }

  private async dealOrRefuse(id: string): Promise<Opportunity> {
    const found = isAnId(id) ? await this.opportunities.find(id) : undefined;

    if (found === undefined) {
      throw new OpportunityNotFound();
    }

    return found;
  }
}

/**
 * Only a deal in a started POC ends by its POC converting or exiting (CLI 52). One before its POC
 * starts is moved on, or marked lost (CLI 51).
 */
export class NotInItsPoc extends Error {
  constructor(productName: string) {
    super(
      `The ${productName} deal is not in a started POC, so it does not end by a POC converting ` +
        'or exiting. Move it on, or mark it lost.',
    );
    this.name = 'NotInItsPoc';
  }
}
