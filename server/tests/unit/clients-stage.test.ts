import { describe, expect, it } from 'vitest';
import {
  type DealOnTheLadder,
  isSigned,
  outcomeAt,
  readStageMove,
  refusalOfMove,
  type Stage,
  STAGES,
} from '../../src/apps/clients/stage.js';
import { problemFor } from '../../src/core/http/problems.js';

/**
 * The rules for moving a deal by hand. #278, Clients SRS CLI 18 to CLI 25, TDD 5. Pure; the
 * database holds the same ladder (clients-schema.test.ts), and the API test drives both.
 */

function at(stage: Stage, hasPoc: boolean | null = null): DealOnTheLadder {
  return { stage, hasPoc, outcome: 'OPEN', product: { name: 'CreditStudio' } };
}

/** The name of what refuses a move, or null where it may be made. */
function refusal(deal: DealOnTheLadder, toStage: Stage, note: string | null = null) {
  return refusalOfMove(deal, { toStage, note })?.name ?? null;
}

describe('the ladder', () => {
  /* CLI 18. */
  it('is the seven stages, in order', () => {
    expect(STAGES).toEqual([
      'DISCOVERY',
      'QUALIFICATION',
      'PROPOSAL',
      'NEGOTIATION',
      'CONTRACT_SIGNED',
      'POC',
      'LIVE',
    ]);
  });

  /* CLI 25. */
  it('wins a deal at Live, and nowhere else', () => {
    expect(STAGES.filter((stage) => outcomeAt(stage) === 'WON')).toEqual(['LIVE']);
  });

  it('counts a deal as signed from Contract signed onward', () => {
    expect(STAGES.filter(isSigned)).toEqual(['CONTRACT_SIGNED', 'POC', 'LIVE']);
  });
});

describe('moving a deal by hand', () => {
  /* CLI 20. */
  it('goes forward by one stage or several, up to Negotiation, with no POC answer', () => {
    for (const to of ['QUALIFICATION', 'PROPOSAL', 'NEGOTIATION'] as const) {
      expect(refusal(at('DISCOVERY'), to)).toBeNull();
    }
  });

  /* CLI 19. */
  it('needs the POC question answered to reach Contract signed or beyond', () => {
    expect(refusal(at('NEGOTIATION'), 'CONTRACT_SIGNED')).toBe('PocDecisionRequired');
    expect(refusal(at('DISCOVERY'), 'LIVE')).toBe('PocDecisionRequired');
    expect(refusal(at('NEGOTIATION', false), 'CONTRACT_SIGNED')).toBeNull();
    expect(refusal(at('DISCOVERY', true), 'CONTRACT_SIGNED')).toBeNull();
  });

  /* CLI 21. */
  it('goes back before Contract signed only with a note', () => {
    expect(refusal(at('NEGOTIATION'), 'DISCOVERY')).toBe('MovingBackNeedsANote');
    expect(refusal(at('NEGOTIATION'), 'DISCOVERY', 'Their CFO left')).toBeNull();
  });

  /* CLI 21, AC L06. */
  it('never goes back from Contract signed, note or no note', () => {
    expect(refusal(at('CONTRACT_SIGNED', false), 'PROPOSAL', 'Legal')).toBe(
      'ContractSignedIsFinal',
    );
  });

  /* CLI 24, CLI 25, AC L04. */
  it('goes to Live from Contract signed with no POC', () => {
    expect(refusal(at('CONTRACT_SIGNED', false), 'LIVE')).toBeNull();
    expect(refusal(at('NEGOTIATION', false), 'LIVE')).toBe('LiveAfterSigning');
  });

  /* CLI 24, AC L05. */
  it('never takes a deal with a POC to Live, or into or out of its POC', () => {
    expect(refusal(at('CONTRACT_SIGNED', true), 'LIVE')).toBe('PocDecides');
    expect(refusal(at('CONTRACT_SIGNED', true), 'POC')).toBe('PocStartsIt');
    expect(refusal(at('POC', true), 'LIVE')).toBe('PocDecides');
  });

  it('is refused to where the deal is already', () => {
    expect(refusal(at('PROPOSAL'), 'PROPOSAL', 'again')).toBe('AlreadyAtStage');
  });

  /* Each is a refusal the person can act on, not a fault (problems.ts). */
  it('answers each refusal with a status and a sentence, never a five hundred', () => {
    const cases: [DealOnTheLadder, Stage, number][] = [
      [at('PROPOSAL'), 'PROPOSAL', 409],
      [at('CONTRACT_SIGNED', false), 'PROPOSAL', 409],
      [at('PROPOSAL'), 'DISCOVERY', 400],
      [at('NEGOTIATION'), 'CONTRACT_SIGNED', 409],
      [at('CONTRACT_SIGNED', true), 'POC', 409],
      [at('CONTRACT_SIGNED', true), 'LIVE', 409],
      [at('NEGOTIATION', false), 'LIVE', 409],
    ];

    for (const [deal, to, status] of cases) {
      const error = refusalOfMove(deal, { toStage: to, note: null });
      expect(error).not.toBeNull();
      expect(problemFor(error).status).toBe(status);
    }
  });
});

describe('reading a move', () => {
  it('takes a stage, and a note trimmed, or none where it is blank', () => {
    expect(readStageMove({ toStage: 'PROPOSAL', note: '  Sent  ' })).toEqual({
      toStage: 'PROPOSAL',
      note: 'Sent',
    });
    expect(readStageMove({ toStage: 'PROPOSAL', note: '   ' })).toEqual({
      toStage: 'PROPOSAL',
      note: null,
    });
    expect(readStageMove({ toStage: 'PROPOSAL' }).note).toBeNull();
  });

  it('refuses a stage there is not, and a note that is not text or too long', () => {
    for (const [body, field] of [
      [{ toStage: 'Proposal' }, 'toStage'],
      [null, 'toStage'],
      [{ toStage: 'PROPOSAL', note: 3 }, 'note'],
      [{ toStage: 'PROPOSAL', note: 'x'.repeat(2001) }, 'note'],
    ] as const) {
      expect(() => readStageMove(body)).toThrow(expect.objectContaining({ field }));
      try {
        readStageMove(body);
      } catch (error) {
        expect(problemFor(error).status).toBe(400);
      }
    }
  });
});
