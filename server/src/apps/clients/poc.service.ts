/**
 * Running a POC. #285, Clients SRS CLI 27 to CLI 34, CLI 100, CLI 101, TDD 3's PocService.
 *
 * A POC is started by its deal's contract being signed, through the stage service (#285, the
 * user, 19 November 2026). Here: the POC list and page, recording a review meeting, and moving
 * the CS lead. Health and usage (#286) and the extension and the end (#287) join it.
 *
 * Every method asks `clientsPolicy` first, before reading the request, so somebody refused learns
 * nothing from what they sent.
 */

import type { Actor } from '../../core/auth/actor.js';
import type { Guard } from '../../core/auth/policy.js';
import { type CalendarDate, currentDate } from '../../core/calendar/time.js';
import { accessOf } from './access.js';
import {
  dayOf,
  daysToDecision,
  InvalidPocLead,
  type Poc,
  type PocPage,
  PocEnded,
  PocNotFound,
  type PocView,
  phaseOf,
  readNewLead,
  readReview,
} from './poc.js';
import type { ClientsPocRepository } from './poc.db.js';
import { type ClientsAccess, clientsPolicy } from './policy.js';
import { isAnId } from './product.js';
import type { ClientsRoleRepository } from './role.db.js';

export class PocService {
  constructor(
    private readonly guard: Guard,
    private readonly grants: Pick<ClientsRoleRepository, 'rolesOf'>,
    private readonly pocs: ClientsPocRepository,
    /** The company's today, which a POC's phase and days are counted to (TDD 6.1). */
    private readonly today: () => CalendarDate = () => currentDate(),
  ) {}

  /**
   * Every POC still running, the soonest to be decided first, each with its phase and days to
   * decision (CLI 101). Anybody with a role's (CLI 90).
   */
  async list(actor: Actor): Promise<PocView[]> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access));

    const today = this.today();

    return (await this.pocs.running()).map((poc) => viewOf(actor, access, poc, today));
  }

  /** One POC's page: its deal, clock, review meetings and those held (CLI 100). */
  async page(actor: Actor, id: string): Promise<PocPage> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const poc = await this.pocOrRefuse(id);
    const [reviews, held] = await Promise.all([
      this.pocs.reviewSteps(poc.id),
      this.pocs.reviewsHeld(poc.id),
    ]);

    return { ...viewOf(actor, access, poc, this.today()), reviews, held };
  }

  /**
   * Records a review meeting: `{ reviewKind, heldOn, dmAttended, withWhom?, outcome? }` (CLI 34).
   * Its CS lead's or a BD manager's, whoever owns its deal (CLI 91, AC L23). Attended, it closes
   * that review's step; not attended, it does not count, and a replacement is due seven days after
   * the meeting (the user, 20 November 2026).
   */
  async recordReview(actor: Actor, id: string, body: unknown): Promise<PocPage> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const poc = await this.pocOrRefuse(id);
    this.guard.enforce(clientsPolicy.updatePoc(actor, access, poc));

    if (poc.deal.outcome !== 'OPEN') {
      throw new PocEnded(poc.deal.productName);
    }

    await this.pocs.recordReview(actor, poc, readReview(body, this.today()));

    return this.page(actor, id);
  }

  /**
   * Hands the POC to another CS lead, `{ employeeId }`, its open review steps with it: a BD
   * manager's (CLI 92). Whoever takes it holds a clients role today (CLI 29).
   */
  async moveLead(actor: Actor, id: string, body: unknown): Promise<PocPage> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const poc = await this.pocOrRefuse(id);
    this.guard.enforce(clientsPolicy.reassign(actor, access, 'poc', id));

    if (poc.deal.outcome !== 'OPEN') {
      throw new PocEnded(poc.deal.productName);
    }

    const employeeId = readNewLead(body);
    if ((await this.grants.rolesOf(employeeId)).length === 0) {
      throw new InvalidPocLead(
        'A CS lead needs a role in clients, to see the POC and run it. Choose somebody who has one.',
      );
    }

    if (employeeId !== poc.csLead.id) {
      await this.pocs.moveLead(actor, poc.id, employeeId);
    }

    return this.page(actor, id);
  }

  private async pocOrRefuse(id: string): Promise<Poc> {
    const found = isAnId(id) ? await this.pocs.find(id) : undefined;

    if (found === undefined) {
      throw new PocNotFound();
    }

    return found;
  }
}

/** A POC as somebody reads it today: its clock, and what they may do (CLI 32, TDD 6.1). */
function viewOf(actor: Actor, access: ClientsAccess, poc: Poc, today: CalendarDate): PocView {
  const running = poc.deal.outcome === 'OPEN';

  return {
    ...poc,
    phase: phaseOf(poc.startedOn, today),
    day: dayOf(poc.startedOn, today),
    daysToDecision: daysToDecision(poc.decisionOn, today),
    may: {
      update: running && clientsPolicy.updatePoc(actor, access, poc).allowed,
      moveLead: running && clientsPolicy.reassign(actor, access, 'poc', poc.id).allowed,
    },
  };
}
