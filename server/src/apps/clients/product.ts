/**
 * What clients sells: product lines, and the products in them. #293, Clients SRS CLI 07, CLI 08.
 *
 * Every product is in exactly one line, for good. Each name is used once, ignoring case and
 * surrounding spaces. A retired product or line takes no new deals and keeps everything already
 * recorded against it; retiring is a date, and nothing is ever deleted.
 */

import type { CalendarDate } from '../../core/calendar/time.js';

export interface Product {
  id: string;
  lineId: string;
  name: string;
  /** The day it stopped taking new deals, or null while it takes them. */
  retiredOn: CalendarDate | null;
}

export interface ProductLine {
  id: string;
  name: string;
  retiredOn: CalendarDate | null;
  /** Its products, by name. */
  products: Product[];
}

/** The longest name the columns hold. */
export const MAX_NAME_LENGTH = 80;

/** A request that makes no sense, naming the field to fix. */
export class InvalidProductSetup extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidProductSetup';
    this.field = field;
  }
}

/** A name, trimmed, from a request body. */
export function readName(body: unknown, what: 'line' | 'product'): string {
  const name = fieldsOf(body).name;

  if (typeof name !== 'string' || name.trim() === '') {
    throw new InvalidProductSetup('name', `Give the ${what} a name.`);
  }
  if (name.trim().length > MAX_NAME_LENGTH) {
    throw new InvalidProductSetup(
      'name',
      `Keep the ${what}'s name to ${String(MAX_NAME_LENGTH)} characters.`,
    );
  }

  return name.trim();
}

/** The line a new product goes in, from a request body. */
export function readLineId(body: unknown): string {
  const lineId = fieldsOf(body).lineId;

  if (typeof lineId !== 'string' || !isAnId(lineId)) {
    throw new InvalidProductSetup('lineId', 'Choose the line the product belongs to.');
  }

  return lineId;
}

/** Whether a string could be a BIGSERIAL id, so a nonsense one is not found rather than a 500. */
export function isAnId(value: string): boolean {
  return /^\d{1,18}$/.test(value);
}

/** The name is somebody else's already, ignoring case and spaces. */
export class ClientsNameTaken extends Error {
  constructor(what: 'line' | 'product' | 'client type', name: string) {
    super(
      `There is already a ${what} called ${name}. Each ${what} is named once, so that it is ` +
        'the same everywhere it is chosen.',
    );
    this.name = 'ClientsNameTaken';
  }
}

/** A product added to, or restored into, a line that is retired. */
export class ClientsLineRetired extends Error {
  constructor(lineName: string, doing: 'add' | 'restore') {
    super(
      doing === 'add'
        ? `${lineName} is retired, so it takes no new products. Restore it first.`
        : `${lineName} is retired. Restore the line first, then the product.`,
    );
    this.name = 'ClientsLineRetired';
  }
}

export class ClientsProductNotFound extends Error {
  constructor() {
    super('No product matches that. Refresh the page to see the products as they are now.');
    this.name = 'ClientsProductNotFound';
  }
}

export class ClientsLineNotFound extends Error {
  constructor() {
    super('No product line matches that. Refresh the page to see the lines as they are now.');
    this.name = 'ClientsLineNotFound';
  }
}

function fieldsOf(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}
