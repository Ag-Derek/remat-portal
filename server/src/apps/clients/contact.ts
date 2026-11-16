/**
 * Somebody the department deals with at a client. #276, Clients SRS CLI 03, CLI 05.
 *
 * A name, and as much else as is known: a job title, an email address, a phone number. Whatever
 * is not known is null, never an empty string, so that it is shown as missing. Added and
 * corrected by anybody with a clients role. Removed rather than deleted when they move on, so
 * the record still shows who was dealt with before.
 */

/** The longest of each the columns hold. */
export const MAX_CONTACT_NAME_LENGTH = 120;
export const MAX_JOB_TITLE_LENGTH = 120;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_PHONE_LENGTH = 40;

export interface Contact {
  id: string;
  clientId: string;
  name: string;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  createdAt: Date;
  /** When they stopped being somebody to deal with there. Null while they are. */
  removedAt: Date | null;
}

/** What a new contact is made of, read from the request. */
export interface NewContact {
  name: string;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
}

/** A correction to a contact. Only what is present changes; null or blank takes it away. */
export type ContactChange = Partial<NewContact>;

/** A request that makes no sense, naming the field to fix. */
export class InvalidContact extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidContact';
    this.field = field;
  }
}

export class ContactNotFound extends Error {
  constructor() {
    super('No contact matches that. Refresh the page to see the contacts as they are now.');
    this.name = 'ContactNotFound';
  }
}

/** A contact who has been removed, asked to be corrected. Bringing them back is the fix. */
export class ContactRemoved extends Error {
  constructor(name: string) {
    super(`${name} has been removed as a contact. Bring them back first to change their details.`);
    this.name = 'ContactRemoved';
  }
}

/** A new contact, from a request body. */
export function readNewContact(body: unknown): NewContact {
  const fields = fieldsOf(body);

  return {
    name: readContactName(fields.name),
    jobTitle: readJobTitle(fields.jobTitle),
    email: readEmail(fields.email),
    phone: readPhone(fields.phone),
  };
}

/** A correction, from a request body. Fields left out are left as they are. */
export function readContactChange(body: unknown): ContactChange {
  const fields = fieldsOf(body);
  const change: ContactChange = {};

  if (fields.name !== undefined) change.name = readContactName(fields.name);
  if ('jobTitle' in fields) change.jobTitle = readJobTitle(fields.jobTitle);
  if ('email' in fields) change.email = readEmail(fields.email);
  if ('phone' in fields) change.phone = readPhone(fields.phone);

  return change;
}

function readContactName(value: unknown): string {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

  if (name === '') {
    throw new InvalidContact('name', 'Give the contact a name.');
  }
  if (name.length > MAX_CONTACT_NAME_LENGTH) {
    throw new InvalidContact(
      'name',
      `Keep the contact's name to ${String(MAX_CONTACT_NAME_LENGTH)} characters.`,
    );
  }

  return name;
}

function readJobTitle(value: unknown): string | null {
  return optionalText(value, 'jobTitle', 'job title', MAX_JOB_TITLE_LENGTH);
}

/** Something with one @ and a dot after it: enough to catch a slip, not to prove it delivers. */
function readEmail(value: unknown): string | null {
  const email = optionalText(value, 'email', 'email address', MAX_EMAIL_LENGTH);

  if (email !== null && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new InvalidContact('email', 'Write the email address in full, like ama@adb.com.gh.');
  }

  return email;
}

/**
 * Digits, with the spaces, brackets, dashes, dots and leading plus people write them with, and
 * at least six digits. Kept as written: "+233 30 278 3111" stays readable.
 */
function readPhone(value: unknown): string | null {
  const phone = optionalText(value, 'phone', 'phone number', MAX_PHONE_LENGTH);

  if (phone !== null && (!/^\+?[0-9 ().-]+$/.test(phone) || phone.replace(/\D/g, '').length < 6)) {
    throw new InvalidContact('phone', 'Write the phone number in digits, like +233 30 278 3111.');
  }

  return phone;
}

/** Trimmed text, or null where it was left out or left blank. */
function optionalText(value: unknown, field: string, what: string, max: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new InvalidContact(field, `Write the ${what} as text.`);
  }

  const text = value.trim();

  if (text.length > max) {
    throw new InvalidContact(field, `Keep the ${what} to ${String(max)} characters.`);
  }

  return text === '' ? null : text;
}

function fieldsOf(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}
