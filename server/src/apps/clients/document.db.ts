/**
 * Database access for documents. #281, Clients SRS CLI 67 to CLI 70, TDD 4.6.
 *
 * Written once and never deleted: the table's trigger holds a document to the file it was, but for
 * its virus scan's verdict.
 */

import { type Kysely, sql } from 'kysely';
import type { Attribution } from '../../core/audit/audit.js';
import type { Database } from '../../core/db/index.js';
import { recording } from '../../core/db/recording.js';
import type { CalendarDate } from '../../core/calendar/time.js';
import {
  type ClientDocument,
  DocumentFixed,
  DocumentRemoved,
  type DocumentType,
  type NewDocument,
  type ScanStatus,
} from './document.js';
import type { ActivityKind } from './logged-activity.js';

/** The trigger that keeps a file on after its first day (#281). */
const REMOVABLE_FOR_A_DAY = 'clients_document_removable_for_a_day';

/** What a document goes on, as the service checks it: which client, and who logged an activity. */
export interface ActivityToAttachTo {
  id: string;
  clientId: string;
  loggedBy: { id: string; name: string };
}

export class ClientsDocumentRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** The client an activity is at, and who logged it, or undefined where there is no such one. */
  async activity(id: string): Promise<ActivityToAttachTo | undefined> {
    const row = await this.db
      .selectFrom('clients_activity as a')
      .innerJoin('employee as e', 'e.id', 'a.logged_by')
      .select([
        'a.id',
        'a.client_id',
        'e.id as logged_by',
        sql<string>`e.first_name || ' ' || e.last_name`.as('logged_by_name'),
      ])
      .where('a.id', '=', id)
      .executeTakeFirst();

    return row === undefined
      ? undefined
      : {
          id: row.id,
          clientId: row.client_id,
          loggedBy: { id: row.logged_by, name: row.logged_by_name },
        };
  }

  /** The client a deal is at, open or ended, or undefined where there is no such deal. */
  async clientOfDeal(id: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('clients_opportunity')
      .select('client_id')
      .where('id', '=', id)
      .executeTakeFirst();

    return row?.client_id;
  }

  /** Writes a document that has been read, scanned and stored. */
  async add(by: Attribution, document: NewDocument): Promise<string> {
    if (by.employeeId === null) {
      throw new Error('A document was uploaded by nobody.');
    }
    const uploadedBy = by.employeeId;

    return recording(this.db, by, async (on) => {
      const made = await on
        .insertInto('clients_document')
        .values({
          client_id: document.clientId,
          activity_id: document.place.kind === 'ACTIVITY' ? document.place.activityId : null,
          opportunity_id: document.place.kind === 'DEAL' ? document.place.opportunityId : null,
          original_filename: document.filename,
          storage_key: document.storageKey,
          content_type: document.contentType,
          size_bytes: document.sizeBytes,
          checksum_sha256: document.checksumSha256,
          scan_status: document.scanStatus,
          scanned_by: document.scannedBy,
          scanned_at: document.scanStatus === 'PENDING' ? null : sql<Date>`now()`,
          uploaded_by: uploadedBy,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      return made.id;
    });
  }

  /**
   * Marks a document as taken off, by whoever asks, now (#281). Its bytes are the service's to
   * delete once this has been written. Refused with {@link DocumentFixed} where the table's trigger
   * finds it attached more than a day ago, and with {@link DocumentRemoved} where somebody got
   * there first.
   */
  async remove(by: Attribution, id: string): Promise<void> {
    if (by.employeeId === null) {
      throw new Error('A document was removed by nobody.');
    }
    const removedBy = by.employeeId;

    try {
      const removed = await recording(this.db, by, (on) =>
        on
          .updateTable('clients_document')
          .set({ removed_at: sql<Date>`now()`, removed_by: removedBy })
          .where('id', '=', id)
          .where('removed_at', 'is', null)
          .executeTakeFirst(),
      );

      if (removed.numUpdatedRows === 0n) {
        const document = await this.find(id);
        throw new DocumentRemoved(document?.removed?.by.name ?? 'Somebody');
      }
    } catch (error) {
      if ((error as { constraint?: unknown }).constraint === REMOVABLE_FOR_A_DAY) {
        throw new DocumentFixed();
      }
      throw error;
    }
  }

  async find(id: string): Promise<ClientDocument | undefined> {
    const row = await documents(this.db).where('d.id', '=', id).executeTakeFirst();

    return row === undefined ? undefined : documentFrom(row);
  }

  /** A client's documents, on its activities and its deals, the latest first. */
  async ofClient(clientId: string): Promise<ClientDocument[]> {
    const rows = await documents(this.db)
      .where('d.client_id', '=', clientId)
      .orderBy('d.uploaded_at', 'desc')
      .orderBy('d.id', 'desc')
      .execute();

    return rows.map(documentFrom);
  }
}

/** Every document, with who uploaded it and what it is on: its activity, and the deal's product. */
function documents(db: Kysely<Database>) {
  return db
    .selectFrom('clients_document as d')
    .innerJoin('employee as e', 'e.id', 'd.uploaded_by')
    .leftJoin('employee as r', 'r.id', 'd.removed_by')
    .leftJoin('clients_activity as a', 'a.id', 'd.activity_id')
    .leftJoin('clients_opportunity as o', (join) =>
      join.on(sql<boolean>`o.id = coalesce(d.opportunity_id, a.opportunity_id)`),
    )
    .leftJoin('clients_product as p', 'p.id', 'o.product_id')
    .select([
      'd.id',
      'd.client_id',
      'd.activity_id',
      'd.opportunity_id',
      'a.kind as activity_kind',
      sql<CalendarDate | null>`a.happened_on::text`.as('happened_on'),
      'p.name as product_name',
      'd.original_filename',
      'd.content_type',
      'd.size_bytes',
      'd.checksum_sha256',
      'd.storage_key',
      'd.scan_status',
      'd.uploaded_at',
      'd.removed_at',
      'r.id as removed_by',
      sql<string | null>`r.first_name || ' ' || r.last_name`.as('removed_by_name'),
      'e.id as uploaded_by',
      sql<string>`e.first_name || ' ' || e.last_name`.as('uploaded_by_name'),
    ]);
}

type Row = Awaited<ReturnType<ReturnType<typeof documents>['executeTakeFirstOrThrow']>>;

function documentFrom(row: Row): ClientDocument {
  return {
    id: row.id,
    clientId: row.client_id,
    activityId: row.activity_id,
    opportunityId: row.opportunity_id,
    on:
      row.activity_id === null
        ? { kind: 'DEAL', dealId: row.opportunity_id ?? '', productName: row.product_name ?? '' }
        : {
            kind: 'ACTIVITY',
            activityId: row.activity_id,
            activityKind: row.activity_kind as ActivityKind,
            happenedOn: row.happened_on ?? '',
            productName: row.product_name,
          },
    filename: row.original_filename,
    contentType: row.content_type as DocumentType,
    sizeBytes: Number(row.size_bytes),
    checksumSha256: row.checksum_sha256,
    storageKey: row.storage_key,
    scanStatus: row.scan_status as ScanStatus,
    uploadedBy: { id: row.uploaded_by, name: row.uploaded_by_name },
    uploadedAt: row.uploaded_at,
    removed:
      row.removed_at === null || row.removed_by === null || row.removed_by_name === null
        ? null
        : { at: row.removed_at, by: { id: row.removed_by, name: row.removed_by_name } },
  };
}
