import { describe, expect, it } from 'vitest';
import {
  halfYearOf,
  InvalidOpportunity,
  MAX_STATED_INTEREST_LENGTH,
  MAX_WAITING_NOTE_LENGTH,
  OpportunityAlreadyOpen,
  readNewOpportunity,
  readValue,
} from '../../src/apps/clients/opportunity.js';
import { problemFor } from '../../src/core/http/problems.js';

/**
 * What a deal is made of, read from a request. #277, Clients SRS CLI 10 to CLI 17.
 *
 * Whatever is not known is null rather than nought or blank, so the screen can show it as missing
 * (CLI 06).
 */

const WHOLE = {
  clientId: '3',
  productId: '7',
  value: { amount: '125000.50', currency: 'GHS' },
  probability: 40,
  expectedClose: { half: 'H1', year: 2027 },
  waitingOn: { on: 'PROPOSAL_RESPONSE', note: '  Their board meets on the 20th ' },
  statedInterest: 'Wants to move SME lending off spreadsheets.',
};

/** The field a request was refused on, or null if it was read. */
function refusedOn(body: unknown): string | null {
  try {
    readNewOpportunity(body);
    return null;
  } catch (error) {
    if (error instanceof InvalidOpportunity) return error.field;
    throw error;
  }
}

describe('a new deal', () => {
  it('is read with its client, product, value and currency, probability, expected close, waiting on and stated interest', () => {
    expect(readNewOpportunity(WHOLE)).toEqual({
      clientId: '3',
      productId: '7',
      value: { amountMinor: 12_500_050, currency: 'GHS' },
      probability: 40,
      expectedClose: { half: 'H1', year: 2027 },
      waitingOn: { on: 'PROPOSAL_RESPONSE', note: 'Their board meets on the 20th' },
      statedInterest: 'Wants to move SME lending off spreadsheets.',
    });
  });

  /* CLI 10: everything but the client and product is optional. */
  it('needs only a client and a product; the rest is missing, not nought', () => {
    expect(readNewOpportunity({ clientId: '3', productId: '7' })).toEqual({
      clientId: '3',
      productId: '7',
      value: null,
      probability: null,
      expectedClose: null,
      waitingOn: null,
      statedInterest: null,
    });
  });

  it('is with a client, for a product', () => {
    expect(refusedOn({ ...WHOLE, clientId: undefined })).toBe('clientId');
    expect(refusedOn({ ...WHOLE, clientId: 'ADB' })).toBe('clientId');
    expect(refusedOn({ ...WHOLE, productId: undefined })).toBe('productId');
    expect(refusedOn({ ...WHOLE, productId: 'CreditStudio' })).toBe('productId');
  });

  /* CLI 15. */
  it('closes in a half, H1 or H2, of a year', () => {
    expect(refusedOn({ ...WHOLE, expectedClose: { half: 'H2', year: 2030 } })).toBeNull();
    for (const close of [
      { half: 'H3', year: 2027 },
      { half: 'h1', year: 2027 },
      { half: 'H1' },
      { year: 2027 },
      { half: 'H1', year: 27 },
      { half: 'H1', year: '2027' },
      { half: 'H1', year: 2027.5 },
      '2027-H1',
    ]) {
      expect(refusedOn({ ...WHOLE, expectedClose: close })).toBe('expectedClose');
    }
  });

  /* CLI 14. */
  it('has a probability that is a whole percentage from 0 to 100', () => {
    expect(refusedOn({ ...WHOLE, probability: 0 })).toBeNull();
    expect(refusedOn({ ...WHOLE, probability: 100 })).toBeNull();
    for (const probability of [-1, 101, 12.5, '40', '40%']) {
      expect(refusedOn({ ...WHOLE, probability })).toBe('probability');
    }
  });

  /* CLI 16. */
  it('waits on one of the six things, and says what when it is "other"', () => {
    for (const on of ['DEMO', 'PROPOSAL_RESPONSE', 'PAPERWORK', 'SIGNATURE', 'CLIENT_DECISION']) {
      expect(readNewOpportunity({ ...WHOLE, waitingOn: { on } }).waitingOn).toEqual({
        on,
        note: null,
      });
    }
    expect(refusedOn({ ...WHOLE, waitingOn: { on: 'OTHER', note: 'Bank of Ghana' } })).toBeNull();
    expect(refusedOn({ ...WHOLE, waitingOn: { on: 'OTHER' } })).toBe('waitingOn');
    expect(refusedOn({ ...WHOLE, waitingOn: { on: 'OTHER', note: '  ' } })).toBe('waitingOn');
    expect(refusedOn({ ...WHOLE, waitingOn: { on: 'LUNCH' } })).toBe('waitingOn');
    expect(refusedOn({ ...WHOLE, waitingOn: 'DEMO' })).toBe('waitingOn');
  });

  it('keeps the waiting note and what the client said to the lengths the columns hold', () => {
    const note = (length: number) => ({ on: 'OTHER', note: 'x'.repeat(length) });

    expect(refusedOn({ ...WHOLE, waitingOn: note(MAX_WAITING_NOTE_LENGTH) })).toBeNull();
    expect(refusedOn({ ...WHOLE, waitingOn: note(MAX_WAITING_NOTE_LENGTH + 1) })).toBe('waitingOn');
    expect(
      refusedOn({ ...WHOLE, statedInterest: 'x'.repeat(MAX_STATED_INTEREST_LENGTH + 1) }),
    ).toBe('statedInterest');
    expect(refusedOn({ ...WHOLE, statedInterest: 42 })).toBe('statedInterest');
  });

  it('takes blank text as missing', () => {
    expect(readNewOpportunity({ ...WHOLE, statedInterest: '   ' }).statedInterest).toBeNull();
  });
});

/* CLI 74, TDD 8. */
describe('what a deal is worth', () => {
  it('is minor units of cedis or dollars, never rounded', () => {
    expect(readValue({ amount: '75600', currency: 'USD' })).toEqual({
      amountMinor: 7_560_000,
      currency: 'USD',
    });
    expect(readValue({ amount: '0.5', currency: 'GHS' })).toEqual({
      amountMinor: 50,
      currency: 'GHS',
    });
    expect(readValue({ amount: ' 19.99 ', currency: 'GHS' })).toEqual({
      amountMinor: 1999,
      currency: 'GHS',
    });
  });

  it('is missing when not given', () => {
    expect(readValue(undefined)).toBeNull();
    expect(readValue(null)).toBeNull();
  });

  it('is in cedis or dollars, and in nothing else', () => {
    expect(() => readValue({ amount: '100', currency: 'EUR' })).toThrow(/cedis or dollars/);
    expect(() => readValue({ amount: '100' })).toThrow(/cedis or dollars/);
  });

  it('has at most two figures after the point, and no thousands marks to guess at', () => {
    for (const amount of ['12.345', '12,500', '1e6', '-100', '', 'lots']) {
      expect(() => readValue({ amount, currency: 'GHS' })).toThrow(InvalidOpportunity);
    }
  });

  it('is not past what any deal could be worth', () => {
    expect(() => readValue({ amount: '1000000000000', currency: 'USD' })).toThrow(/more than/);
  });
});

/* CLI 11, AC L01, TDD 11's ALREADY_OPEN. */
describe('a second open deal for the same client and product', () => {
  it('is refused as a 409 naming the client and the product, against the product field', () => {
    const { status, body } = problemFor(new OpportunityAlreadyOpen('ADB', 'CreditStudio'));

    expect(status).toBe(409);
    expect(body).toEqual({
      error: 'OpportunityAlreadyOpen',
      message:
        'ADB already has an open CreditStudio deal. Work on that one, or end it before ' +
        'starting another.',
      field: 'productId',
    });
  });
});

describe('the half year a day falls in', () => {
  it('is H1 to the end of June and H2 from July', () => {
    expect(halfYearOf('2026-01-01')).toEqual({ half: 'H1', year: 2026 });
    expect(halfYearOf('2026-06-30')).toEqual({ half: 'H1', year: 2026 });
    expect(halfYearOf('2026-07-01')).toEqual({ half: 'H2', year: 2026 });
    expect(halfYearOf('2026-12-31')).toEqual({ half: 'H2', year: 2026 });
  });
});
