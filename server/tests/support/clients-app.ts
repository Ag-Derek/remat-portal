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
import { DashboardService } from '../../src/apps/clients/dashboard.service.js';
import { ClientsStandings } from '../../src/apps/clients/standing.js';
import { ClientsReassignRepository } from '../../src/apps/clients/reassign.db.js';
import { ReassignService } from '../../src/apps/clients/reassign.service.js';
import { ClientsContactRepository } from '../../src/apps/clients/contact.db.js';
import { ClientsProductInUseRepository } from '../../src/apps/clients/product-in-use.db.js';
import { clientsDoor } from '../../src/apps/clients/door.js';
import { ClientsOpportunityRepository } from '../../src/apps/clients/opportunity.db.js';
import { ClientsNoteRepository } from '../../src/apps/clients/note.db.js';
import { OpportunityService } from '../../src/apps/clients/opportunity.service.js';
import { ClientsProductRepository } from '../../src/apps/clients/product.db.js';
import { ClientsReasonRepository } from '../../src/apps/clients/reason.db.js';
import { ClientsRoleRepository } from '../../src/apps/clients/role.db.js';
import { RoleService } from '../../src/apps/clients/role.service.js';
import { clientsRoutes } from '../../src/apps/clients/routes.js';
import { SetupService } from '../../src/apps/clients/setup.service.js';
import { StageService } from '../../src/apps/clients/stage.service.js';
import { clientsVisibility } from '../../src/apps/clients/visibility.js';
import { ClientsActivityRepository } from '../../src/apps/clients/activity.db.js';
import { ActivityService } from '../../src/apps/clients/activity.service.js';
import { ClientsDocumentRepository } from '../../src/apps/clients/document.db.js';
import { DocumentService } from '../../src/apps/clients/document.service.js';
import { ClientsCheckRepository } from '../../src/apps/clients/checklist.db.js';
import { ClientsChecklistItemRepository } from '../../src/apps/clients/checklist-item.db.js';
import { ChecklistService } from '../../src/apps/clients/checklist.service.js';
import { ClientsPocRepository } from '../../src/apps/clients/poc.db.js';
import { PocService } from '../../src/apps/clients/poc.service.js';
import { StageForPoc } from '../../src/apps/clients/stage-for-poc.js';
import { CompanyCalendar } from '../../src/core/calendar/company-calendar.js';
import { SignatureScanner } from '../../src/core/scanning/signature-scanner.js';
import { InMemoryStorage } from './in-memory-storage.js';
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
  /** Where documents' bytes go (#281), for a test that asserts on what was or was not kept. */
  storage: InMemoryStorage;
  /** Sends a request, never following a redirect, so a test sees the 302 itself. */
  send(method: string, path: string, as: Asker, body?: unknown): Promise<globalThis.Response>;
  /** Uploads a file as the screen does: its bytes as the body, its name in `X-Filename`. #281. */
  sendFile(
    path: string,
    as: Asker,
    file: { content: Buffer; filename?: string; contentType?: string },
  ): Promise<globalThis.Response>;
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
  /** Where documents' bytes go: by default a Map, which, as the local driver, mints no links. */
  storage: InMemoryStorage = new InMemoryStorage(),
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
  const activities = new ClientsActivityRepository(db);

  const standings = new ClientsStandings(grants, new EmployeeRepository(db));
  const pocs = new PocService(
    guard,
    grants,
    new ClientsPocRepository(db),
    new StageForPoc(
      opportunities,
      new ClientsReasonRepository(db),
      grants,
      new EmployeeRepository(db),
      new CompanyCalendar(db),
    ),
    standings,
  );

  const router = clientsRoutes({
    door: clientsDoor(guard, grants),
    grants,
    roles: new RoleService(guard, grants, new EmployeeRepository(db)),
    setup: new SetupService(
      guard,
      grants,
      new ClientsProductRepository(db),
      clientRecords,
      new ClientsReasonRepository(db),
      new ClientsChecklistItemRepository(db),
    ),
    clients: new ClientService(
      guard,
      grants,
      clientRecords,
      new ClientsContactRepository(db),
      productsInUse,
      opportunities,
      new ClientsNoteRepository(db),
      activities,
      standings,
    ),
    opportunities: new OpportunityService(
      guard,
      grants,
      clientRecords,
      productsInUse,
      opportunities,
    ),
    stages: new StageService(guard, grants, opportunities, new ClientsReasonRepository(db)),
    activities: new ActivityService(guard, grants, clientRecords, activities),
    pocs,
    reassign: new ReassignService(
      guard,
      grants,
      opportunities,
      new ClientsReassignRepository(db),
      standings,
    ),
    dashboard: new DashboardService(guard, grants, opportunities, clientRecords, pocs, standings),
    documents: new DocumentService(
      guard,
      grants,
      new ClientsDocumentRepository(db),
      storage,
      new SignatureScanner(),
    ),
    checklists: new ChecklistService(guard, grants, new ClientsCheckRepository(db)),
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
    storage,
    sendFile(path, as, { content, filename = 'proposal.pdf', contentType = 'application/pdf' }) {
      const headers: Record<string, string> = {
        'x-test-employee': as.employeeId,
        'content-type': contentType,
        'x-filename': encodeURIComponent(filename),
      };

      return fetch(`${origin}${path}`, { method: 'POST', headers, body: content });
    },
    send(method, path, as, body) {
      const headers: Record<string, string> = { 'x-test-employee': as.employeeId };

      if (as.sysAdmin === true) headers['x-test-sysadmin'] = 'yes';
      if (body !== undefined) headers['content-type'] = 'application/json';

      return fetch(`${origin}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
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
