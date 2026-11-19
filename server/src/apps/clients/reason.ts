/**
 * Why a deal ended without winning: lost before its POC started, or exited from a started POC.
 * #279, Clients SRS CLI 51 to CLI 54, TDD 4.5.
 *
 * Each is chosen from a list the BD manager keeps (CLI 54), so the reasons can be counted, with a
 * note for anything more. A lost deal's note is optional (CLI 51); an exit's says which products
 * the POC ran on, and is required (CLI 52).
 */

import { isAnId } from './product.js';

/** The two lists: why deals are lost, and why POCs are exited. */
export const REASON_LISTS = ['LOST', 'EXITED'] as const;

export type ReasonList = (typeof REASON_LISTS)[number];

/** One reason on one list. Retired ones are kept by the deals that ended for them. */
export interface Reason {
  id: string;
  appliesTo: ReasonList;
  /** "Chose a competitor". */
  label: string;
  /** The day it was retired; null while it may still be chosen. */
  retiredOn: string | null;
}

/** Why an ended deal ended, as the deal shows it (CLI 55). */
export interface Ending {
  reason: { id: string; label: string };
  /** For an exit, which products the POC ran on (CLI 52). Null where nothing more was said. */
  note: string | null;
}

/** Losing a deal, as the request asks it: `{ reasonId, note? }`. */
export interface Loss {
  reasonId: string;
  note: string | null;
}

export const MAX_END_NOTE_LENGTH = 2000;

/** A request that makes no sense as sent, naming the field to fix. */
export class InvalidEnding extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidEnding';
    this.field = field;
  }
}

/**
 * A reason that is not on the list it would have to be on, or is retired, or is nobody's. TDD's
 * REASON_REQUIRED where none was chosen is {@link InvalidEnding}. Choosing one that is offered is
 * the fix.
 */
export class ReasonNotOffered extends Error {
  readonly field = 'reasonId';

  constructor(message: string) {
    super(message);
    this.name = 'ReasonNotOffered';
  }
}

/** A loss from a request body (CLI 51): a reason, and optionally a note. */
export function readLoss(body: unknown): Loss {
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

  return {
    reasonId: readReasonId(fields.reasonId, 'Choose why the deal was lost.'),
    note: readNote(fields.note),
  };
}

/** A POC exiting for a deal, as the POC service is asked it: why, and which products it ran on. */
export interface Exit {
  reasonId: string;
  /** Which products the POC ran on (CLI 52). Required, unlike a lost deal's note. */
  note: string;
}

/**
 * An exit, as the POC service hands one over from its request (CLI 52, TDD's REASON_REQUIRED): a
 * reason from the exit list, and a note saying which products the POC ran on, both required. The
 * Brokerage POC SOP's exit protocol asks for both.
 */
export function readExit(value: unknown): Exit {
  const fields =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const note = readNote(fields.note);

  const reasonId = readReasonId(fields.reasonId, 'Choose why the POC was exited.');
  if (note === null) {
    throw new InvalidEnding('note', 'Say which products the POC ran on.');
  }

  return { reasonId, note };
}

/** Why a reason may not be given to a deal ending this way, or null where it may. */
export function refusalOfReason(
  reason: Reason | undefined,
  outcome: ReasonList,
): ReasonNotOffered | null {
  if (reason === undefined) {
    return new ReasonNotOffered(
      'No reason matches that. Refresh the page to see the reasons as they are now.',
    );
  }
  if (reason.appliesTo !== outcome) {
    return new ReasonNotOffered(
      `"${reason.label}" is a reason for ${LIST_NAME[reason.appliesTo]}, not for ` +
        `${LIST_NAME[outcome]}. Choose one from the ${LIST_NAME[outcome]} list.`,
    );
  }
  if (reason.retiredOn !== null) {
    return new ReasonNotOffered(`"${reason.label}" is retired. Choose another reason.`);
  }

  return null;
}

const LIST_NAME: Record<ReasonList, string> = {
  LOST: 'losing a deal',
  EXITED: 'exiting a POC',
};

function readReasonId(value: unknown, missing: string): string {
  if (value === undefined || value === null || value === '') {
    throw new InvalidEnding('reasonId', missing);
  }
  if (typeof value !== 'string' || !isAnId(value)) {
    throw new InvalidEnding('reasonId', 'Choose a reason from the list.');
  }

  return value;
}

/** Trimmed, or null where it was left out or left blank. */
function readNote(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new InvalidEnding('note', 'Write the note as text.');
  }

  const text = value.trim();
  if (text.length > MAX_END_NOTE_LENGTH) {
    throw new InvalidEnding('note', `Keep the note to ${String(MAX_END_NOTE_LENGTH)} characters.`);
  }

  return text === '' ? null : text;
}

/* ------------------------------------------------------- keeping the lists, CLI 54 */

/** The longest a reason's words may be, as the column holds. */
export const MAX_REASON_LABEL_LENGTH = 120;

/** A reason as the setup screen shows it: and whether a deal has ended for it. */
export interface ReasonInSetup extends Reason {
  /** A deal names it, so its words are kept and it is never deleted (CLI 54, #279). */
  inUse: boolean;
}

/** A new reason, from a request body: `{ appliesTo, label }`. */
export function readNewReason(body: unknown): { appliesTo: ReasonList; label: string } {
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

  if (!(REASON_LISTS as readonly unknown[]).includes(fields.appliesTo)) {
    throw new InvalidReason(
      'appliesTo',
      'Say which list the reason is for: losing a deal, or exiting a POC.',
    );
  }

  return { appliesTo: fields.appliesTo as ReasonList, label: readReasonLabel(body) };
}

/** A reason's words, from a request body: `{ label }`, its spacing tidied. */
export function readReasonLabel(body: unknown): string {
  const { label } = (typeof body === 'object' && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  const tidied = typeof label === 'string' ? label.trim().replace(/\s+/g, ' ') : '';

  if (tidied === '') {
    throw new InvalidReason('label', 'Say what the reason is.');
  }
  if (tidied.length > MAX_REASON_LABEL_LENGTH) {
    throw new InvalidReason(
      'label',
      `Keep the reason to ${String(MAX_REASON_LABEL_LENGTH)} characters.`,
    );
  }

  return tidied;
}

/** A request about a reason that makes no sense, naming the field to fix. */
export class InvalidReason extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidReason';
    this.field = field;
  }
}

export class ReasonNotFound extends Error {
  constructor() {
    super('No reason matches that. Refresh the page to see the reasons as they are now.');
    this.name = 'ReasonNotFound';
  }
}

/** The list has the words already, ignoring case and spacing. */
export class ReasonLabelTaken extends Error {
  readonly field = 'label';

  constructor(appliesTo: ReasonList, label: string) {
    super(
      `There is already a reason for ${LIST_NAME[appliesTo]} called "${label}". Each is named ` +
        'once on its list, so that the reasons can be counted.',
    );
    this.name = 'ReasonLabelTaken';
  }
}

/**
 * A deal has ended for the reason, so it is kept as it was: not reworded, not deleted (CLI 54,
 * #279). Retiring it, and adding the new words as another, is the fix.
 */
export class ReasonInUse extends Error {
  constructor(label: string, doing: 'reword' | 'delete') {
    super(
      doing === 'reword'
        ? `A deal has ended for "${label}", so its words are kept as they were. Retire it and ` +
            'add the new words as another reason.'
        : `A deal has ended for "${label}", so it is kept. Retire it instead, and it is offered ` +
            'for no new deal.',
    );
    this.name = 'ReasonInUse';
  }
}
