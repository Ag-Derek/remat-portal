import { describe, expect, it } from 'vitest';
import { type Actor, signedInAs, theSystem } from '../../src/core/auth/actor.js';
import type { Decision } from '../../src/core/auth/policy.js';
import {
  type ClientsAccess,
  clientsPolicy,
  type MeetingReportSubject,
} from '../../src/apps/clients/policy.js';
import type { ClientsRole } from '../../src/apps/clients/role.js';

/**
 * Every clients access question, against Clients TDD 12.1. #274.
 *
 * Three answers, and each test says which:
 *
 * - **allowed**;
 * - **refused openly**, a 403 whose sentence says who can (`told` is set);
 * - **refused silently**, a 404 that says nothing (`told` is null), for anybody with no
 *   clients role, which is most staff and a System Administrator who holds none.
 *
 * Any number of BD managers may hold the role at once (#274), so nothing here depends on there
 * being one.
 */

/** Somebody signed in, holding these portal roles. */
function person(id: string, { sysAdmin = false } = {}): Actor {
  return signedInAs(id, {
    roles: sysAdmin ? ['EMPLOYEE', 'SYS_ADMIN'] : ['EMPLOYEE', 'HR_ADMIN', 'HR_OFFICER'],
    isManager: true,
  });
}

function holding(...holds: ClientsRole[]): ClientsAccess {
  return { holds };
}

type Answer = 'allowed' | 'refused openly' | 'refused silently';

function answer(decision: Decision): Answer {
  if (decision.allowed) return 'allowed';
  return decision.told === null ? 'refused silently' : 'refused openly';
}

/* The cast, by employee id. */
const AMA = '1'; // an associate, who owns the record asked about
const KOFI = '2'; // another associate
const ESI = '3'; // a BD manager
const YAW = '4'; // a System Administrator with no clients role
const ABENA = '5'; // somebody with no clients role at all

const owner = { id: AMA, name: 'Ama Owusu' };

/** Each kind of person, as an actor and what they hold in clients. */
const cast = {
  owner: [person(AMA), holding('ASSOCIATE')],
  otherAssociate: [person(KOFI), holding('ASSOCIATE')],
  bdManager: [person(ESI), holding('BD_MANAGER')],
  sysAdminWithNoRole: [person(YAW, { sysAdmin: true }), holding()],
  nobody: [person(ABENA), holding()],
  system: [theSystem('a test'), holding()],
} as const satisfies Record<string, readonly [Actor, ClientsAccess]>;

type Who = keyof typeof cast;

/** The answer for each kind of person to one question. */
function answers(ask: (actor: Actor, access: ClientsAccess) => Decision): Record<Who, Answer> {
  return Object.fromEntries(
    Object.entries(cast).map(([who, [actor, access]]) => [who, answer(ask(actor, access))]),
  ) as Record<Who, Answer>;
}

/** Everybody without a clients role, who must learn nothing. */
const SILENT_FOR_THE_ROLELESS = {
  sysAdminWithNoRole: 'refused silently',
  nobody: 'refused silently',
  system: 'refused silently',
} as const;

describe('clients standing', () => {
  it('is the most a person may do, a BD manager outranking an associate', () => {
    expect(clientsPolicy.standingOf(holding())).toBe('NONE');
    expect(clientsPolicy.standingOf(holding('ASSOCIATE'))).toBe('ASSOCIATE');
    expect(clientsPolicy.standingOf(holding('BD_MANAGER'))).toBe('BD_MANAGER');
    expect(clientsPolicy.standingOf(holding('ASSOCIATE', 'BD_MANAGER'))).toBe('BD_MANAGER');
  });
});

describe('the tile on the portal home (CLI 93, TDD 12.2)', () => {
  it('is shown to either role and to a System Administrator, and to nobody else', () => {
    expect(answers((actor, access) => clientsPolicy.seeTile(actor, access))).toEqual({
      owner: 'allowed',
      otherAssociate: 'allowed',
      bdManager: 'allowed',
      sysAdminWithNoRole: 'allowed',
      nobody: 'refused silently',
      /* The system is nobody's portal home. */
      system: 'refused silently',
    });
  });
});

describe('reading and adding (CLI 90, TDD 12.1 rows two and three)', () => {
  it('reading anything is either role’s, a System Administrator’s only with a role', () => {
    expect(answers((actor, access) => clientsPolicy.read(actor, access, '42'))).toEqual({
      owner: 'allowed',
      otherAssociate: 'allowed',
      bdManager: 'allowed',
      ...SILENT_FOR_THE_ROLELESS,
    });
  });

  it.each([
    'createClient',
    'addContact',
    /* #276. */
    'editContact',
    'recordProductInUse',
    'createDeal',
    'logActivity',
    'addNextStep',
    'addDocument',
  ] as const)('%s is either role’s', (what) => {
    expect(answers((actor, access) => clientsPolicy.contribute(actor, access, what))).toEqual({
      owner: 'allowed',
      otherAssociate: 'allowed',
      bdManager: 'allowed',
      ...SILENT_FOR_THE_ROLELESS,
    });
  });
});

describe('changing what somebody owns (CLI 05, CLI 13, CLI 64)', () => {
  it.each([
    [
      'a client',
      (a: Actor, x: ClientsAccess) => clientsPolicy.changeClient(a, x, { id: '9', owner }),
    ],
    ['a deal', (a: Actor, x: ClientsAccess) => clientsPolicy.changeDeal(a, x, { id: '9', owner })],
    [
      'a next step',
      (a: Actor, x: ClientsAccess) => clientsPolicy.closeNextStep(a, x, { id: '9', owner }),
    ],
  ])('%s is its owner’s or a BD manager’s', (_thing, ask) => {
    expect(answers(ask)).toEqual({
      owner: 'allowed',
      otherAssociate: 'refused openly',
      bdManager: 'allowed',
      ...SILENT_FOR_THE_ROLELESS,
    });
  });

  /* AC L22. */
  it('names the owner, and a BD manager, as who can', () => {
    const [actor, access] = cast.otherAssociate;

    expect(clientsPolicy.changeDeal(actor, access, { id: '9', owner }).told).toBe(
      "This deal is Ama Owusu's. Only they or a BD manager can change it.",
    );
    expect(clientsPolicy.changeDeal(actor, access, { id: '9', owner: { id: AMA } }).told).toBe(
      "Only the deal's owner or a BD manager can change this deal.",
    );
  });

  /* #276: the owner changes their client's name, type and note, and does not hand it on. */
  it('lets the owner of a client change it, but not move it to somebody else', () => {
    const [actor, access] = cast.owner;

    expect(answer(clientsPolicy.changeClient(actor, access, { id: '9', owner }))).toBe('allowed');
    expect(answer(clientsPolicy.reassign(actor, access, 'client', '9'))).toBe('refused openly');
  });
});

describe('a POC (CLI 35, CLI 91, AC L23)', () => {
  const poc = { id: '7', csLead: { id: KOFI, name: 'Kofi Boateng' } };

  it('is updated by its CS lead, who need not own its deals, or a BD manager', () => {
    expect(answers((actor, access) => clientsPolicy.updatePoc(actor, access, poc))).toEqual({
      /* Owns the deals, but is not the CS lead. */
      owner: 'refused openly',
      otherAssociate: 'allowed',
      bdManager: 'allowed',
      ...SILENT_FOR_THE_ROLELESS,
    });
  });

  it('names the CS lead as who can', () => {
    const [actor, access] = cast.owner;

    expect(clientsPolicy.updatePoc(actor, access, poc).told).toMatch(
      /Kofi Boateng or a BD manager/,
    );
  });

  /* AC L23 and its converse: the CS lead may update the POC and may not move the deal. */
  it('does not make its CS lead able to change a deal they do not own', () => {
    const [actor, access] = cast.otherAssociate;

    expect(answer(clientsPolicy.updatePoc(actor, access, poc))).toBe('allowed');
    expect(answer(clientsPolicy.changeDeal(actor, access, { id: '9', owner }))).toBe(
      'refused openly',
    );
  });
});

describe('ticking a check (CLI 41)', () => {
  it('on a deal, a qualification criterion, is its owner’s or a BD manager’s', () => {
    const check = { id: '3', on: 'DEAL', owner } as const;

    expect(answers((actor, access) => clientsPolicy.tickCheck(actor, access, check))).toEqual({
      owner: 'allowed',
      otherAssociate: 'refused openly',
      bdManager: 'allowed',
      ...SILENT_FOR_THE_ROLELESS,
    });
  });

  it('on a POC, is its CS lead’s, a covered deal owner’s, or a BD manager’s', () => {
    const led = { id: '3', on: 'POC', csLead: { id: KOFI }, dealOwnerIds: [] } as const;
    const owned = { id: '3', on: 'POC', csLead: { id: ESI }, dealOwnerIds: [AMA] } as const;

    expect(answers((actor, access) => clientsPolicy.tickCheck(actor, access, led))).toEqual({
      owner: 'refused openly',
      otherAssociate: 'allowed',
      bdManager: 'allowed',
      ...SILENT_FOR_THE_ROLELESS,
    });
    expect(answers((actor, access) => clientsPolicy.tickCheck(actor, access, owned))).toEqual({
      owner: 'allowed',
      otherAssociate: 'refused openly',
      bdManager: 'allowed',
      ...SILENT_FOR_THE_ROLELESS,
    });
  });
});

describe('an activity (CLI 62)', () => {
  it('is corrected only by whoever logged it, a BD manager included', () => {
    const activity = { id: '5', loggedBy: owner };

    expect(answers((actor, access) => clientsPolicy.editActivity(actor, access, activity))).toEqual(
      {
        owner: 'allowed',
        otherAssociate: 'refused openly',
        bdManager: 'refused openly',
        ...SILENT_FOR_THE_ROLELESS,
      },
    );
  });
});

describe('a BD manager’s alone (CLI 92)', () => {
  it.each([
    [
      'reassigning a client',
      (a: Actor, x: ClientsAccess) => clientsPolicy.reassign(a, x, 'client', '1'),
    ],
    [
      'reassigning a deal',
      (a: Actor, x: ClientsAccess) => clientsPolicy.reassign(a, x, 'deal', '1'),
    ],
    ['reassigning a POC', (a: Actor, x: ClientsAccess) => clientsPolicy.reassign(a, x, 'poc', '1')],
    [
      'setting up products, checklists and reasons',
      (a: Actor, x: ClientsAccess) => clientsPolicy.setUp(a, x),
    ],
    ['the CEO report', (a: Actor, x: ClientsAccess) => clientsPolicy.ceoReport(a, x)],
  ])('%s', (_what, ask) => {
    expect(answers(ask)).toEqual({
      owner: 'refused openly',
      otherAssociate: 'refused openly',
      bdManager: 'allowed',
      ...SILENT_FOR_THE_ROLELESS,
    });
  });

  it('and the refusal says to ask a BD manager', () => {
    const [actor, access] = cast.owner;

    expect(clientsPolicy.reassign(actor, access, 'deal', '1').told).toBe(
      'Only a BD manager can move a deal.',
    );
  });
});

describe('meeting reports (CLI 79 to CLI 82)', () => {
  const draft: MeetingReportSubject = { id: '8', author: owner, status: 'DRAFT' };
  const shared: MeetingReportSubject = { ...draft, status: 'SHARED' };

  it('a draft is read by its author alone, not even a BD manager', () => {
    expect(
      answers((actor, access) => clientsPolicy.readMeetingReport(actor, access, draft)),
    ).toEqual({
      owner: 'allowed',
      otherAssociate: 'refused openly',
      bdManager: 'refused openly',
      ...SILENT_FOR_THE_ROLELESS,
    });
  });

  /* AC L21. */
  it('a shared one is read by its author and a BD manager, and no other associate', () => {
    expect(
      answers((actor, access) => clientsPolicy.readMeetingReport(actor, access, shared)),
    ).toEqual({
      owner: 'allowed',
      otherAssociate: 'refused openly',
      bdManager: 'allowed',
      ...SILENT_FOR_THE_ROLELESS,
    });
  });

  it('is written and shared by its author alone', () => {
    expect(
      answers((actor, access) => clientsPolicy.writeMeetingReport(actor, access, draft)),
    ).toEqual({
      owner: 'allowed',
      otherAssociate: 'refused openly',
      bdManager: 'refused openly',
      ...SILENT_FOR_THE_ROLELESS,
    });
  });

  /* NFR CLI SEC 05: the list is scoped by the query, from this. */
  it('a list is scoped to their own, and every shared one for a BD manager', () => {
    const [associate, associateAccess] = cast.owner;
    const [bdManager, bdManagerAccess] = cast.bdManager;
    const [nobody, nobodyAccess] = cast.nobody;

    expect(clientsPolicy.meetingReportScope(associate, associateAccess)).toEqual({
      authorId: AMA,
      everyShared: false,
    });
    expect(clientsPolicy.meetingReportScope(bdManager, bdManagerAccess)).toEqual({
      authorId: ESI,
      everyShared: true,
    });
    expect(clientsPolicy.meetingReportScope(nobody, nobodyAccess)).toBeUndefined();
  });
});

describe('roles (CLI 94)', () => {
  it('are granted and ended by a System Administrator, and refused openly to either role', () => {
    expect(answers((actor, access) => clientsPolicy.manageRoles(actor, access, '12'))).toEqual({
      owner: 'refused openly',
      otherAssociate: 'refused openly',
      bdManager: 'refused openly',
      sysAdminWithNoRole: 'allowed',
      nobody: 'refused silently',
      /* Every grant records who made it, and the system is nobody. */
      system: 'refused silently',
    });
  });

  it('a System Administrator may whatever clients roles they hold', () => {
    for (const holds of [[], ['ASSOCIATE'], ['BD_MANAGER', 'ASSOCIATE']] as ClientsRole[][]) {
      expect(answer(clientsPolicy.manageRoles(person(YAW, { sysAdmin: true }), { holds }))).toBe(
        'allowed',
      );
    }
  });

  it('the refusal names a system administrator as who can', () => {
    const [actor, access] = cast.bdManager;

    expect(clientsPolicy.manageRoles(actor, access).told).toMatch(/system administrator/);
  });
});

describe('work nobody asked for (TDD 10, CLI 95)', () => {
  it.each(['dailyRun', 'endGrantsOnExit'] as const)('%s is the system’s alone', (what) => {
    expect(answers((actor) => clientsPolicy.runUnattended(actor, what))).toEqual({
      owner: 'refused silently',
      otherAssociate: 'refused silently',
      bdManager: 'refused silently',
      /* A person, whatever they administer. */
      sysAdminWithNoRole: 'refused silently',
      nobody: 'refused silently',
      system: 'allowed',
    });
  });
});

/**
 * Nothing answers somebody with no clients role in a way that says clients exists: every
 * question but the System Administrator's two refuses them silently. NFR CLI SEC 04.
 */
describe('somebody with no clients role', () => {
  it('is refused silently by every question that is not a System Administrator’s', () => {
    const [actor, access] = cast.nobody;
    const deal = { id: '1', owner };
    const decisions = [
      clientsPolicy.seeTile(actor, access),
      clientsPolicy.read(actor, access),
      clientsPolicy.contribute(actor, access, 'createDeal'),
      clientsPolicy.changeClient(actor, access, deal),
      clientsPolicy.changeDeal(actor, access, deal),
      clientsPolicy.updatePoc(actor, access, { id: '1', csLead: owner }),
      clientsPolicy.tickCheck(actor, access, { id: '1', on: 'DEAL', owner }),
      clientsPolicy.editActivity(actor, access, { id: '1', loggedBy: owner }),
      clientsPolicy.closeNextStep(actor, access, deal),
      clientsPolicy.reassign(actor, access, 'deal', '1'),
      clientsPolicy.setUp(actor, access),
      clientsPolicy.readMeetingReport(actor, access, { id: '1', author: owner, status: 'SHARED' }),
      clientsPolicy.writeMeetingReport(actor, access, { id: '1', author: owner, status: 'DRAFT' }),
      clientsPolicy.ceoReport(actor, access),
      clientsPolicy.manageRoles(actor, access),
    ];

    expect(decisions.map(answer)).toEqual(decisions.map(() => 'refused silently'));
  });
});
