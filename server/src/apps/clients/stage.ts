/**
 * The seven stage ladder a deal climbs, from Discovery to Live. #278, Clients SRS CLI 18 to CLI
 * 26, TDD 5.
 *
 * Stage and outcome are separate (TDD 1, principle 2): the stage says how far a deal came, the
 * outcome whether it is still open. A deal is won at Live and nowhere else (CLI 25), because a
 * signed contract whose free POC then fails never earns anything.
 *
 * {@link refusalOfMove} is every rule about moving a deal by hand, pure, so the service asks it
 * before writing and the screen can be tested against it. The database holds the same rules
 * whoever writes (migration `clients-deal-stages`); this is where they are said in a sentence.
 */

import type { Person } from './client.js';
import type { Outcome } from './opportunity.js';

/** In order (CLI 18). Fixed, and not maintained as data. */
export const STAGES = [
  'DISCOVERY',
  'QUALIFICATION',
  'PROPOSAL',
  'NEGOTIATION',
  'CONTRACT_SIGNED',
  'POC',
  'LIVE',
] as const;

export type Stage = (typeof STAGES)[number];

/** How each stage is named in a sentence. */
export const STAGE_NAME: Record<Stage, string> = {
  DISCOVERY: 'Discovery',
  QUALIFICATION: 'Qualification',
  PROPOSAL: 'Proposal',
  NEGOTIATION: 'Negotiation',
  CONTRACT_SIGNED: 'Contract signed',
  POC: 'POC',
  LIVE: 'Live',
};

export const MAX_NOTE_LENGTH = 2000;

export function isStage(value: unknown): value is Stage {
  return (STAGES as readonly unknown[]).includes(value);
}

/** Where a stage stands on the ladder: Discovery is 0. */
export function rankOf(stage: Stage): number {
  return STAGES.indexOf(stage);
}

/** Whether a deal at this stage has signed its contract, after which it never moves back. */
export function isSigned(stage: Stage): boolean {
  return rankOf(stage) >= rankOf('CONTRACT_SIGNED');
}

/** A move asked for: where to, and why, which a move back must say (CLI 21). */
export interface StageMove {
  toStage: Stage;
  note: string | null;
}

/** A deal, as deciding a move needs it. */
export interface DealOnTheLadder {
  stage: Stage;
  /** Null while nobody has said. */
  hasPoc: boolean | null;
  outcome: Outcome;
  product: { name: string };
}

/** One step a deal took, or its opening. Never changed once written (CLI 26). */
export interface StageChange {
  /** Null where this is the deal being opened. */
  fromStage: Stage | null;
  toStage: Stage;
  /** Its outcome after: won where it reached Live. */
  toOutcome: Outcome;
  note: string | null;
  changedBy: Person;
  changedAt: Date;
}

/** A move from a request body: `{ toStage, note? }`. */
export function readStageMove(body: unknown): StageMove {
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

  if (!isStage(fields.toStage)) {
    throw new InvalidStageMove('toStage', 'Choose the stage to move the deal to.');
  }

  const { note } = fields;
  if (note !== undefined && note !== null && typeof note !== 'string') {
    throw new InvalidStageMove('note', 'Write the note as text.');
  }

  const written = typeof note === 'string' ? note.trim() : '';
  if (written.length > MAX_NOTE_LENGTH) {
    throw new InvalidStageMove('note', `Keep the note to ${String(MAX_NOTE_LENGTH)} characters.`);
  }

  return { toStage: fields.toStage, note: written === '' ? null : written };
}

/**
 * Why a deal may not be moved to a stage by hand, or null where it may. In TDD 5's order:
 *
 * 1. Only an open deal moves (the caller says so first, with {@link OpportunityEnded}).
 * 2. Not to where it already is.
 * 3. Never back from Contract signed onward (CLI 21, NO_BACKWARD); back before it only with a
 *    note (NOTE_REQUIRED).
 * 4. Into Contract signed or beyond only once the POC question is answered (CLI 19,
 *    HAS_POC_REQUIRED).
 * 5. Never into POC by hand (POC_STARTS_IT): starting the POC moves it (CLI 31).
 * 6. Never out of POC, or to Live with a POC, by hand (CLI 24, POC_DECIDES): the POC's outcome
 *    decides.
 * 7. To Live only from Contract signed (CLI 24).
 *
 * The qualification gate into Negotiation (CLI 22) and the pre-POC gate (CLI 23) join these with
 * the checklists.
 */
export function refusalOfMove(deal: DealOnTheLadder, move: StageMove): Error | null {
  const { stage: from } = deal;
  const { toStage: to } = move;
  const product = deal.product.name;

  if (to === from) {
    return new AlreadyAtStage(product, to);
  }

  if (from === 'POC') {
    return new PocDecides(product);
  }

  if (rankOf(to) < rankOf(from)) {
    if (isSigned(from)) return new ContractSignedIsFinal(product);
    if (move.note === null) return new MovingBackNeedsANote(to);
    return null;
  }

  if (isSigned(to) && deal.hasPoc === null) {
    return new PocDecisionRequired(to);
  }

  if (to === 'POC') {
    return new PocStartsIt(product);
  }

  if (to === 'LIVE') {
    if (deal.hasPoc === true) return new PocDecides(product);
    if (from !== 'CONTRACT_SIGNED') return new LiveAfterSigning(product);
  }

  return null;
}

/**
 * A stage a deal could be moved to by hand, as the screen offers it: whether it is open to it, and
 * if not, the sentence the server would refuse it with. Computed by {@link refusalOfMove}, so the
 * screen offers exactly what the server allows and the rules are written once.
 */
export interface StageOption {
  stage: Stage;
  open: boolean;
  /** Why not, where it is not open. */
  why: string | null;
  /** A move back, which needs a note saying why (CLI 21). */
  needsNote: boolean;
}

/** Every stage, and whether a deal could be moved there by hand, a note given where needed. */
export function optionsOf(deal: DealOnTheLadder): StageOption[] {
  return STAGES.map((stage) => {
    const refusal = refusalOfMove(deal, { toStage: stage, note: 'given' });

    return {
      stage,
      open: refusal === null,
      why: refusal?.message ?? null,
      needsNote: rankOf(stage) < rankOf(deal.stage),
    };
  });
}

/** The outcome a deal has after moving to a stage: won at Live, open anywhere else (CLI 25). */
export function outcomeAt(stage: Stage): Outcome {
  return stage === 'LIVE' ? 'WON' : 'OPEN';
}

/* ------------------------------------------------------------------------------ refusals */

/** A move that makes no sense as sent, naming the field to fix. */
export class InvalidStageMove extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidStageMove';
    this.field = field;
  }
}

/** Already there. Nothing to do. */
export class AlreadyAtStage extends Error {
  readonly field = 'toStage';

  constructor(productName: string, stage: Stage) {
    super(`This ${productName} deal is at ${STAGE_NAME[stage]} already.`);
    this.name = 'AlreadyAtStage';
  }
}

/** TDD's NO_BACKWARD (CLI 21). */
export class ContractSignedIsFinal extends Error {
  readonly field = 'toStage';

  constructor(productName: string) {
    super(
      `The ${productName} contract is signed, so the deal does not move back. If it will not ` +
        'go ahead, end it instead.',
    );
    this.name = 'ContractSignedIsFinal';
  }
}

/** TDD's NOTE_REQUIRED (CLI 21). The note box is the fix. */
export class MovingBackNeedsANote extends Error {
  readonly field = 'note';

  constructor(to: Stage) {
    super(`Say why the deal is going back to ${STAGE_NAME[to]}.`);
    this.name = 'MovingBackNeedsANote';
  }
}

/** TDD's HAS_POC_REQUIRED (CLI 19). Answering the question is the fix. */
export class PocDecisionRequired extends Error {
  readonly field = 'hasPoc';

  constructor(to: Stage) {
    super(`Say whether there will be a POC before moving the deal to ${STAGE_NAME[to]}.`);
    this.name = 'PocDecisionRequired';
  }
}

/** TDD's HAS_POC_FIXED (CLI 19). */
export class PocDecisionFixed extends Error {
  readonly field = 'hasPoc';

  constructor(productName: string) {
    super(`The ${productName} contract is signed, so whether there is a POC is settled.`);
    this.name = 'PocDecisionFixed';
  }
}

/** TDD's POC_STARTS_IT (CLI 31). */
export class PocStartsIt extends Error {
  readonly field = 'toStage';

  constructor(productName: string) {
    super(
      `The ${productName} deal moves to POC when its POC is started, once every pre-POC gate is ` +
        'ticked. It is not moved there by hand.',
    );
    this.name = 'PocStartsIt';
  }
}

/** TDD's POC_DECIDES (CLI 24, AC L05). */
export class PocDecides extends Error {
  readonly field = 'toStage';

  constructor(productName: string) {
    super(
      `The ${productName} deal has a POC, so it goes live only by its POC converting. It is not ` +
        'moved there by hand.',
    );
    this.name = 'PocDecides';
  }
}

/** CLI 24. Live comes after the contract is signed. */
export class LiveAfterSigning extends Error {
  readonly field = 'toStage';

  constructor(productName: string) {
    super(
      `The ${productName} deal goes live once its contract is signed. Move it to Contract ` +
        'signed first.',
    );
    this.name = 'LiveAfterSigning';
  }
}

/** Somebody else moved it between the look and the write. Looking again is the fix. */
export class StageMovedMeanwhile extends Error {
  constructor() {
    super('Somebody moved this deal while you were looking at it. Refresh to see where it is now.');
    this.name = 'StageMovedMeanwhile';
  }
}
