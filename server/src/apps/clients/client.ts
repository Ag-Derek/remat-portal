/**
 * A client: one record per bank, broker or lender the department sells to. #276, Clients SRS
 * CLI 02, CLI 05.
 *
 * The client is the record. Its deals, its contacts and the products it already uses each hang
 * off it. It has a name, a type and an owner, and any number of notes, each with a heading
 * (#278).
 */

import type { CalendarDate } from '../../core/calendar/time.js';
import type { Contact } from './contact.js';
import type { ClientNote } from './note.js';
import type { Opportunity } from './opportunity.js';
import { isAnId } from './product.js';
import type { ProductInUse } from './product-in-use.js';

/**
 * What kind of institution a client is. A list that grows rather than a fixed one: it starts
 * with Bank, Broker, Microfinance institution, Digital lender and DFI, and takes others as the
 * department sells to them. Retired rather than deleted, so a client of a retired type keeps it.
 */
export interface ClientType {
  id: string;
  name: string;
  /** The day it stopped being offered for new clients, or null while it is. */
  retiredOn: CalendarDate | null;
}

/** A person a client page names: its owner, for now. */
export interface Person {
  id: string;
  /** "Ama Mensah". */
  name: string;
}

export interface Client {
  id: string;
  name: string;
  type: { id: string; name: string };
  /** Who looks after it. */
  owner: Person;
  createdAt: Date;
  /** Its contacts by name, removed ones included and marked. */
  contacts: Contact[];
  /** The products it uses or has used, by name, those it stopped using marked with the day. */
  products: ProductInUse[];
  /** Its deals, open first and then ended, each newest first (CLI 55, CLI 99). #277. */
  opportunities: Opportunity[];
  /** Its notes, newest first, archived ones included and marked. #278. */
  notes: ClientNote[];
}

/** A client as the clients list shows it. */
export type ClientSummary = Pick<Client, 'id' | 'name' | 'type' | 'owner'>;

/**
 * What the person reading a client page may do there: the policy's own answers, so the screen
 * offers only what the server would allow. The server still refuses whatever it refuses.
 */
export interface ClientPermissions {
  /** Its name and type. Its owner's or a BD manager's. */
  change: boolean;
  /** Moving it to somebody else. A BD manager's. */
  reassign: boolean;
  /** Adding and correcting contacts and products, opening a deal, and adding a note. */
  contribute: boolean;
}

/** A type's name, from a request body. */
export function readClientTypeName(body: unknown): string {
  const name = fieldsOf(body).name;
  const tidied = typeof name === 'string' ? tidy(name) : '';

  if (tidied === '') {
    throw new InvalidClient('name', 'Give the client type a name.');
  }
  if (tidied.length > MAX_CLIENT_TYPE_NAME_LENGTH) {
    throw new InvalidClient(
      'name',
      `Keep the client type's name to ${String(MAX_CLIENT_TYPE_NAME_LENGTH)} characters.`,
    );
  }

  return tidied;
}

/** What a new client is made of, read from the request. The owner is whoever asks. */
export interface NewClient {
  name: string;
  typeId: string;
}

/** What a change to a client asks for. Only what is present changes. */
export interface ClientChange {
  name?: string;
  typeId?: string;
  ownerId?: string;
}

/** The longest names the columns hold. */
export const MAX_CLIENT_NAME_LENGTH = 120;
export const MAX_CLIENT_TYPE_NAME_LENGTH = 60;

/** A request that makes no sense, naming the field to fix. */
export class InvalidClient extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidClient';
    this.field = field;
  }
}

/**
 * Another client already has the name, once case and spacing are set aside (CLI 02). Names the
 * client as it is recorded, so that whoever typed " adb" learns it is there as "ADB".
 */
export class ClientAlreadyRecorded extends Error {
  readonly field = 'name';

  constructor(existingName: string) {
    super(
      `${existingName} is already a client. Each client is recorded once, so add to that one ` +
        'instead.',
    );
    this.name = 'ClientAlreadyRecorded';
  }
}

export class ClientTypeNotFound extends Error {
  constructor() {
    super('No client type matches that. Refresh the page to see the types as they are now.');
    this.name = 'ClientTypeNotFound';
  }
}

export class ClientNotFound extends Error {
  constructor() {
    super('No client matches that. Refresh the page to see the clients as they are now.');
    this.name = 'ClientNotFound';
  }
}

/** A new client, from a request body. */
export function readNewClient(body: unknown): NewClient {
  const fields = fieldsOf(body);

  return {
    name: readClientName(fields.name),
    typeId: readTypeId(fields.typeId),
  };
}

/** A change to a client, from a request body. Fields left out are left as they are. */
export function readClientChange(body: unknown): ClientChange {
  const fields = fieldsOf(body);
  const change: ClientChange = {};

  if (fields.name !== undefined) change.name = readClientName(fields.name);
  if (fields.typeId !== undefined) change.typeId = readTypeId(fields.typeId);
  if (fields.ownerId !== undefined) change.ownerId = readOwnerId(fields.ownerId);

  return change;
}

/**
 * A client's name, tidied as it is compared: trimmed, and each run of spaces inside it one
 * space. Case is kept as typed; "ADB" stays "ADB".
 */
export function readClientName(value: unknown): string {
  const name = typeof value === 'string' ? tidy(value) : '';

  if (name === '') {
    throw new InvalidClient('name', 'Give the client a name.');
  }
  if (name.length > MAX_CLIENT_NAME_LENGTH) {
    throw new InvalidClient(
      'name',
      `Keep the client's name to ${String(MAX_CLIENT_NAME_LENGTH)} characters.`,
    );
  }

  return name;
}

export function readTypeId(value: unknown): string {
  if (typeof value !== 'string' || !isAnId(value)) {
    throw new InvalidClient('typeId', 'Choose what kind of institution the client is.');
  }

  return value;
}

export function readOwnerId(value: unknown): string {
  if (typeof value !== 'string' || !isAnId(value)) {
    throw new InvalidClient('ownerId', 'Choose who looks after the client.');
  }

  return value;
}

/** Trimmed, with each run of white space inside one space: as clients_name_key compares. */
function tidy(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function fieldsOf(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}
