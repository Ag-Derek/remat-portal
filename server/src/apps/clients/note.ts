/**
 * A note on a client: a heading to find it by, and the note itself. #278.
 *
 * Standing facts about a client, "How they buy", "Who signs off", as many as are wanted. Things
 * that happened on a day are its activity instead. Written by anybody with a clients role;
 * changed and archived by whoever wrote it or a BD manager. Archived rather than deleted (CLI 57),
 * and brought back the same way.
 */

import type { Person } from './client.js';

export interface ClientNote {
  id: string;
  heading: string;
  body: string;
  writtenBy: Person;
  writtenAt: Date;
  /** When it was last changed, or null if it never was. */
  editedAt: Date | null;
  /** When it was archived, or null while it is current. */
  archivedAt: Date | null;
}

/** A note, with what the person reading it may do to it: the policy's answer. */
export type NoteView = ClientNote & { may: { change: boolean } };

export interface NewNote {
  heading: string;
  body: string;
}

/** Only what is present changes. */
export interface NoteChange {
  heading?: string;
  body?: string;
}

export const MAX_HEADING_LENGTH = 120;
export const MAX_BODY_LENGTH = 4000;

/** A request that makes no sense, naming the field to fix. */
export class InvalidNote extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidNote';
    this.field = field;
  }
}

export class NoteNotFound extends Error {
  constructor() {
    super('No note matches that. Refresh the page to see the notes as they are now.');
    this.name = 'NoteNotFound';
  }
}

/** Archived notes are kept as they were. Bringing it back is the fix. */
export class NoteArchived extends Error {
  constructor() {
    super('This note is archived. Bring it back before changing it.');
    this.name = 'NoteArchived';
  }
}

/** A new note, from a request body. */
export function readNewNote(body: unknown): NewNote {
  const fields = fieldsOf(body);

  return {
    heading: readText(fields.heading, 'heading', 'a heading', MAX_HEADING_LENGTH),
    body: readText(fields.body, 'body', 'the note', MAX_BODY_LENGTH),
  };
}

/** A change to a note, from a request body. Fields left out are left as they are. */
export function readNoteChange(body: unknown): NoteChange {
  const fields = fieldsOf(body);
  const change: NoteChange = {};

  if (fields.heading !== undefined) {
    change.heading = readText(fields.heading, 'heading', 'a heading', MAX_HEADING_LENGTH);
  }
  if (fields.body !== undefined) {
    change.body = readText(fields.body, 'body', 'the note', MAX_BODY_LENGTH);
  }

  return change;
}

/** Trimmed text, which is needed: a note with no heading or nothing in it is no note. */
function readText(value: unknown, field: string, what: string, longest: number): string {
  const text = typeof value === 'string' ? value.trim() : '';

  if (text === '') {
    throw new InvalidNote(field, `Write ${what}.`);
  }
  if (text.length > longest) {
    throw new InvalidNote(field, `Keep ${what} to ${String(longest)} characters.`);
  }

  return text;
}

function fieldsOf(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}
