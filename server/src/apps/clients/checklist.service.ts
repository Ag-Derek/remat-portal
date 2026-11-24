/**
 * A deal's and a POC's checks: reading them, ticking and unticking them, and each one's history.
 * #284, Clients SRS CLI 40, CLI 41, TDD 11's `/checks/{id}/tick`.
 *
 * A deal's qualification criteria and pre-POC gates are its owner's or a BD manager's to tick; a
 * POC's phase checks are its CS lead's, its deal owner's or a BD manager's (CLI 41). Only while
 * the deal or POC is open (the user, 23 November 2026). Every tick is a change, and every one is
 * kept, with who and when.
 *
 * Every method asks `clientsPolicy` first, before reading the request, so somebody refused learns
 * nothing from what they sent.
 */

import type { Actor } from '../../core/auth/actor.js';
import type { Guard } from '../../core/auth/policy.js';
import { accessOf } from './access.js';
import {
  CheckNotFound,
  type Checklist,
  type ChecklistOwner,
  readTick,
  type Tick,
  TickUnchanged,
} from './checklist.js';
import {
  ChecklistClosed,
  type ChecklistSubject,
  type ClientsCheckRepository,
} from './checklist.db.js';
import { OpportunityEnded, OpportunityNotFound } from './opportunity.js';
import { PocEnded, PocNotFound } from './poc.js';
import { type CheckSubject, type ClientsAccess, clientsPolicy } from './policy.js';
import { isAnId } from './product.js';
import type { ClientsRoleRepository } from './role.db.js';

export class ChecklistService {
  constructor(
    private readonly guard: Guard,
    private readonly grants: Pick<ClientsRoleRepository, 'rolesOf'>,
    private readonly checks: ClientsCheckRepository,
  ) {}

  /** A deal's qualification criteria and pre-POC gates. Anybody with a role's to read (CLI 90). */
  async ofDeal(actor: Actor, dealId: string): Promise<Checklist> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, dealId));

    const subject = isAnId(dealId) ? await this.checks.dealSubject(dealId) : undefined;
    if (subject === undefined) {
      throw new OpportunityNotFound();
    }

    return this.checklistOf(actor, access, subject);
  }

  /** A POC's Foundation, Deepening and Converting checks. Anybody with a role's to read. */
  async ofPoc(actor: Actor, pocId: string): Promise<Checklist> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, pocId));

    const subject = isAnId(pocId) ? await this.checks.pocSubject(pocId) : undefined;
    if (subject === undefined) {
      throw new PocNotFound();
    }

    return this.checklistOf(actor, access, subject);
  }

  /**
   * Ticks or unticks a check, `{ ticked }`, recording who and when (CLI 41), and answers with
   * its whole checklist as it now stands. Refused where it is that already, and once its deal or
   * POC has ended. Unticking a criterion whose gate was passed is recorded, and moves nothing.
   */
  async tick(actor: Actor, checkId: string, body: unknown): Promise<Checklist> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, checkId));

    const found = isAnId(checkId) ? await this.checks.find(checkId) : undefined;
    if (found === undefined) {
      throw new CheckNotFound();
    }

    const subject = await this.subjectOf(found.owner);
    this.guard.enforce(clientsPolicy.tickCheck(actor, access, checkSubjectOf(checkId, subject)));
    refuseIfEnded(subject);

    const ticked = readTick(body);
    if (found.check.ticked === ticked) {
      throw new TickUnchanged(found.check.label, ticked);
    }

    try {
      await this.checks.tick(actor, found.check, ticked);
    } catch (error) {
      if (error instanceof ChecklistClosed) {
        refuseIfEnded(await this.subjectOf(found.owner));
      }
      throw error;
    }

    return this.checklistOf(actor, access, subject);
  }

  /** Every tick and untick of a check, the latest first. Anybody with a role's to read. */
  async history(actor: Actor, checkId: string): Promise<Tick[]> {
    this.guard.enforce(clientsPolicy.read(actor, await accessOf(actor, this.grants), checkId));

    const found = isAnId(checkId) ? await this.checks.find(checkId) : undefined;
    if (found === undefined) {
      throw new CheckNotFound();
    }

    return this.checks.ticks(checkId);
  }

  private async checklistOf(
    actor: Actor,
    access: ClientsAccess,
    subject: ChecklistSubject,
  ): Promise<Checklist> {
    const checks = await this.checks.checksOf(subject);

    return {
      on: subject.on,
      id: subject.id,
      checks,
      may: {
        tick:
          subject.outcome === 'OPEN' &&
          clientsPolicy.tickCheck(actor, access, checkSubjectOf(subject.id, subject)).allowed,
      },
    };
  }

  private async subjectOf(owner: ChecklistOwner): Promise<ChecklistSubject> {
    const subject =
      owner.on === 'DEAL'
        ? await this.checks.dealSubject(owner.id)
        : await this.checks.pocSubject(owner.id);

    if (subject === undefined) {
      throw new CheckNotFound();
    }

    return subject;
  }
}

/** Whose a check is, as the policy asks it (CLI 41). */
function checkSubjectOf(id: string, subject: ChecklistSubject): CheckSubject {
  return subject.on === 'DEAL' || subject.csLead === null
    ? { id, on: 'DEAL', owner: subject.dealOwner }
    : { id, on: 'POC', csLead: subject.csLead, dealOwnerIds: [subject.dealOwner.id] };
}

/** Once its deal or POC has ended, nothing is judged by its checks: they are kept as they ended. */
function refuseIfEnded(subject: ChecklistSubject): void {
  if (subject.outcome === 'OPEN') {
    return;
  }

  throw subject.on === 'DEAL'
    ? new OpportunityEnded(subject.productName, subject.outcome)
    : new PocEnded(subject.productName);
}
