/**
 * Opportunities, which the screen calls deals. #277, Clients SRS CLI 10 to CLI 17.
 *
 * Every method asks `clientsPolicy` first, before reading the request or looking anything up, so
 * somebody refused learns nothing from what they sent. Stages and outcomes are not changed here:
 * that is the stage service's alone (TDD 3, #278).
 */

import type { Actor } from '../../core/auth/actor.js';
import type { Guard } from '../../core/auth/policy.js';
import { accessOf } from './access.js';
import type { ClientsClientRepository } from './client.db.js';
import {
  type DealView,
  InvalidOpportunity,
  type Opportunity,
  OpportunityAlreadyOpen,
  OpportunityEnded,
  OpportunityNotFound,
  readNewOpportunity,
  readOpportunityChange,
  type ValueChange,
} from './opportunity.js';
import {
  AlreadyOpen,
  type ClientsOpportunityRepository,
  Ended,
  ProductRetired,
} from './opportunity.db.js';
import { type ClientsAccess, clientsPolicy } from './policy.js';
import { isAnId } from './product.js';
import type { ClientsProductInUseRepository } from './product-in-use.db.js';
import type { ClientsRoleRepository } from './role.db.js';

export class OpportunityService {
  constructor(
    private readonly guard: Guard,
    private readonly grants: Pick<ClientsRoleRepository, 'rolesOf'>,
    private readonly clients: Pick<ClientsClientRepository, 'find'>,
    /** Whether a product exists, and is retired. */
    private readonly products: Pick<ClientsProductInUseRepository, 'product'>,
    private readonly opportunities: ClientsOpportunityRepository,
  ) {}

  /**
   * Opens a deal for a client and a product, owned by whoever opens it (CLI 12). Anybody with a
   * clients role may, at any client: an associate owns what they open, as a BD manager does. An
   * owner named in the request is not read; moving a deal is a BD manager's, later (CLI 92).
   *
   * A client has one open deal per product (CLI 11), and a retired product takes none (CLI 08).
   * The database holds both; this turns its refusal into a sentence that names what is in the way.
   */
  async create(actor: Actor, body: unknown): Promise<DealView> {
    const access = await this.accessOf(actor);
    this.guard.enforce(clientsPolicy.contribute(actor, access, 'createDeal'));

    /* The policy allows only somebody holding a role, who is always a person. */
    const ownerId = actor.employeeId;
    if (ownerId === null) {
      throw new Error('A deal was opened by nobody.');
    }

    const deal = readNewOpportunity(body);
    const [client, product] = await Promise.all([
      this.clients.find(deal.clientId),
      this.products.product(deal.productId),
    ]);

    if (client === undefined) {
      throw new InvalidOpportunity(
        'clientId',
        'No client matches that. Refresh the page to see the clients as they are now.',
      );
    }
    if (product === undefined) {
      throw new InvalidOpportunity('productId', 'Choose the product the deal is for.');
    }
    if (product.retired) {
      throw retired(product.name);
    }

    let id: string;
    try {
      id = await this.opportunities.create(actor, deal, ownerId);
    } catch (error) {
      if (error instanceof AlreadyOpen) throw new OpportunityAlreadyOpen(client.name, product.name);
      /* Retired between the look and the write. */
      if (error instanceof ProductRetired) throw retired(product.name);
      throw error;
    }

    return viewOf(actor, access, await this.opportunityOrRefuse(id));
  }

  /** One deal, and what the person asking may do to it. Anybody with a role's (CLI 90). */
  async find(actor: Actor, id: string): Promise<DealView> {
    const access = await this.accessOf(actor);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    return viewOf(actor, access, await this.opportunityOrRefuse(id));
  }

  /**
   * What a deal was worth and how likely to close, each time either changed, newest first: its
   * past values (#277). Anybody with a role's, as the deal itself is (CLI 90).
   */
  async history(actor: Actor, id: string): Promise<ValueChange[]> {
    this.guard.enforce(clientsPolicy.read(actor, await this.accessOf(actor), id));

    await this.opportunityOrRefuse(id);

    return this.opportunities.history(id);
  }

  /**
   * Edits a deal's value, probability, expected close, what it is waiting on and the client's
   * stated interest (CLI 13). Its owner's or a BD manager's; anybody else with a role is told
   * whose it is. Only what the request names changes.
   *
   * Asks whether they may read clients at all before looking the deal up, so that somebody with
   * no role is told nothing about which ids are deals. An ended deal is kept as it ended (CLI 55),
   * which the database holds too.
   */
  async change(actor: Actor, id: string, body: unknown): Promise<DealView> {
    const access = await this.accessOf(actor);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const deal = await this.opportunityOrRefuse(id);
    this.guard.enforce(clientsPolicy.changeDeal(actor, access, deal));

    if (deal.outcome !== 'OPEN') {
      throw new OpportunityEnded(deal.product.name, deal.outcome);
    }

    const change = readOpportunityChange(body);

    try {
      await this.opportunities.change(actor, id, change);
    } catch (error) {
      if (error instanceof Ended) {
        /* Ended between the look and the write: say how, as it is now. */
        const now = await this.opportunityOrRefuse(id);
        throw new OpportunityEnded(now.product.name, now.outcome);
      }
      throw error;
    }

    return viewOf(actor, access, await this.opportunityOrRefuse(id));
  }

  private async opportunityOrRefuse(id: string): Promise<Opportunity> {
    const found = isAnId(id) ? await this.opportunities.find(id) : undefined;

    if (found === undefined) {
      throw new OpportunityNotFound();
    }

    return found;
  }

  private accessOf(actor: Actor) {
    return accessOf(actor, this.grants);
  }
}

/**
 * A deal, with the policy's answers about it for the screen to offer. Editing an ended deal is
 * offered to nobody, since the database refuses it whoever asks.
 */
export function viewOf(actor: Actor, access: ClientsAccess, deal: Opportunity): DealView {
  return {
    ...deal,
    may: {
      change: deal.outcome === 'OPEN' && clientsPolicy.changeDeal(actor, access, deal).allowed,
    },
  };
}

/** A retired product takes no new deals (CLI 08). */
function retired(productName: string): InvalidOpportunity {
  return new InvalidOpportunity(
    'productId',
    `${productName} is retired, so it takes no new deals. Choose another product.`,
  );
}
