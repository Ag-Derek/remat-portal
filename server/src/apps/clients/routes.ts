/**
 * Clients, over HTTP. #274, Clients TDD 11.
 *
 * The business development and customer success department's pipeline: clients, their
 * opportunities, POCs and the reports made from them. Every route is under `/clients`, and
 * every one asks `clientsPolicy` through its service; none decides anything itself.
 *
 * Still being built, so app.ts mounts this outside production only: `/api/clients` answers 404
 * there until it goes live, and the portal home shows no clients card there either.
 */

import {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from 'express';
import { actorOf } from '../../core/http/identify.js';
import { accessOf, viewsOf } from './access.js';
import type { Client } from './client.js';
import type { ClientService } from './client.service.js';
import type { Contact } from './contact.js';
import type { Opportunity } from './opportunity.js';
import type { OpportunityService } from './opportunity.service.js';
import type { Grant } from './role.js';
import type { ClientsRoleRepository } from './role.db.js';
import type { RoleService, RolesScreen } from './role.service.js';
import type { SetupService } from './setup.service.js';

export interface ClientsRoutes {
  /**
   * `clientsDoor`, which every request under `/clients` comes through first. Required, so there
   * is no way to build these routes without it.
   */
  door: RequestHandler;
  /** Who holds what, read for `/clients/me`. */
  grants: Pick<ClientsRoleRepository, 'rolesOf'>;
  /** The roles screen. A portal System Administrator's. */
  roles: RoleService;
  /** Products and lines. A BD manager's. Optional, so a test app without them has no such routes. */
  setup?: SetupService;
  /** Clients themselves. Optional, for the same reason. */
  clients?: ClientService;
  /** Deals. #277. Optional, for the same reason. */
  opportunities?: OpportunityService;
}

export function clientsRoutes({
  door,
  grants,
  roles,
  setup,
  clients,
  opportunities,
}: ClientsRoutes): Router {
  const routes = Router();

  /* First, before any route below: somebody with no clients role is turned away here, from
     every address under /clients whether or not there is a route at it. NFR CLI SEC 04. */
  routes.use('/clients', door);

  /** Which parts of clients this person has, so the screen draws only those tabs. */
  routes.get('/clients/me', (_request: Request, response: Response, next: NextFunction) => {
    const actor = actorOf(response);

    void accessOf(actor, grants)
      .then((access) => {
        response.json(viewsOf(actor, access));
      })
      .catch(next);
  });

  if (setup !== undefined) {
    setupRoutes(routes, setup);
  }

  if (clients !== undefined) {
    clientRoutes(routes, clients);
  }

  if (opportunities !== undefined) {
    opportunityRoutes(routes, opportunities);
  }

  /** Who holds which role, and who could be granted one. */
  routes.get('/clients/roles', (_request: Request, response: Response, next: NextFunction) => {
    void roles
      .screen(actorOf(response))
      .then((screen) => {
        response.json(screenAsJson(screen));
      })
      .catch(next);
  });

  /** Grants a role: `{ employeeId, role }`. */
  routes.post('/clients/roles', (request: Request, response: Response, next: NextFunction) => {
    void roles
      .grant(actorOf(response), request.body)
      .then((grant) => {
        response.status(201).json(grantAsJson(grant));
      })
      .catch(next);
  });

  /** Ends a grant. The row stays, as the record that it was held and who ended it. */
  routes.delete(
    '/clients/roles/:id',
    (request: Request, response: Response, next: NextFunction) => {
      void roles
        .end(actorOf(response), String(request.params.id))
        .then((grant) => {
          response.json(grantAsJson(grant));
        })
        .catch(next);
    },
  );

  return routes;
}

/**
 * Products and lines, under `/clients/setup`. #293, Clients TDD 11. Every one asks
 * `clientsPolicy.setUp` through the service, so an associate is refused openly and somebody with
 * no role never gets past the door.
 */
function setupRoutes(routes: Router, setup: SetupService): void {
  /** Every line with its products, retired ones included. */
  routes.get(
    '/clients/setup/products',
    answer(async (_request, response) => ({
      lines: await setup.lines(actorOf(response)),
    })),
  );

  /** `{ name }`. */
  routes.post(
    '/clients/setup/lines',
    answer((request, response) => setup.addLine(actorOf(response), request.body), 201),
  );

  /** `{ lineId, name }`. */
  routes.post(
    '/clients/setup/products',
    answer((request, response) => setup.addProduct(actorOf(response), request.body), 201),
  );

  /** `{ name }`. */
  routes.patch(
    '/clients/setup/lines/:id',
    answer((request, response) => setup.renameLine(actorOf(response), idOf(request), request.body)),
  );

  routes.patch(
    '/clients/setup/products/:id',
    answer((request, response) =>
      setup.renameProduct(actorOf(response), idOf(request), request.body),
    ),
  );

  routes.post(
    '/clients/setup/lines/:id/retire',
    answer((request, response) => setup.retireLine(actorOf(response), idOf(request))),
  );

  routes.post(
    '/clients/setup/lines/:id/restore',
    answer((request, response) => setup.restoreLine(actorOf(response), idOf(request))),
  );

  routes.post(
    '/clients/setup/products/:id/retire',
    answer((request, response) => setup.retireProduct(actorOf(response), idOf(request))),
  );

  routes.post(
    '/clients/setup/products/:id/restore',
    answer((request, response) => setup.restoreProduct(actorOf(response), idOf(request))),
  );

  /* Client types, #276: the kinds of institution a client may be. */

  routes.get(
    '/clients/setup/client-types',
    answer(async (_request, response) => ({ types: await setup.clientTypes(actorOf(response)) })),
  );

  /** `{ name }`. */
  routes.post(
    '/clients/setup/client-types',
    answer((request, response) => setup.addClientType(actorOf(response), request.body), 201),
  );

  routes.patch(
    '/clients/setup/client-types/:id',
    answer((request, response) =>
      setup.renameClientType(actorOf(response), idOf(request), request.body),
    ),
  );

  routes.post(
    '/clients/setup/client-types/:id/retire',
    answer((request, response) => setup.retireClientType(actorOf(response), idOf(request))),
  );

  routes.post(
    '/clients/setup/client-types/:id/restore',
    answer((request, response) => setup.restoreClientType(actorOf(response), idOf(request))),
  );
}

/**
 * Clients themselves, under `/clients/clients`. #276, Clients SRS CLI 02, CLI 05. Anybody with a
 * clients role reads and creates them; somebody with none never gets past the door.
 */
function clientRoutes(routes: Router, clients: ClientService): void {
  /** The kinds of institution a client may be, retired ones included and marked. */
  routes.get(
    '/clients/client-types',
    answer(async (_request, response) => ({ types: await clients.types(actorOf(response)) })),
  );

  /** `{ name, typeId, note? }`. The owner is whoever asks. */
  routes.post(
    '/clients/clients',
    answer(
      async (request, response) =>
        clientAsJson(await clients.create(actorOf(response), request.body)),
      201,
    ),
  );

  /** Every client by name, with its type and owner. */
  routes.get(
    '/clients/clients',
    answer(async (_request, response) => ({ clients: await clients.list(actorOf(response)) })),
  );

  /** The client page: the client, and what the person asking may do to it. */
  routes.get(
    '/clients/clients/:id',
    answer(async (request, response) => {
      const { client, may } = await clients.page(actorOf(response), idOf(request));

      return { ...(clientAsJson(client) as object), may };
    }),
  );

  /** The products that may be added to a client: neither retired nor in a retired line. */
  routes.get(
    '/clients/products',
    answer(async (_request, response) => ({
      products: await clients.offeredProducts(actorOf(response)),
    })),
  );

  /** Everybody holding a clients role, whom a client may be moved to. */
  routes.get(
    '/clients/holders',
    answer(async (_request, response) => ({ people: await clients.holders(actorOf(response)) })),
  );

  /**
   * `{ name?, typeId?, ownerId?, note? }`: only what is present changes, and a note given as null
   * or blank is taken away. Its owner's or a BD manager's.
   */
  routes.patch(
    '/clients/clients/:id',
    answer(async (request, response) =>
      clientAsJson(await clients.change(actorOf(response), idOf(request), request.body)),
    ),
  );

  /** `{ name, jobTitle?, email?, phone? }`. Anybody with a role's. CLI 03, CLI 05. */
  routes.post(
    '/clients/clients/:id/contacts',
    answer(
      async (request, response) =>
        contactAsJson(await clients.addContact(actorOf(response), idOf(request), request.body)),
      201,
    ),
  );

  /** `{ name?, jobTitle?, email?, phone? }`: only what is present changes; null takes it away. */
  routes.patch(
    '/clients/contacts/:id',
    answer(async (request, response) =>
      contactAsJson(await clients.changeContact(actorOf(response), idOf(request), request.body)),
    ),
  );

  /** No longer somebody to deal with there. Kept, and marked removed. */
  routes.post(
    '/clients/contacts/:id/remove',
    answer((request, response) => clients.removeContact(actorOf(response), idOf(request))),
  );

  routes.post(
    '/clients/contacts/:id/restore',
    answer((request, response) => clients.restoreContact(actorOf(response), idOf(request))),
  );

  /** `{ productId, sinceOn }`: a product the client already uses, from that day. CLI 04. */
  routes.post(
    '/clients/clients/:id/products',
    answer(
      (request, response) =>
        clients.addProductInUse(actorOf(response), idOf(request), request.body),
      201,
    ),
  );

  /** `{ sinceOn?, endedOn? }`: corrects the dates. An `endedOn` of null says they use it again. */
  routes.patch(
    '/clients/clients/:id/products/:productId',
    answer((request, response) =>
      clients.changeProductInUse(
        actorOf(response),
        idOf(request),
        String(request.params.productId),
        request.body,
      ),
    ),
  );
}

/**
 * Deals, under `/clients/opportunities`. #277, Clients SRS CLI 10 to CLI 17, TDD 11. Anybody with a
 * clients role reads and opens them; somebody with none never gets past the door.
 */
function opportunityRoutes(routes: Router, opportunities: OpportunityService): void {
  /**
   * `{ clientId, productId, value?: { amount, currency }, probability?, expectedClose?: { half,
   * year }, waitingOn?: { on, note? }, statedInterest? }`. The owner is whoever asks.
   */
  routes.post(
    '/clients/opportunities',
    answer(
      async (request, response) =>
        opportunityAsJson(await opportunities.create(actorOf(response), request.body)),
      201,
    ),
  );

  routes.get(
    '/clients/opportunities/:id',
    answer(async (request, response) =>
      opportunityAsJson(await opportunities.find(actorOf(response), idOf(request))),
    ),
  );

  /** Its past values: value and probability after each change, newest first. */
  routes.get(
    '/clients/opportunities/:id/history',
    answer(async (request, response) => ({
      history: (await opportunities.history(actorOf(response), idOf(request))).map((change) => ({
        ...change,
        changedAt: change.changedAt.toISOString(),
      })),
    })),
  );

  /**
   * `{ value?, probability?, expectedClose?, waitingOn?, statedInterest? }`, each as opening a
   * deal takes it: only what is present changes, and null takes it away. Its owner's or a BD
   * manager's, while it is open (CLI 13).
   */
  routes.patch(
    '/clients/opportunities/:id',
    answer(async (request, response) =>
      opportunityAsJson(await opportunities.change(actorOf(response), idOf(request), request.body)),
    ),
  );
}

/** Answers with the result, or with nothing where there is nothing to say. */
function answer(work: (request: Request, response: Response) => Promise<unknown>, status = 200) {
  return (request: Request, response: Response, next: NextFunction) => {
    void work(request, response)
      .then((result) => {
        if (result === undefined) {
          response.status(204).end();
        } else {
          response.status(status).json(result);
        }
      })
      .catch(next);
  };
}

function idOf(request: Request): string {
  return String(request.params.id);
}

/** Every field present, a missing one as null, so the screen shows it as missing. */
function clientAsJson(client: Client): unknown {
  return {
    ...client,
    createdAt: client.createdAt.toISOString(),
    contacts: client.contacts.map(contactAsJson),
    opportunities: client.opportunities.map(opportunityAsJson),
  };
}

/** Every field present, a missing one as null, so the screen shows it as missing (CLI 06). */
function opportunityAsJson(opportunity: Opportunity): unknown {
  return { ...opportunity, createdAt: opportunity.createdAt.toISOString() };
}

function contactAsJson(contact: Contact): unknown {
  return {
    ...contact,
    createdAt: contact.createdAt.toISOString(),
    removedAt: contact.removedAt?.toISOString() ?? null,
  };
}

function screenAsJson(screen: RolesScreen): unknown {
  return {
    today: screen.today,
    grants: screen.grants.map((grant) => ({
      ...grant,
      grantedAt: grant.grantedAt.toISOString(),
    })),
    people: screen.people,
  };
}

function grantAsJson(grant: Grant): unknown {
  return {
    id: grant.id,
    employeeId: grant.employeeId,
    role: grant.role,
    grantedBy: grant.grantedBy,
    grantedAt: grant.grantedAt.toISOString(),
    endedAt: grant.endedAt?.toISOString() ?? null,
    endedBy: grant.endedBy,
    endedReason: grant.endedReason,
  };
}
