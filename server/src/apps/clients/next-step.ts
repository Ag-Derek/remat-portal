/**
 * A next step: what happens next, by when, and whose it is. #280, Clients SRS CLI 63, CLI 64,
 * TDD 4.5.
 *
 * Offered when an activity is logged, or added on its own (CLI 63). Whose it is defaults to the
 * client's owner and is always somebody holding a clients role, who can see it and close it;
 * anybody outside the department is named in what it says ("Kofi in Finance to send the
 * invoice"). Closed by its owner alone, and never by itself: a day passing makes it overdue and
 * nothing else (CLI 64). Reopened by its owner or a BD manager (#280). Overdue is worked out from
 * the day it was due, never stored (TDD 1, principle 3).
 */

import { type CalendarDate, isCalendarDate } from '../../core/calendar/time.js';
import type { Person } from './client.js';
import type { DealNamed } from './logged-activity.js';
import { isAnId } from './product.js';

/** What made it (TDD 4.5). Only ACTIVITY and MANUAL are made by a person asking; see the table. */
export type NextStepSource = 'ACTIVITY' | 'REVIEW' | 'DEBRIEF' | 'MANUAL';

export interface NextStep {
  id: string;
  clientId: string;
  /** The deal it is about, or null where it is about the client. */
  deal: DealNamed | null;
  description: string;
  dueOn: CalendarDate;
  owner: Person;
  source: NextStepSource;
  /** The activity it was offered with, where its source is ACTIVITY. */
  fromActivity: string | null;
  /** Who closed it and when, or null while it is open. */
  done: { at: Date; by: Person } | null;
  createdBy: Person;
  createdAt: Date;
}

/**
 * A step as the person reading it sees it: whether it is overdue, and what they may do to it, the
 * policy's answers, for the screen to offer only those.
 */
export type NextStepView = NextStep & {
  overdue: boolean;
  may: { close: boolean; reopen: boolean };
};

/**
 * Overdue: still open, and due before today (CLI 64). Due today is not yet late, so a step missed
 * shows as overdue the day after it was due.
 */
export function isOverdue(step: Pick<NextStep, 'dueOn' | 'done'>, today: CalendarDate): boolean {
  return step.done === null && step.dueOn < today;
}

/** A step added on its own (CLI 63), about a client and optionally one of its deals. */
export interface NewNextStep extends NextStepAsked {
  clientId: string;
  opportunityId: string | null;
}

export class NextStepNotFound extends Error {
  constructor() {
    super('No next step matches that. Refresh the page to see the next steps as they are now.');
    this.name = 'NextStepNotFound';
  }
}

/** Closed already, by whoever; reopening it is the other way. */
export class NextStepAlreadyClosed extends Error {
  /** `by` where it is known who closed it; a step closed in the same moment is not read back. */
  constructor(by?: string) {
    super(
      by === undefined
        ? 'This next step was closed already.'
        : `This next step was closed already, by ${by}.`,
    );
    this.name = 'NextStepAlreadyClosed';
  }
}

/** Open already: there is nothing to reopen. */
export class NextStepNotClosed extends Error {
  constructor() {
    super('This next step is open already.');
    this.name = 'NextStepNotClosed';
  }
}

/** A step as asked for. Whose it is is left out to make it the client's owner's. */
export interface NextStepAsked {
  description: string;
  dueOn: CalendarDate;
  ownerId: string | null;
}

export const MAX_DESCRIPTION_LENGTH = 300;

/** A request that makes no sense, naming the field to fix. */
export class InvalidNextStep extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidNextStep';
    this.field = field;
  }
}

/**
 * A next step, from a request body: `{ description, dueOn, ownerId? }`. `prefix` names where it
 * sat in the request, "nextStep." when it came with an activity, so a form can put the message
 * beside the right box.
 *
 * Due today or later where somebody types it (#280): a step already late when it is written is
 * one nobody is going to take. Whether the owner holds a role is the service's.
 */
export function readNextStep(body: unknown, today: CalendarDate, prefix = ''): NextStepAsked {
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

  const description = typeof fields.description === 'string' ? fields.description.trim() : '';
  if (description === '') {
    throw new InvalidNextStep(`${prefix}description`, 'Say what happens next.');
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new InvalidNextStep(
      `${prefix}description`,
      `Keep what happens next to ${String(MAX_DESCRIPTION_LENGTH)} characters.`,
    );
  }

  if (!isCalendarDate(fields.dueOn)) {
    throw new InvalidNextStep(`${prefix}dueOn`, 'Give the day it is due by.');
  }
  if (fields.dueOn < today) {
    throw new InvalidNextStep(
      `${prefix}dueOn`,
      'That day has passed. Give the day it is due by, today or later.',
    );
  }

  const ownerId = fields.ownerId;
  if (
    ownerId !== undefined &&
    ownerId !== null &&
    (typeof ownerId !== 'string' || !isAnId(ownerId))
  ) {
    throw new InvalidNextStep(`${prefix}ownerId`, 'Choose whose it is.');
  }

  return {
    description,
    dueOn: fields.dueOn,
    ownerId: typeof ownerId === 'string' ? ownerId : null,
  };
}

/**
 * A step added on its own, from a request body: `{ clientId, opportunityId?, description, dueOn,
 * ownerId? }`. Whether the client and deal exist, and whose it may be, is the service's.
 */
export function readNewNextStep(body: unknown, today: CalendarDate): NewNextStep {
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

  if (typeof fields.clientId !== 'string' || !isAnId(fields.clientId)) {
    throw new InvalidNextStep('clientId', 'Choose the client it is for.');
  }

  const deal = fields.opportunityId;
  if (
    deal !== undefined &&
    deal !== null &&
    deal !== '' &&
    (typeof deal !== 'string' || !isAnId(deal))
  ) {
    throw new InvalidNextStep('opportunityId', "Choose one of the client's deals, or none.");
  }

  return {
    clientId: fields.clientId,
    opportunityId: typeof deal === 'string' && deal !== '' ? deal : null,
    ...readNextStep(body, today),
  };
}
