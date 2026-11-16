/**
 * Every authorisation question clients asks. #274, Clients TDD 12, NFR CLI SEC 02.
 *
 * Every route asks one of these through its service, and nothing else in clients decides who
 * may do what: not a route, not a query, not the screen. The tile on the portal home asks
 * {@link clientsPolicy.seeTile}, the same module (NFR CLI SEC 06).
 *
 * Clients knows a System Administrator by `actor.isSysAdmin` and never by the portal's role
 * codes, which are Rota's vocabulary (.dependency-cruiser.cjs, `clients-not-to-roles`). Its own
 * two roles are passed in by the caller, read from clients_role, as is every fact about the
 * record asked about, so every answer here is pure.
 *
 * ## Two kinds of refusal, on purpose (TDD 11)
 *
 * - **Somebody with no clients role is told nothing.** Every question answers with a silent
 *   refusal, which the HTTP layer turns into 404 whatever the id, so that clients cannot be
 *   used to learn which clients or deals exist (NFR CLI SEC 04). A System Administrator with
 *   no clients role is no exception outside the roles screen: seeing the pipeline needs an
 *   associate grant like anybody else (TDD 12.1).
 * - **Somebody with a role who is refused one action is told who can do it**, with a 403.
 *   Inside the department the fact of a deal is no secret, and a sentence naming who to ask
 *   is more use than a blank.
 *
 * ## Any number of BD managers
 *
 * TDD 12.1 speaks of "the BD manager". Clients allows several at once (#274), so every rule
 * here that is the BD manager's is every current BD manager's, and every refusal says "a BD
 * manager".
 */

import type { Actor } from '../../core/auth/actor.js';
import { type Decision, policyFor } from '../../core/auth/policy.js';
import type { ClientsRole } from './role.js';

const about = policyFor('clients');

/** What clients knows about who is asking, beyond the actor itself. */
export interface ClientsAccess {
  /** The clients roles the actor holds today. Empty for most staff. */
  holds: readonly ClientsRole[];
}

/** The most a person may do in clients. A BD manager who is also an associate is a BD manager. */
export type ClientsStanding = 'NONE' | 'ASSOCIATE' | 'BD_MANAGER';

/** Somebody a refusal can name. */
export interface Named {
  id: string;
  /** "Ama Mensah". Left out where the caller has no name to hand; the sentence then says less. */
  name?: string;
}

/** A client, as the questions about it need it. */
export interface ClientSubject {
  id: string;
  owner: Named;
}

/** An opportunity, as the questions about it need it. */
export interface DealSubject {
  id: string;
  owner: Named;
}

/** A POC, as the questions about it need it. */
export interface PocSubject {
  id: string;
  csLead: Named;
}

/**
 * A checklist item to tick or untick (CLI 41). A qualification criterion sits on a deal and is
 * its owner's; a pre-POC or phase check sits on a POC and is its CS lead's or the owner of any
 * deal the POC covers (TDD 11, `/checks/{id}/tick`).
 */
export type CheckSubject =
  | { id: string; on: 'DEAL'; owner: Named }
  | { id: string; on: 'POC'; csLead: Named; dealOwnerIds: readonly string[] };

/** An activity, as editing it needs it. The 24 hour window is the database's (TDD 4.5). */
export interface ActivitySubject {
  id: string;
  loggedBy: Named;
}

/** A next step, as closing it needs it. */
export interface NextStepSubject {
  id: string;
  owner: Named;
}

/** A meeting report, as reading and writing it need it. */
export interface MeetingReportSubject {
  id: string;
  author: Named;
  status: 'DRAFT' | 'SHARED';
}

/**
 * What may be added to clients by anybody with a role (TDD 12.1, row three). A contact is
 * corrected, removed and brought back by anybody with a role too, not only the client's owner
 * (#276): whoever last spoke to them knows best.
 */
export type Contribution =
  | 'createClient'
  | 'addContact'
  | 'editContact'
  /** #276, CLI 04. A product a client already uses, and when they started and stopped. */
  | 'recordProductInUse'
  | 'createDeal'
  | 'logActivity'
  | 'addNextStep'
  | 'addDocument';

/** What may be moved to another person, which is a BD manager's alone (CLI 92). */
export type Reassignable = 'client' | 'deal' | 'poc';

/**
 * Which meeting reports a list may hold, for the query to apply (NFR CLI SEC 05). The list is
 * scoped where it is fetched, never filtered after, so this is handed to the query rather than
 * asked of each row.
 */
export interface MeetingReportScope {
  /** Their own, in any state. */
  authorId: string;
  /** Everybody's shared ones too. A BD manager's. */
  everyShared: boolean;
}

const ASK_A_BD_MANAGER = 'Ask a BD manager.';

export const clientsPolicy = {
  resource: about.resource,

  /** The most this person may do in clients. */
  standingOf(access: ClientsAccess): ClientsStanding {
    if (access.holds.includes('BD_MANAGER')) {
      return 'BD_MANAGER';
    }

    return access.holds.includes('ASSOCIATE') ? 'ASSOCIATE' : 'NONE';
  },

  /**
   * Whether the clients tile is on their portal home (CLI 93, TDD 12.2). Anybody with a role,
   * and a System Administrator, who needs it to reach the roles screen. Nobody else is ever
   * shown that clients is there.
   */
  seeTile(actor: Actor, access: ClientsAccess): Decision {
    return mayEnter(actor, access)
      ? about.allow(actor, 'seeTile')
      : nothingToSee(actor, 'seeTile', null);
  },

  /**
   * Reaching anything in clients at all: the door every `/api/clients` request comes through
   * before any route sees it (CLI 93, NFR CLI SEC 04). Whoever the tile is shown to, by the same
   * rule, so a tile never leads to a door that is shut and no door opens without a tile.
   *
   * Refused silently, and the door answers as an address with nothing at it. Getting through it
   * is not permission for anything: each route still asks its own question, which is how a
   * System Administrator with no clients role reaches the roles screen and nothing else.
   */
  enter(actor: Actor, access: ClientsAccess): Decision {
    return mayEnter(actor, access)
      ? about.allow(actor, 'enter')
      : nothingToSee(actor, 'enter', null);
  },

  /**
   * Reading anything in the pipeline: my pipeline, the company pipeline, a client page, the POC
   * list and a POC, the dashboard, a document, past proposals. Every role's, including values
   * and probabilities on deals they do not own (CLI 90).
   */
  read(actor: Actor, access: ClientsAccess, subject: string | null = null): Decision {
    return holdsARole(access)
      ? about.allow(actor, 'read', subject)
      : nothingToSee(actor, 'read', subject);
  },

  /** Adding a client, a contact, a deal, an activity, a next step or a document (CLI 05, 12, 60). */
  contribute(actor: Actor, access: ClientsAccess, what: Contribution): Decision {
    return holdsARole(access) ? about.allow(actor, what) : nothingToSee(actor, what, null);
  },

  /**
   * A client's name, type and note: its owner's or a BD manager's (CLI 05, #276). Not its owner,
   * which is moved by a BD manager alone, through {@link clientsPolicy.reassign}.
   */
  changeClient(actor: Actor, access: ClientsAccess, client: ClientSubject): Decision {
    return ownerOrBdManager(actor, access, 'changeClient', client.id, client.owner, 'client');
  },

  /** Editing a deal, moving its stage, or ending it as lost: its owner's or a BD manager's (CLI 13). */
  changeDeal(actor: Actor, access: ClientsAccess, deal: DealSubject): Decision {
    return ownerOrBdManager(actor, access, 'changeDeal', deal.id, deal.owner, 'deal');
  },

  /**
   * Starting a POC, setting its health, recording usage, extending and ending it: its CS lead's
   * or a BD manager's, whoever owns the deals it covers (CLI 35, CLI 91, AC L23).
   */
  updatePoc(actor: Actor, access: ClientsAccess, poc: PocSubject): Decision {
    if (!holdsARole(access)) {
      return nothingToSee(actor, 'updatePoc', poc.id);
    }

    return isBdManager(access) || isSelfNamed(actor, poc.csLead)
      ? about.allow(actor, 'updatePoc', poc.id)
      : about.refuseOpenly(
          actor,
          'updatePoc',
          poc.id,
          'not its CS lead, and not a BD manager',
          `Only ${whose(poc.csLead, 'the CS lead')} or a BD manager can update this POC.`,
        );
  },

  /** Ticking or unticking a checklist item (CLI 41). See {@link CheckSubject} for whose. */
  tickCheck(actor: Actor, access: ClientsAccess, check: CheckSubject): Decision {
    if (!holdsARole(access)) {
      return nothingToSee(actor, 'tickCheck', check.id);
    }
    if (isBdManager(access)) {
      return about.allow(actor, 'tickCheck', check.id);
    }

    if (check.on === 'DEAL') {
      return isSelfNamed(actor, check.owner)
        ? about.allow(actor, 'tickCheck', check.id)
        : about.refuseOpenly(
            actor,
            'tickCheck',
            check.id,
            'not the deal owner, and not a BD manager',
            `Only ${whose(check.owner, "the deal's owner")} or a BD manager can tick this.`,
          );
    }

    return isSelfNamed(actor, check.csLead) || check.dealOwnerIds.some((id) => isMe(actor, id))
      ? about.allow(actor, 'tickCheck', check.id)
      : about.refuseOpenly(
          actor,
          'tickCheck',
          check.id,
          'not the CS lead or a deal owner, and not a BD manager',
          `Only ${whose(check.csLead, 'the CS lead')}, the owner of a deal in this POC, or a BD ` +
            'manager can tick this.',
        );
  },

  /**
   * Correcting an activity: only whoever logged it, a BD manager included (CLI 62). The 24
   * hours are refused by the database trigger, whoever asks; this is whose it is.
   */
  editActivity(actor: Actor, access: ClientsAccess, activity: ActivitySubject): Decision {
    if (!holdsARole(access)) {
      return nothingToSee(actor, 'editActivity', activity.id);
    }

    return isSelfNamed(actor, activity.loggedBy)
      ? about.allow(actor, 'editActivity', activity.id)
      : about.refuseOpenly(
          actor,
          'editActivity',
          activity.id,
          'did not log it',
          `Only ${whose(activity.loggedBy, 'whoever logged it')} can change this activity. ` +
            'Add a note to correct it instead.',
        );
  },

  /** Closing a next step: its owner's or a BD manager's (CLI 64). */
  closeNextStep(actor: Actor, access: ClientsAccess, step: NextStepSubject): Decision {
    return ownerOrBdManager(actor, access, 'closeNextStep', step.id, step.owner, 'next step');
  },

  /**
   * Moving a client, a deal or a POC to somebody else, a CS lead included: a BD manager's (CLI
   * 92), and not the owner's, even of their own client (#276).
   */
  reassign(actor: Actor, access: ClientsAccess, what: Reassignable, id: string): Decision {
    return bdManagersAlone(actor, access, 'reassign', id, `Only a BD manager can move a ${what}.`);
  },

  /** Products, lines, checklists and the lost and exit reasons: a BD manager's (CLI 8, 40, 54). */
  setUp(actor: Actor, access: ClientsAccess): Decision {
    return bdManagersAlone(
      actor,
      access,
      'setUp',
      null,
      'Products, checklists and reasons are kept by a BD manager. ' + ASK_A_BD_MANAGER,
    );
  },

  /**
   * Which meeting reports somebody may list, for the query to apply (NFR CLI SEC 05). Their
   * own, and every shared one for a BD manager (CLI 82, TDD 9). Undefined for somebody with no
   * role, who may list none; the route refuses through {@link read} before it gets here.
   */
  meetingReportScope(actor: Actor, access: ClientsAccess): MeetingReportScope | undefined {
    if (!holdsARole(access) || actor.employeeId === null) {
      return undefined;
    }

    return { authorId: actor.employeeId, everyShared: isBdManager(access) };
  },

  /**
   * Reading one meeting report: its author's, and a BD manager's once it is shared (CLI 82).
   * Somebody else's draft is no BD manager's to read until it is shared.
   */
  readMeetingReport(actor: Actor, access: ClientsAccess, report: MeetingReportSubject): Decision {
    if (!holdsARole(access)) {
      return nothingToSee(actor, 'readMeetingReport', report.id);
    }

    return isSelfNamed(actor, report.author) || (isBdManager(access) && report.status === 'SHARED')
      ? about.allow(actor, 'readMeetingReport', report.id)
      : about.refuseOpenly(
          actor,
          'readMeetingReport',
          report.id,
          'not its author, and not a BD manager reading a shared report',
          'A meeting report is read by whoever wrote it, and by a BD manager once it is shared.',
        );
  },

  /**
   * Drafting, editing and sharing a meeting report: its author's alone (CLI 79, CLI 81). Once
   * shared it is fixed for everybody, which the database refuses (TDD 4.7).
   */
  writeMeetingReport(actor: Actor, access: ClientsAccess, report: MeetingReportSubject): Decision {
    if (!holdsARole(access)) {
      return nothingToSee(actor, 'writeMeetingReport', report.id);
    }

    return isSelfNamed(actor, report.author)
      ? about.allow(actor, 'writeMeetingReport', report.id)
      : about.refuseOpenly(
          actor,
          'writeMeetingReport',
          report.id,
          'not its author',
          'Only whoever wrote a meeting report can change or share it.',
        );
  },

  /** Drafting, reading and submitting the CEO report: a BD manager's (CLI 83, CLI 92). */
  ceoReport(actor: Actor, access: ClientsAccess, reportId: string | null = null): Decision {
    return bdManagersAlone(
      actor,
      access,
      'ceoReport',
      reportId,
      'The report to the CEO is written and submitted by a BD manager.',
    );
  },

  /**
   * Seeing who holds which role, and granting and ending them. CLI 94.
   *
   * A portal System Administrator's, and nobody else's: not a BD manager's, including for
   * themselves, or the list of who has access stops being evidence of anything (TDD 12.1).
   * Needs a person behind it, because every grant records who made it.
   *
   * Refused openly to somebody who holds a clients role, BD manager included. Refused silently
   * to everybody else, who has no business knowing clients is there.
   */
  manageRoles(actor: Actor, access: ClientsAccess, grantId: string | null = null): Decision {
    if (isAPersonWhoAdministers(actor)) {
      return about.allow(actor, 'manageRoles', grantId);
    }

    return holdsARole(access)
      ? about.refuseOpenly(
          actor,
          'manageRoles',
          grantId,
          'not a portal System Administrator',
          'Roles in clients are granted and ended by a portal system administrator. Ask one of ' +
            'them.',
        )
      : nothingToSee(actor, 'manageRoles', grantId);
  },

  /**
   * Work nobody asked for: the daily reminders, and ending a leaver's grants (TDD 10, CLI 95).
   * The system's, which has no employee record and stands for every role, and nobody else's.
   */
  runUnattended(actor: Actor, what: 'dailyRun' | 'endGrantsOnExit'): Decision {
    return actor.employeeId === null && actor.isSysAdmin
      ? about.allow(actor, what)
      : about.refuse(actor, what, null, 'not the system');
  },
};

/** Either role, or a System Administrator, who needs to reach the roles screen. */
function mayEnter(actor: Actor, access: ClientsAccess): boolean {
  return holdsARole(access) || isAPersonWhoAdministers(actor);
}

function holdsARole(access: ClientsAccess): boolean {
  return access.holds.length > 0;
}

function isBdManager(access: ClientsAccess): boolean {
  return access.holds.includes('BD_MANAGER');
}

/** A portal System Administrator with an employee record: a person, not the system. */
function isAPersonWhoAdministers(actor: Actor): boolean {
  return actor.isSysAdmin && actor.employeeId !== null;
}

/** Null never matches, so a record with nobody on it is nobody's, the system's included. */
function isMe(actor: Actor, employeeId: string | null): boolean {
  return actor.employeeId !== null && actor.employeeId === employeeId;
}

function isSelfNamed(actor: Actor, who: Named): boolean {
  return isMe(actor, who.id);
}

/** "Ama Mensah", or what to call them where there is no name to hand. */
function whose(who: Named, otherwise: string): string {
  return who.name ?? otherwise;
}

/** The silent refusal: somebody with no clients role learns nothing, not even that it exists. */
function nothingToSee(actor: Actor, action: string, subject: string | null): Decision {
  return about.refuse(
    actor,
    action,
    subject,
    actor.employeeId === null ? 'has no employee record behind it' : 'holds no clients role',
  );
}

function ownerOrBdManager(
  actor: Actor,
  access: ClientsAccess,
  action: string,
  subject: string,
  owner: Named,
  thing: string,
): Decision {
  if (!holdsARole(access)) {
    return nothingToSee(actor, action, subject);
  }

  return isBdManager(access) || isSelfNamed(actor, owner)
    ? about.allow(actor, action, subject)
    : about.refuseOpenly(
        actor,
        action,
        subject,
        'not the owner, and not a BD manager',
        owner.name === undefined
          ? `Only the ${thing}'s owner or a BD manager can change this ${thing}.`
          : `This ${thing} is ${owner.name}'s. Only they or a BD manager can change it.`,
      );
}

function bdManagersAlone(
  actor: Actor,
  access: ClientsAccess,
  action: string,
  subject: string | null,
  told: string,
): Decision {
  if (!holdsARole(access)) {
    return nothingToSee(actor, action, subject);
  }

  return isBdManager(access)
    ? about.allow(actor, action, subject)
    : about.refuseOpenly(actor, action, subject, 'not a BD manager', told);
}
