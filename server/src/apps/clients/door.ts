/**
 * The door of clients: every `/api/clients` request comes through it first. #274, Clients SRS
 * CLI 93, NFR CLI SEC 04.
 *
 * Somebody with no clients role, who is not a System Administrator, is turned away here, before
 * any route runs, with exactly what an address with nothing at it answers. So every clients
 * endpoint, every id, and every address under `/api/clients` that is no endpoint at all, answers
 * them the same — including endpoints written after this, which cannot forget to.
 *
 * The refusal is still written to the denial log, as every refusal is (NFR SEC 03). Getting
 * through is not permission for anything: each route asks `clientsPolicy` its own question.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Guard } from '../../core/auth/policy.js';
import { actorOf } from '../../core/http/identify.js';
import { NO_SUCH_ROUTE } from '../../core/http/problems.js';
import { accessOf } from './access.js';
import { clientsPolicy } from './policy.js';
import type { ClientsRoleRepository } from './role.db.js';

export function clientsDoor(
  guard: Guard,
  grants: Pick<ClientsRoleRepository, 'rolesOf'>,
): RequestHandler {
  return (_request: Request, response: Response, next: NextFunction) => {
    const actor = actorOf(response);

    void accessOf(actor, grants)
      .then((access) => {
        const decision = clientsPolicy.enter(actor, access);

        if (decision.allowed) {
          next();
          return;
        }

        guard.record(decision);
        response.status(404).json(NO_SUCH_ROUTE);
      })
      .catch(next);
  };
}
