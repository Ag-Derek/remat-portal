/**
 * A product a client already uses, from the day it started. #276, Clients SRS CLI 04.
 *
 * Each product is on a client once. Added by hand by anybody with a clients role, for a client
 * that was using it before this system existed; once opportunities are built, winning one adds
 * it too. A client that stops is given an end date rather than having the product taken off, so
 * the page still says what they once had; taking the end date away says they use it again.
 */

import { type CalendarDate, isCalendarDate } from '../../core/calendar/time.js';
import { isAnId } from './product.js';

export interface ProductInUse {
  productId: string;
  /** "CreditStudio". */
  productName: string;
  /** "Dura Capital". */
  lineName: string;
  sinceOn: CalendarDate;
  /** The day they stopped, or null while they use it. */
  endedOn: CalendarDate | null;
  /** The opportunity that won it, or null for one added by hand. */
  wonBy: string | null;
}

export interface NewProductInUse {
  productId: string;
  sinceOn: CalendarDate;
}

/** A correction to the dates. Only what is present changes; an end date of null resumes it. */
export interface ProductInUseChange {
  sinceOn?: CalendarDate;
  endedOn?: CalendarDate | null;
}

/** A request that makes no sense, naming the field to fix. */
export class InvalidProductInUse extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidProductInUse';
    this.field = field;
  }
}

/** The product is on this client already. Correcting its dates is the fix. */
export class ProductAlreadyInUse extends Error {
  readonly field = 'productId';

  constructor(clientName: string, productName: string) {
    super(
      `${clientName} already has ${productName}. Change its dates there rather than adding it ` +
        'again.',
    );
    this.name = 'ProductAlreadyInUse';
  }
}

export class ProductInUseNotFound extends Error {
  constructor() {
    super('That product is not on this client. Refresh the page to see what it uses now.');
    this.name = 'ProductInUseNotFound';
  }
}

/** A product being added to a client, from a request body. */
export function readNewProductInUse(body: unknown, today: CalendarDate): NewProductInUse {
  const fields = fieldsOf(body);
  const productId = fields.productId;

  if (typeof productId !== 'string' || !isAnId(productId)) {
    throw new InvalidProductInUse('productId', 'Choose the product the client uses.');
  }

  return { productId, sinceOn: readSinceOn(fields.sinceOn, today) };
}

/** A correction to the dates, from a request body. */
export function readProductInUseChange(body: unknown, today: CalendarDate): ProductInUseChange {
  const fields = fieldsOf(body);
  const change: ProductInUseChange = {};

  if (fields.sinceOn !== undefined) change.sinceOn = readSinceOn(fields.sinceOn, today);
  if ('endedOn' in fields) {
    change.endedOn =
      fields.endedOn === null ? null : readPastDate(fields.endedOn, 'endedOn', 'stopped', today);
  }

  return change;
}

/** Ends after it starts, as the table also holds (`clients_client_product_ends_after_it_starts`). */
export function mustEndAfterItStarts(sinceOn: CalendarDate, endedOn: CalendarDate | null): void {
  if (endedOn !== null && endedOn < sinceOn) {
    throw new InvalidProductInUse(
      'endedOn',
      'The day they stopped is before the day they started. Check both dates.',
    );
  }
}

function readSinceOn(value: unknown, today: CalendarDate): CalendarDate {
  return readPastDate(value, 'sinceOn', 'started', today);
}

/** A real calendar date, today or earlier: a client does not use a product from next month. */
function readPastDate(
  value: unknown,
  field: string,
  what: 'started' | 'stopped',
  today: CalendarDate,
): CalendarDate {
  if (!isCalendarDate(value)) {
    throw new InvalidProductInUse(field, `Give the day the client ${what} using it.`);
  }
  if (value > today) {
    throw new InvalidProductInUse(
      field,
      `The day the client ${what} using it is in the future. Give a day up to today.`,
    );
  }

  return value;
}

function fieldsOf(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}
