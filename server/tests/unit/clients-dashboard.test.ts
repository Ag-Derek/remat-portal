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
    expect(stages.every((one) => one.opportunities === 0 && one.weighted.length === 0)).toBe(true);
  });

  it("counts each stage's deals, and weighs them per currency", () => {
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
      weighted: [
        { currency: 'GHS', amountMinor: 10_000 },
        { currency: 'USD', amountMinor: 5_000 },
      ],
      noValue: 1,
      noProbability: 0,
    });
    expect(at('NEGOTIATION')).toMatchObject({ opportunities: 1, weighted: [], noProbability: 1 });
  });

  it('totals the whole pipeline as the company pipeline does', () => {
    const { totals } = dashboardOf([aDeal('POC', [10_000, 'USD'], 70)], [], [], TODAY);

    expect(totals.weighted).toEqual([{ currency: 'USD', amountMinor: 7_000 }]);
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

describe("the largest deal's share of each currency's figure (CLI 78)", () => {
  it('names the deal, per currency, with its share and whether it warns', () => {
    const big = aDeal('NEGOTIATION', [6_000, 'USD'], 100);
    const small = aDeal('PROPOSAL', [2_000, 'USD'], 100);
    const cedis = aDeal('PROPOSAL', [1_000, 'GHS'], 40);
    const { largest } = dashboardOf(
      [
        small,
        big,
        cedis,
        aDeal('PROPOSAL', [1_000, 'GHS'], 30),
        aDeal('PROPOSAL', [1_000, 'GHS'], 30),
      ],
      [],
      [],
      TODAY,
    );

    expect(largest).toEqual([
      {
        currency: 'GHS',
        deal: { id: cedis.deal.id, client: cedis.deal.client, productName: 'Federation' },
        weighted: { currency: 'GHS', amountMinor: 400 },
        percent: 40,
        counted: 3,
        warns: false,
      },
      {
        currency: 'USD',
        deal: { id: big.deal.id, client: big.deal.client, productName: 'Federation' },
        weighted: { currency: 'USD', amountMinor: 6_000 },
        percent: 75,
        counted: 2,
        warns: true,
      },
    ]);
  });

  it('rounds half up, and warns from 50%', () => {
    /* 99 of 200 is 49.5%: shown as 50%, which warns. */
    const { largest } = dashboardOf(
      [
        aDeal('PROPOSAL', [99, 'USD'], 100),
        aDeal('PROPOSAL', [55, 'USD'], 100),
        aDeal('PROPOSAL', [46, 'USD'], 100),
      ],
      [],
      [],
      TODAY,
    );

    expect(largest[0]).toMatchObject({ currency: 'USD', percent: 50, warns: true });

    const below = dashboardOf(
      [
        aDeal('PROPOSAL', [98, 'USD'], 100),
        aDeal('PROPOSAL', [51, 'USD'], 100),
        aDeal('PROPOSAL', [51, 'USD'], 100),
      ],
      [],
      [],
      TODAY,
    ).largest;
    expect(below[0]).toMatchObject({ percent: 49, warns: false });
  });

  it('works on the exact sums, not the rounded ones', () => {
    /* Three half-cents and a cent and a half: rounded first, it would be 2 of 5, 40%. */
    const halves = [1, 2, 3].map(() => aDeal('PROPOSAL', [50, 'USD'], 1));
    const larger = aDeal('PROPOSAL', [150, 'USD'], 1);

    expect(dashboardOf([...halves, larger], [], [], TODAY).largest[0]).toMatchObject({
      deal: { id: larger.deal.id },
      percent: 50,
    });
  });

  it('takes the first by client A to Z where two weigh the same', () => {
    const first = aDeal('PROPOSAL', [1_000, 'USD'], 50);
    const second = aDeal('PROPOSAL', [1_000, 'USD'], 50);

    expect(dashboardOf([first, second], [], [], TODAY).largest[0]).toMatchObject({
      deal: { id: first.deal.id },
      percent: 50,
    });
  });

  it('is all of it where it is the only deal weighed', () => {
    const only = aDeal('POC', [1_000, 'GHS'], 70);

    expect(
      dashboardOf([only, aDeal('POC', [9_000, 'GHS'], null), aDeal('POC')], [], [], TODAY).largest,
    ).toEqual([expect.objectContaining({ percent: 100, counted: 1, warns: true })]);
  });

  it('gives no share for a currency weighed at nothing, nor one with nothing weighed', () => {
    expect(
      dashboardOf(
        [aDeal('PROPOSAL', [1_000, 'USD'], 0), aDeal('PROPOSAL', [1_000, 'GHS'], null)],
        [],
        [],
        TODAY,
      ).largest,
    ).toEqual([]);
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
