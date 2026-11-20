/**
 * A POC: up to ten weeks, free, under the signed contract, for one deal. #285, Clients SRS CLI 27
 * to CLI 34, TDD 4.3, TDD 6.
 *
 * **Signing the contract starts it** (the user, 19 November 2026, over SRS CLI 28 and CLI 31,
 * which put a Pre-POC wait between the two). A deal with a POC moved to Contract signed goes on
 * into its POC there and then; nothing about a POC is ever "not started".
 *
 * **One deal per POC** (the user, 20 November 2026, over CLI 27's "one or more"). A second deal
 * for the same client and line signed later starts a POC of its own.
 *
 * The clock's numbers are here and nowhere else (TDD 6.2): the tracker guide and the POC SOPs
 * disagree about the weeks (SRS 17, item 4), and settling that is a change to this file. Phase,
 * day and days to decision are worked out from the start and today, never stored (TDD 1,
 * principle 3), so they change on their own as the weeks pass.
 */

import { type CalendarDate, daysAfter, isCalendarDate } from '../../core/calendar/time.js';
import type { Person } from './client.js';
import type { Outcome } from './opportunity.js';
import { isAnId } from './product.js';
import type { Stage } from './stage.js';

/** Ten weeks, every day counted (CLI 31, TDD 6.1). Day 1 is the start. */
export const POC_DAYS = 70;

/** The day a POC started on `startedOn` is to be decided by (CLI 31, AC L09). */
export function decisionDateOf(startedOn: CalendarDate): CalendarDate {
  return daysAfter(startedOn, POC_DAYS);
}

/* ----------------------------------------------------------------------- the phase */

/** CLI 32: Foundation in weeks 1 to 3, Deepening in 4 to 6, Converting in 7 to 10. */
export type PocPhase = 'FOUNDATION' | 'DEEPENING' | 'CONVERTING';

/** The last day of Foundation and of Deepening (TDD 6.1). */
const FOUNDATION_UNTIL_DAY = 21;
const DEEPENING_UNTIL_DAY = 42;

/** Which day of its POC today is: the start is day 1 (TDD 6.1). */
export function dayOf(startedOn: CalendarDate, today: CalendarDate): number {
  return daysBetween(startedOn, today) + 1;
}

/**
 * The phase a POC is in on `today` (CLI 32), never set by hand. Past its decision date it is
 * still Converting: it shows as past its date, and nothing ends it (CLI 50).
 */
export function phaseOf(startedOn: CalendarDate, today: CalendarDate): PocPhase {
  const day = dayOf(startedOn, today);

  if (day <= FOUNDATION_UNTIL_DAY) return 'FOUNDATION';
  if (day <= DEEPENING_UNTIL_DAY) return 'DEEPENING';
  return 'CONVERTING';
}

/** Days from `today` to the decision date: 0 on the day, negative once it has passed. */
export function daysToDecision(decisionOn: CalendarDate, today: CalendarDate): number {
  return daysBetween(today, decisionOn);
}

/** Whole days from one day to another, negative where `to` is earlier. */
function daysBetween(from: CalendarDate, to: CalendarDate): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);

  return Math.round(ms / 86_400_000);
}

/* --------------------------------------------------------------------- the reviews */

/** The three review meetings (CLI 33). */
export const REVIEW_KINDS = ['DAY7', 'WEEK6', 'WEEK9'] as const;

export type ReviewKind = (typeof REVIEW_KINDS)[number];

/** Each review: how many days after the start it falls (TDD 6.2), and what it is called. */
export const REVIEWS: Record<ReviewKind, { afterDays: number; name: string }> = {
  DAY7: { afterDays: 7, name: 'Day 7 showcase' },
  WEEK6: { afterDays: 42, name: 'Week 6 midpoint review' },
  WEEK9: { afterDays: 63, name: 'Week 9 activation review' },
};

/**
 * How long after a review the senior decision maker missed its replacement is due (TDD 6.2, the
 * user, 20 November 2026): seven days after the meeting.
 */
export const RESCHEDULE_AFTER_DAYS = 7;

/** The three review steps a POC started on `startedOn` gives its CS lead (CLI 33, AC L09). */
export function reviewStepsOf(
  startedOn: CalendarDate,
  about: { clientName: string; productName: string },
): { kind: ReviewKind; dueOn: CalendarDate; description: string }[] {
  return REVIEW_KINDS.map((kind) => ({
    kind,
    dueOn: daysAfter(startedOn, REVIEWS[kind].afterDays),
    description: `${REVIEWS[kind].name} with ${about.clientName} on the ${about.productName} POC`,
  }));
}

/** The step that replaces a review the senior decision maker missed (CLI 34). */
export function rescheduledReviewOf(
  kind: ReviewKind,
  heldOn: CalendarDate,
  about: { clientName: string; productName: string },
): { dueOn: CalendarDate; description: string } {
  return {
    dueOn: daysAfter(heldOn, RESCHEDULE_AFTER_DAYS),
    description:
      `${REVIEWS[kind].name} with ${about.clientName} on the ${about.productName} POC, ` +
      'again: the senior decision maker was not there',
  };
}

export function isReviewKind(value: unknown): value is ReviewKind {
  return (REVIEW_KINDS as readonly unknown[]).includes(value);
}

/* ------------------------------------------------------------------------- the POC */

/** A POC, as a deal shows it. */
export interface PocOfADeal {
  id: string;
  startedOn: CalendarDate;
  decisionOn: CalendarDate;
  csLead: Person;
}

/** The POC a deal's signing starts, as the repository writes it. */
export interface NewPoc {
  /** Who runs it: the owner of the deal that started it (#279, #285). */
  csLeadId: string;
  startedOn: CalendarDate;
  decisionOn: CalendarDate;
}

/** A POC as it is stored, with what its list and page name. */
export interface Poc {
  id: string;
  client: { id: string; name: string; type: string };
  lineName: string;
  /** The one deal it is for. */
  deal: { id: string; productName: string; stage: Stage; outcome: Outcome; owner: Person };
  csLead: Person;
  /** Whether its CS lead still holds a clients role; one who does not needs replacing (CLI 96). */
  csLeadHoldsARole: boolean;
  startedOn: CalendarDate;
  decisionOn: CalendarDate;
}

/** A review step, as the POC page lists it. */
export interface ReviewStep {
  id: string;
  kind: ReviewKind;
  description: string;
  dueOn: CalendarDate;
  owner: Person;
  done: { at: Date; by: Person } | null;
}

/** A review meeting recorded (CLI 34). */
export interface ReviewHeld {
  id: string;
  kind: ReviewKind;
  heldOn: CalendarDate;
  /** Whether the senior decision maker was there. A review without them does not count. */
  dmAttended: boolean;
  withWhom: string | null;
  outcome: string | null;
  loggedBy: Person;
  loggedAt: Date;
}

/**
 * A POC as somebody reads it: where its clock stands today, worked out rather than stored (CLI 32,
 * TDD 6.1), and what they may do to it, the policy's answers.
 */
export type PocView = Poc & {
  phase: PocPhase;
  /** Which day of its ten weeks today is; the start is day 1. */
  day: number;
  /** Negative once the decision date has passed (CLI 50). */
  daysToDecision: number;
  may: { update: boolean; moveLead: boolean };
};

/** The POC page (CLI 100), as far as #285 takes it. */
export type PocPage = PocView & { reviews: ReviewStep[]; held: ReviewHeld[] };

/* ------------------------------------------------------------------------ requests */

/** A review recorded: `{ reviewKind, heldOn, dmAttended, withWhom?, outcome? }` (CLI 34). */
export interface ReviewRecorded {
  kind: ReviewKind;
  heldOn: CalendarDate;
  dmAttended: boolean;
  withWhom: string | null;
  outcome: string | null;
}

const MAX_WITH_WHOM_LENGTH = 200;
const MAX_OUTCOME_LENGTH = 4000;

export function readReview(body: unknown, today: CalendarDate): ReviewRecorded {
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

  if (!isReviewKind(fields.reviewKind)) {
    throw new InvalidReview(
      'reviewKind',
      'Choose which review it was: the Day 7 showcase, the Week 6 midpoint or the Week 9 ' +
        'activation review.',
    );
  }
  if (!isCalendarDate(fields.heldOn)) {
    throw new InvalidReview('heldOn', 'Give the day the review was held.');
  }
  if (fields.heldOn > today) {
    throw new InvalidReview(
      'heldOn',
      'That day has not come yet. Give the day the review was held, today or earlier.',
    );
  }
  if (typeof fields.dmAttended !== 'boolean') {
    throw new InvalidReview('dmAttended', 'Say whether the senior decision maker was there.');
  }

  return {
    kind: fields.reviewKind,
    heldOn: fields.heldOn,
    dmAttended: fields.dmAttended,
    withWhom: readText(fields.withWhom, 'withWhom', 'who was there', MAX_WITH_WHOM_LENGTH),
    outcome: readText(fields.outcome, 'outcome', 'what came of it', MAX_OUTCOME_LENGTH),
  };
}

/** A new CS lead: `{ employeeId }` (CLI 92). Whether they hold a role is the service's. */
export function readNewLead(body: unknown): string {
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

  if (typeof fields.employeeId !== 'string' || !isAnId(fields.employeeId)) {
    throw new InvalidPocLead('Choose who is to run the POC.');
  }

  return fields.employeeId;
}

function readText(value: unknown, field: string, what: string, longest: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new InvalidReview(field, `Write ${what} as text.`);
  }

  const text = value.trim();
  if (text.length > longest) {
    throw new InvalidReview(field, `Keep ${what} to ${String(longest)} characters.`);
  }

  return text === '' ? null : text;
}

/* ------------------------------------------------------------------------ refusals */

export class PocNotFound extends Error {
  constructor() {
    super('No POC matches that. Refresh the page to see the POCs as they are now.');
    this.name = 'PocNotFound';
  }
}

/** A review that makes no sense as sent, naming the field to fix. */
export class InvalidReview extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidReview';
    this.field = field;
  }
}

/** A new CS lead that is nobody, or nobody who could run it (CLI 29). */
export class InvalidPocLead extends Error {
  readonly field = 'employeeId';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidPocLead';
  }
}

/**
 * A POC whose deal has ended, converted or exited (#287), takes no more reviews: it is kept as it
 * ended, as its deal is.
 */
export class PocEnded extends Error {
  constructor(productName: string) {
    super(`The ${productName} POC has ended, so it is kept as it ended.`);
    this.name = 'PocEnded';
  }
}
