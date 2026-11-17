/**
 * An activity: something that happened with a client, on a day. #280, Clients SRS CLI 58 to CLI 62,
 * TDD 4.5.
 *
 * A call, a meeting, a demo or a note, logged by anybody with a clients role against any client,
 * and optionally one of its deals, open or ended (CLI 55, CLI 60). The day is the day it happened,
 * which may be any day up to today (CLI 61). Whoever logged it may correct it for 24 hours, and
 * after that it is fixed (CLI 62).
 *
 * A review meeting joins the kinds with the POC (#285), and a proposal sent with proposals (#281).
 *
 * Not ./activity.ts, which is the client page's Activity section: everything that has happened at
 * a client, of which these are one part.
 */

import { type CalendarDate, isCalendarDate } from '../../core/calendar/time.js';
import type { Person } from './client.js';
import { isAnId } from './product.js';

/** CLI 59, for now. */
export const ACTIVITY_KINDS = ['CALL', 'MEETING', 'DEMO', 'NOTE'] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** The deal an activity or a next step is about, as the page names it. */
export interface DealNamed {
  id: string;
  productName: string;
}

export interface LoggedActivity {
  id: string;
  clientId: string;
  /** The deal it was about, or null where it was about the client. */
  deal: DealNamed | null;
  kind: ActivityKind;
  happenedOn: CalendarDate;
  /** Who it was with, in words, or null where nobody said. */
  withWhom: string | null;
  /** What came of it, or null where nobody said. */
  outcome: string | null;
  loggedBy: Person;
  loggedAt: Date;
}

export interface NewActivity {
  clientId: string;
  opportunityId: string | null;
  kind: ActivityKind;
  happenedOn: CalendarDate;
  withWhom: string | null;
  outcome: string | null;
}

export const MAX_WITH_WHOM_LENGTH = 200;
export const MAX_OUTCOME_LENGTH = 4000;

/** A request that makes no sense, naming the field to fix. */
export class InvalidActivity extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidActivity';
    this.field = field;
  }
}

export class ActivityNotFound extends Error {
  constructor() {
    super('No activity matches that. Refresh the page to see the activity as it is now.');
    this.name = 'ActivityNotFound';
  }
}

/** A correction. Only what is present changes; null takes an optional field away. */
export interface ActivityChange {
  opportunityId?: string | null;
  kind?: ActivityKind;
  happenedOn?: CalendarDate;
  withWhom?: string | null;
  outcome?: string | null;
}

/** How long whoever logged an activity may correct it (CLI 62, TDD 4.5). */
export const CORRECTABLE_FOR_MS = 24 * 60 * 60 * 1000;

/** Whether an activity logged at `loggedAt` may still be corrected at `now`. */
export function stillCorrectable(loggedAt: Date, now: Date): boolean {
  return now.getTime() <= loggedAt.getTime() + CORRECTABLE_FOR_MS;
}

/**
 * TDD 11's ACTIVITY_LOCKED. Fixed 24 hours after it was logged (CLI 62); a further note is the
 * fix, and the sentence says so.
 */
export class ActivityLocked extends Error {
  constructor() {
    super(
      'This activity was logged more than 24 hours ago, so it is fixed. Log a note to correct it.',
    );
    this.name = 'ActivityLocked';
  }
}

/**
 * A correction, from a request body: `{ opportunityId?, kind?, happenedOn?, withWhom?, outcome? }`.
 * Which client it was with never changes (#280), so a `clientId` other than its own is refused.
 */
export function readActivityChange(
  body: unknown,
  today: CalendarDate,
  clientId: string,
): ActivityChange {
  const fields = fieldsOf(body);
  const change: ActivityChange = {};

  if (fields.clientId !== undefined && fields.clientId !== clientId) {
    throw new InvalidActivity(
      'clientId',
      'An activity stays with the client it was logged against. Log it again against the ' +
        'other client instead.',
    );
  }

  if ('opportunityId' in fields) change.opportunityId = readDealId(fields.opportunityId);
  if (fields.kind !== undefined) change.kind = readKind(fields.kind);
  if (fields.happenedOn !== undefined) {
    change.happenedOn = readHappenedOn(fields.happenedOn, today);
  }
  if ('withWhom' in fields) {
    change.withWhom = readOptionalText(
      fields.withWhom,
      'withWhom',
      'who it was with',
      MAX_WITH_WHOM_LENGTH,
    );
  }
  if ('outcome' in fields) {
    change.outcome = readOptionalText(
      fields.outcome,
      'outcome',
      'what came of it',
      MAX_OUTCOME_LENGTH,
    );
  }

  return change;
}

/**
 * A new activity, from a request body: `{ clientId, opportunityId?, kind, happenedOn, withWhom?,
 * outcome? }`. Whether the client and deal exist, and the deal is the client's, is the service's.
 */
export function readNewActivity(body: unknown, today: CalendarDate): NewActivity {
  const fields = fieldsOf(body);

  if (typeof fields.clientId !== 'string' || !isAnId(fields.clientId)) {
    throw new InvalidActivity('clientId', 'Choose the client it was with.');
  }

  return {
    clientId: fields.clientId,
    opportunityId: readDealId(fields.opportunityId),
    kind: readKind(fields.kind),
    happenedOn: readHappenedOn(fields.happenedOn, today),
    withWhom: readOptionalText(
      fields.withWhom,
      'withWhom',
      'who it was with',
      MAX_WITH_WHOM_LENGTH,
    ),
    outcome: readOptionalText(fields.outcome, 'outcome', 'what came of it', MAX_OUTCOME_LENGTH),
  };
}

function readDealId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !isAnId(value)) {
    throw new InvalidActivity('opportunityId', "Choose one of the client's deals, or none.");
  }

  return value;
}

function readKind(value: unknown): ActivityKind {
  if (!ACTIVITY_KINDS.includes(value as ActivityKind)) {
    throw new InvalidActivity('kind', 'Say whether it was a call, a meeting, a demo or a note.');
  }

  return value as ActivityKind;
}

/** CLI 61: any day up to today, however long ago. Not a day still to come. */
function readHappenedOn(value: unknown, today: CalendarDate): CalendarDate {
  if (!isCalendarDate(value)) {
    throw new InvalidActivity('happenedOn', 'Give the day it happened.');
  }
  if (value > today) {
    throw new InvalidActivity(
      'happenedOn',
      'That day has not come yet. Give the day it happened, today or earlier.',
    );
  }

  return value;
}

/** Trimmed text, or null where it was left out or blank. */
function readOptionalText(
  value: unknown,
  field: string,
  what: string,
  longest: number,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new InvalidActivity(field, `Write ${what} as text.`);
  }

  const text = value.trim();

  if (text.length > longest) {
    throw new InvalidActivity(field, `Keep ${what} to ${String(longest)} characters.`);
  }

  return text === '' ? null : text;
}

export function fieldsOf(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}
