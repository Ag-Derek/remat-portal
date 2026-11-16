import { describe, expect, it } from 'vitest';
import { type Actor, signedInAs, theSystem } from '../../src/core/auth/actor.js';
import { Guard } from '../../src/core/auth/policy.js';
import { visibleApps } from '../../src/core/portal/app-visibility.js';
import { clientsPolicy } from '../../src/apps/clients/policy.js';
import { type ClientsRole, CLIENTS_ROLES } from '../../src/apps/clients/role.js';
import { clientsVisibility } from '../../src/apps/clients/visibility.js';
import { recordingDenials } from '../support/recording-denials.js';

/**
 * The clients tile and the clients policy agree. #274, Clients TDD 15, NFR CLI SEC 06.
 *
 * Over every combination of clients roles held, with and without System Administrator, and the
 * system itself: the tile is shown exactly where the policy's `seeTile` allows it, and exactly
 * where something in clients would answer — the pipeline for either role, the roles screen for
 * a System Administrator. A tile nobody can use behind, or a screen with no tile in front of it,
 * would fail here.
 */

/** Every subset of the two roles: none, either, both. */
const HOLDINGS: ClientsRole[][] = [[], ...CLIENTS_ROLES.map((one) => [one]), [...CLIENTS_ROLES]];

/** Everybody worth asking about. */
const ASKERS: { name: string; actor: Actor }[] = [
  {
    name: 'somebody',
    actor: signedInAs('7', { roles: ['EMPLOYEE'], isManager: false }),
  },
  {
    name: 'an HR administrator and manager',
    actor: signedInAs('7', { roles: ['EMPLOYEE', 'HR_ADMIN', 'HR_OFFICER'], isManager: true }),
  },
  {
    name: 'a System Administrator',
    actor: signedInAs('7', { roles: ['EMPLOYEE', 'SYS_ADMIN'], isManager: false }),
  },
  { name: 'the system', actor: theSystem('a test') },
];

const CASES = ASKERS.flatMap(({ name, actor }) =>
  HOLDINGS.map((holds) => ({
    label: `${name} holding ${holds.length === 0 ? 'no clients role' : holds.join(' and ')}`,
    actor,
    holds,
  })),
);

describe('the clients tile', () => {
  it.each(CASES)('agrees with the policy for $label', async ({ actor, holds }) => {
    const denials = recordingDenials();
    const guard = new Guard(denials);
    const tile = clientsVisibility(guard, { rolesOf: () => Promise.resolve(holds) });
    /* The system is nobody, and accessOf never asks for its roles. */
    const access = { holds: actor.employeeId === null ? [] : holds };

    const shown = await tile.canSee(actor);
    const somethingAnswers =
      clientsPolicy.read(actor, access).allowed || clientsPolicy.manageRoles(actor, access).allowed;

    expect(shown).toBe(clientsPolicy.seeTile(actor, access).allowed);
    expect(shown).toBe(somethingAnswers);
    /* The door every /api/clients request comes through opens for exactly the same people. */
    expect(clientsPolicy.enter(actor, access).allowed).toBe(shown);
    expect(await visibleApps(actor, [tile])).toEqual(shown ? ['clients'] : []);

    /* Not seeing a tile is nobody's refused attempt. */
    expect(denials.entries).toEqual([]);
  });

  it('is shown to most staff never', async () => {
    const tile = clientsVisibility(new Guard(recordingDenials()), {
      rolesOf: () => Promise.resolve([]),
    });

    expect(await tile.canSee(signedInAs('7', { roles: ['EMPLOYEE'], isManager: false }))).toBe(
      false,
    );
  });
});

describe('the apps a portal home shows', () => {
  it('are those that say yes, in the order registered', async () => {
    const actor = signedInAs('7', { roles: ['EMPLOYEE'], isManager: false });
    const yes = (app: string) => ({ app, canSee: () => Promise.resolve(true) });
    const no = (app: string) => ({ app, canSee: () => Promise.resolve(false) });

    expect(await visibleApps(actor, [yes('a'), no('b'), yes('c')])).toEqual(['a', 'c']);
    expect(await visibleApps(actor, [])).toEqual([]);
  });
});
