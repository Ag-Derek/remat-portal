/**
 * Documents on activities and deals. #281, Clients SRS CLI 67 to CLI 70, TDD 3's ActivityService
 * (documents), TDD 4.6.
 *
 * Every method asks `clientsPolicy` first, before reading the upload or looking anything up, so
 * somebody refused learns nothing from what they sent.
 */

import type { Actor } from '../../core/auth/actor.js';
import type { Guard } from '../../core/auth/policy.js';
import { type ScanResult, type Scanner, ScannerUnavailable } from '../../core/scanning/index.js';
import { sniffContentType } from '../../core/storage/content-type.js';
import type { Storage } from '../../core/storage/index.js';
import { accessOf } from './access.js';
import {
  type ClientDocument,
  type DocumentPlace,
  DocumentFixed,
  DocumentIsInfected,
  DocumentNotFound,
  DocumentNotScanned,
  DocumentRemoved,
  DocumentTypeNotAccepted,
  type DocumentView,
  downloadable,
  stillRemovable,
  isAcceptedType,
  readContent,
  readFilename,
  type UploadedDocument,
} from './document.js';
import type { ClientsDocumentRepository } from './document.db.js';
import { ActivityNotFound } from './logged-activity.js';
import { OpportunityNotFound } from './opportunity.js';
import { type ClientsAccess, clientsPolicy } from './policy.js';
import { isAnId } from './product.js';
import type { ClientsRoleRepository } from './role.db.js';

export class DocumentService {
  constructor(
    private readonly guard: Guard,
    private readonly grants: Pick<ClientsRoleRepository, 'rolesOf'>,
    private readonly documents: ClientsDocumentRepository,
    private readonly storage: Storage,
    private readonly scanner: Scanner,
    /** The moment, against which the day a file may be taken off within runs (#281). */
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Attaches a file to an activity: whoever logged it, at any time (#281). The proposal sent, the
   * financials, the deck shown at a demo.
   */
  async attachToActivity(
    actor: Actor,
    activityId: string,
    upload: UploadedDocument,
  ): Promise<DocumentView> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.contribute(actor, access, 'addDocument'));

    const activity = isAnId(activityId) ? await this.documents.activity(activityId) : undefined;
    if (activity === undefined) {
      throw new ActivityNotFound();
    }
    this.guard.enforce(clientsPolicy.attachToActivity(actor, access, activity));

    return this.viewOf(
      actor,
      access,
      await this.store(
        actor,
        activity.clientId,
        { kind: 'ACTIVITY', activityId: activity.id },
        upload,
      ),
    );
  }

  /**
   * Attaches a file to a deal, open or ended: anybody with a role (CLI 67, #281). A BRD, a
   * configuration sheet, a signed contract.
   */
  async attachToDeal(
    actor: Actor,
    dealId: string,
    upload: UploadedDocument,
  ): Promise<DocumentView> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.contribute(actor, access, 'addDocument'));

    const clientId = isAnId(dealId) ? await this.documents.clientOfDeal(dealId) : undefined;
    if (clientId === undefined) {
      throw new OpportunityNotFound();
    }

    return this.viewOf(
      actor,
      access,
      await this.store(actor, clientId, { kind: 'DEAL', opportunityId: dealId }, upload),
    );
  }

  /**
   * A client's documents, on its activities and its deals, the latest first (CLI 90, CLI 99),
   * those taken off among them, saying so.
   */
  async ofClient(actor: Actor, clientId: string): Promise<DocumentView[]> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, clientId));

    const documents = isAnId(clientId) ? await this.documents.ofClient(clientId) : [];

    return documents.map((document) => this.viewOf(actor, access, document));
  }

  /**
   * Takes a file off again: whoever attached it, within a day of attaching it (#281, the user, 18
   * November 2026). Its bytes are deleted and its row is kept, saying who took it off and when, so
   * no document record is ever deleted (CLI 57). Nothing does this by itself (CLI 70).
   *
   * The row first, then the bytes: were the bytes to go first and the row then be refused, as
   * when the day ran out meanwhile, a document would be left on the record with nothing behind it.
   */
  async remove(actor: Actor, id: string): Promise<DocumentView> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const document = await this.documentOrRefuse(id);
    this.guard.enforce(clientsPolicy.removeDocument(actor, access, document));

    if (document.removed !== null) {
      throw new DocumentRemoved(document.removed.by.name);
    }
    if (!stillRemovable(document.uploadedAt, this.now())) {
      throw new DocumentFixed();
    }

    await this.documents.remove(actor, document.id);
    await this.storage.delete(document.storageKey);

    return this.viewOf(actor, access, await this.documentOrRefuse(id));
  }

  /**
   * A document, to be opened: anybody with a role may, any document (CLI 90), and only once the
   * scanner has cleared it (CLI 68, NFR CLI SEC 03).
   *
   * Asked on every request, so a link is never handed to somebody who has since lost their role.
   * Where storage mints one, the answer is a short lived signed address straight to the file,
   * saved under its own name, and nothing in the database or the browser outlives it. Where it
   * does not, the local driver of development and tests, the bytes themselves.
   *
   * Not recorded: reads are not audited in clients (NFR CLI AUD 03).
   */
  async download(
    actor: Actor,
    id: string,
  ): Promise<
    { document: ClientDocument; url: string } | { document: ClientDocument; content: Buffer }
  > {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const document = await this.documentOrRefuse(id);
    if (document.removed !== null) {
      throw new DocumentRemoved(document.removed.by.name);
    }
    if (!downloadable(document)) {
      throw new DocumentNotScanned();
    }

    const url = await this.storage.linkTo(document.storageKey, document.filename);

    return url === undefined
      ? { document, content: await this.storage.get(document.storageKey) }
      : { document, url };
  }

  /**
   * Everything an upload is. In this order, each refused before the next costs anything: its
   * name, its size, what its bytes are (CLI 69), then the scan. Nothing is stored or written until
   * all of those pass, and an infected file is refused outright. A scanner that cannot be reached
   * leaves the file kept but PENDING, which nobody may open.
   */
  private async store(
    actor: Actor,
    clientId: string,
    place: DocumentPlace,
    upload: UploadedDocument,
  ): Promise<ClientDocument> {
    const filename = readFilename(upload.filename);
    const content = readContent(upload.content);

    const contentType = sniffContentType(content);
    if (!isAcceptedType(contentType)) {
      throw new DocumentTypeNotAccepted();
    }

    const scan = await this.scan(content);
    if (scan?.verdict === 'INFECTED') {
      throw new DocumentIsInfected(scan.signature);
    }

    const stored = await this.storage.put(content);

    try {
      const id = await this.documents.add(actor, {
        clientId,
        place,
        filename,
        contentType,
        sizeBytes: stored.size,
        checksumSha256: stored.checksumSha256,
        storageKey: stored.key,
        scanStatus: scan === null ? 'PENDING' : 'CLEAN',
        scannedBy: scan?.scannedBy ?? null,
      });
      const document = await this.documents.find(id);

      if (document === undefined) {
        throw new Error(`Document ${id} was written and then not found.`);
      }

      return document;
    } catch (error) {
      /* Bytes nothing names, removed here rather than left in the bucket. */
      await this.storage.delete(stored.key);
      throw error;
    }
  }

  private async documentOrRefuse(id: string): Promise<ClientDocument> {
    const document = isAnId(id) ? await this.documents.find(id) : undefined;
    if (document === undefined) {
      throw new DocumentNotFound();
    }

    return document;
  }

  /**
   * A document as this person reads it: whether they may take it off, which is whoever attached it,
   * while it is on, and within its day.
   */
  private viewOf(actor: Actor, access: ClientsAccess, document: ClientDocument): DocumentView {
    return {
      ...document,
      may: {
        remove:
          document.removed === null &&
          stillRemovable(document.uploadedAt, this.now()) &&
          clientsPolicy.removeDocument(actor, access, document).allowed,
      },
    };
  }

  private async scan(content: Buffer): Promise<ScanResult | null> {
    try {
      return await this.scanner.scan(content);
    } catch (error) {
      if (error instanceof ScannerUnavailable) {
        return null;
      }
      throw error;
    }
  }
}
