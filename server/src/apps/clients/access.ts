/**
 * What clients knows about who is asking: the clients roles they hold today. #274.
 *
 * The one way every clients service learns it, read fresh on each request from clients_role,
 * so a grant ended a moment ago is ended on the next click rather than at the next sign in.
 * The answer is handed to `clientsPolicy`, which decides; this only reads.
 */

import type { Actor } from '../../core/auth/actor.js';
import { type ClientsAccess, clientsPolicy } from './policy.js';
import type { ClientsRoleRepository } from './role.db.js';

/**
 * Which parts of clients this person has, so the screen draws only those tabs. Each is the
 * policy's own answer to the question that part's routes ask; the routes still refuse whatever
 * the screen draws.
 */
export interface ClientsViews {
  /** Products and lines, and later checklists and reasons. A BD manager's. */
  setUp: boolean;
  /** Who holds which role. A portal System Administrator's. */
  manageRoles: boolean;
}

export function viewsOf(actor: Actor, access: ClientsAccess): ClientsViews {
  return {
    setUp: clientsPolicy.setUp(actor, access).allowed,
    manageRoles: clientsPolicy.manageRoles(actor, access).allowed,
  };
}

export async function accessOf(
  actor: Actor,
  grants: Pick<ClientsRoleRepository, 'rolesOf'>,
): Promise<ClientsAccess> {
  /* The system is nobody, and nobody holds a clients role. */
  return { holds: actor.employeeId === null ? [] : await grants.rolesOf(actor.employeeId) };
}
