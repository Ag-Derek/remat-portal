/**
 * Whether the clients tile is on somebody's portal home. #274, Clients SRS CLI 93, TDD 12.2.
 *
 * Asks `clientsPolicy.seeTile`, the same module every clients endpoint asks (NFR CLI SEC 06):
 * either role, or a System Administrator, who needs the tile to reach the roles screen.
 */

import type { Actor } from '../../core/auth/actor.js';
import type { Guard } from '../../core/auth/policy.js';
import type { AppVisibility } from '../../core/portal/app-visibility.js';
import { accessOf } from './access.js';
import { clientsPolicy } from './policy.js';
import type { ClientsRoleRepository } from './role.db.js';

export function clientsVisibility(
  guard: Guard,
  grants: Pick<ClientsRoleRepository, 'rolesOf'>,
): AppVisibility {
  return {
    app: 'clients',
    /* `permits` rather than `enforce`: not seeing a tile is nobody's refused attempt, and
       writing every portal home load to the denial log would bury the real ones. */
    async canSee(actor: Actor): Promise<boolean> {
      return guard.permits(clientsPolicy.seeTile(actor, await accessOf(actor, grants)));
    },
  };
}
