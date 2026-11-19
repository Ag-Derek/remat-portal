/**
 * A certificate or supporting document on a request. FR 12, FR 13, NFR SEC 07.
 */

import type { LeaveType } from '../leave-type/leave-type.js';
import { sniffContentType as sniffBytes } from '../../../core/storage/content-type.js';
import { type CalendarDate, monthsAfter } from '../../../core/calendar/time.js';
import { type LeaveRequest, isSettled } from './leave-request.js';

/** FR 12. What is accepted, as the bytes say it rather than as the name claims it. */
export const ACCEPTED_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

export type AcceptedContentType = (typeof ACCEPTED_CONTENT_TYPES)[number];

/** FR 12. Ten megabytes, and five files. The same numbers the table holds. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_REQUEST = 5;

/** A type as somebody says it, for a message about what may be attached. NFR USA 03. */
export function contentTypeInWords(type: AcceptedContentType): string {
  switch (type) {
    case 'application/pdf':
      return 'PDF';
    case 'image/jpeg':
      return 'JPG';
    case 'image/png':
      return 'PNG';
    default:
      return 'DOCX';
  }
}

/** "PDF, JPG, PNG and DOCX". */
export function acceptedInWords(): string {
  const words = ACCEPTED_CONTENT_TYPES.map(contentTypeInWords);

  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/* ------------------------------------------------------------------ scanning */

/** NFR SEC 07. `PENDING` is a file nothing has looked at yet. */
export const SCAN_STATUSES = ['PENDING', 'CLEAN', 'INFECTED'] as const;

export type ScanStatus = (typeof SCAN_STATUSES)[number];

/** An attachment as it comes back out. */
export interface LeaveRequestAttachment {
  id: string;
  /**
   * The request this evidences, or null while it is still waiting for one.
   *
   * FR 13 is answered at submission, which is before a request exists — so a file is
   * uploaded, waits under {@link LeaveRequestAttachment.heldForEmployeeId}, and is put on
   * the request in the same transaction as the row itself.
   */
  leaveRequestId: string | null;
  /** Whose evidence this is. The one thing a waiting file can be addressed by. */
  heldForEmployeeId: string;
  /** Which of the five seats this holds — on the request, or in the pile waiting for one. */
  slot: number;
  /** The uploader's own name for it. A label, never a path. */
  filename: string;
  /** Sniffed, never taken from the extension. NFR SEC 07. */
  contentType: AcceptedContentType;
  sizeBytes: number;
  checksumSha256: string;
  /** The handle storage issued. Never sent to a client. NFR SEC 04. */
  storageKey: string;
  scanStatus: ScanStatus;
  /** What the scanner found, on `INFECTED` alone. */
  scanSignature: string | null;
  scannedBy: string | null;
  scannedAt: Date | null;
  uploadedBy: string;
  uploadedByEmployeeId: string | null;
  uploadedAt: Date;
  /** When retention deleted the stored file. The row stays. NFR SEC 06. */
  fileDeletedAt: Date | null;
}

/** What a validated upload holds, before it is written. */
export interface NewAttachment {
  /** Null where it is being uploaded ahead of the request it will evidence. */
  leaveRequestId: string | null;
  heldForEmployeeId: string;
  slot: number;
  filename: string;
  contentType: AcceptedContentType;
  sizeBytes: number;
  checksumSha256: string;
  storageKey: string;
  scanStatus: ScanStatus;
  scanSignature: string | null;
  scannedBy: string | null;
  scannedAt: Date | null;
}

/**
 * Whether this file can stand as evidence. NFR SEC 07.
 *
 * A scanned, clean file and nothing else — which is the whole of "unscanned files cannot
 * satisfy a requirement".
 */
export function attachmentSatisfiesADocumentationRule(attachment: LeaveRequestAttachment): boolean {
  return attachment.scanStatus === 'CLEAN';
}

/** Whether FR 13's rule for this leave is met, and the sentence saying so. FR 13, NFR SEC 07. */
export interface EvidenceOnARequest {
  required: boolean;
  satisfied: boolean;
  /** Files that count, of the files that are there. */
  usable: number;
  attached: number;
  inWords: string;
}

export function evidenceOn(
  type: LeaveType,
  request: LeaveRequest,
  attachments: readonly LeaveRequestAttachment[],
): EvidenceOnARequest {
  /* Read off the request rather than asked of the type again, and the two are not
     the same question: FR 32a's threshold is the balance, which has moved since, and FR 13's
     is a rule HR may have reworded. What this reports is what the leave was allowed on. */
  const required = request.evidenceRequired;
  const usable = countUsable(attachments);
  const waiting = attachments.length - usable;

  return {
    required,
    satisfied: !required || usable > 0,
    usable,
    attached: attachments.length,
    inWords: evidenceInWords(type, required, usable, waiting),
  };
}

/** How many of these can stand as evidence. NFR SEC 07. */
export function countUsable(attachments: readonly LeaveRequestAttachment[]): number {
  return attachments.filter(attachmentSatisfiesADocumentationRule).length;
}

function evidenceInWords(
  type: LeaveType,
  required: boolean,
  usable: number,
  waiting: number,
): string {
  const unscanned =
    waiting === 0
      ? ''
      : ` ${waiting === 1 ? 'One file is' : `${waiting} files are`} still being checked ` +
        `for viruses and cannot count until that is done.`;

  if (!required) {
    return usable === 0
      ? `This ${type.name.toLowerCase()} asked for no documentation. Anything attached is ` +
          `there because you wanted it on the record.${unscanned}`
      : `This ${type.name.toLowerCase()} asked for no documentation, and ${usable} ` +
          `${usable === 1 ? 'file is' : 'files are'} attached anyway.${unscanned}`;
  }

  return usable === 0
    ? `This ${type.name.toLowerCase()} needed supporting documentation, and nothing usable ` +
        `is attached.${unscanned} Attach ${acceptedInWords()}, up to ` +
        `${MAX_ATTACHMENTS_PER_REQUEST} files.`
    : `This ${type.name.toLowerCase()} needed supporting documentation, and ${usable} ` +
        `${usable === 1 ? 'file' : 'files'} can stand as it.${unscanned}`;
}

/* ----------------------------------------------------------------- retention */

/** A stored file on leave that is decided or ended. NFR SEC 06. */
export interface KeptAttachment {
  attachment: LeaveRequestAttachment;
  leaveRequestId: string;
  leaveEndedOn: CalendarDate;
}

/** The day the stored file is deleted: the retention period after the leave ends. */
export function fileDeletedOn(leaveEndedOn: CalendarDate, retentionMonths: number): CalendarDate {
  return monthsAfter(leaveEndedOn, retentionMonths);
}

/* ------------------------------------------------------------------ the seats */

/** The lowest free seat, or undefined where all five are taken. FR 12. */
export function nextFreeSlot(taken: readonly number[]): number | undefined {
  for (let slot = 1; slot <= MAX_ATTACHMENTS_PER_REQUEST; slot += 1) {
    if (!taken.includes(slot)) {
      return slot;
    }
  }

  return undefined;
}

/* ------------------------------------------------------------------ refusals */

/** An upload that is not one. Carries the field, like every other validator. NFR USA 03. */
export class InvalidAttachment extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidAttachment';
    this.field = field;
  }
}

export class AttachmentNotFound extends Error {
  readonly attachmentId: string;

  constructor(id: string) {
    super(`There is no attachment ${id}.`);
    this.name = 'AttachmentNotFound';
    this.attachmentId = id;
  }
}

/** FR 12, NFR SEC 07. What the bytes are is not what may be attached. */
export class AttachmentTypeNotAccepted extends Error {
  readonly code = 'TYPE_NOT_ACCEPTED';
  /** What it actually is, where that could be told at all. */
  readonly sniffed: string | null;

  constructor(sniffed: string | null, claimed: string) {
    super(
      `This file is ${sniffed ?? 'not a kind of file this system recognises'}, whatever ` +
        `it is called. ${acceptedInWords()} are accepted, and what a file is, is read ` +
        `from the file rather than from its name, so renaming it will not help. ` +
        `You sent it as ${claimed || 'nothing in particular'}. FR 12.`,
    );
    this.name = 'AttachmentTypeNotAccepted';
    this.sniffed = sniffed;
  }
}

/** FR 12. */
export class AttachmentTooLarge extends Error {
  readonly code = 'FILE_TOO_LARGE';
  readonly sizeBytes: number;
  readonly maxBytes = MAX_ATTACHMENT_BYTES;

  constructor(sizeBytes: number) {
    super(
      `That file is ${megabytes(sizeBytes)} MB and the limit is ` +
        `${megabytes(MAX_ATTACHMENT_BYTES)} MB per file. A photograph of a certificate ` +
        `is usually well under it; scanning at a lower resolution, or saving as PDF, ` +
        `brings most things down. FR 12.`,
    );
    this.name = 'AttachmentTooLarge';
    this.sizeBytes = sizeBytes;
  }
}

/** FR 12. Five seats, on a request or in the pile waiting for one. */
export class TooManyAttachments extends Error {
  readonly code = 'TOO_MANY_FILES';
  /** Null where the five that are full are the ones waiting for a request. */
  readonly leaveRequestId: string | null;
  readonly maxFiles = MAX_ATTACHMENTS_PER_REQUEST;

  constructor(request: LeaveRequest | null) {
    super(
      `${
        request === null
          ? `You already have ${MAX_ATTACHMENTS_PER_REQUEST} files waiting to go on a ` +
            `request, which is the limit`
          : `This request already has ${MAX_ATTACHMENTS_PER_REQUEST} files on it, which is ` +
            `the limit`
      }. Remove one you no longer need and attach this in its place. FR 12.`,
    );
    this.name = 'TooManyAttachments';
    this.leaveRequestId = request?.id ?? null;
  }
}

/** NFR SEC 07. Refused at the door; nothing is stored and no row is written. */
export class AttachmentIsInfected extends Error {
  readonly code = 'FILE_INFECTED';
  readonly signature: string | null;

  constructor(signature: string | null) {
    super(
      `The virus scanner refused this file${signature === null ? '' : `, ${signature}`}. ` +
        `It has not been stored. If you believe that is wrong, send the document to HR ` +
        `another way and tell them what happened. NFR SEC 07.`,
    );
    this.name = 'AttachmentIsInfected';
    this.signature = signature;
  }
}

/** NFR SEC 07. A file nothing has cleared is a file nobody may open. */
export class AttachmentNotScanned extends Error {
  readonly code = 'NOT_SCANNED';
  readonly attachmentId: string;
  readonly scanStatus: ScanStatus;

  constructor(attachment: LeaveRequestAttachment) {
    super(
      attachment.scanStatus === 'INFECTED'
        ? `This file was found to be infected and cannot be downloaded. It counts as no ` +
            `evidence of anything. NFR SEC 07.`
        : `This file has not been scanned for viruses yet, so it cannot be downloaded and ` +
            `it satisfies no documentation requirement. It will be scanned again shortly. ` +
            `NFR SEC 07.`,
    );
    this.name = 'AttachmentNotScanned';
    this.attachmentId = attachment.id;
    this.scanStatus = attachment.scanStatus;
  }
}

/** NFR SEC 06. Deleted under retention; the name and details stay. */
export class AttachmentFileDeleted extends Error {
  readonly code = 'FILE_DELETED';
  readonly attachmentId: string;

  constructor(attachment: LeaveRequestAttachment) {
    super(
      `This file was deleted once the retention period had passed, so it can no longer be ` +
        `downloaded. Its name and details stay on the request. NFR SEC 06.`,
    );
    this.name = 'AttachmentFileDeleted';
    this.attachmentId = attachment.id;
  }
}

/** FR 12. Evidence goes on a request that is still open. */
export class AttachmentsAreClosed extends Error {
  readonly code = 'REQUEST_CLOSED';
  readonly leaveRequestId: string;

  constructor(request: LeaveRequest, act: 'attach to' | 'remove from') {
    super(
      request.status === 'SUBMITTED'
        ? 'An approver has already responded to this request, so its files stay on it: they ' +
            'are part of what it is being decided on. You can still add another. FR 12.'
        : `This leave has been ${request.status.toLowerCase()}, so there is nothing left to ` +
            `${act === 'attach to' ? 'evidence' : 'take back'}. Files already on it stay on ` +
            `it: what was attached while it was being decided is part of the record of why it ` +
            `was decided that way. FR 12.`,
    );
    this.name = 'AttachmentsAreClosed';
    this.leaveRequestId = request.id;
  }
}

/** Whether a request is still open to evidence. FR 12. */
export function assertAttachmentsAreOpen(
  request: LeaveRequest,
  act: 'attach to' | 'remove from',
  /** Decisions recorded at any stage. Removing stops at the first, as changing dates does. */
  decisionsRecorded = 0,
): void {
  /* Attaching is refused once the leave has ended; removing once anybody has decided anything. */
  const closed =
    act === 'attach to'
      ? isSettled(request.status)
      : request.status !== 'SUBMITTED' || decisionsRecorded > 0;

  if (closed) {
    throw new AttachmentsAreClosed(request, act);
  }
}

/**
 * The file a request was let through on, being taken back off. FR 13.
 *
 * The hole attachments could not have: evidence that arrives with the request and leaves a minute
 * later is evidence that was chased after all. A second certificate attached first frees this
 * one, so it refuses the *last* usable file rather than any of them.
 */
export class DocumentationCannotBeRemoved extends Error {
  /** FR 13. What a client branches on, so a screen can grey the button rather than throw. */
  readonly code = 'DOCUMENTATION_STANDS';
  readonly leaveRequestId: string;
  readonly attachmentId: string;

  constructor(request: LeaveRequest, attachment: LeaveRequestAttachment) {
    super(
      `This leave needed supporting documentation and this is the only file standing as ` +
        `it, so taking it off would leave a request on the books that could not have been ` +
        `made. Attach the replacement first and this one can go. If the leave itself is ` +
        `wrong, withdraw it. FR 13.`,
    );
    this.name = 'DocumentationCannotBeRemoved';
    this.leaveRequestId = request.id;
    this.attachmentId = attachment.id;
  }
}

/**
 * Refuses taking the last of a request's evidence off it. FR 13.
 *
 * `leave_request_attachment_is_what_it_was_allowed_on` holds the same rule where no sentence
 * can reach, and on every connection.
 */
export function assertItIsNotTheLastEvidence(
  request: LeaveRequest,
  attachment: LeaveRequestAttachment,
  onTheRequest: readonly LeaveRequestAttachment[],
): void {
  if (!request.evidenceRequired || !attachmentSatisfiesADocumentationRule(attachment)) {
    return;
  }

  if (countUsable(onTheRequest.filter((held) => held.id !== attachment.id)) === 0) {
    throw new DocumentationCannotBeRemoved(request, attachment);
  }
}

/* ---------------------------------------------------------------- validation */

/**
 * The name, as a name. FR 12.
 *
 * Trimmed, stripped of anything that makes it a path, and capped. The database holds the
 * same rule; this is where the sentence is.
 */
export function validateFilename(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidAttachment(
      'filename',
      'An attachment needs a name, so that whoever approves this knows what they are ' +
        'looking at. Send it in the X-Filename header.',
    );
  }

  /* The basename, whatever arrived: a browser on Windows sends the whole path on some
     forms, and none of it is ours to keep. */
  const name = value.split(/[\\/]/).pop()?.trim() ?? '';

  if (name === '' || name === '.' || name === '..' || hasAControlCharacter(name)) {
    throw new InvalidAttachment(
      'filename',
      `"${value}" is a path or a control character rather than the name of a file. Send ` +
        `the name as it appears on your machine, such as "certificate.pdf".`,
    );
  }

  if (name.length > 255) {
    throw new InvalidAttachment(
      'filename',
      'That filename is longer than 255 characters. Shorten it. The name is a label for ' +
        'whoever approves this, not part of the document.',
    );
  }

  return name;
}

/** The bytes, as bytes. FR 12. */
export function validateContent(content: unknown): Buffer {
  if (!Buffer.isBuffer(content) || content.byteLength === 0) {
    throw new InvalidAttachment(
      'file',
      'The body of an upload is the file itself, sent as bytes with a content type this ' +
        'server does not read. An empty body is not a document.',
    );
  }

  if (content.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentTooLarge(content.byteLength);
  }

  return content;
}

/** A filename is a label somebody types, so nothing below space belongs in it. */
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

/* ------------------------------------------------------------------ sniffing */

/**
 * What the bytes actually are, where leave accepts it, or null. NFR SEC 07.
 *
 * The extension is never consulted. Reading the bytes is core's, which clients shares (#281):
 * a workbook or a deck it can tell apart is still no certificate, and is refused here.
 */
export function sniffContentType(content: Buffer): AcceptedContentType | null {
  const sniffed = sniffBytes(content);

  return (ACCEPTED_CONTENT_TYPES as readonly string[]).includes(sniffed ?? '')
    ? (sniffed as AcceptedContentType)
    : null;
}
