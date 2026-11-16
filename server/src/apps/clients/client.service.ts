/**
 * Clients, their contacts and the products they use. #276, Clients SRS CLI 02 to CLI 05. A
 * client's page lists its deals too (#277), which are opened through OpportunityService.
 *
 * Every method asks `clientsPolicy` first, before reading the request or looking anything up, so
 * somebody refused learns nothing from what they sent.
 */

import type { Actor } from '../../core/auth/actor.js';
import type { Guard } from '../../core/auth/policy.js';
import { currentDate } from '../../core/calendar/time.js';
import { accessOf } from './access.js';
import {
  type Client,
  ClientNotFound,
  type ClientPermissions,
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

export class ClientService {
  constructor(
    private readonly guard: Guard,
    private readonly grants: Pick<ClientsRoleRepository, 'rolesOf'>,
    private readonly clients: ClientsClientRepository,
    private readonly contacts: ClientsContactRepository,
    private readonly productsInUse: ClientsProductInUseRepository,
    /** #277. A client's deals, which its page lists. */
    private readonly opportunities: Pick<ClientsOpportunityRepository, 'of'>,
  ) {}

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
      await this.mustHoldARole(change.ownerId);
    }

    await this.clients.change(actor, id, change);

    return this.clientOrRefuse(id);
  }

  /** Every client by name: the clients list. Anybody with a role's (CLI 90). */
  async list(actor: Actor): Promise<ClientSummary[]> {
    this.guard.enforce(clientsPolicy.read(actor, await this.accessOf(actor)));

    return this.clients.list();
  }

  /** The products that may be added to a client, by line. Anybody with a role's. */
  async offeredProducts(actor: Actor) {
    this.guard.enforce(clientsPolicy.read(actor, await this.accessOf(actor)));

    return this.productsInUse.offered();
  }

  /** Everybody holding a clients role, whom a BD manager may move a client to. */
  async holders(actor: Actor): Promise<Person[]> {
    this.guard.enforce(clientsPolicy.read(actor, await this.accessOf(actor)));

    return this.clients.holders();
  }

  /**
   * One client, by id, with its contacts and products, and what the person asking may do to it:
   * the policy's answers, for the screen to offer only those.
   */
  async page(
    actor: Actor,
    id: string,
  ): Promise<{ client: Client & { opportunities: DealView[] }; may: ClientPermissions }> {
    const access = await this.accessOf(actor);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const client = await this.clientOrRefuse(id);

    return {
      client: {
        ...client,
        /* Each with what the person reading may do to it, for the page to offer. #277. */
        opportunities: client.opportunities.map((deal) => viewOf(actor, access, deal)),
      },
      may: {
        change: clientsPolicy.changeClient(actor, access, client).allowed,
        reassign: clientsPolicy.reassign(actor, access, 'client', id).allowed,
        contribute: clientsPolicy.contribute(actor, access, 'addContact').allowed,
      },
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
  private async mustHoldARole(employeeId: string): Promise<void> {
    if ((await this.grants.rolesOf(employeeId)).length === 0) {
      throw new InvalidClient(
        'ownerId',
        'Whoever looks after a client needs a role in clients. Choose somebody who has one.',
      );
    }
  }

  private async clientOrRefuse(id: string): Promise<Client> {
    const client = isAnId(id) ? await this.clients.find(id) : undefined;

    if (client === undefined) {
      throw new ClientNotFound();
    }

    const [contacts, products, opportunities] = await Promise.all([
      this.contacts.of(id),
      this.productsInUse.of(id),
      this.opportunities.of(id),
    ]);

    return { ...client, contacts, products, opportunities };
  }
}
