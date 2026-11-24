/**
 * Clients, their contacts and the products they use. #276, Clients SRS CLI 02 to CLI 05. A
 * client's page lists its deals too (#277), which are opened through OpportunityService.
 *
 * Every method asks `clientsPolicy` first, before reading the request or looking anything up, so
 * somebody refused learns nothing from what they sent.
 */

import type { Actor } from '../../core/auth/actor.js';
import type { Guard } from '../../core/auth/policy.js';
import { type CalendarDate, currentDate } from '../../core/calendar/time.js';
import { accessOf } from './access.js';
import { type Activity, type LoggedEntry, newestFirst } from './activity.js';
import type { ClientsActivityRepository } from './activity.db.js';
import { viewOfStep } from './activity.service.js';
import { type LoggedActivity, stillCorrectable } from './logged-activity.js';
import type { NextStepView } from './next-step.js';
import {
  type Client,
  ClientNotFound,
  type ClientPermissions,
  type ClientAtAGlance,
  type ClientSummary,
  type ClientType,
  type Person,
  InvalidClient,
  readClientChange,
  readNewClient,
} from './client.js';
import type { ClientsClientRepository } from './client.db.js';
import {
  type Contact,
  ContactNotFound,
  ContactRemoved,
  readContactChange,
  readNewContact,
} from './contact.js';
import type { ClientsContactRepository } from './contact.db.js';
import type { DealView } from './opportunity.js';
import type { ClientsOpportunityRepository } from './opportunity.db.js';
import {
  type ClientNote,
  NoteArchived,
  NoteNotFound,
  type NoteView,
  readNewNote,
  readNoteChange,
} from './note.js';
import type { ClientsNoteRepository } from './note.db.js';
import {
  choicesOf,
  type CompanyPipeline,
  filtered,
  type PipelineDeal,
  type PipelineEntry,
  readPipelineFilters,
  totalsOf,
  weightedOf,
} from './pipeline.js';
import { type ClientsAccess } from './policy.js';
import { viewOf } from './opportunity.service.js';
import { clientsPolicy } from './policy.js';
import { isAnId } from './product.js';
import {
  InvalidProductInUse,
  mustEndAfterItStarts,
  ProductAlreadyInUse,
  type ProductInUse,
  ProductInUseNotFound,
  readNewProductInUse,
  readProductInUseChange,
} from './product-in-use.js';
import { AlreadyThere, type ClientsProductInUseRepository } from './product-in-use.db.js';
import type { ClientsRoleRepository } from './role.db.js';
import { CANNOT_TAKE_OVER, canTakeOver, type ClientsStandings, type Standing } from './standing.js';

export class ClientService {
  constructor(
    private readonly guard: Guard,
    private readonly grants: Pick<ClientsRoleRepository, 'rolesOf'>,
    private readonly clients: ClientsClientRepository,
    private readonly contacts: ClientsContactRepository,
    private readonly productsInUse: ClientsProductInUseRepository,
    /** #277. A client's deals, which its page lists, and what has happened to them (#278). */
    private readonly opportunities: Pick<
      ClientsOpportunityRepository,
      'of' | 'activityOf' | 'pipeline' | 'companyPipeline'
    >,
    /** #278. Its notes, each with a heading. */
    private readonly notes: ClientsNoteRepository,
    /** #280. What has been logged there, and its next steps. */
    private readonly activities: Pick<ClientsActivityRepository, 'activitiesOf' | 'stepsOf'>,
    /** #289. Whose things need a new owner, because they left or hold no role (CLI 96). */
    private readonly standings: Pick<ClientsStandings, 'of'>,
    /** The company's today, against which a next step is overdue (CLI 64). */
    private readonly today: () => CalendarDate = () => currentDate(),
    /** The moment, against which an activity's 24 hours to be corrected run (CLI 62). */
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Adds a note to a client: a heading and the note. Anybody with a role's, at any client, as a
   * contact is (#278). Whoever adds it wrote it.
   */
  async addNote(actor: Actor, clientId: string, body: unknown): Promise<NoteView> {
    const access = await this.accessOf(actor);
    this.guard.enforce(clientsPolicy.contribute(actor, access, 'addNote'));

    /* The policy allows only somebody holding a role, who is always a person. */
    if (actor.employeeId === null) {
      throw new Error('A note was written by nobody.');
    }

    await this.clientOrRefuse(clientId);
    const note = readNewNote(body);
    const id = await this.notes.add(actor, clientId, note, actor.employeeId);

    return noteViewOf(actor, access, await this.noteOrRefuse(id));
  }

  /** Changes a note's heading or words. Whoever wrote it, or a BD manager; not while archived. */
  async changeNote(actor: Actor, id: string, body: unknown): Promise<NoteView> {
    const access = await this.accessOf(actor);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const note = await this.noteOrRefuse(id);
    this.guard.enforce(clientsPolicy.changeNote(actor, access, note));

    if (note.archivedAt !== null) {
      throw new NoteArchived();
    }

    await this.notes.change(actor, id, readNoteChange(body));

    return noteViewOf(actor, access, await this.noteOrRefuse(id));
  }

  /** Archives a note, or brings one back. Whoever wrote it, or a BD manager. Nothing is deleted. */
  async archiveNote(actor: Actor, id: string, archived: boolean): Promise<NoteView> {
    const access = await this.accessOf(actor);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const note = await this.noteOrRefuse(id);
    this.guard.enforce(clientsPolicy.changeNote(actor, access, note));

    await this.notes.archive(actor, id, archived);

    return noteViewOf(actor, access, await this.noteOrRefuse(id));
  }

  /**
   * Everything that has happened at a client, newest first by the day it happened: what happened
   * to its deals, each entry naming its deal (#278), and every activity logged there (#280), each
   * with whether the person reading may still correct it. The page's Activity section (CLI 99).
   * Anybody with a role's, as the client is (CLI 90).
   */
  async activity(actor: Actor, id: string): Promise<Activity[]> {
    const access = await this.accessOf(actor);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    await this.clientOrRefuse(id);

    const [deals, logged] = await Promise.all([
      this.opportunities.activityOf(id),
      this.activities.activitiesOf(id),
    ]);
    const now = this.now();

    return newestFirst([
      ...deals,
      ...logged.map((activity) => loggedEntryOf(actor, access, activity, now)),
    ]);
  }

  /** Every client type, retired ones included and marked, for the form to offer. */
  async types(actor: Actor): Promise<ClientType[]> {
    this.guard.enforce(clientsPolicy.read(actor, await this.accessOf(actor)));

    return this.clients.types();
  }

  /**
   * Records a client, owned by whoever creates it (CLI 05). Anybody with a clients role may; an
   * associate owns what they add, as a BD manager does.
   */
  async create(actor: Actor, body: unknown): Promise<Client> {
    this.guard.enforce(clientsPolicy.contribute(actor, await this.accessOf(actor), 'createClient'));

    /* The policy allows only somebody holding a role, who is always a person. */
    const ownerId = actor.employeeId;
    if (ownerId === null) {
      throw new Error('A client was created by nobody.');
    }

    const client = readNewClient(body);
    await this.mustBeOffered(client.typeId);

    const id = await this.clients.create(actor, client, ownerId);

    return this.clientOrRefuse(id);
  }

  /**
   * Changes a client's name, type or note, which is its owner's or a BD manager's (CLI 05), or
   * its owner, which is a BD manager's alone (CLI 92, #276). The new owner holds a clients role.
   *
   * Asks whether they may read clients at all before looking the client up, so that somebody
   * with no role is told nothing about which ids are clients.
   */
  async change(actor: Actor, id: string, body: unknown): Promise<Client> {
    const access = await this.accessOf(actor);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const client = await this.clientOrRefuse(id);
    this.guard.enforce(clientsPolicy.changeClient(actor, access, client));

    const change = readClientChange(body);

    /* A client already of a retired type keeps it; only a move onto one is refused. */
    if (change.typeId !== undefined && change.typeId !== client.type.id) {
      await this.mustBeOffered(change.typeId);
    }
    if (change.ownerId !== undefined && change.ownerId !== client.owner.id) {
      this.guard.enforce(clientsPolicy.reassign(actor, access, 'client', id));
      await this.mustTakeOver(change.ownerId);
    }

    await this.clients.change(actor, id, change);

    return this.clientOrRefuse(id);
  }

  /**
   * My pipeline: the open deals the person asking owns, soonest next step first, each saying
   * whether that step is overdue (CLI 97, TDD 7). Anybody with a role's, about their own deals.
   */
  async pipeline(actor: Actor): Promise<PipelineEntry[]> {
    this.guard.enforce(clientsPolicy.read(actor, await this.accessOf(actor)));

    /* The policy allows only somebody holding a role, who is always a person. */
    if (actor.employeeId === null) {
      throw new Error('A pipeline was asked for by nobody.');
    }

    return this.asOfToday(await this.opportunities.pipeline(actor.employeeId));
  }

  /**
   * The company pipeline: every open deal the filters leave, whoever owns it, by client A to Z,
   * each with its weighted value, and the figures over them per currency (CLI 76, CLI 98, TDD 7,
   * 8). What each filter offers comes from every open deal. Anybody with a role's, values and
   * probabilities included (CLI 90).
   *
   * Every open deal is read in one query and filtered here: there are under a hundred (TDD 17,
   * item 7), and the choices need them all.
   */
  async companyPipeline(actor: Actor, query: Record<string, unknown>): Promise<CompanyPipeline> {
    this.guard.enforce(clientsPolicy.read(actor, await this.accessOf(actor)));
    const filters = readPipelineFilters(query);

    const every = await this.opportunities.companyPipeline();
    const shown = filtered(every, filters);
    const standings = await this.standings.of(shown.map(({ deal }) => deal.owner.id));

    return {
      deals: this.asOfToday(shown).map((entry) => ({
        ...entry,
        weighted: weightedOf(entry.deal),
        ownerStanding: standings.get(entry.deal.owner.id) ?? null,
      })),
      totals: totalsOf(shown),
      choices: choicesOf(every),
    };
  }

  /** Each deal saying whether its next step is overdue, against the company's today. */
  private asOfToday(deals: PipelineDeal[]): PipelineEntry[] {
    const today = this.today();

    return deals.map((entry) => ({
      ...entry,
      overdue: entry.nextStep !== null && entry.nextStep.dueOn < today,
    }));
  }

  /** Every client by name: the clients list. Anybody with a role's (CLI 90). */
  async list(actor: Actor): Promise<ClientSummary[]> {
    this.guard.enforce(clientsPolicy.read(actor, await this.accessOf(actor)));

    return this.clients.list();
  }

  /**
   * Every client by name, with where it stands, for the search on the company pipeline: those
   * with no open deal too, live, lost, exited or just added (#289). Anybody with a role's (CLI 90).
   */
  async atAGlance(actor: Actor): Promise<ClientAtAGlance[]> {
    this.guard.enforce(clientsPolicy.read(actor, await this.accessOf(actor)));

    return this.clients.atAGlance();
  }

  /** The products that may be added to a client, by line. Anybody with a role's. */
  async offeredProducts(actor: Actor) {
    this.guard.enforce(clientsPolicy.read(actor, await this.accessOf(actor)));

    return this.productsInUse.offered();
  }

  /**
   * Everybody holding a clients role, each saying whether a BD manager may move things to them:
   * whether they are at the company today too (#289). A screen moving something offers only
   * those who can take over; one choosing a next step's owner offers everybody, as before.
   */
  async holders(actor: Actor): Promise<(Person & { canTakeOver: boolean })[]> {
    this.guard.enforce(clientsPolicy.read(actor, await this.accessOf(actor)));

    const people = await this.clients.holders();
    const flagged = await this.standings.of(people.map((person) => person.id));

    return people.map((person) => ({ ...person, canTakeOver: !flagged.has(person.id) }));
  }

  /**
   * One client, by id, with its contacts and products, and what the person asking may do to it:
   * the policy's answers, for the screen to offer only those.
   */
  async page(
    actor: Actor,
    id: string,
  ): Promise<{
    client: Client & { opportunities: DealView[]; notes: NoteView[]; nextSteps: NextStepView[] };
    may: ClientPermissions;
    /** Why its owner can no longer look after it, or null where they can (CLI 96). #289. */
    ownerStanding: Standing | null;
  }> {
    const access = await this.accessOf(actor);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const client = await this.clientOrRefuse(id);
    const [steps, today] = [await this.activities.stepsOf(id), this.today()];
    const standings = await this.standings.of([client.owner.id]);

    return {
      client: {
        ...client,
        /* Each with what the person reading may do to it, for the page to offer. #277. */
        opportunities: client.opportunities.map((deal) => viewOf(actor, access, deal)),
        /* And each note, with whether they may change it. #278. */
        notes: client.notes.map((note) => noteViewOf(actor, access, note)),
        /* Open first, soonest due, each marked overdue or not today; then closed ones. #280. */
        nextSteps: steps.map((step) => viewOfStep(actor, access, step, today)),
      },
      may: {
        change: clientsPolicy.changeClient(actor, access, client).allowed,
        reassign: clientsPolicy.reassign(actor, access, 'client', id).allowed,
        contribute: clientsPolicy.contribute(actor, access, 'addContact').allowed,
      },
      ownerStanding: standings.get(client.owner.id) ?? null,
    };
  }

  /** Adds somebody the department deals with there. Anybody with a role's (CLI 03, CLI 05). */
  async addContact(actor: Actor, clientId: string, body: unknown): Promise<Contact> {
    const access = await this.accessOf(actor);
    this.guard.enforce(clientsPolicy.read(actor, access, clientId));

    await this.clientOrRefuse(clientId);
    this.guard.enforce(clientsPolicy.contribute(actor, access, 'addContact'));

    return this.contacts.add(actor, clientId, readNewContact(body));
  }

  /**
   * Corrects a contact's name, job title, email or phone. Anybody with a role's, not only the
   * client's owner (#276). A removed contact is brought back first.
   */
  async changeContact(actor: Actor, contactId: string, body: unknown): Promise<Contact> {
    const contact = await this.mayEditContact(actor, contactId);

    if (contact.removedAt !== null) {
      throw new ContactRemoved(contact.name);
    }

    await this.contacts.change(actor, contactId, readContactChange(body));

    return this.contactOrRefuse(contactId);
  }

  /** Marks a contact as no longer somebody to deal with there. Kept, and marked removed. */
  async removeContact(actor: Actor, contactId: string): Promise<void> {
    await this.mayEditContact(actor, contactId);
    await this.contacts.remove(actor, contactId);
  }

  async restoreContact(actor: Actor, contactId: string): Promise<void> {
    await this.mayEditContact(actor, contactId);
    await this.contacts.restore(actor, contactId);
  }

  /**
   * Records that a client already uses a product, from a day up to today (CLI 04). Anybody with
   * a role's. A retired product, or one in a retired line, is not added: it takes nothing new.
   */
  async addProductInUse(actor: Actor, clientId: string, body: unknown): Promise<ProductInUse> {
    const access = await this.accessOf(actor);
    this.guard.enforce(clientsPolicy.read(actor, access, clientId));

    const client = await this.clientOrRefuse(clientId);
    this.guard.enforce(clientsPolicy.contribute(actor, access, 'recordProductInUse'));

    const adding = readNewProductInUse(body, currentDate());
    const product = await this.productsInUse.product(adding.productId);

    if (product === undefined) {
      throw new InvalidProductInUse('productId', 'Choose the product the client uses.');
    }
    if (product.retired) {
      throw new InvalidProductInUse(
        'productId',
        `${product.name} is retired, so it is not added to clients any more.`,
      );
    }

    try {
      await this.productsInUse.add(actor, clientId, adding);
    } catch (error) {
      throw error instanceof AlreadyThere
        ? new ProductAlreadyInUse(client.name, product.name)
        : error;
    }

    return this.productInUseOrRefuse(clientId, adding.productId);
  }

  /**
   * Corrects when a client started or stopped using a product. An end date of null says they
   * use it again. Anybody with a role's.
   */
  async changeProductInUse(
    actor: Actor,
    clientId: string,
    productId: string,
    body: unknown,
  ): Promise<ProductInUse> {
    const access = await this.accessOf(actor);
    this.guard.enforce(clientsPolicy.read(actor, access, clientId));

    await this.clientOrRefuse(clientId);
    this.guard.enforce(clientsPolicy.contribute(actor, access, 'recordProductInUse'));

    const existing = await this.productInUseOrRefuse(clientId, productId);
    const change = readProductInUseChange(body, currentDate());

    mustEndAfterItStarts(
      change.sinceOn ?? existing.sinceOn,
      change.endedOn === undefined ? existing.endedOn : change.endedOn,
    );

    await this.productsInUse.change(actor, clientId, productId, change);

    return this.productInUseOrRefuse(clientId, productId);
  }

  private async productInUseOrRefuse(clientId: string, productId: string): Promise<ProductInUse> {
    const found = isAnId(productId)
      ? await this.productsInUse.find(clientId, productId)
      : undefined;

    if (found === undefined) {
      throw new ProductInUseNotFound();
    }

    return found;
  }

  private async mayEditContact(actor: Actor, contactId: string): Promise<Contact> {
    const access = await this.accessOf(actor);
    this.guard.enforce(clientsPolicy.read(actor, access, contactId));

    const contact = await this.contactOrRefuse(contactId);
    this.guard.enforce(clientsPolicy.contribute(actor, access, 'editContact'));

    return contact;
  }

  private async contactOrRefuse(id: string): Promise<Contact> {
    const contact = isAnId(id) ? await this.contacts.find(id) : undefined;

    if (contact === undefined) {
      throw new ContactNotFound();
    }

    return contact;
  }

  private accessOf(actor: Actor) {
    return accessOf(actor, this.grants);
  }

  /** A type that exists and is still offered for new clients. */
  private async mustBeOffered(typeId: string): Promise<void> {
    const type = await this.clients.findType(typeId);

    if (type === undefined) {
      throw new InvalidClient('typeId', 'Choose what kind of institution the client is.');
    }
    if (type.retiredOn !== null) {
      throw new InvalidClient(
        'typeId',
        `${type.name} is no longer offered for new clients. Choose another type.`,
      );
    }
  }

  /**
   * Whoever looks after a client holds a clients role, or it would be owned by somebody who
   * cannot open it.
   */
  /** A client goes only to somebody who would not need replacing themselves (#289). */
  private async mustTakeOver(employeeId: string): Promise<void> {
    if (!(await canTakeOver(this.standings, employeeId))) {
      throw new InvalidClient('ownerId', CANNOT_TAKE_OVER);
    }
  }

  private async clientOrRefuse(id: string): Promise<Client> {
    const client = isAnId(id) ? await this.clients.find(id) : undefined;

    if (client === undefined) {
      throw new ClientNotFound();
    }

    const [contacts, products, opportunities, notes] = await Promise.all([
      this.contacts.of(id),
      this.productsInUse.of(id),
      this.opportunities.of(id),
      this.notes.of(id),
    ]);

    return { ...client, contacts, products, opportunities, notes };
  }

  private async noteOrRefuse(id: string): Promise<ClientNote> {
    const found = isAnId(id) ? await this.notes.find(id) : undefined;

    if (found === undefined) {
      throw new NoteNotFound();
    }

    return found;
  }
}

/** A note, with whether the person reading may change it: its writer or a BD manager. */
function noteViewOf(actor: Actor, access: ClientsAccess, note: ClientNote): NoteView {
  return {
    id: note.id,
    heading: note.heading,
    body: note.body,
    writtenBy: note.writtenBy,
    writtenAt: note.writtenAt,
    editedAt: note.editedAt,
    archivedAt: note.archivedAt,
    may: { change: clientsPolicy.changeNote(actor, access, note).allowed },
  };
}

/**
 * A logged activity as the Activity section lists it, with whether the person reading may still
 * correct it: whoever logged it, within 24 hours of logging it (CLI 62).
 */
function loggedEntryOf(
  actor: Actor,
  access: ClientsAccess,
  activity: LoggedActivity,
  now: Date,
): LoggedEntry {
  return {
    kind: 'LOGGED',
    id: activity.id,
    deal: activity.deal,
    activityKind: activity.kind,
    happenedOn: activity.happenedOn,
    withWhom: activity.withWhom,
    outcome: activity.outcome,
    amount: activity.amount,
    review: activity.review,
    by: activity.loggedBy,
    at: activity.loggedAt,
    may: {
      /* A review meeting is fixed once recorded (#285). */
      correct:
        activity.kind !== 'REVIEW' &&
        stillCorrectable(activity.loggedAt, now) &&
        clientsPolicy.editActivity(actor, access, activity).allowed,
      attach: clientsPolicy.attachToActivity(actor, access, activity).allowed,
    },
  };
}
