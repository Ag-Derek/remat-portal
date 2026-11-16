/**
 * An opportunity, which the screen calls a deal: one client and one product. #277, Clients SRS
 * CLI 10 to CLI 17, TDD 4.2.
 *
 * It has an owner and an outcome, and may have a value, a probability, an expected close, what it
 * is waiting on and what the client said they want (CLI 10). Whatever is not known is null, never
 * nought or an empty string, so that it is shown as missing by name (CLI 06).
 *
 * Money is whole minor units of one currency, cedis or dollars (CLI 74, TDD 8). Two currencies
 * are never added together, so an amount never travels without its currency.
 */

import type { CalendarDate } from '../../core/calendar/time.js';
import type { Person } from './client.js';
import { isAnId } from './product.js';

/** Ghana cedis and US dollars, the two the department prices in (CLI 74). */
export const CURRENCIES = ['GHS', 'USD'] as const;

export type Currency = (typeof CURRENCIES)[number];

/** An amount in pesewas or cents, with the currency it is in. */
export interface Money {
  amountMinor: number;
  currency: Currency;
}

/** Half of a calendar year (CLI 15): H1 is January to June, H2 July to December. */
export interface HalfYear {
  half: 'H1' | 'H2';
  year: number;
}

/** What is holding a deal up today, whatever its stage (CLI 16). */
export const WAITING_ON = [
  'DEMO',
  'PROPOSAL_RESPONSE',
  'PAPERWORK',
  'SIGNATURE',
  'CLIENT_DECISION',
  'OTHER',
] as const;

export type WaitingOnWhat = (typeof WAITING_ON)[number];

/** What a deal waits on, and anything more to say about it. "Other" always says what. */
export interface WaitingOn {
  on: WaitingOnWhat;
  note: string | null;
}

/** Open until won, lost or exited, which the stage service decides (#278, #279). */
export type Outcome = 'OPEN' | 'WON' | 'LOST' | 'EXITED';

export interface Opportunity {
  id: string;
  client: { id: string; name: string };
  /** "CreditStudio", in "Dura Capital". */
  product: { id: string; name: string; lineName: string };
  /** Who works it. */
  owner: Person;
  outcome: Outcome;
  /** Null while nobody knows what it is worth. */
  value: Money | null;
  /** A whole percentage, or null while nobody has said (CLI 14). */
  probability: number | null;
  /** Null while nobody has said. */
  expectedClose: HalfYear | null;
  /** Null when nothing is holding it up. */
  waitingOn: WaitingOn | null;
  /** In the client's own words (CLI 17). Null where they have said nothing yet. */
  statedInterest: string | null;
  createdAt: Date;
}

/**
 * What changed a deal's figures: an owner or BD manager by hand, a proposal sent (#281), a POC
 * converting (#287), or the workbook import (#283). TDD 4.2.
 */
export type ValueSource = 'MANUAL' | 'PROPOSAL' | 'CONVERSION' | 'IMPORT';

/**
 * A deal's value and probability as they stood after one change to either, and who made it and
 * when. The first is what it was opened with. Never changed once written (NFR CLI REC 01).
 */
export interface ValueChange {
  /** Null where it had no value then. */
  value: Money | null;
  /** Null where it had no probability then. */
  probability: number | null;
  source: ValueSource;
  changedBy: Person;
  changedAt: Date;
}

/**
 * What the person reading a deal may do to it: the policy's own answers, so the screen offers only
 * what the server would allow. The server still refuses whatever it refuses.
 */
export interface DealPermissions {
  /** Its figures and words: its owner's or a BD manager's, while it is open (CLI 13). */
  change: boolean;
}

/** A deal, with what the person reading it may do to it. */
export type DealView = Opportunity & { may: DealPermissions };

/** What a new deal is made of, read from the request. Its owner is whoever asks (CLI 12). */
export interface NewOpportunity {
  clientId: string;
  productId: string;
  value: Money | null;
  probability: number | null;
  expectedClose: HalfYear | null;
  waitingOn: WaitingOn | null;
  statedInterest: string | null;
}

/** The longest texts the columns hold. */
export const MAX_WAITING_NOTE_LENGTH = 2000;
export const MAX_STATED_INTEREST_LENGTH = 2000;

/**
 * The most a deal may be worth: just under a trillion, in either currency. Far beyond any deal
 * the department will see, and well inside what a JavaScript number holds exactly in minor units.
 */
export const MAX_AMOUNT_MINOR = 99_999_999_999_999;

/** The years an expected close may fall in, as the table holds. */
const EARLIEST_YEAR = 2000;
const LATEST_YEAR = 2100;

/** A request that makes no sense, naming the field to fix. */
export class InvalidOpportunity extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidOpportunity';
    this.field = field;
  }
}

/**
 * The client has an open deal for the product already (CLI 11, AC L01): TDD 11's ALREADY_OPEN.
 * Working that one, or ending it first, is the fix.
 */
export class OpportunityAlreadyOpen extends Error {
  readonly field = 'productId';

  constructor(clientName: string, productName: string) {
    super(
      `${clientName} already has an open ${productName} deal. Work on that one, or end it ` +
        'before starting another.',
    );
    this.name = 'OpportunityAlreadyOpen';
  }
}

/**
 * What an edit to a deal asks for (CLI 13). Only what is present changes; null takes it away, so
 * that the deal shows it as missing again. Its client, product and owner are not edited here.
 */
export interface OpportunityChange {
  value?: Money | null;
  probability?: number | null;
  expectedClose?: HalfYear | null;
  waitingOn?: WaitingOn | null;
  statedInterest?: string | null;
}

/** An edit to a deal, from a request body. Fields left out are left as they are. */
export function readOpportunityChange(body: unknown): OpportunityChange {
  const fields = fieldsOf(body);
  const change: OpportunityChange = {};

  if ('value' in fields) change.value = readValue(fields.value);
  if ('probability' in fields) change.probability = readProbability(fields.probability);
  if ('expectedClose' in fields) change.expectedClose = readExpectedClose(fields.expectedClose);
  if ('waitingOn' in fields) change.waitingOn = readWaitingOn(fields.waitingOn);
  if ('statedInterest' in fields) {
    change.statedInterest = readText(
      fields.statedInterest,
      'statedInterest',
      'what the client said they want',
      MAX_STATED_INTEREST_LENGTH,
    );
  }

  return change;
}

/**
 * The deal has ended: won, lost or exited. It stays as it ended (CLI 55), and re-engaging the
 * client is a new deal (CLI 56).
 */
export class OpportunityEnded extends Error {
  constructor(productName: string, outcome: Outcome) {
    super(
      `This ${productName} deal was ${OUTCOME_IN_WORDS[outcome]}, so it is kept as it ended. ` +
        'Open a new deal to take it up again.',
    );
    this.name = 'OpportunityEnded';
  }
}

const OUTCOME_IN_WORDS: Record<Outcome, string> = {
  OPEN: 'open',
  WON: 'won',
  LOST: 'lost',
  EXITED: 'exited',
};

export class OpportunityNotFound extends Error {
  constructor() {
    super('No deal matches that. Refresh the page to see the deals as they are now.');
    this.name = 'OpportunityNotFound';
  }
}

/** A new deal, from a request body. */
export function readNewOpportunity(body: unknown): NewOpportunity {
  const fields = fieldsOf(body);

  return {
    clientId: readId(fields.clientId, 'clientId', 'Choose the client the deal is with.'),
    productId: readId(fields.productId, 'productId', 'Choose the product the deal is for.'),
    value: readValue(fields.value),
    probability: readProbability(fields.probability),
    expectedClose: readExpectedClose(fields.expectedClose),
    waitingOn: readWaitingOn(fields.waitingOn),
    statedInterest: readText(
      fields.statedInterest,
      'statedInterest',
      'what the client said they want',
      MAX_STATED_INTEREST_LENGTH,
    ),
  };
}

/**
 * What a deal is worth, as `{ amount, currency }` with the amount in cedis or dollars written as
 * text, "12500" or "12500.50", or null where nobody knows. Read as text rather than as a number
 * so that no amount is rounded on its way in.
 */
export function readValue(value: unknown): Money | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'object') {
    throw new InvalidOpportunity('value', 'Give what the deal is worth, and in which currency.');
  }

  const { amount, currency } = value as Record<string, unknown>;

  if (!isCurrency(currency)) {
    throw new InvalidOpportunity('value', 'Say whether the deal is in cedis or dollars.');
  }

  return { amountMinor: readAmount(amount), currency };
}

/** A whole percentage from 0 to 100, or null where nobody has said (CLI 14). */
export function readProbability(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new InvalidOpportunity(
      'probability',
      'Give the probability as a whole percentage from 0 to 100.',
    );
  }

  return value;
}

/** `{ half: 'H1' | 'H2', year }`, or null where nobody has said (CLI 15). */
export function readExpectedClose(value: unknown): HalfYear | null {
  if (value === undefined || value === null) {
    return null;
  }

  const { half, year } = (typeof value === 'object' ? value : {}) as Record<string, unknown>;

  if (
    (half !== 'H1' && half !== 'H2') ||
    typeof year !== 'number' ||
    !Number.isInteger(year) ||
    year < EARLIEST_YEAR ||
    year > LATEST_YEAR
  ) {
    throw new InvalidOpportunity(
      'expectedClose',
      'Give the expected close as a half, H1 or H2, and its year.',
    );
  }

  return { half, year };
}

/** `{ on, note? }`, or null where nothing is holding the deal up (CLI 16). */
export function readWaitingOn(value: unknown): WaitingOn | null {
  if (value === undefined || value === null) {
    return null;
  }

  const { on, note } = (typeof value === 'object' ? value : {}) as Record<string, unknown>;

  if (!(WAITING_ON as readonly unknown[]).includes(on)) {
    throw new InvalidOpportunity(
      'waitingOn',
      'Choose what the deal is waiting on: a demo, a proposal response, paperwork, a ' +
        'signature, a client decision, or other.',
    );
  }

  const written = readText(note, 'waitingOn', 'the note', MAX_WAITING_NOTE_LENGTH);

  if (on === 'OTHER' && written === null) {
    throw new InvalidOpportunity('waitingOn', 'Say what else the deal is waiting on.');
  }

  return { on: on as WaitingOnWhat, note: written };
}

export function isCurrency(value: unknown): value is Currency {
  return (CURRENCIES as readonly unknown[]).includes(value);
}

/** The half year a day falls in: 1 January to 30 June is H1. */
export function halfYearOf(day: CalendarDate): HalfYear {
  const [year, month] = day.split('-').map(Number);

  return { half: month <= 6 ? 'H1' : 'H2', year };
}

function readId(value: unknown, field: string, message: string): string {
  if (typeof value !== 'string' || !isAnId(value)) {
    throw new InvalidOpportunity(field, message);
  }

  return value;
}

/**
 * An amount in cedis or dollars, as text, to minor units. "12,500.50" is not accepted, because
 * whether the comma is a thousands mark or a decimal one is a guess.
 */
function readAmount(value: unknown): number {
  const text =
    typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);

  if (match === null) {
    throw new InvalidOpportunity(
      'value',
      'Give what the deal is worth as a number, with at most two figures after the point.',
    );
  }

  const [, whole, fraction = ''] = match;
  const amountMinor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));

  if (amountMinor > MAX_AMOUNT_MINOR) {
    throw new InvalidOpportunity('value', 'That is more than any deal could be worth. Check it.');
  }

  return amountMinor;
}

/** Trimmed text, or null where it was left out or left blank. */
function readText(value: unknown, field: string, what: string, longest: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new InvalidOpportunity(field, `Write ${what} as text.`);
  }

  const text = value.trim();

  if (text.length > longest) {
    throw new InvalidOpportunity(field, `Keep ${what} to ${String(longest)} characters.`);
  }

  return text === '' ? null : text;
}

function fieldsOf(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}
