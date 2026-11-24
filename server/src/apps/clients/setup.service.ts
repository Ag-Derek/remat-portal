/**
 * Products and lines, client types, and the lost and exit reasons, kept by a BD manager. #293,
 * #276, #279, Clients SRS CLI 07, CLI 08, CLI 54, TDD 3.
 *
 * Every method asks `clientsPolicy.setUp` first, before reading the request or looking anything
 * up, so somebody refused learns nothing from what they sent. The checklists too (#284, CLI 39 to
 * CLI 42): the template deals and POCs are given copies of.
 */

import type { Actor } from '../../core/auth/actor.js';
import type { Guard } from '../../core/auth/policy.js';
import { currentDate } from '../../core/calendar/time.js';
import { accessOf } from './access.js';
import { type ClientType, ClientTypeNotFound, readClientTypeName } from './client.js';
import type { ClientsClientRepository } from './client.db.js';
import { clientsPolicy } from './policy.js';
import {
  ClientsLineNotFound,
  ClientsLineRetired,
  ClientsProductNotFound,
  isAnId,
  type Product,
  type ProductLine,
  readLineId,
  readName,
} from './product.js';
import type { ClientsProductRepository } from './product.db.js';
import {
  type ReasonInSetup,
  ReasonInUse,
  ReasonNotFound,
  readNewReason,
  readReasonLabel,
} from './reason.js';
import type { ClientsReasonRepository } from './reason.db.js';
import {
  type ChecklistItem,
  ChecklistItemNotFound,
  InvalidChecklistItem,
  readChecklistItemChange,
  readCopyFrom,
  readDirection,
  readNewChecklistItem,
  readWhichChecklist,
} from './checklist.js';
import type { ClientsChecklistItemRepository, WhichChecklist } from './checklist-item.db.js';
import type { ClientsRoleRepository } from './role.db.js';

export class SetupService {
  constructor(
    private readonly guard: Guard,
    private readonly grants: Pick<ClientsRoleRepository, 'rolesOf'>,
    private readonly products: ClientsProductRepository,
    /** #276. The kinds of institution a client may be. */
    private readonly clientTypesFrom: Pick<
      ClientsClientRepository,
      'types' | 'findType' | 'addType' | 'renameType' | 'retireType' | 'restoreType'
    >,
    /** #279. Why deals are lost and POCs exited. */
    private readonly reasons: Pick<
      ClientsReasonRepository,
      'inSetup' | 'find' | 'add' | 'reword' | 'retire' | 'restore' | 'delete'
    >,
    /** #284. The checklists deals and POCs are judged by copies of. */
    private readonly checklists: ClientsChecklistItemRepository,
  ) {}

  /** Every line and its products, retired ones included and marked. */
  async lines(actor: Actor): Promise<ProductLine[]> {
    await this.mustSetUp(actor);

    return this.products.lines();
  }

  async addLine(actor: Actor, body: unknown): Promise<ProductLine> {
    await this.mustSetUp(actor);

    return this.products.addLine(actor, readName(body, 'line'));
  }

  /** Adds a product to a line that is taking deals. */
  async addProduct(actor: Actor, body: unknown): Promise<Product> {
    await this.mustSetUp(actor);

    const name = readName(body, 'product');
    const line = await this.lineOrRefuse(readLineId(body));

    if (line.retiredOn !== null) {
      throw new ClientsLineRetired(line.name, 'add');
    }

    return this.products.addProduct(actor, line.id, name);
  }

  async renameLine(actor: Actor, id: string, body: unknown): Promise<void> {
    await this.mustSetUp(actor);

    const name = readName(body, 'line');
    await this.lineOrRefuse(id);
    await this.products.renameLine(actor, id, name);
  }

  async renameProduct(actor: Actor, id: string, body: unknown): Promise<void> {
    await this.mustSetUp(actor);

    const name = readName(body, 'product');
    await this.productOrRefuse(id);
    await this.products.renameProduct(actor, id, name);
  }

  /** Retires a line, and every product in it, today. */
  async retireLine(actor: Actor, id: string): Promise<void> {
    await this.mustSetUp(actor);
    await this.lineOrRefuse(id);

    await this.products.retireLine(actor, id, currentDate());
  }

  async retireProduct(actor: Actor, id: string): Promise<void> {
    await this.mustSetUp(actor);
    await this.productOrRefuse(id);

    await this.products.retireProduct(actor, id, currentDate());
  }

  /** Brings a line back to taking deals. Its products are restored one by one. */
  async restoreLine(actor: Actor, id: string): Promise<void> {
    await this.mustSetUp(actor);
    await this.lineOrRefuse(id);

    await this.products.restoreLine(actor, id);
  }

  /** Brings a product back, into a line that is itself taking deals. */
  async restoreProduct(actor: Actor, id: string): Promise<void> {
    await this.mustSetUp(actor);

    const product = await this.productOrRefuse(id);
    const line = await this.lineOrRefuse(product.lineId);

    if (line.retiredOn !== null) {
      throw new ClientsLineRetired(line.name, 'restore');
    }

    await this.products.restoreProduct(actor, id);
  }

  /* ------------------------------------------------------------------ client types, #276 */

  /** Every client type, retired ones included and marked. */
  async clientTypes(actor: Actor): Promise<ClientType[]> {
    await this.mustSetUp(actor);

    return this.clientTypesFrom.types();
  }

  /** A kind of institution the department starts selling to. */
  async addClientType(actor: Actor, body: unknown): Promise<ClientType> {
    await this.mustSetUp(actor);

    return this.clientTypesFrom.addType(actor, readClientTypeName(body));
  }

  async renameClientType(actor: Actor, id: string, body: unknown): Promise<void> {
    await this.mustSetUp(actor);

    const name = readClientTypeName(body);
    await this.clientTypeOrRefuse(id);
    await this.clientTypesFrom.renameType(actor, id, name);
  }

  /** No longer offered for new clients. A client of it keeps it. */
  async retireClientType(actor: Actor, id: string): Promise<void> {
    await this.mustSetUp(actor);
    await this.clientTypeOrRefuse(id);

    await this.clientTypesFrom.retireType(actor, id, currentDate());
  }

  async restoreClientType(actor: Actor, id: string): Promise<void> {
    await this.mustSetUp(actor);
    await this.clientTypeOrRefuse(id);

    await this.clientTypesFrom.restoreType(actor, id);
  }

  /* ---------------------------------------------------- lost and exit reasons, #279 */

  /** Both lists, retired reasons included and marked, and which a deal has ended for (CLI 54). */
  async reasonLists(actor: Actor): Promise<ReasonInSetup[]> {
    await this.mustSetUp(actor);

    return this.reasons.inSetup();
  }

  /** `{ appliesTo, label }`: a new reason on the lost list or the exit list. */
  async addReason(actor: Actor, body: unknown): Promise<ReasonInSetup> {
    await this.mustSetUp(actor);

    const { appliesTo, label } = readNewReason(body);

    return this.reasons.add(actor, appliesTo, label);
  }

  /**
   * `{ label }`: new words for a reason, while no deal has ended for it. One that a deal has
   * ended for keeps its words, so that the deal still says what it was told (#279); the database
   * refuses it too.
   */
  async rewordReason(actor: Actor, id: string, body: unknown): Promise<void> {
    await this.mustSetUp(actor);

    const label = readReasonLabel(body);
    const reason = await this.reasonOrRefuse(id);
    if (reason.inUse && label !== reason.label) {
      throw new ReasonInUse(reason.label, 'reword');
    }

    await this.reasons.reword(actor, reason, label);
  }

  /** No longer offered for a new loss or exit. The deals that ended for it keep it (CLI 54). */
  async retireReason(actor: Actor, id: string): Promise<void> {
    await this.mustSetUp(actor);
    await this.reasonOrRefuse(id);

    await this.reasons.retire(actor, id, currentDate());
  }

  async restoreReason(actor: Actor, id: string): Promise<void> {
    await this.mustSetUp(actor);
    await this.reasonOrRefuse(id);

    await this.reasons.restore(actor, id);
  }

  /**
   * Gone for good, where no deal has ended for it, a reason added by mistake say. One in use is
   * retired instead (CLI 54); the database refuses it too.
   */
  async deleteReason(actor: Actor, id: string): Promise<void> {
    await this.mustSetUp(actor);

    const reason = await this.reasonOrRefuse(id);
    if (reason.inUse) {
      throw new ReasonInUse(reason.label, 'delete');
    }

    await this.reasons.delete(actor, reason);
  }

  /* ----------------------------------------------------------- checklists, #284 */

  /**
   * One checklist, `{ lineId, clientTypeId }`: its items group by group, retired ones included
   * and marked (CLI 39, CLI 42). None at all is a checklist nobody has written, which every gate
   * passes (CLI 43).
   */
  async checklist(actor: Actor, query: unknown): Promise<ChecklistItem[]> {
    await this.mustSetUp(actor);

    return this.checklists.items(await this.checklistOrRefuse(readWhichChecklist(query)));
  }

  /**
   * `{ lineId, clientTypeId, group, label, pocOnly? }`: a new item at the end of its group. Only
   * a qualification criterion can be for POC deals only (CLI 41).
   */
  async addChecklistItem(actor: Actor, body: unknown): Promise<ChecklistItem> {
    await this.mustSetUp(actor);

    const item = readNewChecklistItem(body);
    await this.checklistOrRefuse(item);

    return this.checklists.add(actor, item);
  }

  /**
   * `{ label?, pocOnly? }`: new words, or for POC deals only or not. Reaches only deals and POCs
   * copied after (CLI 40): every copy already taken keeps what it was copied as.
   */
  async changeChecklistItem(actor: Actor, id: string, body: unknown): Promise<ChecklistItem> {
    await this.mustSetUp(actor);

    const item = await this.checklistItemOrRefuse(id);
    await this.checklists.change(actor, item.id, readChecklistItemChange(body, item.group));

    return this.checklistItemOrRefuse(id);
  }

  /** `{ direction: 'UP' | 'DOWN' }`: one place up or down its group. */
  async moveChecklistItem(actor: Actor, id: string, body: unknown): Promise<void> {
    await this.mustSetUp(actor);

    const direction = readDirection(body);
    await this.checklists.move(actor, await this.checklistItemOrRefuse(id), direction);
  }

  /** Copied onto nothing new from today. Every copy already taken keeps it (CLI 40). */
  async retireChecklistItem(actor: Actor, id: string): Promise<void> {
    await this.mustSetUp(actor);
    await this.checklistItemOrRefuse(id);

    await this.checklists.retire(actor, id, currentDate());
  }

  async restoreChecklistItem(actor: Actor, id: string): Promise<void> {
    await this.mustSetUp(actor);
    await this.checklistItemOrRefuse(id);

    await this.checklists.restore(actor, id);
  }

  /**
   * `{ lineId, clientTypeId, fromLineId, fromClientTypeId }`: fills an empty checklist with a
   * copy of another's items in use, each then its own to change (the user, 24 November 2026).
   * Answers with the checklist filled.
   */
  async copyChecklist(actor: Actor, body: unknown): Promise<ChecklistItem[]> {
    await this.mustSetUp(actor);

    const into = await this.checklistOrRefuse(readWhichChecklist(body));
    const from = await this.checklistOrRefuse(readCopyFrom(body));
    if (from.lineId === into.lineId && from.clientTypeId === into.clientTypeId) {
      throw new InvalidChecklistItem('fromClientTypeId', 'Choose another checklist to copy from.');
    }

    await this.checklists.copy(actor, into, from);

    return this.checklists.items(into);
  }

  /** The checklist asked for, where its line and client type both exist. */
  private async checklistOrRefuse(which: WhichChecklist): Promise<WhichChecklist> {
    await this.lineOrRefuse(which.lineId);
    await this.clientTypeOrRefuse(which.clientTypeId);

    return { lineId: which.lineId, clientTypeId: which.clientTypeId };
  }

  private async checklistItemOrRefuse(id: string): Promise<ChecklistItem> {
    const item = isAnId(id) ? await this.checklists.find(id) : undefined;

    if (item === undefined) {
      throw new ChecklistItemNotFound();
    }

    return item;
  }

  private async reasonOrRefuse(id: string): Promise<ReasonInSetup> {
    const reason = isAnId(id) ? await this.reasons.find(id) : undefined;

    if (reason === undefined) {
      throw new ReasonNotFound();
    }

    return reason;
  }

  private async clientTypeOrRefuse(id: string): Promise<ClientType> {
    const type = isAnId(id) ? await this.clientTypesFrom.findType(id) : undefined;

    if (type === undefined) {
      throw new ClientTypeNotFound();
    }

    return type;
  }

  private async mustSetUp(actor: Actor): Promise<void> {
    this.guard.enforce(clientsPolicy.setUp(actor, await accessOf(actor, this.grants)));
  }

  private async lineOrRefuse(id: string): Promise<ProductLine> {
    const line = isAnId(id) ? await this.products.findLine(id) : undefined;

    if (line === undefined) {
      throw new ClientsLineNotFound();
    }

    return line;
  }

  private async productOrRefuse(id: string): Promise<Product> {
    const product = isAnId(id) ? await this.products.findProduct(id) : undefined;

    if (product === undefined) {
      throw new ClientsProductNotFound();
    }

    return product;
  }
}
