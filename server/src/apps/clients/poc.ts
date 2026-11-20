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

import {
  type CalendarDate,
  dayAfter,
  daysAfter,
  formatDay,
  isCalendarDate,
} from '../../core/calendar/time.js';
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

/* ---------------------------------------------------------------------- its health */

/**
 * CLI 35: how the CS lead or a BD manager judges it is going. Every POC starts On Track (the
 * user, 20 November 2026). The flags (#286) never change it.
 */
export const POC_HEALTHS = ['ON_TRACK', 'AT_RISK', 'STALLED'] as const;

export type PocHealth = (typeof POC_HEALTHS)[number];

export const HEALTH_NAMES: Record<PocHealth, string> = {
  ON_TRACK: 'On Track',
  AT_RISK: 'At Risk',
  STALLED: 'Stalled',
};

export function isPocHealth(value: unknown): value is PocHealth {
  return (POC_HEALTHS as readonly unknown[]).includes(value);
}

/** One change of its health, or its start On Track (CLI 35), with the actions answering it. */
export interface HealthChange {
  id: string;
  health: PocHealth;
  note: string | null;
  setBy: Person;
  setAt: Date;
  /**
   * What was written against it, the earliest first: corrective actions on At Risk, resets on
   * Stalled. On Track has none.
   */
  actions: PocAction[];
}

/**
 * What is being done about its health (#286): a corrective action answering At Risk, or a reset
 * answering Stalled. Which it is follows from the health it answers.
 */
export interface PocAction {
  id: string;
  body: string;
  loggedBy: Person;
  loggedAt: Date;
}

/* ------------------------------------------------------------------------ the flags */

/** What a health asks for: a corrective action (At Risk) or a reset (Stalled). */
export type AskedFor = 'CORRECTIVE_ACTION' | 'RESET';

/** The flag raised when what was asked for is not written in time. */
type Unanswered = 'NO_CORRECTIVE_ACTION' | 'EXIT_DECISION';

/**
 * The SOPs, the user on 20 November 2026. At Risk asks for a corrective action, and the POC is
 * flagged if none is written 48 hours after the move into At Risk. Stalled asks for a reset, and
 * the POC is flagged for an exit decision if none is written seven days after the move into
 * Stalled. Real hours, every one counted. On Track asks for nothing.
 */
export const ASKS: Record<
  Exclude<PocHealth, 'ON_TRACK'>,
  { what: AskedFor; withinHours: number; flag: Unanswered }
> = {
  AT_RISK: { what: 'CORRECTIVE_ACTION', withinHours: 48, flag: 'NO_CORRECTIVE_ACTION' },
  STALLED: { what: 'RESET', withinHours: 7 * 24, flag: 'EXIT_DECISION' },
};

/** What each is called in a sentence. */
export const ASKED_FOR_NAMES: Record<AskedFor, string> = {
  CORRECTIVE_ACTION: 'a corrective action',
  RESET: 'a reset',
};

/** Whether a health asks for anything: At Risk and Stalled do. */
export function asksSomething(health: PocHealth): health is keyof typeof ASKS {
  return health !== 'ON_TRACK';
}

/** What its health asks for now, and by when, if anything. */
export interface HealthAsk {
  what: AskedFor;
  by: Date;
}

/**
 * Something about a running POC that needs somebody's attention, worked out on read and never
 * stored. A flag never changes the health (#286).
 */
export type PocFlag = { kind: Unanswered | UsageFlag | 'PAST_DECISION'; since: Date };

/**
 * A running POC past its decision date (#286, CLI 50): flagged from the day after it, until it
 * converts, exits or is extended (#287). Nothing ends it on its own.
 */
export function decisionFlagsOf(poc: Pick<Poc, 'decisionOn'>, today: CalendarDate): PocFlag[] {
  return today > poc.decisionOn
    ? [{ kind: 'PAST_DECISION', since: new Date(`${dayAfter(poc.decisionOn)}T00:00:00Z`) }]
    : [];
}

/** Below 50% from Day 63 (unlikely to convert), or nothing recorded by then. */
type UsageFlag = 'LOW_USAGE' | 'NO_USAGE';

/** Its health as the flags read it: what it is, since when, and whether an action answers it. */
type HealthNow = Pick<Poc, 'health' | 'healthSince' | 'healthAnswered'>;

/** What its health asks for: while At Risk or Stalled, until something answers it. */
export function askOf(poc: HealthNow): HealthAsk | null {
  if (!asksSomething(poc.health) || poc.healthAnswered) {
    return null;
  }

  const ask = ASKS[poc.health];

  return {
    what: ask.what,
    by: new Date(poc.healthSince.getTime() + ask.withinHours * 3_600_000),
  };
}

/** Its flags at `now`: what it asked for and did not get in time. */
export function flagsOf(poc: HealthNow, now: Date): PocFlag[] {
  const ask = askOf(poc);
  const flags: PocFlag[] = [];

  if (ask !== null && asksSomething(poc.health) && now.getTime() >= ask.by.getTime()) {
    flags.push({ kind: ASKS[poc.health].flag, since: ask.by });
  }

  return flags;
}

/* ------------------------------------------------------------------------ its usage */

/** The counts of one day: how many users were enrolled, and how many of them active (#286). */
export interface Usage {
  measuredOn: CalendarDate;
  enrolled: number;
  active: number;
  /** Active over enrolled, a whole percent rounded half up: worked out, never typed. */
  percent: number;
}

/** A usage reading as recorded, and whether a later one for the same day replaced it. */
export type UsageReading = Usage & {
  id: string;
  recordedBy: Person;
  recordedAt: Date;
  /** A later reading for the same day counts instead; this one is kept (the user, 20 November). */
  replaced: boolean;
};

/**
 * Active over enrolled as a whole percent, rounded half up (the user, 20 November 2026): 28 of 64
 * is 43.75%, shown as 44%. Whole numbers throughout, so no float rounds a half the wrong way.
 */
export function percentOf(active: number, enrolled: number): number {
  return Math.floor((active * 200 + enrolled) / (enrolled * 2));
}

/* --------------------------------------------------------------- the usage targets */

/** A share of users active to reach by a day of the POC; the start is day 1 (#286). */
export interface UsageTarget {
  percent: number;
  byDay: number;
}

/**
 * The usage targets per checklist (#286, the POC SOPs): a bank 50% by Day 30, a brokerage 40% by
 * Day 21, both 70% by Day 63. Every other type takes the brokerage's (the user, 20 November
 * 2026). Here until the checklists (#284) carry them.
 */
const BANK_TARGETS: readonly UsageTarget[] = [
  { percent: 50, byDay: 30 },
  { percent: 70, byDay: 63 },
];
const BROKERAGE_TARGETS: readonly UsageTarget[] = [
  { percent: 40, byDay: 21 },
  { percent: 70, byDay: 63 },
];

/** The type name a bank's checklist goes by (#276's seed). */
const BANK = 'bank';

/** The targets for a POC whose client was of `clientType` when it started (CLI 30). */
export function targetsFor(clientType: string): readonly UsageTarget[] {
  return clientType.trim().toLowerCase() === BANK ? BANK_TARGETS : BROKERAGE_TARGETS;
}

/** The day of a POC started on `startedOn` that is its day `n`; the start is day 1. */
export function dayNumbered(startedOn: CalendarDate, n: number): CalendarDate {
  return daysAfter(startedOn, n - 1);
}

/**
 * A target as it stands today. Before its day: upcoming. From its day: judged on the latest
 * reading on or before it, met or missed, or no reading (the user, 20 November 2026). A missed
 * target is shown, never flagged.
 */
export type TargetCheck = UsageTarget & {
  dueOn: CalendarDate;
  status: 'UPCOMING' | 'MET' | 'MISSED' | 'NO_READING';
  /** The reading it is judged on; null while upcoming, or where there is none. */
  reading: Usage | null;
};

/** Its targets as they stand on `today`, from its readings, replaced ones left out. */
export function targetChecksOf(
  poc: { startedOn: CalendarDate; client: { type: string } },
  readings: readonly (Usage & { replaced: boolean })[],
  today: CalendarDate,
): TargetCheck[] {
  const counting = readings
    .filter((reading) => !reading.replaced)
    .sort((one, other) => (one.measuredOn < other.measuredOn ? 1 : -1));

  return targetsFor(poc.client.type).map((target) => {
    const dueOn = dayNumbered(poc.startedOn, target.byDay);

    if (today < dueOn) {
      return { ...target, dueOn, status: 'UPCOMING', reading: null };
    }

    const reading = counting.find((one) => one.measuredOn <= dueOn);
    if (reading === undefined) {
      return { ...target, dueOn, status: 'NO_READING', reading: null };
    }

    const { measuredOn, enrolled, active, percent } = reading;
    return {
      ...target,
      dueOn,
      status: percent >= target.percent ? 'MET' : 'MISSED',
      reading: { measuredOn, enrolled, active, percent },
    };
  });
}

/**
 * The SOPs: from Day 63, a POC below 50% is unlikely to convert, and flagged. One with nothing
 * recorded by then is flagged too (the user, 20 November 2026). Judged on its latest reading,
 * shown as the whole percent it is, so 49.5% shows as 50% and is not flagged.
 */
export const LOW_USAGE = { belowPercent: 50, fromDay: 63 };

/** Its usage flags on `today`: none before Day 63. */
export function usageFlagsOf(
  poc: Pick<Poc, 'startedOn' | 'usage'>,
  today: CalendarDate,
): PocFlag[] {
  const from = dayNumbered(poc.startedOn, LOW_USAGE.fromDay);
  if (today < from) {
    return [];
  }

  const since = new Date(`${from}T00:00:00Z`);
  if (poc.usage === null) {
    return [{ kind: 'NO_USAGE', since }];
  }

  return poc.usage.percent < LOW_USAGE.belowPercent ? [{ kind: 'LOW_USAGE', since }] : [];
}

/** Its counts on a day, as they are recorded: `{ measuredOn, enrolled, active }`. */
export interface UsageRecorded {
  measuredOn: CalendarDate;
  enrolled: number;
  active: number;
}

/** More users than any POC could have, so a slip of the keyboard is caught. */
const MOST_USERS = 1_000_000;

export function readUsage(
  body: unknown,
  poc: { startedOn: CalendarDate },
  today: CalendarDate,
): UsageRecorded {
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

  if (!isCalendarDate(fields.measuredOn)) {
    throw new InvalidUsage('measuredOn', 'Give the day the counts are for.');
  }
  if (fields.measuredOn < poc.startedOn) {
    throw new InvalidUsage(
      'measuredOn',
      `The POC started on ${formatDay(poc.startedOn)}. Give a day from then to today.`,
    );
  }
  if (fields.measuredOn > today) {
    throw new InvalidUsage(
      'measuredOn',
      'That day has not come yet. Give the day the counts are for, today or earlier.',
    );
  }

  const enrolled = fields.enrolled;
  if (typeof enrolled !== 'number' || !Number.isInteger(enrolled) || enrolled < 1) {
    throw new InvalidUsage(
      'enrolled',
      'Give how many users are enrolled, as a whole number, 1 or more.',
    );
  }
  if (enrolled > MOST_USERS) {
    throw new InvalidUsage(
      'enrolled',
      'That is more users than a POC could have. Check the count.',
    );
  }

  const active = fields.active;
  if (typeof active !== 'number' || !Number.isInteger(active) || active < 0) {
    throw new InvalidUsage('active', 'Give how many users were active, as a whole number.');
  }
  if (active > enrolled) {
    throw new InvalidUsage(
      'active',
      `Only ${String(enrolled)} are enrolled, so no more than that can be active.`,
    );
  }

  return { measuredOn: fields.measuredOn, enrolled, active };
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
  /** Its latest health, and when it was set: the moment it moved into it (CLI 35). */
  health: PocHealth;
  healthSince: Date;
  /** Whether an action answers its health now: a corrective action or a reset written since. */
  healthAnswered: boolean;
  /** Its latest usage: the latest day recorded, and the latest reading recorded for it (#286). */
  usage: Usage | null;
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
  /** What its health asks for, and by when; null for one that has ended. */
  asks: HealthAsk | null;
  /** What needs attention, worked out now; none for one that has ended. */
  flags: PocFlag[];
};

/** The POC page (CLI 100), as far as #285 and #286 take it. */
export type PocPage = PocView & {
  reviews: ReviewStep[];
  held: ReviewHeld[];
  /** Every health it has had, the latest first (CLI 35). */
  healthHistory: HealthChange[];
  /** Every usage reading, the latest day first, and the latest recorded first within a day. */
  usageReadings: UsageReading[];
  /** Its usage targets for its client type, as they stand today (#286). */
  targets: TargetCheck[];
};

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

/**
 * A health set: `{ health, note?, action? }` (CLI 35). At Risk asks for a corrective action and
 * Stalled for a reset, either of which may come with it or later; On Track takes neither.
 */
export interface HealthSet {
  health: PocHealth;
  note: string | null;
  action: string | null;
}

const MAX_HEALTH_NOTE_LENGTH = 2000;
const MAX_ACTION_LENGTH = 2000;

export function readHealth(body: unknown): HealthSet {
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

  if (!isPocHealth(fields.health)) {
    throw new InvalidHealth('health', 'Choose how the POC is going: On Track, At Risk or Stalled.');
  }

  const note = optionalText(fields.note, 'note', 'the note', MAX_HEALTH_NOTE_LENGTH);
  const action = optionalText(fields.action, 'action', 'what is being done', MAX_ACTION_LENGTH);
  if (action !== null && !asksSomething(fields.health)) {
    throw new InvalidHealth(
      'action',
      'On Track asks for no corrective action or reset. Leave it out, or choose At Risk or ' +
        'Stalled.',
    );
  }

  return { health: fields.health, note, action };
}

/** A corrective action or a reset written on its own: `{ action }` (#286). */
export function readAction(body: unknown): string {
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const action = optionalText(fields.action, 'action', 'what is being done', MAX_ACTION_LENGTH);

  if (action === null) {
    throw new InvalidHealth('action', 'Say what is being done about it.');
  }

  return action;
}

/** Words that may be left out, trimmed: null where left out or blank. */
function optionalText(value: unknown, field: string, what: string, longest: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new InvalidHealth(field, `Write ${what} as text.`);
  }

  const text = value.trim();
  if (text.length > longest) {
    throw new InvalidHealth(field, `Keep ${what} to ${String(longest)} characters.`);
  }

  return text === '' ? null : text;
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

/** A health that makes no sense as sent, naming the field to fix. */
export class InvalidHealth extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidHealth';
    this.field = field;
  }
}

/** A usage reading that makes no sense as sent, naming the field to fix. */
export class InvalidUsage extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidUsage';
    this.field = field;
  }
}

/** The health it has already: each change is a change (the user, 20 November 2026). */
export class HealthUnchanged extends Error {
  constructor(health: PocHealth) {
    super(`The POC is ${HEALTH_NAMES[health]} already.`);
    this.name = 'HealthUnchanged';
  }
}

/** An action written while the health asks for none (#286). */
export class NoActionAsked extends Error {
  constructor(health: PocHealth) {
    super(
      `The POC is ${HEALTH_NAMES[health]}, so nothing is asked for. At Risk asks for a ` +
        'corrective action, and Stalled for a reset.',
    );
    this.name = 'NoActionAsked';
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
