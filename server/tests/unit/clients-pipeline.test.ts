import { describe, expect, it } from 'vitest';
import type { Currency, Opportunity } from '../../src/apps/clients/opportunity.js';
import {
  choicesOf,
  filtered,
  InvalidPipelineFilter,
  type PipelineDeal,
  readPipelineFilters,
  totalsOf,
} from '../../src/apps/clients/pipeline.js';
import type { Stage } from '../../src/apps/clients/stage.js';

/** The company pipeline's filters and figures, with no database. #289, CLI 75, 77, 98, TDD 8. */

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

describe('the totals (CLI 75, TDD 8)', () => {
  it('records every value, never adding cedis to dollars', () => {
    const totals = totalsOf([
      aDeal({ value: [10_000, 'USD'], probability: 50 }),
      aDeal({ value: [20_000, 'GHS'], probability: null }),
      aDeal({ value: [30_000, 'USD'], probability: 100 }),
      aDeal({ value: null, probability: 90 }),
    ]);

    expect(totals.recorded).toEqual([
      { currency: 'GHS', amountMinor: 20_000 },
      { currency: 'USD', amountMinor: 40_000 },
    ]);
  });

  it('leaves out a currency nothing is recorded in, rather than showing nothing', () => {
    expect(totalsOf([aDeal({ value: [10_000, 'GHS'] })]).recorded).toEqual([
      { currency: 'GHS', amountMinor: 10_000 },
    ]);
    expect(totalsOf([aDeal()]).recorded).toEqual([]);
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

  /* CLI 77: what the total leaves out. */
  it('counts the deals with no value, whatever their probability', () => {
    const totals = totalsOf([
      aDeal({ value: [10_000, 'USD'], probability: null }),
      aDeal({ value: null, probability: 40 }),
      aDeal({ value: null, probability: null }),
    ]);

    expect(totals.noValue).toBe(2);
    expect(totalsOf([]).noValue).toBe(0);
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
