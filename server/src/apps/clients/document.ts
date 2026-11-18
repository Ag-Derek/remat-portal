/**
 * A document: a file kept on an activity or a deal. #281, Clients SRS CLI 67 to CLI 70, TDD 4.6.
 *
 * A proposal, the financials, a BRD, a configuration sheet, a signed contract. On an activity it is
 * whoever logged it who attaches, at any time; on a deal, anybody with a role, open or ended (the
 * user, 18 November 2026). What it is comes from its bytes (CLI 69), and it is virus scanned before
 * anything is kept, as leave's certificates are.
 */

import {
  DOCX,
  PPTX,
  type SniffedType,
  sniffedTypeInWords,
  XLSX,
} from '../../core/storage/content-type.js';
import type { CalendarDate } from '../../core/calendar/time.js';
import type { Person } from './client.js';
import type { ActivityKind } from './logged-activity.js';

/**
 * What may be attached, as the bytes say it (the user, 18 November 2026): proposals are PDF and
 * Word, and workbooks, decks and pictures come with them. The same list the table holds.
 */
export const ACCEPTED_DOCUMENT_TYPES = [
  'application/pdf',
  DOCX,
  XLSX,
  PPTX,
  'image/png',
  'image/jpeg',
] as const satisfies readonly SniffedType[];

export type DocumentType = (typeof ACCEPTED_DOCUMENT_TYPES)[number];

/** 50 MB a file, the limit the user set for #281. The table holds the same number. */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

export const MAX_FILENAME_LENGTH = 255;

/** PENDING is a file nothing has looked at yet, and nobody may open. */
export type ScanStatus = 'PENDING' | 'CLEAN' | 'INFECTED';

/**
 * What a document is on, as the client page names it: a deal, by its product; or an activity, by
 * what it was and the day it happened, with its deal's product where it was about one.
 */
export type DocumentOn =
  | { kind: 'DEAL'; dealId: string; productName: string }
  | {
      kind: 'ACTIVITY';
      activityId: string;
      activityKind: ActivityKind;
      happenedOn: CalendarDate;
      productName: string | null;
    };

/** Where a document is kept: one of the two, and the client either is at. */
export type DocumentPlace =
  { kind: 'ACTIVITY'; activityId: string } | { kind: 'DEAL'; opportunityId: string };

export interface ClientDocument {
  id: string;
  clientId: string;
  /** The activity it is on, or null where it is on a deal. */
  activityId: string | null;
  /** The deal it is on, or null where it is on an activity. */
  opportunityId: string | null;
  /** What it is on, as the page names it. */
  on: DocumentOn;
  /** The uploader's own name for it. A label, never a path. */
  filename: string;
  /** What the bytes are (CLI 69). */
  contentType: DocumentType;
  sizeBytes: number;
  checksumSha256: string;
  /** Storage's handle. Never sent to a browser (CLI 68). */
  storageKey: string;
  scanStatus: ScanStatus;
  uploadedBy: Person;
  uploadedAt: Date;
  /** Taken off by whoever attached it, within a day: its bytes gone, this kept. Null while on. */
  removed: { at: Date; by: Person } | null;
}

/** How long whoever attached a file may take it off again (#281): as an activity's correction. */
export const REMOVABLE_FOR_MS = 24 * 60 * 60 * 1000;

/** Whether a file attached at `uploadedAt` may still be taken off at `now`. */
export function stillRemovable(uploadedAt: Date, now: Date): boolean {
  return now.getTime() <= uploadedAt.getTime() + REMOVABLE_FOR_MS;
}

/** A document as somebody reads it: whether they may take it off, the policy's answer. */
export type DocumentView = ClientDocument & { may: { remove: boolean } };

/** What is written for a new document, once it has been read, scanned and stored. */
export interface NewDocument {
  clientId: string;
  place: DocumentPlace;
  filename: string;
  contentType: DocumentType;
  sizeBytes: number;
  checksumSha256: string;
  storageKey: string;
  scanStatus: Exclude<ScanStatus, 'INFECTED'>;
  scannedBy: string | null;
}

/** The upload as it arrived: the bytes, the name in its header, and what the browser called it. */
export interface UploadedDocument {
  filename: string;
  content: unknown;
  claimedContentType: string;
}

/** Whether it may be opened: scanned and found clean. */
export function downloadable(document: Pick<ClientDocument, 'scanStatus' | 'removed'>): boolean {
  return document.scanStatus === 'CLEAN' && document.removed === null;
}

/** The accepted types as somebody says them: "PDF, DOCX, XLSX, PPTX, PNG and JPG". */
export function acceptedInWords(): string {
  const words = ACCEPTED_DOCUMENT_TYPES.map(sniffedTypeInWords);

  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export function isAcceptedType(type: SniffedType | null): type is DocumentType {
  return (ACCEPTED_DOCUMENT_TYPES as readonly string[]).includes(type ?? '');
}

/* ---------------------------------------------------------------------------- reading */

/**
 * The name, as a name: trimmed, its folders dropped, and nothing in it that makes it a path. A
 * browser on Windows sends the whole path on some forms, and none of it is ours to keep.
 */
export function readFilename(value: string): string {
  const name = value.split(/[\\/]/).pop()?.trim() ?? '';

  if (name === '' || name === '.' || name === '..' || hasAControlCharacter(name)) {
    throw new InvalidDocument(
      'filename',
      'Send the file with its name, such as "proposal.pdf", in the X-Filename header.',
    );
  }
  if (name.length > MAX_FILENAME_LENGTH) {
    throw new InvalidDocument(
      'filename',
      `That file's name is longer than ${String(MAX_FILENAME_LENGTH)} characters. Shorten it.`,
    );
  }

  return name;
}

/** The bytes, as bytes, within the limit. */
export function readContent(content: unknown): Buffer {
  if (!Buffer.isBuffer(content) || content.byteLength === 0) {
    throw new InvalidDocument(
      'file',
      'The body of an upload is the file itself, and an empty one is not a document.',
    );
  }
  if (content.byteLength > MAX_DOCUMENT_BYTES) {
    throw new DocumentTooLarge(content.byteLength);
  }

  return content;
}

function hasAControlCharacter(name: string): boolean {
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;

    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '');
}

/* --------------------------------------------------------------------------- refusals */

/** An upload that is not one, naming what to fix. */
export class InvalidDocument extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidDocument';
    this.field = field;
  }
}

export class DocumentNotFound extends Error {
  constructor() {
    super('No document matches that. Refresh the page to see the documents as they are now.');
    this.name = 'DocumentNotFound';
  }
}

/** Over the 50 MB a file may be. */
export class DocumentTooLarge extends Error {
  readonly sizeBytes: number;

  constructor(sizeBytes: number) {
    super(
      `${sizeBytes > 0 ? `That file is ${megabytes(sizeBytes)} MB, and` : 'That file is too large:'}` +
        ` the limit is ${megabytes(MAX_DOCUMENT_BYTES)} MB a file. Saving a deck as PDF, or ` +
        'its pictures at a lower resolution, brings most things down.',
    );
    this.name = 'DocumentTooLarge';
    this.sizeBytes = sizeBytes;
  }
}

/** CLI 69: what the bytes are is not something that may be attached. */
export class DocumentTypeNotAccepted extends Error {
  constructor() {
    super(
      `That file is not one of the kinds that can be attached: ${acceptedInWords()}. What a ` +
        'file is, is read from the file itself rather than its name, so renaming it will not ' +
        'help.',
    );
    this.name = 'DocumentTypeNotAccepted';
  }
}

/** Taken off already: its bytes are gone, and who took it off is on the record. */
export class DocumentRemoved extends Error {
  constructor(by: string) {
    super(`${by} removed this file, so it can no longer be opened or removed again.`);
    this.name = 'DocumentRemoved';
  }
}

/** Attached more than a day ago, so it stays (#281). The right file goes beside it. */
export class DocumentFixed extends Error {
  constructor() {
    super(
      'This file was attached more than 24 hours ago, so it stays. Attach the right one beside ' +
        'it, and say in a note which to use.',
    );
    this.name = 'DocumentFixed';
  }
}

/** A file nothing has cleared is a file nobody may open, as leave's AttachmentNotScanned. */
export class DocumentNotScanned extends Error {
  constructor() {
    super(
      'This file has not been checked for viruses yet, so it cannot be opened. It will be ' +
        'once the check has been made.',
    );
    this.name = 'DocumentNotScanned';
  }
}

/** Refused by the virus scanner. Nothing was stored and nothing written. */
export class DocumentIsInfected extends Error {
  readonly signature: string | null;

  constructor(signature: string | null) {
    super(
      `The virus scanner refused this file${signature === null ? '' : `, ${signature}`}, so it ` +
        'has not been kept. If you believe that is wrong, tell the system administrator.',
    );
    this.name = 'DocumentIsInfected';
    this.signature = signature;
  }
}
