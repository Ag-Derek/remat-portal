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

function at(
  stage: Stage,
  hasPoc: boolean | null = null,
  openCriteria: readonly string[] = [],
  openGates: readonly string[] = [],
): DealOnTheLadder {
  return {
    stage,
    hasPoc,
    outcome: 'OPEN',
    product: { name: 'CreditStudio' },
    openCriteria,
    openGates,
  };
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

  /* CLI 22, CLI 43, CLI 44, #284. */
  describe('past the qualification criteria', () => {
    const open = ['Point person identified', 'Finance or procurement contact identified'];

    it('goes to Negotiation or beyond only with none open, and names those that are', () => {
      expect(refusal(at('PROPOSAL', null, open), 'QUALIFICATION', 'back')).toBeNull();
      expect(refusal(at('QUALIFICATION', null, open), 'PROPOSAL')).toBeNull();
      expect(refusal(at('PROPOSAL', null, open), 'NEGOTIATION')).toBe('GateOpen');
      expect(refusal(at('PROPOSAL', false, open), 'CONTRACT_SIGNED')).toBe('GateOpen');

      expect(
        refusalOfMove(at('PROPOSAL', null, open), { toStage: 'NEGOTIATION', note: null }),
      ).toMatchObject({
        message:
          'The CreditStudio deal goes to Negotiation once its qualification criteria are ' +
          'ticked. Still to tick: Point person identified; Finance or procurement contact ' +
          'identified.',
        field: 'toStage',
      });
    });

    /* The user, 24 November 2026: unticked after the gate, the next move waits for it. */
    it('holds every forward move after Negotiation too', () => {
      expect(refusal(at('NEGOTIATION', false, open), 'CONTRACT_SIGNED')).toBe('GateOpen');
      expect(refusal(at('CONTRACT_SIGNED', false, open), 'LIVE')).toBe('GateOpen');
      expect(refusal(at('NEGOTIATION', false, open), 'PROPOSAL', 'Rethinking')).toBeNull();
    });

    /* The user, 24 November 2026: at Discovery there is no checklist to tick yet. */
    it('tells a deal skipping Qualification from Discovery to go there first', () => {
      expect(
        refusalOfMove(at('DISCOVERY', null, open), { toStage: 'NEGOTIATION', note: null })?.message,
      ).toMatch(/Move it to Qualification first, which gives it its checklist to tick\.$/);
    });

    /* CLI 43: no checklist, so nothing open. */
    it('passes a deal with nothing open', () => {
      expect(refusal(at('DISCOVERY'), 'NEGOTIATION')).toBeNull();
    });

    it('is a 409 naming the stage, so the screen can say it beside the choice', () => {
      expect(
        problemFor(
          refusalOfMove(at('PROPOSAL', null, open), { toStage: 'NEGOTIATION', note: null }),
        ).status,
      ).toBe(409);
    });
  });

  /* CLI 23, #284, #285: signing a deal with a POC starts it, so its gates come first. */
  describe('past the pre-POC gates', () => {
    const gates = ['Metrics agreed', 'User list final'];

    it('signs a deal with a POC only with none open, and names those that are', () => {
      expect(refusal(at('NEGOTIATION', true, [], gates), 'CONTRACT_SIGNED')).toBe('GateOpen');
      expect(
        refusalOfMove(at('NEGOTIATION', true, [], gates), {
          toStage: 'CONTRACT_SIGNED',
          note: null,
        })?.message,
      ).toBe(
        'The CreditStudio deal goes to Contract signed once its pre-POC gates are ticked, since ' +
          'signing starts its POC. Still to tick: Metrics agreed; User list final.',
      );
      expect(refusal(at('NEGOTIATION', true), 'CONTRACT_SIGNED')).toBeNull();
    });

    it('asks nothing of a deal without a POC, nor holds any stage before signing', () => {
      expect(refusal(at('NEGOTIATION', false, [], gates), 'CONTRACT_SIGNED')).toBeNull();
      expect(refusal(at('PROPOSAL', true, [], gates), 'NEGOTIATION')).toBeNull();
    });

    /* The user, 24 November 2026: one refusal naming both, so everything is seen at once. */
    it('names the criteria and the gates together where both are open', () => {
      expect(
        refusalOfMove(at('NEGOTIATION', true, ['Point person identified'], gates), {
          toStage: 'CONTRACT_SIGNED',
          note: null,
        }),
      ).toMatchObject({
        name: 'GateOpen',
        message:
          'The CreditStudio deal goes to Contract signed once its qualification criteria and ' +
          'pre-POC gates are ticked. Criteria still to tick: Point person identified. Gates still ' +
          'to tick: Metrics agreed; User list final.',
        criteria: ['Point person identified'],
        gates,
      });
    });
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
