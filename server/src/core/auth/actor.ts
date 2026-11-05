/** Who is asking. NFR SEC 02. */

import type { Authority, RoleCode } from '../identity/role/roles.js';

/** Somebody, or something, making a request of a service. */
export interface Actor extends Authority {
  /** The employee making the request, or null for theSystem. */
  employeeId: string | null;
  /** What to call this in the denial log. */
  description: string;
  /**
   * Whether this is a portal System Administrator. SRS 2.3 (3), CMP 57.
   *
   * The same fact as holding SYS_ADMIN, answered once here so that an app which must not
   * read the portal's role codes still has it. Compliance is that app: only a System
   * Administrator grants its roles, and it asks this rather than `roles`, which are Rota's
   * vocabulary and not its own.
   *
   * On the actor and not on {@link Authority}, because it is never borrowed: a delegator
   * lends their approvals, not the keys to who may hold what. FR 49.
   */
  isSysAdmin: boolean;
}

/** Whether these roles make somebody a portal System Administrator. */
function isSysAdminBy(roles: readonly RoleCode[]): boolean {
  return roles.includes('SYS_ADMIN');
}

/** The actor for somebody who has just signed in. */
export function signedInAs(employeeId: string, authority: Authority): Actor {
  return {
    employeeId,
    roles: [...authority.roles],
    isManager: authority.isManager,
    ...(authority.isChiefExecutive === true ? { isChiefExecutive: true } : {}),
    isSysAdmin: isSysAdminBy(authority.roles),
    description: `employee ${employeeId}`,
  };
}

/**
 * Work that no person asked for.
 *
 * A scheduled job, a migration correcting data, a seed loading fixtures, a test
 * building the organisation it is about to make assertions on. All of those have
 * to write records and none of them has a person behind them, so refusing them
 * would mean either no jobs or a second, unguarded way into every service — and
 * the second way is the one that quietly becomes the way everything is done.
 *
 * So it exists, and three things are true of it on purpose.
 *
 * **It holds every role.** Not a flag that policies branch on: a branch in every
 * policy is a branch that one policy forgets, and the forgetting is silent. It
 * is an actor like any other, judged by the same rules as anybody else, and it
 * passes them because it holds the roles that pass them.
 *
 * **It is nobody.** `employeeId` is null, so it matches no record's owner and no
 * record's manager. It cannot be somebody's colleague by accident.
 *
 * **It says why it exists.** `purpose` is not decoration — it is what the denial
 * log prints, and it is the difference between "the system was refused" and "the
 * nightly reminder job was refused". Being made to write a sentence is also the
 * point: `theSystem('')` looks wrong in a diff in a way that a bare constant
 * never would.
 *
 * This is a back door with a name on it, and a name is what makes it reviewable.
 * `grep -rn theSystem server/src` is the list of everything in the application
 * that runs unattended, and it should stay short.
 */
export function theSystem(purpose: string): Actor {
  const roles: RoleCode[] = ['EMPLOYEE', 'HR_OFFICER', 'HR_ADMIN', 'SYS_ADMIN'];

  return {
    employeeId: null,
    roles,
    isManager: false,
    isSysAdmin: isSysAdminBy(roles),
    description: `the system (${purpose})`,
  };
}

/** Whether these roles include any of those. An `Authority`, so a delegator's answer too. FR 49. */
export function holdsAny(who: Authority, ...codes: readonly RoleCode[]): boolean {
  return codes.some((code) => who.roles.includes(code));
}

/**
 * Whether this record is the actor's own.
 *
 * Written as a function rather than as `actor.employeeId === id` at each call
 * site, because the comparison has one wrong answer that is easy to write by
 * accident: `null === null` is true, and two records with no owner are not the
 * same person. The system is nobody, and nobody owns nothing.
 */
export function isSelf(actor: Actor, employeeId: string | null): boolean {
  return actor.employeeId !== null && employeeId !== null && actor.employeeId === employeeId;
}
