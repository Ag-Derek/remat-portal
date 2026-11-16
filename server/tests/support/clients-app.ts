import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import type { Kysely } from 'kysely';
import { signedInAs } from '../../src/core/auth/actor.js';
import { Guard } from '../../src/core/auth/policy.js';
import type { Database } from '../../src/core/db/index.js';
import { answerProblems, NO_SUCH_ROUTE } from '../../src/core/http/problems.js';
import { EmployeeRepository } from '../../src/core/organisation/employee/employee.db.js';
import { portalRoutes } from '../../src/core/portal/routes.js';
import { ClientsClientRepository } from '../../src/apps/clients/client.db.js';
import { ClientService } from '../../src/apps/clients/client.service.js';
import { ClientsContactRepository } from '../../src/apps/clients/contact.db.js';
import { ClientsProductInUseRepository } from '../../src/apps/clients/product-in-use.db.js';
import { clientsDoor } from '../../src/apps/clients/door.js';
import { ClientsOpportunityRepository } from '../../src/apps/clients/opportunity.db.js';
import { OpportunityService } from '../../src/apps/clients/opportunity.service.js';
import { ClientsProductRepository } from '../../src/apps/clients/product.db.js';
import { ClientsRoleRepository } from '../../src/apps/clients/role.db.js';
import { RoleService } from '../../src/apps/clients/role.service.js';
import { clientsRoutes } from '../../src/apps/clients/routes.js';
import { SetupService } from '../../src/apps/clients/setup.service.js';
import { clientsVisibility } from '../../src/apps/clients/visibility.js';
import type { RecordingDenialLog } from './recording-denials.js';

/**
 * Clients over HTTP, for an integration test: its routes, the portal home's `/api/me/apps`, and
 * the catch-all for an address with nothing at it, all as app.ts mounts them. #274, #293.
 *
 * In front, a stand in for `identify` that builds the actor exactly as signing in does,
 * `signedInAs` from the portal roles held: the test names who is asking in `x-test-employee`, and
 * `x-test-sysadmin: yes` makes them a portal System Administrator. That a System Administrator
 * is somebody holding SYS_ADMIN is ../unit/one-actor.test.ts's to prove.
 */
export interface ClientsApp {
  origin: string;
  /** The clients router, as built, so a test can ask it which routes it has. */
  router: Router;
  send(method: string, path: string, as: Asker, body?: unknown): Promise<globalThis.Response>;
  close(): Promise<void>;
}

/** Who is asking, and whether they are a portal System Administrator. */
export interface Asker {
  employeeId: string;
  sysAdmin?: boolean;
}

export async function startClientsApp(
  db: Kysely<Database>,
  denials: RecordingDenialLog,
): Promise<ClientsApp> {
  const app = express();
  app.use(express.json());

  app.use((request: Request, response: Response, next: NextFunction) => {
    const employeeId = request.header('x-test-employee');

    if (employeeId !== undefined) {
      response.locals.actor = signedInAs(employeeId, {
        roles:
          request.header('x-test-sysadmin') === 'yes' ? ['EMPLOYEE', 'SYS_ADMIN'] : ['EMPLOYEE'],
        isManager: false,
      });
    }
    next();
  });

  const guard = new Guard(denials);
  const grants = new ClientsRoleRepository(db);
  const clientRecords = new ClientsClientRepository(db);
  const productsInUse = new ClientsProductInUseRepository(db);
  const opportunities = new ClientsOpportunityRepository(db);

  const router = clientsRoutes({
    door: clientsDoor(guard, grants),
    grants,
    roles: new RoleService(guard, grants, new EmployeeRepository(db)),
    setup: new SetupService(guard, grants, new ClientsProductRepository(db), clientRecords),
    clients: new ClientService(
      guard,
      grants,
      clientRecords,
      new ClientsContactRepository(db),
      productsInUse,
      opportunities,
    ),
    opportunities: new OpportunityService(
      guard,
      grants,
      clientRecords,
      productsInUse,
      opportunities,
    ),
  });

  app.use('/api', router);
  app.use('/api', portalRoutes({ apps: [clientsVisibility(guard, grants)] }));
  app.use('/api', (_request: Request, response: Response) => {
    response.status(404).json(NO_SUCH_ROUTE);
  });
  app.use(answerProblems());

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => {
      resolve(listening);
    });
  });
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  return {
    origin,
    router,
    send(method, path, as, body) {
      const headers: Record<string, string> = { 'x-test-employee': as.employeeId };

      if (as.sysAdmin === true) headers['x-test-sysadmin'] = 'yes';
      if (body !== undefined) headers['content-type'] = 'application/json';

      return fetch(`${origin}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
