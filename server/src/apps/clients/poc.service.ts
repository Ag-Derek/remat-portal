/**
 * Running a POC. #285, Clients SRS CLI 27 to CLI 34, CLI 100, CLI 101, TDD 3's PocService.
 *
 * A POC is started by its deal's contract being signed, through the stage service (#285, the
 * user, 19 November 2026). Here: the POC list and page, recording a review meeting, and moving
 * the CS lead; its health and usage (#286); and its one extension, and its end, converted or
 * exited (#287). A POC never ends itself when its date passes (CLI 50): only these end it.
 *
 * Every method asks `clientsPolicy` first, before reading the request, so somebody refused learns
 * nothing from what they sent.
 */

import type { Actor } from '../../core/auth/actor.js';
import type { Guard } from '../../core/auth/policy.js';
import { type CalendarDate, currentDate } from '../../core/calendar/time.js';
import { accessOf } from './access.js';
import {
  askOf,
  asksSomething,
  dayOf,
  daysToDecision,
  decisionFlagsOf,
  ExtendedAlready,
  extendedDecisionDateOf,
  flagsOf,
  HealthUnchanged,
  InvalidPocLead,
  NoActionAsked,
  type Poc,
  type PocPage,
  PocEnded,
  PocNotFound,
  type PocView,
  phaseOf,
  readAction,
  readExtension,
  readHealth,
  readNewLead,
  readUsage,
  targetChecksOf,
  usageFlagsOf,
  readReview,
} from './poc.js';
import type { ClientsPocRepository } from './poc.db.js';
import { readValue } from './opportunity.js';
import type { StageForPoc } from './stage-for-poc.js';
import { type ClientsAccess, clientsPolicy } from './policy.js';
import { isAnId } from './product.js';
import type { ClientsRoleRepository } from './role.db.js';

export class PocService {
  constructor(
    private readonly guard: Guard,
    private readonly grants: Pick<ClientsRoleRepository, 'rolesOf'>,
    private readonly pocs: ClientsPocRepository,
    /** The moves only a POC ending makes on its deal: converted or exited (#279, #287). */
    private readonly stages: Pick<StageForPoc, 'convert' | 'exit'>,
    /** The company's today, which a POC's phase and days are counted to (TDD 6.1). */
    private readonly today: () => CalendarDate = () => currentDate(),
    /** This moment, which the 48-hour clock is read against (#286). */
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Every POC still running, the soonest to be decided first, each with its phase and days to
   * decision (CLI 101). Anybody with a role's (CLI 90).
   */
  async list(actor: Actor): Promise<PocView[]> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access));

    const today = this.today();
    const now = this.now();

    return (await this.pocs.running()).map((poc) => viewOf(actor, access, poc, today, now));
  }

  /** One POC's page: its deal, clock, review meetings and those held (CLI 100). */
  async page(actor: Actor, id: string): Promise<PocPage> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const poc = await this.pocOrRefuse(id);
    const [reviews, held, healthHistory, usageReadings] = await Promise.all([
      this.pocs.reviewSteps(poc.id),
      this.pocs.reviewsHeld(poc.id),
      this.pocs.healthHistory(poc.id),
      this.pocs.usageReadings(poc.id),
    ]);

    return {
      ...viewOf(actor, access, poc, this.today(), this.now()),
      reviews,
      held,
      healthHistory,
      usageReadings,
      targets: targetChecksOf(poc, usageReadings, this.today()),
    };
  }

  /**
   * Records its usage on a day, `{ measuredOn, enrolled, active }`, from its start to today; the
   * percentage is worked out (#286). Its CS lead's or a BD manager's. A later reading for the same
   * day replaces it in the figures, and both are kept.
   */
  async recordUsage(actor: Actor, id: string, body: unknown): Promise<PocPage> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const poc = await this.pocOrRefuse(id);
    this.guard.enforce(clientsPolicy.updatePoc(actor, access, poc));

    if (poc.deal.outcome !== 'OPEN') {
      throw new PocEnded(poc.deal.productName);
    }

    await this.pocs.recordUsage(actor, poc.id, readUsage(body, poc, this.today()));

    return this.page(actor, id);
  }

  /**
   * Sets its health, `{ health, note? }`: On Track, At Risk or Stalled, with a note if one is
   * given (CLI 35). Its CS lead's or a BD manager's (CLI 91). Each is a change: the health it has
   * already is refused. Kept, every one, in its history.
   */
  async setHealth(actor: Actor, id: string, body: unknown): Promise<PocPage> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const poc = await this.pocOrRefuse(id);
    this.guard.enforce(clientsPolicy.updatePoc(actor, access, poc));

    if (poc.deal.outcome !== 'OPEN') {
      throw new PocEnded(poc.deal.productName);
    }

    const set = readHealth(body);
    if (set.health === poc.health) {
      throw new HealthUnchanged(set.health);
    }

    await this.pocs.setHealth(actor, poc.id, set);

    return this.page(actor, id);
  }

  /**
   * Writes what is being done, `{ action }`, against its health now (#286): a corrective action
   * while At Risk, flagged if none is written 48 hours after the move; a reset while Stalled,
   * flagged for an exit decision if none is written seven days after. Its CS lead's or a BD
   * manager's.
   */
  async addAction(actor: Actor, id: string, body: unknown): Promise<PocPage> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const poc = await this.pocOrRefuse(id);
    this.guard.enforce(clientsPolicy.updatePoc(actor, access, poc));

    if (poc.deal.outcome !== 'OPEN') {
      throw new PocEnded(poc.deal.productName);
    }

    const action = readAction(body);
    if (!asksSomething(poc.health)) {
      throw new NoActionAsked(poc.health);
    }

    await this.pocs.addAction(actor, poc.id, action);

    return this.page(actor, id);
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

  /**
   * Extends it, once, `{ days, plan }`: 1 to 30 days more, with what they are for, its decision
   * date moved to match (CLI 31, #287). Its CS lead's or a BD manager's, any time while it runs,
   * past its decision date too. A second is refused.
   */
  async extend(actor: Actor, id: string, body: unknown): Promise<PocPage> {
    const poc = await this.updatable(actor, id);

    if (poc.extension !== null) {
      throw new ExtendedAlready(poc.decisionOn);
    }

    const extension = readExtension(body);
    await this.pocs.extend(
      actor,
      poc.id,
      extension,
      extendedDecisionDateOf(poc.startedOn, extension.days),
    );

    return this.page(actor, id);
  }

  /**
   * Ends it converted, `{ value? }` (CLI 48, CLI 49, #287): its deal goes to Live and is won, its
   * product on what the client uses, and its value revised where a new one is given, the old one
   * kept in its history. Its CS lead's or a BD manager's. Its open review meetings close.
   */
  async convert(actor: Actor, id: string, body: unknown): Promise<PocPage> {
    const poc = await this.updatable(actor, id);
    const fields =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

    await this.stages.convert(actor, poc.deal.id, readValue(fields.value) ?? undefined);

    return this.page(actor, id);
  }

  /**
   * Ends it exited, `{ reasonId, note }` (CLI 48, CLI 52 to CLI 54, #287), by the exit rules: a
   * reason from the exit list, a note naming the products it ran on, and the debrief. Its CS
   * lead's or a BD manager's. Its open review meetings close.
   */
  async exit(actor: Actor, id: string, body: unknown): Promise<PocPage> {
    const poc = await this.updatable(actor, id);

    await this.stages.exit(actor, poc.deal.id, body);

    return this.page(actor, id);
  }

  /** The POC, running, and `actor`'s to update (CLI 35, CLI 91); or why not. */
  private async updatable(actor: Actor, id: string): Promise<Poc> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const poc = await this.pocOrRefuse(id);
    this.guard.enforce(clientsPolicy.updatePoc(actor, access, poc));

    if (poc.deal.outcome !== 'OPEN') {
      throw new PocEnded(poc.deal.productName);
    }

    return poc;
  }

  private async pocOrRefuse(id: string): Promise<Poc> {
    const found = isAnId(id) ? await this.pocs.find(id) : undefined;

    if (found === undefined) {
      throw new PocNotFound();
    }

    return found;
  }
}

/**
 * A POC as somebody reads it today: its clock, what they may do (CLI 32, TDD 6.1), and what its
 * health asks for and the flags, while it runs (#286).
 */
function viewOf(
  actor: Actor,
  access: ClientsAccess,
  poc: Poc,
  today: CalendarDate,
  now: Date,
): PocView {
  const running = poc.deal.outcome === 'OPEN';

  return {
    ...poc,
    phase: phaseOf(poc.startedOn, today),
    day: dayOf(poc.startedOn, today),
    daysToDecision: daysToDecision(poc.decisionOn, today),
    may: {
      update: running && clientsPolicy.updatePoc(actor, access, poc).allowed,
      moveLead: running && clientsPolicy.reassign(actor, access, 'poc', poc.id).allowed,
      /* #287. Once. */
      extend:
        running && poc.extension === null && clientsPolicy.updatePoc(actor, access, poc).allowed,
    },
    asks: running ? askOf(poc) : null,
    flags: running
      ? [...flagsOf(poc, now), ...usageFlagsOf(poc, today), ...decisionFlagsOf(poc, today)]
      : [],
  };
}
