import { describe, expect, it } from 'vitest';
import {
  InvalidNextStep,
  isOverdue,
  readNewNextStep,
  readNextStep,
} from '../../src/apps/clients/next-step.js';

/** Next steps, with no database. #280, Clients SRS CLI 63, CLI 64. */

const TODAY = '2026-10-30';

describe('whether a step is overdue (CLI 64)', () => {
  const by = { id: '1', name: 'Ama Owusu' };

  /* The done-when line: a missed step shows as overdue the day after it was due. */
  it('is not on the day it is due, and is the day after', () => {
    expect(isOverdue({ dueOn: '2026-10-30', done: null }, '2026-10-30')).toBe(false);
    expect(isOverdue({ dueOn: '2026-10-30', done: null }, '2026-10-31')).toBe(true);
  });

  it('stays overdue however long it is left, and nothing closes it', () => {
    expect(isOverdue({ dueOn: '2026-01-05', done: null }, '2026-10-30')).toBe(true);
  });

  it('is never overdue once closed, however late', () => {
    expect(isOverdue({ dueOn: '2026-01-05', done: { at: new Date(), by } }, TODAY)).toBe(false);
  });

  it('is not before it is due', () => {
    expect(isOverdue({ dueOn: '2026-11-02', done: null }, TODAY)).toBe(false);
  });
});

describe('reading a step from a request (CLI 63)', () => {
  /** The field a step was refused on. */
  function refusedOn(read: () => unknown): string {
    try {
      read();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidNextStep);
      return (error as InvalidNextStep).field;
    }

    throw new Error('Expected the step to be refused, and it was not.');
  }

  it('takes what, by when, and whose, trimmed, whose left out for the client owner', () => {
    expect(readNextStep({ description: '  Send pricing ', dueOn: TODAY }, TODAY)).toEqual({
      description: 'Send pricing',
      dueOn: TODAY,
      ownerId: null,
    });
    expect(
      readNextStep({ description: 'Send pricing', dueOn: TODAY, ownerId: '7' }, TODAY).ownerId,
    ).toBe('7');
  });

  /* #280. Due today or later where somebody types it. */
  it('is due today or later', () => {
    expect(refusedOn(() => readNextStep({ description: 'x', dueOn: '2026-10-29' }, TODAY))).toBe(
      'dueOn',
    );
  });

  it('names the field as it sat in the request', () => {
    expect(refusedOn(() => readNextStep({ dueOn: TODAY }, TODAY, 'nextStep.'))).toBe(
      'nextStep.description',
    );
    expect(
      refusedOn(() => readNextStep({ description: 'x', dueOn: TODAY, ownerId: 'Kofi' }, TODAY)),
    ).toBe('ownerId');
  });

  it('on its own, is for a client and optionally one of its deals', () => {
    expect(readNewNextStep({ clientId: '3', description: 'x', dueOn: TODAY }, TODAY)).toMatchObject(
      { clientId: '3', opportunityId: null },
    );
    expect(
      readNewNextStep({ clientId: '3', opportunityId: '9', description: 'x', dueOn: TODAY }, TODAY)
        .opportunityId,
    ).toBe('9');
    expect(refusedOn(() => readNewNextStep({ description: 'x', dueOn: TODAY }, TODAY))).toBe(
      'clientId',
    );
    expect(
      refusedOn(() =>
        readNewNextStep(
          { clientId: '3', opportunityId: 'CreditStudio', description: 'x', dueOn: TODAY },
          TODAY,
        ),
      ),
    ).toBe('opportunityId');
  });
});
