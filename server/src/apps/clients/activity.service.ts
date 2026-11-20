/**
 * Activities and next steps. #280, Clients SRS CLI 58 to CLI 64, TDD 3's ActivityService.
 *
 * Changes no deal's stage: logging something never moves a deal, a proposal included (TDD 3). The
 * one thing it changes on a deal is its value, from the financials sent on it (CLI 65, #281).
 *
 * Every method asks `clientsPolicy` first, before reading the request or looking anything up, so
 * somebody refused learns nothing from what they sent.
 */

import type { Actor } from '../../core/auth/actor.js';
import type { Guard } from '../../core/auth/policy.js';
import { type CalendarDate, currentDate } from '../../core/calendar/time.js';
import { accessOf } from './access.js';
import type { ClientsActivityRepository, StepToWrite } from './activity.db.js';
import type { ClientsClientRepository } from './client.db.js';
import {
  type ActivityKind,
  ActivityLocked,
  ActivityNotFound,
  assertSentShape,
  fieldsOf,
  InvalidActivity,
  type LoggedActivity,
  type PastProposal,
  readActivityChange,
  readNewActivity,
  ReviewFixed,
  readProposalFilters,
  SENT_ON_A_DEAL,
  stillCorrectable,
} from './logged-activity.js';
import { OpportunityEnded } from './opportunity.js';
import { Ended } from './opportunity.db.js';
import { isAnId } from './product.js';
import {
  InvalidNextStep,
  isOverdue,
  type NextStep,
  NextStepAlreadyClosed,
  type NextStepAsked,
  NextStepNotClosed,
  NextStepNotFound,
  type NextStepView,
  readNewNextStep,
  readNextStep,
} from './next-step.js';
import { type ClientsAccess, clientsPolicy } from './policy.js';
import type { ClientsRoleRepository } from './role.db.js';

/** What logging gives back: the activity, and the step offered with it, if one was. */
export interface Logged {
  activity: LoggedActivity;
  nextStep: NextStepView | null;
}

export class ActivityService {
  constructor(
    private readonly guard: Guard,
    private readonly grants: Pick<ClientsRoleRepository, 'rolesOf'>,
    private readonly clients: Pick<ClientsClientRepository, 'find'>,
    private readonly activities: ClientsActivityRepository,
    /** The company's today: no activity after it (CLI 61), and no step due before it. */
    private readonly today: () => CalendarDate = () => currentDate(),
    /** The moment, against which the 24 hours an activity may be corrected run (CLI 62). */
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Logs an activity against any client, optionally one of its deals, open or ended (CLI 55, CLI
   * 60), with a next step if one is asked for (CLI 63): `{ clientId, opportunityId?, kind,
   * happenedOn, withWhom?, outcome?, nextStep?: { description, dueOn, ownerId? } }`.
   *
   * The step is about the same deal as the activity, and is the client owner's unless somebody
   * else holding a role is named. Both are written together or neither is.
   */
  async log(actor: Actor, body: unknown): Promise<Logged> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.contribute(actor, access, 'logActivity'));

    const today = this.today();
    const activity = readNewActivity(body, today);
    const stepBody = fieldsOf(body).nextStep;
    const asked =
      stepBody === undefined || stepBody === null
        ? null
        : readNextStep(stepBody, today, 'nextStep.');

    if (asked !== null) {
      this.guard.enforce(clientsPolicy.contribute(actor, access, 'addNextStep'));
    }

    const client = await this.clients.find(activity.clientId);
    if (client === undefined) {
      throw new InvalidActivity(
        'clientId',
        'No client matches that. Refresh the page to see the clients as they are now.',
      );
    }

    if (
      activity.opportunityId !== null &&
      (await this.activities.dealOf(client.id, activity.opportunityId)) === undefined
    ) {
      throw new InvalidActivity('opportunityId', `Choose one of ${client.name}'s deals, or none.`);
    }

    if (activity.opportunityId !== null) {
      await this.mayBeSentOn(actor, access, activity.kind, client.id, activity.opportunityId);
    }

    const step = asked === null ? null : await this.stepFor(asked, client.owner.id, 'nextStep.');
    const { activityId, stepId } = await this.endedMeanwhile(
      client.id,
      [activity.opportunityId],
      () => this.activities.log(actor, activity, step),
    );

    return {
      activity: await this.activityOrRefuse(activityId),
      nextStep: stepId === null ? null : await this.stepView(actor, access, stepId),
    };
  }

  /**
   * Adds a next step on its own (CLI 63): `{ clientId, opportunityId?, description, dueOn,
   * ownerId? }`. Anybody with a role's, at any client. Whose it is is the client owner's unless
   * somebody else holding a role is named, as with one offered when logging.
   */
  async addStep(actor: Actor, body: unknown): Promise<NextStepView> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.contribute(actor, access, 'addNextStep'));

    const asked = readNewNextStep(body, this.today());

    const client = await this.clients.find(asked.clientId);
    if (client === undefined) {
      throw new InvalidNextStep(
        'clientId',
        'No client matches that. Refresh the page to see the clients as they are now.',
      );
    }
    if (
      asked.opportunityId !== null &&
      (await this.activities.dealOf(client.id, asked.opportunityId)) === undefined
    ) {
      throw new InvalidNextStep('opportunityId', `Choose one of ${client.name}'s deals, or none.`);
    }

    const { ownerId } = await this.stepFor(asked, client.owner.id, '');
    const id = await this.activities.addStep(actor, { ...asked, ownerId });

    return this.stepView(actor, access, id);
  }

  /**
   * Closes a step: its owner's, and nobody else's (CLI 64). Nothing closes one by itself; a day
   * passing only makes it overdue.
   */
  async closeStep(actor: Actor, id: string): Promise<NextStepView> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const step = await this.stepOrRefuse(id);
    this.guard.enforce(clientsPolicy.closeNextStep(actor, access, step));

    if (step.done !== null) {
      throw new NextStepAlreadyClosed(step.done.by.name);
    }

    await this.activities.close(actor, id);

    return this.stepView(actor, access, id);
  }

  /** Opens a closed step again: its owner's or a BD manager's (#280). */
  async reopenStep(actor: Actor, id: string): Promise<NextStepView> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const step = await this.stepOrRefuse(id);
    this.guard.enforce(clientsPolicy.reopenNextStep(actor, access, step));

    if (step.done === null) {
      throw new NextStepNotClosed();
    }

    await this.activities.reopen(actor, id);

    return this.stepView(actor, access, id);
  }

  /**
   * Corrects an activity: `{ opportunityId?, kind?, happenedOn?, withWhom?, outcome? }`, only
   * what is present changing and null taking an optional field away. Only whoever logged it, a BD
   * manager included, and only for 24 hours after (CLI 62); a correction after that is a further
   * note. Its client never changes, and neither does a next step offered with it.
   */
  async correct(actor: Actor, id: string, body: unknown): Promise<LoggedActivity> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const activity = await this.activityOrRefuse(id);
    this.guard.enforce(clientsPolicy.editActivity(actor, access, activity));

    if (!stillCorrectable(activity.loggedAt, this.now())) {
      throw new ActivityLocked();
    }

    /* A review meeting is fixed once recorded (#285): which review it was, its day and whether the
       decision maker came decided which step it closed and when it falls due again. */
    if (activity.kind === 'REVIEW') {
      throw new ReviewFixed();
    }

    const change = readActivityChange(body, this.today(), activity.clientId);

    if (change.kind === 'REVIEW') {
      throw new InvalidActivity(
        'kind',
        "A review meeting is recorded on its POC's page, which asks whether the senior decision " +
          'maker was there.',
      );
    }

    /* No longer the financials, so no longer an amount, unless one was sent, which is refused
       below: the form needs only to change the kind (#281). */
    if (change.kind !== undefined && change.kind !== 'FINANCIALS' && change.amount === undefined) {
      change.amount = null;
    }

    const kind = change.kind ?? activity.kind;
    const dealId =
      change.opportunityId === undefined ? (activity.deal?.id ?? null) : change.opportunityId;

    assertSentShape({
      kind,
      opportunityId: dealId,
      amount: change.amount === undefined ? activity.amount : change.amount,
    });

    if (
      change.opportunityId !== undefined &&
      change.opportunityId !== null &&
      (await this.activities.dealOf(activity.clientId, change.opportunityId)) === undefined
    ) {
      throw new InvalidActivity('opportunityId', "Choose one of the client's deals, or none.");
    }

    /* Sent on a deal now, where it was not, or on another deal, or for another amount: asked as
       logging it would be. Correcting only its words or its day asks nothing more. */
    if (
      dealId !== null &&
      (change.kind !== undefined ||
        change.opportunityId !== undefined ||
        change.amount !== undefined)
    ) {
      await this.mayBeSentOn(actor, access, kind, activity.clientId, dealId);
    }

    /* The financials taken off their deal put its value back (#281), which is as much a change to
       that deal as setting it: asked the same. */
    const leftDeal =
      activity.kind === 'FINANCIALS' &&
      activity.deal !== null &&
      (kind !== 'FINANCIALS' || dealId !== activity.deal.id)
        ? activity.deal.id
        : null;
    if (leftDeal !== null) {
      await this.mayBeSentOn(actor, access, 'FINANCIALS', activity.clientId, leftDeal);
    }

    await this.endedMeanwhile(activity.clientId, [leftDeal, dealId], () =>
      this.activities.correct(actor, id, change),
    );

    return this.activityOrRefuse(id);
  }

  /**
   * Past proposals and financials, at every client, the latest first: by the type of client and
   * the product, so the last one written for a similar client can be opened as a starting point
   * (CLI 66, TDD 11's `GET /proposals?type=&product=`). Anybody with a role's, as every client is
   * (CLI 90). `{ type?, product?, kind? }`, from the query string.
   */
  async pastProposals(actor: Actor, query: Record<string, unknown>): Promise<PastProposal[]> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access));

    return this.activities.proposals(readProposalFilters(query));
  }

  /**
   * A proposal or the financials go on an open deal, sent by its owner or a BD manager (#281).
   * Anything else asks nothing here: a call may be about any deal, open or ended (CLI 55, CLI 60).
   */
  private async mayBeSentOn(
    actor: Actor,
    access: ClientsAccess,
    kind: ActivityKind,
    clientId: string,
    dealId: string,
  ): Promise<void> {
    if (!SENT_ON_A_DEAL.includes(kind)) {
      return;
    }

    const deal = await this.activities.dealSentOn(clientId, dealId);
    if (deal === undefined) {
      throw new InvalidActivity('opportunityId', "Choose one of the client's deals.");
    }

    this.guard.enforce(clientsPolicy.sendOnDeal(actor, access, deal));

    if (deal.outcome !== 'OPEN') {
      throw new OpportunityEnded(deal.productName, deal.outcome);
    }
  }

  /**
   * Writes, saying which deal and how it ended where one of `deals` ended between the look and the
   * write, and the database refused to change its value (#281).
   */
  private async endedMeanwhile<T>(
    clientId: string,
    deals: readonly (string | null)[],
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (!(error instanceof Ended)) throw error;

      for (const id of deals) {
        const deal = id === null ? undefined : await this.activities.dealSentOn(clientId, id);
        if (deal !== undefined && deal.outcome !== 'OPEN') {
          throw new OpportunityEnded(deal.productName, deal.outcome);
        }
      }
      throw error;
    }
  }

  /**
   * Whose a step is: who was named, or else the client's owner, and in either case somebody who
   * holds a clients role today, so that they can see it and close it (#280).
   */
  private async stepFor(
    asked: NextStepAsked,
    clientOwnerId: string,
    prefix: string,
  ): Promise<StepToWrite> {
    const ownerId = asked.ownerId ?? clientOwnerId;

    if ((await this.grants.rolesOf(ownerId)).length === 0) {
      throw new InvalidNextStep(
        `${prefix}ownerId`,
        asked.ownerId === null
          ? "The client's owner no longer has a role in clients, so the step cannot be theirs. " +
              'Choose somebody who has one.'
          : 'Whose it is needs a role in clients, to see it and close it. Choose somebody who ' +
              'has one, and name anybody else in what happens next.',
      );
    }

    return { description: asked.description, dueOn: asked.dueOn, ownerId };
  }

  private async activityOrRefuse(id: string): Promise<LoggedActivity> {
    const found = isAnId(id) ? await this.activities.findActivity(id) : undefined;

    if (found === undefined) {
      throw new ActivityNotFound();
    }

    return found;
  }

  private async stepOrRefuse(id: string): Promise<NextStep> {
    const found = isAnId(id) ? await this.activities.findStep(id) : undefined;

    if (found === undefined) {
      throw new NextStepNotFound();
    }

    return found;
  }

  private async stepView(actor: Actor, access: ClientsAccess, id: string): Promise<NextStepView> {
    return viewOfStep(actor, access, await this.stepOrRefuse(id), this.today());
  }
}

/**
 * A step as somebody sees it: whether it is overdue today, worked out rather than stored (CLI 64),
 * and whether they may close or reopen it, the policy's answers.
 */
export function viewOfStep(
  actor: Actor,
  access: ClientsAccess,
  step: NextStep,
  today: CalendarDate,
): NextStepView {
  return {
    ...step,
    overdue: isOverdue(step, today),
    may: {
      close: step.done === null && clientsPolicy.closeNextStep(actor, access, step).allowed,
      reopen: step.done !== null && clientsPolicy.reopenNextStep(actor, access, step).allowed,
    },
  };
}
