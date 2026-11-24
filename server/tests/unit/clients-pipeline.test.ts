import { describe, expect, it } from 'vitest';
import type { Currency, Opportunity } from '../../src/apps/clients/opportunity.js';
import {
  choicesOf,
  filtered,
  InvalidPipelineFilter,
  type PipelineDeal,
  readPipelineFilters,
  totalsOf,
  weightedOf,
} from '../../src/apps/clients/pipeline.js';
import type { Stage } from '../../src/apps/clients/stage.js';

/** The company pipeline's filters and figures, with no database. #289, CLI 75, 76, 98, TDD 8. */

let next = 0;

interface Shape {
  client?: string;
  value?: [number, Currency] | null;
  probability?: number | null;
  line?: [string, string];
  product?: [string, string];
  stage?: Stage;
  owner?: [string, string];
  type?: [string, string];
}

/** An open deal, with only what the pipeline reads of it. Values are in minor units. */
function aDeal(shape: Shape = {}): PipelineDeal {
  next += 1;
  const [lineId, lineName] = shape.line ?? ['1', 'Symphony'];
  const [productId, productName] = shape.product ?? ['10', 'Federation'];
  const [ownerId, ownerName] = shape.owner ?? ['100', 'Mavis Ansah'];
  const [typeId, typeName] = shape.type ?? ['5', 'Bank'];
  const value = shape.value === undefined ? null : shape.value;

  return {
    deal: {
      id: String(next),
      client: { id: shape.client ?? String(next), name: `Client ${String(next)}` },
      product: { id: productId, name: productName, lineId, lineName },
      owner: { id: ownerId, name: ownerName },
      stage: shape.stage ?? 'DISCOVERY',
      outcome: 'OPEN',
      value: value === null ? null : { amountMinor: value[0], currency: value[1] },
      probability: shape.probability === undefined ? null : shape.probability,
    } as Opportunity,
    clientTypeId: typeId,
    clientType: typeName,
    nextStep: null,
    lastContact: null,
  };
}

describe("a deal's weighted value (CLI 76)", () => {
  it('is its value times its probability', () => {
    expect(
      weightedOf({ value: { amountMinor: 7_560_000, currency: 'USD' }, probability: 70 }),
    ).toEqual({ amountMinor: 5_292_000, currency: 'USD' });
  });

  it('is rounded to the nearest cent, half up', () => {
    expect(weightedOf({ value: { amountMinor: 50, currency: 'GHS' }, probability: 1 })).toEqual({
      amountMinor: 1,
      currency: 'GHS',
    });
    expect(weightedOf({ value: { amountMinor: 49, currency: 'GHS' }, probability: 1 })).toEqual({
      amountMinor: 0,
      currency: 'GHS',
    });
  });

  it('is not counted with no value, or no probability', () => {
    expect(weightedOf({ value: null, probability: 50 })).toBeNull();
    expect(
      weightedOf({ value: { amountMinor: 100, currency: 'USD' }, probability: null }),
    ).toBeNull();
  });

  it('is nothing at 0%, which is counted', () => {
    expect(weightedOf({ value: { amountMinor: 100, currency: 'USD' }, probability: 0 })).toEqual({
      amountMinor: 0,
      currency: 'USD',
    });
  });
});

describe('the totals (CLI 75, CLI 76, TDD 8)', () => {
  it('never adds cedis to dollars', () => {
    const totals = totalsOf([
      aDeal({ value: [10_000, 'USD'], probability: 50 }),
      aDeal({ value: [20_000, 'GHS'], probability: 50 }),
      aDeal({ value: [30_000, 'USD'], probability: 100 }),
    ]);

    expect(totals.weighted).toEqual([
      { currency: 'GHS', amountMinor: 10_000 },
      { currency: 'USD', amountMinor: 35_000 },
    ]);
    expect(totals.recorded).toEqual([
      { currency: 'GHS', amountMinor: 20_000 },
      { currency: 'USD', amountMinor: 40_000 },
    ]);
  });

  it('rounds once, on the total, not row by row', () => {
    /* Each is half a cent, which row by row would round to a cent each: 3 cents, not 2. */
    const halves = [1, 2, 3].map(() => aDeal({ value: [50, 'USD'], probability: 1 }));

    expect(totalsOf(halves).weighted).toEqual([{ currency: 'USD', amountMinor: 2 }]);
  });

  it('weighs only deals with both a value and a probability, and records every value', () => {
    const totals = totalsOf([
      aDeal({ value: [10_000, 'USD'], probability: 50 }),
      aDeal({ value: [99_000, 'USD'], probability: null }),
      aDeal({ value: null, probability: 90 }),
    ]);

    expect(totals.weighted).toEqual([{ currency: 'USD', amountMinor: 5_000 }]);
    expect(totals.recorded).toEqual([{ currency: 'USD', amountMinor: 109_000 }]);
  });

  it('leaves out a currency nothing is counted in, rather than showing nothing', () => {
    const totals = totalsOf([aDeal({ value: [10_000, 'GHS'], probability: null })]);

    expect(totals.weighted).toEqual([]);
    expect(totals.recorded).toEqual([{ currency: 'GHS', amountMinor: 10_000 }]);
    expect(totalsOf([]).weighted).toEqual([]);
  });

  it('counts the opportunities, and the clients they are for', () => {
    const totals = totalsOf([
      aDeal({ client: 'a' }),
      aDeal({ client: 'a' }),
      aDeal({ client: 'b' }),
    ]);

    expect(totals.opportunities).toBe(3);
    expect(totals.clients).toBe(2);
  });

  /* CLI 77: what the totals leave out, by why. */
  it('counts the deals with no value, and those with a value but no probability', () => {
    const totals = totalsOf([
      aDeal({ value: [10_000, 'USD'], probability: 50 }),
      aDeal({ value: [10_000, 'USD'], probability: null }),
      aDeal({ value: [10_000, 'GHS'], probability: null }),
      aDeal({ value: null, probability: 40 }),
      /* No value is the reason, whether or not it has a probability. */
      aDeal({ value: null, probability: null }),
      /* 0% is a probability, and counted. */
      aDeal({ value: [10_000, 'USD'], probability: 0 }),
    ]);

    expect(totals.noValue).toBe(2);
    expect(totals.noProbability).toBe(2);
  });

  it('counts nothing missing where every deal has both', () => {
    const totals = totalsOf([aDeal({ value: [10_000, 'USD'], probability: 50 })]);

    expect([totals.noValue, totals.noProbability]).toEqual([0, 0]);
    expect([totalsOf([]).noValue, totalsOf([]).noProbability]).toEqual([0, 0]);
  });
});

describe('filtering (CLI 09, CLI 98)', () => {
  const studio = aDeal({ line: ['2', 'Dura Capital'], product: ['20', 'CreditStudio'] });
  const onboard = aDeal({
    line: ['2', 'Dura Capital'],
    product: ['21', 'OnboardStudio'],
    stage: 'PROPOSAL',
    owner: ['101', 'Adwoa Tetteh'],
  });
  const federation = aDeal({ type: ['6', 'Broker'] });
  const all = [studio, onboard, federation];

  const none = { lineId: null, productId: null, stage: null, ownerId: null, clientTypeId: null };

  it('keeps every deal with no filter', () => {
    expect(filtered(all, none)).toEqual(all);
  });

  it('by a line, keeps every product in it', () => {
    expect(filtered(all, { ...none, lineId: '2' })).toEqual([studio, onboard]);
  });

  it('by product, stage, owner and client type, and by several at once', () => {
    expect(filtered(all, { ...none, productId: '20' })).toEqual([studio]);
    expect(filtered(all, { ...none, stage: 'PROPOSAL' })).toEqual([onboard]);
    expect(filtered(all, { ...none, ownerId: '101' })).toEqual([onboard]);
    expect(filtered(all, { ...none, clientTypeId: '6' })).toEqual([federation]);
    expect(filtered(all, { ...none, lineId: '2', ownerId: '100' })).toEqual([studio]);
  });
});

describe('what each filter offers', () => {
  it('only what some deal has, by name, and stages up the ladder', () => {
    const choices = choicesOf([
      aDeal({ line: ['2', 'Dura Capital'], product: ['21', 'OnboardStudio'], stage: 'PROPOSAL' }),
      aDeal({ line: ['2', 'Dura Capital'], product: ['20', 'CreditStudio'] }),
      aDeal({ owner: ['101', 'Adwoa Tetteh'], type: ['6', 'Broker'] }),
    ]);

    expect(choices).toEqual({
      lines: [
        {
          id: '2',
          name: 'Dura Capital',
          products: [
            { id: '20', name: 'CreditStudio' },
            { id: '21', name: 'OnboardStudio' },
          ],
        },
        { id: '1', name: 'Symphony', products: [{ id: '10', name: 'Federation' }] },
      ],
      stages: ['DISCOVERY', 'PROPOSAL'],
      owners: [
        { id: '101', name: 'Adwoa Tetteh' },
        { id: '100', name: 'Mavis Ansah' },
      ],
      clientTypes: [
        { id: '5', name: 'Bank' },
        { id: '6', name: 'Broker' },
      ],
    });
  });
});

describe('reading the filters from a query', () => {
  function refusedOn(query: Record<string, unknown>): string | undefined {
    try {
      readPipelineFilters(query);
    } catch (error) {
      if (error instanceof InvalidPipelineFilter) return error.field;
      throw error;
    }
    return undefined;
  }

  it('reads each, and takes left out or empty as every one', () => {
    expect(
      readPipelineFilters({
        line: '1',
        product: '',
        stage: 'NEGOTIATION',
        owner: '100',
        clientType: '5',
      }),
    ).toEqual({
      lineId: '1',
      productId: null,
      stage: 'NEGOTIATION',
      ownerId: '100',
      clientTypeId: '5',
    });
    expect(readPipelineFilters({})).toEqual({
      lineId: null,
      productId: null,
      stage: null,
      ownerId: null,
      clientTypeId: null,
    });
  });

  it('refuses an id that is not one, and a stage that is not one', () => {
    expect(refusedOn({ line: 'Symphony' })).toBe('line');
    expect(refusedOn({ owner: ['1', '2'] })).toBe('owner');
    expect(refusedOn({ stage: 'WON' })).toBe('stage');
  });
});
