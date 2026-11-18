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

import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from 'express';
import { actorOf } from '../../core/http/identify.js';
import { accessOf, viewsOf } from './access.js';
import type { ActivityService, Logged } from './activity.service.js';
import type { Client } from './client.js';
import type { ClientService } from './client.service.js';
import type { Contact } from './contact.js';
import {
  DocumentTooLarge,
  type DocumentView,
  downloadable,
  MAX_DOCUMENT_BYTES,
  type UploadedDocument,
} from './document.js';
import type { DocumentService } from './document.service.js';
import type { LoggedActivity } from './logged-activity.js';
import type { NextStep } from './next-step.js';
import type { ClientNote } from './note.js';
import type { Opportunity } from './opportunity.js';
import type { OpportunityService } from './opportunity.service.js';
import type { Grant } from './role.js';
import type { ClientsRoleRepository } from './role.db.js';
import type { RoleService, RolesScreen } from './role.service.js';
import type { SetupService } from './setup.service.js';
import type { StageService } from './stage.service.js';

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
  /** Moving deals up the ladder. #278. Optional, for the same reason. */
  stages?: StageService;
  /** Activities and next steps. #280. Optional, for the same reason. */
  activities?: ActivityService;
  /** Documents on activities and deals. #281. Optional, for the same reason. */
  documents?: DocumentService;
}

export function clientsRoutes({
  door,
  grants,
  roles,
  setup,
  clients,
  opportunities,
  stages,
  activities,
  documents,
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

  if (stages !== undefined) {
    stageRoutes(routes, stages);
  }

  if (activities !== undefined) {
    activityRoutes(routes, activities);
  }

  if (documents !== undefined) {
    documentRoutes(routes, documents);
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

  /* Lost and exit reasons, #279, CLI 54: both lists, and which a deal has ended for. */

  routes.get(
    '/clients/setup/reasons',
    answer(async (_request, response) => ({ reasons: await setup.reasonLists(actorOf(response)) })),
  );

  /** `{ appliesTo: 'LOST' | 'EXITED', label }`. */
  routes.post(
    '/clients/setup/reasons',
    answer((request, response) => setup.addReason(actorOf(response), request.body), 201),
  );

  /** `{ label }`, while no deal has ended for it. */
  routes.patch(
    '/clients/setup/reasons/:id',
    answer((request, response) =>
      setup.rewordReason(actorOf(response), idOf(request), request.body),
    ),
  );

  routes.post(
    '/clients/setup/reasons/:id/retire',
    answer((request, response) => setup.retireReason(actorOf(response), idOf(request))),
  );

  routes.post(
    '/clients/setup/reasons/:id/restore',
    answer((request, response) => setup.restoreReason(actorOf(response), idOf(request))),
  );

  /** Only while no deal has ended for it; one in use is retired instead. */
  routes.delete(
    '/clients/setup/reasons/:id',
    answer((request, response) => setup.deleteReason(actorOf(response), idOf(request))),
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

      return {
        ...(clientAsJson(client) as object),
        nextSteps: client.nextSteps.map(nextStepAsJson),
        may,
      };
    }),
  );

  /**
   * Everything that has happened to the client's deals, newest first: stage changes and changes
   * to value or chance of closing, each naming its deal. #278, CLI 99.
   */
  routes.get(
    '/clients/clients/:id/activity',
    answer(async (request, response) => ({
      activity: (await clients.activity(actorOf(response), idOf(request))).map((entry) => ({
        ...entry,
        at: entry.at.toISOString(),
      })),
    })),
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

  /* Notes on a client, each with a heading. #278. */

  /** `{ heading, body }`. Anybody with a role's. */
  routes.post(
    '/clients/clients/:id/notes',
    answer(
      async (request, response) =>
        noteAsJson(await clients.addNote(actorOf(response), idOf(request), request.body)),
      201,
    ),
  );

  /** `{ heading?, body? }`: only what is present changes. Its writer's or a BD manager's. */
  routes.patch(
    '/clients/notes/:id',
    answer(async (request, response) =>
      noteAsJson(await clients.changeNote(actorOf(response), idOf(request), request.body)),
    ),
  );

  /** Folded away, and kept. */
  routes.post(
    '/clients/notes/:id/archive',
    answer(async (request, response) =>
      noteAsJson(await clients.archiveNote(actorOf(response), idOf(request), true)),
    ),
  );

  routes.post(
    '/clients/notes/:id/restore',
    answer(async (request, response) =>
      noteAsJson(await clients.archiveNote(actorOf(response), idOf(request), false)),
    ),
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

/**
 * A deal's stage, under `/clients/opportunities/:id`. #278, Clients SRS CLI 18 to CLI 26, TDD 11.
 */
function stageRoutes(routes: Router, stages: StageService): void {
  /**
   * `{ toStage, note? }`: moves the deal, forward by one stage or more, or back with a note
   * before its contract is signed. Its owner's or a BD manager's, while it is open. Live wins it.
   */
  routes.post(
    '/clients/opportunities/:id/stage',
    answer(async (request, response) =>
      opportunityAsJson(await stages.move(actorOf(response), idOf(request), request.body)),
    ),
  );

  /**
   * `{ reasonId, note? }`: marks the deal lost, where it stands, for a reason from the lost list.
   * Its owner's or a BD manager's, while it is open and its POC has not started. #279, CLI 51.
   */
  routes.post(
    '/clients/opportunities/:id/lose',
    answer(async (request, response) =>
      opportunityAsJson(await stages.lose(actorOf(response), idOf(request), request.body)),
    ),
  );

  /** The reasons a deal may be lost or a POC exited for now, on each list. #279, CLI 54. */
  routes.get(
    '/clients/reasons',
    answer((_request, response) => stages.reasons(actorOf(response))),
  );

  /** Every stage it has been at, newest first, with who moved it, when, and any note. */
  routes.get(
    '/clients/opportunities/:id/stages',
    answer(async (request, response) => ({
      stages: (await stages.stages(actorOf(response), idOf(request))).map((change) => ({
        ...change,
        changedAt: change.changedAt.toISOString(),
      })),
    })),
  );
}

/**
 * Activities and next steps, under `/clients/activities` and `/clients/next-steps`. #280,
 * Clients SRS CLI 58 to CLI 64, TDD 11.
 */
function activityRoutes(routes: Router, activities: ActivityService): void {
  /**
   * `{ clientId, opportunityId?, kind, happenedOn, withWhom?, outcome?, nextStep?: { description,
   * dueOn, ownerId? } }`: logs it, and the next step with it where one is given, whose is the
   * client owner's unless somebody else is named. Anybody with a role's, at any client (CLI 60).
   */
  routes.post(
    '/clients/activities',
    answer(
      async (request, response) =>
        loggedAsJson(await activities.log(actorOf(response), request.body)),
      201,
    ),
  );

  /**
   * `{ opportunityId?, kind?, happenedOn?, withWhom?, outcome? }`: only what is present changes,
   * and null takes an optional field away. Whoever logged it, within 24 hours (CLI 62).
   */
  /**
   * `{ clientId, opportunityId?, description, dueOn, ownerId? }`: a next step on its own, whose is
   * the client owner's unless somebody else holding a role is named (CLI 63).
   */
  routes.post(
    '/clients/next-steps',
    answer(
      async (request, response) =>
        nextStepAsJson(await activities.addStep(actorOf(response), request.body)),
      201,
    ),
  );

  /** Closes it. Its owner's alone (CLI 64). */
  routes.post(
    '/clients/next-steps/:id/done',
    answer(async (request, response) =>
      nextStepAsJson(await activities.closeStep(actorOf(response), idOf(request))),
    ),
  );

  /** Opens a closed one again. Its owner's or a BD manager's (#280). */
  routes.post(
    '/clients/next-steps/:id/reopen',
    answer(async (request, response) =>
      nextStepAsJson(await activities.reopenStep(actorOf(response), idOf(request))),
    ),
  );

  routes.patch(
    '/clients/activities/:id',
    answer(async (request, response) =>
      activityAsJson(await activities.correct(actorOf(response), idOf(request), request.body)),
    ),
  );

  /**
   * Past proposals and financials, `?type=&product=&kind=`, the latest first, each with its files
   * to open as a starting point (CLI 66, TDD 11, #281).
   */
  routes.get(
    '/clients/proposals',
    answer(async (request, response) => ({
      proposals: await activities.pastProposals(
        actorOf(response),
        request.query as Record<string, unknown>,
      ),
    })),
  );
}

/**
 * Documents, under the activity or deal they go on, and a client's all together. #281, CLI 67.
 *
 * **The body is the file.** One file a call, sent as its bytes with its name in `X-Filename`,
 * percent encoded since a header is Latin-1 and a name is not: as leave's attachments are, rather
 * than TDD 11's multipart, which would be a second parser to agree with the limit and a new
 * dependency (TDD 2.2). The `Content-Type` sent says nothing about what the file is (CLI 69).
 */
function documentRoutes(routes: Router, documents: DocumentService): void {
  routes.post(
    '/clients/activities/:id/documents',
    rawUpload,
    answer(
      async (request, response) =>
        documentAsJson(
          await documents.attachToActivity(actorOf(response), idOf(request), uploadIn(request)),
        ),
      201,
    ),
  );

  routes.post(
    '/clients/opportunities/:id/documents',
    rawUpload,
    answer(
      async (request, response) =>
        documentAsJson(
          await documents.attachToDeal(actorOf(response), idOf(request), uploadIn(request)),
        ),
      201,
    ),
  );

  /**
   * The file itself, after asking on this request whether the person may have it. TDD 11, NFR
   * CLI SEC 03.
   *
   * A 302 to a signed address straight to the file where storage mints one: it expires in
   * minutes, names one object, and is no use to anybody once it has. Otherwise the bytes, sent so
   * nothing a browser renders can be served from this origin. Neither is kept by the browser on
   * the way, and neither leaves this address in a referrer.
   */
  routes.get(
    '/clients/documents/:id/download',
    (request: Request, response: Response, next: NextFunction) => {
      void documents
        .download(actorOf(response), idOf(request))
        .then((found) => {
          response.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');

          if ('url' in found) {
            response.status(302).location(found.url).end();
            return;
          }

          response
            .status(200)
            .set('Content-Type', 'application/octet-stream')
            .set('X-Content-Type-Options', 'nosniff')
            .set('X-Document-Content-Type', found.document.contentType)
            .set('Content-Disposition', dispositionFor(found.document.filename))
            .send(found.content);
        })
        .catch(next);
    },
  );

  /**
   * Takes a file off again: whoever attached it, within a day (#281). A POST rather than a DELETE,
   * because nothing is deleted but the bytes: the document stays on the record, saying who took it
   * off and when (CLI 57).
   */
  routes.post(
    '/clients/documents/:id/remove',
    answer(async (request, response) =>
      documentAsJson(await documents.remove(actorOf(response), idOf(request))),
    ),
  );

  /** Every document at a client, on its activities and its deals, the latest first. */
  routes.get(
    '/clients/clients/:id/documents',
    answer(async (request, response) => ({
      documents: (await documents.ofClient(actorOf(response), idOf(request))).map(documentAsJson),
    })),
  );
}

/**
 * The file's bytes, up to the 50 MB a document may be. A body over it is refused by the parser
 * before any route sees it, and is answered here with clients' own limit rather than leave's.
 */
function rawUpload(request: Request, response: Response, next: NextFunction): void {
  express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES })(request, response, (error) => {
    if ((error as { type?: unknown } | undefined)?.type === 'entity.too.large') {
      next(new DocumentTooLarge(Number((error as { length?: unknown }).length) || 0));
      return;
    }
    next(error);
  });
}

function uploadIn(request: Request): UploadedDocument {
  const sent = request.get('x-filename') ?? '';
  let filename: string;

  try {
    filename = decodeURIComponent(sent);
  } catch {
    filename = sent;
  }

  return {
    filename,
    content: request.body,
    claimedContentType: request.get('content-type') ?? '',
  };
}

/**
 * `Content-Disposition` with the name in both forms, as leave's: an ASCII one for clients that
 * read only that, and `filename*` for what it was actually called. RFC 6266.
 */
function dispositionFor(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Storage's key stays on the server (CLI 68), and whether it may be opened is worked out here. */
function documentAsJson(document: DocumentView): unknown {
  return {
    id: document.id,
    clientId: document.clientId,
    activityId: document.activityId,
    opportunityId: document.opportunityId,
    on: document.on,
    filename: document.filename,
    contentType: document.contentType,
    sizeBytes: document.sizeBytes,
    checksumSha256: document.checksumSha256,
    scanStatus: document.scanStatus,
    downloadable: downloadable(document),
    uploadedBy: document.uploadedBy,
    uploadedAt: document.uploadedAt.toISOString(),
    /** #281. Taken off by whoever attached it: the bytes gone, this kept. */
    removed:
      document.removed === null
        ? null
        : { at: document.removed.at.toISOString(), by: document.removed.by },
    may: document.may,
  };
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
    notes: client.notes.map(noteAsJson),
  };
}

/** Every field present, a missing one as null, so the screen shows it as missing (CLI 06). */
function opportunityAsJson(opportunity: Opportunity): unknown {
  return { ...opportunity, createdAt: opportunity.createdAt.toISOString() };
}

function noteAsJson(note: ClientNote): unknown {
  return {
    ...note,
    writtenAt: note.writtenAt.toISOString(),
    editedAt: note.editedAt?.toISOString() ?? null,
    archivedAt: note.archivedAt?.toISOString() ?? null,
  };
}

function loggedAsJson(logged: Logged): unknown {
  return {
    activity: activityAsJson(logged.activity),
    nextStep: logged.nextStep === null ? null : nextStepAsJson(logged.nextStep),
  };
}

function activityAsJson(activity: LoggedActivity): unknown {
  return { ...activity, loggedAt: activity.loggedAt.toISOString() };
}

function nextStepAsJson(step: NextStep): unknown {
  return {
    ...step,
    done: step.done === null ? null : { ...step.done, at: step.done.at.toISOString() },
    createdAt: step.createdAt.toISOString(),
  };
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
