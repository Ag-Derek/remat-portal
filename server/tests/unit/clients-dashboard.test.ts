import { describe, expect, it } from 'vitest';
import { dashboardOf, OPEN_STAGES } from '../../src/apps/clients/dashboard.js';
import type { Currency, Opportunity } from '../../src/apps/clients/opportunity.js';
import type { PipelineDeal } from '../../src/apps/clients/pipeline.js';
import type { PocHealth, PocView } from '../../src/apps/clients/poc.js';
import type { Stage } from '../../src/apps/clients/stage.js';

/** The dashboard, with no database. #289, Clients SRS CLI 102. */

const TODAY = '2026-11-24';

let next = 0;

function aDeal(
  stage: Stage,
  value: [number, Currency] | null = null,
  probability: number | null = null,
): PipelineDeal {
  next += 1;

  return {
    deal: {
      id: String(next),
      client: { id: String(next), name: `Client ${String(next)}` },
      product: { id: '10', name: 'Federation', lineId: '1', lineName: 'Symphony' },
      owner: { id: '100', name: 'Mavis Ansah' },
      stage,
      outcome: 'OPEN',
      value: value === null ? null : { amountMinor: value[0], currency: value[1] },
      probability,
    } as Opportunity,
    clientTypeId: '5',
    clientType: 'Bank',
    nextStep: null,
    lastContact: null,
  };
}

function aPoc(health: PocHealth, daysToDecision: number, flagged = false): PocView {
  next += 1;

  return {
    id: String(next),
    health,
    daysToDecision,
    deal: { outcome: 'OPEN' },
    csLeadStanding: null,
    flags: flagged ? [{ kind: 'PAST_DECISION', since: new Date() }] : [],
  } as unknown as PocView;
}

describe('where every open deal sits', () => {
  it('lists every open stage up to POC, in order, the empty ones too', () => {
    const { stages } = dashboardOf([], [], [], TODAY);

    expect(stages.map((one) => one.stage)).toEqual(OPEN_STAGES);
    expect(OPEN_STAGES).not.toContain('LIVE');
    expect(stages.every((one) => one.opportunities === 0 && one.recorded.length === 0)).toBe(true);
  });

  it("counts each stage's deals, and totals their value per currency", () => {
    const { stages } = dashboardOf(
      [
        aDeal('QUALIFICATION', [10_000, 'USD'], 50),
        aDeal('QUALIFICATION', [20_000, 'GHS'], 50),
        aDeal('QUALIFICATION'),
        aDeal('NEGOTIATION', [8_000, 'USD'], null),
      ],
      [],
      [],
      TODAY,
    );
    const at = (stage: Stage) => stages.find((one) => one.stage === stage);

    expect(at('QUALIFICATION')).toEqual({
      stage: 'QUALIFICATION',
      opportunities: 3,
      recorded: [
        { currency: 'GHS', amountMinor: 20_000 },
        { currency: 'USD', amountMinor: 10_000 },
      ],
      noValue: 1,
    });
    expect(at('NEGOTIATION')).toMatchObject({
      opportunities: 1,
      recorded: [{ currency: 'USD', amountMinor: 8_000 }],
    });
  });

  it('totals the whole pipeline as the company pipeline does', () => {
    const { totals } = dashboardOf([aDeal('POC', [10_000, 'USD'], 70)], [], [], TODAY);

    expect(totals.recorded).toEqual([{ currency: 'USD', amountMinor: 10_000 }]);
    expect(totals.opportunities).toBe(1);
  });
});

describe('clients gone quiet', () => {
  it('lists those not spoken to in over 30 days, the longest first', () => {
    const { quiet } = dashboardOf(
      [],
      [],
      [
        { id: '1', name: 'Republic Bank', lastContact: '2026-10-05' },
        { id: '2', name: 'Direct Savings', lastContact: '2026-09-15' },
        { id: '3', name: 'ADB', lastContact: '2026-11-17' },
      ],
      TODAY,
    );

    expect(quiet).toEqual([
      { id: '2', name: 'Direct Savings', lastContact: '2026-09-15', daysAgo: 70 },
      { id: '1', name: 'Republic Bank', lastContact: '2026-10-05', daysAgo: 50 },
    ]);
  });

  it('is quiet at 31 days, and not at 30', () => {
    const { quiet } = dashboardOf(
      [],
      [],
      [
        { id: '1', name: 'Thirty', lastContact: '2026-10-25' },
        { id: '2', name: 'Thirty-one', lastContact: '2026-10-24' },
      ],
      TODAY,
    );

    expect(quiet.map((client) => [client.name, client.daysAgo])).toEqual([['Thirty-one', 31]]);
  });

  it('counts those never spoken to, rather than listing them', () => {
    const dashboard = dashboardOf(
      [],
      [],
      [
        { id: '1', name: 'GT Bank', lastContact: null },
        { id: '2', name: 'Standard Chartered', lastContact: null },
      ],
      TODAY,
    );

    expect(dashboard.quiet).toEqual([]);
    expect(dashboard.neverContacted).toBe(2);
  });
});

describe('POCs by health', () => {
  it('counts the running ones at each health', () => {
    const ended = { ...aPoc('STALLED', 0), deal: { outcome: 'WON' } } as unknown as PocView;
    const { pocs } = dashboardOf(
      [],
      [aPoc('ON_TRACK', 10), aPoc('ON_TRACK', 20), aPoc('AT_RISK', 5), ended],
      [],
      TODAY,
    );

    expect(pocs.health).toEqual({ ON_TRACK: 2, AT_RISK: 1, STALLED: 0 });
  });

  it('lists the ones needing a look: Stalled, At Risk, then flagged On Track', () => {
    const fine = aPoc('ON_TRACK', 1);
    const flagged = aPoc('ON_TRACK', -3, true);
    const risky = aPoc('AT_RISK', 30);
    const riskier = aPoc('AT_RISK', 2);
    const stalled = aPoc('STALLED', 40);

    const { pocs } = dashboardOf([], [fine, flagged, risky, riskier, stalled], [], TODAY);

    expect(pocs.attention.map((poc) => poc.id)).toEqual([
      stalled.id,
      riskier.id,
      risky.id,
      flagged.id,
    ]);
  });
});
