/**
 * The checklists: items kept per product line and client type, in five groups. #284, Clients SRS
 * CLI 39 to CLI 43, TDD 4.4.
 *
 * A checklist is the items of one line and one client type. There is nothing else to it: a line
 * and type with no items has no checklist, and every gate passes for it (CLI 43). Deals and POCs
 * are judged by copies taken from it, so editing an item never changes one already copied (CLI
 * 40).
 */

import type { CalendarDate } from '../../core/calendar/time.js';

/**
 * In the order a deal and its POC meet them: the qualification criteria before Negotiation (CLI
 * 22), the pre-POC gates before the POC (CLI 23), and the checks of each of its three phases (CLI
 * 32). Fixed, as the stages are, and not maintained as data.
 */
export const CHECKLIST_GROUPS = [
  'QUALIFICATION',
  'PRE_POC',
  'FOUNDATION',
  'DEEPENING',
  'CONVERTING',
] as const;

export type ChecklistGroup = (typeof CHECKLIST_GROUPS)[number];

/** How each group is named on the screen. */
export const CHECKLIST_GROUP_NAMES: Record<ChecklistGroup, string> = {
  QUALIFICATION: 'Qualification criteria',
  PRE_POC: 'Pre-POC gates',
  FOUNDATION: 'Foundation',
  DEEPENING: 'Deepening',
  CONVERTING: 'Converting',
};

export function isChecklistGroup(value: unknown): value is ChecklistGroup {
  return (CHECKLIST_GROUPS as readonly unknown[]).includes(value);
}

/** One item of a checklist, as the template holds it. */
export interface ChecklistItem {
  id: string;
  lineId: string;
  clientTypeId: string;
  group: ChecklistGroup;
  label: string;
  /** Where it comes in its group; ties fall back to the order items were added. */
  sort: number;
  /**
   * A qualification criterion that applies only to a deal with a POC (CLI 41). A deal that
   * won't have one isn't held to it; one that hasn't said yet is, so nothing slips through
   * undecided.
   */
  pocOnly: boolean;
  /** A retired item is copied onto nothing new; every copy already taken keeps it. */
  retiredOn: CalendarDate | null;
}

/* ------------------------------------------------------------ copies and their ticks */

/** Somebody who ticked something. */
export interface Ticker {
  id: string;
  name: string;
}

/** One tick or untick of a check: what it was set to, by whom, and when (CLI 41). */
export interface Tick {
  ticked: boolean;
  by: Ticker;
  at: Date;
}

/**
 * A deal's or a POC's own copy of one item, as it stood when copied (CLI 40), and whether it is
 * ticked now: by its latest tick, unticked if it has none.
 */
export interface Check {
  id: string;
  group: ChecklistGroup;
  label: string;
  pocOnly: boolean;
  sort: number;
  ticked: boolean;
  /** Its latest tick or untick; null if nobody has touched it. */
  latest: Tick | null;
}

/** Whose checks: a deal's criteria and pre-POC gates, or a POC's phase checks. */
export interface ChecklistOwner {
  on: 'DEAL' | 'POC';
  id: string;
}

/** A deal's or a POC's checks, in their groups' order, and whether the asker may tick them. */
export interface Checklist extends ChecklistOwner {
  checks: Check[];
  may: { tick: boolean };
}

/** In the order a deal and its POC meet them, then each group's own order. */
export function inChecklistOrder(one: Check, other: Check): number {
  return (
    CHECKLIST_GROUPS.indexOf(one.group) - CHECKLIST_GROUPS.indexOf(other.group) ||
    one.sort - other.sort ||
    Number(one.id) - Number(other.id)
  );
}

/** Whether to tick or untick, from `{ ticked }`. */
export function readTick(body: unknown): boolean {
  const ticked =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>).ticked
      : undefined;

  if (typeof ticked !== 'boolean') {
    throw new InvalidTick('Say whether to tick it or untick it.');
  }

  return ticked;
}

export class CheckNotFound extends Error {
  constructor() {
    super('No checklist item matches that. Refresh the page to see the checklist as it is now.');
    this.name = 'CheckNotFound';
  }
}

export class InvalidTick extends Error {
  readonly field = 'ticked';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidTick';
  }
}

/**
 * A tick on a ticked check, or an untick on one that isn't (the user, 23 November 2026): the
 * history says only what moved.
 */
export class TickUnchanged extends Error {
  constructor(label: string, ticked: boolean) {
    super(`"${label}" is ${ticked ? 'ticked' : 'not ticked'} already.`);
    this.name = 'TickUnchanged';
  }
}

/* ------------------------------------------------------------ the editor, CLI 40, CLI 42 */

/** As long as a label may be: the column's own width. */
export const MAX_CHECK_LABEL_LENGTH = 200;

/** A new item for a checklist: which, its group, its words, and whether for POC deals only. */
export interface NewChecklistItem {
  lineId: string;
  clientTypeId: string;
  group: ChecklistGroup;
  label: string;
  pocOnly: boolean;
}

/** What changes about an item: its words, whether it is for POC deals only, or both. */
export interface ChecklistItemChange {
  label?: string;
  pocOnly?: boolean;
}

/** `{ lineId, clientTypeId, group, label, pocOnly? }`. */
export function readNewChecklistItem(body: unknown): NewChecklistItem {
  const fields = fieldsOf(body);

  const lineId = readAnId(fields.lineId, 'lineId', 'Choose the product line.');
  const clientTypeId = readAnId(fields.clientTypeId, 'clientTypeId', 'Choose the client type.');
  if (!isChecklistGroup(fields.group)) {
    throw new InvalidChecklistItem('group', 'Choose which part of the checklist it goes in.');
  }
  const label = readLabel(fields.label);
  const pocOnly = readPocOnly(fields.pocOnly, fields.group) ?? false;

  return { lineId, clientTypeId, group: fields.group, label, pocOnly };
}

/** `{ label?, pocOnly? }`: only what is present changes. `group` is the item's, to check against. */
export function readChecklistItemChange(body: unknown, group: ChecklistGroup): ChecklistItemChange {
  const fields = fieldsOf(body);
  const change: ChecklistItemChange = {};

  if (fields.label !== undefined) change.label = readLabel(fields.label);
  const pocOnly = readPocOnly(fields.pocOnly, group);
  if (pocOnly !== undefined) change.pocOnly = pocOnly;

  return change;
}

/** `{ direction: 'UP' | 'DOWN' }`: one place up or down its group. */
export function readDirection(body: unknown): 'UP' | 'DOWN' {
  const { direction } = fieldsOf(body);

  if (direction !== 'UP' && direction !== 'DOWN') {
    throw new InvalidChecklistItem('direction', 'Say whether to move it up or down.');
  }
  return direction;
}

/** `{ lineId, clientTypeId }`, from a query or a body: which checklist. */
export function readWhichChecklist(body: unknown): { lineId: string; clientTypeId: string } {
  const fields = fieldsOf(body);

  return {
    lineId: readAnId(fields.lineId, 'lineId', 'Choose the product line.'),
    clientTypeId: readAnId(fields.clientTypeId, 'clientTypeId', 'Choose the client type.'),
  };
}

/** `{ fromLineId, fromClientTypeId }`: the checklist to copy an empty one from. */
export function readCopyFrom(body: unknown): { lineId: string; clientTypeId: string } {
  const fields = fieldsOf(body);

  return {
    lineId: readAnId(fields.fromLineId, 'fromLineId', 'Choose the product line to copy from.'),
    clientTypeId: readAnId(
      fields.fromClientTypeId,
      'fromClientTypeId',
      'Choose the client type to copy from.',
    ),
  };
}

function fieldsOf(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

function readAnId(value: unknown, field: string, message: string): string {
  const id = typeof value === 'number' ? String(value) : value;

  if (typeof id !== 'string' || !/^[1-9]\d{0,17}$/.test(id)) {
    throw new InvalidChecklistItem(field, message);
  }
  return id;
}

function readLabel(value: unknown): string {
  const label = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';

  if (label === '') {
    throw new InvalidChecklistItem('label', 'Say what has to be done or shown.');
  }
  if (label.length > MAX_CHECK_LABEL_LENGTH) {
    throw new InvalidChecklistItem(
      'label',
      `Keep it to ${String(MAX_CHECK_LABEL_LENGTH)} characters.`,
    );
  }
  return label;
}

/** Undefined where not said. Only a qualification criterion can be for POC deals only (CLI 41). */
function readPocOnly(value: unknown, group: ChecklistGroup): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new InvalidChecklistItem('pocOnly', 'Say whether it is for POC deals only.');
  }
  if (value && group !== 'QUALIFICATION') {
    throw new InvalidChecklistItem(
      'pocOnly',
      'Only a qualification criterion can be for POC deals only; the rest are about the POC already.',
    );
  }
  return value;
}

/** An item that makes no sense as sent, naming the field to fix. */
export class InvalidChecklistItem extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidChecklistItem';
    this.field = field;
  }
}

export class ChecklistItemNotFound extends Error {
  constructor() {
    super('No checklist item matches that. Refresh the page to see the checklist as it is now.');
    this.name = 'ChecklistItemNotFound';
  }
}

/** Its group of the checklist says that already, ignoring case and spaces. */
export class ChecklistItemLabelTaken extends Error {
  readonly field = 'label';

  constructor(label: string) {
    super(`"${label}" is in this part of the checklist already.`);
    this.name = 'ChecklistItemLabelTaken';
  }
}

/** Copying is for filling an empty checklist, so it never mixes two into one. */
export class ChecklistNotEmpty extends Error {
  constructor() {
    super(
      'This checklist has items already, so nothing was copied into it. Copying fills an empty ' +
        'checklist; add to this one item by item instead.',
    );
    this.name = 'ChecklistNotEmpty';
  }
}
