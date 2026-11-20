import { describe, expect, it } from 'vitest';
import { daysAfter } from '../../src/core/calendar/time.js';
import {
  dayOf,
  daysToDecision,
  decisionDateOf,
  phaseOf,
  POC_DAYS,
  readNewLead,
  readReview,
  rescheduledReviewOf,
  reviewStepsOf,
} from '../../src/apps/clients/poc.js';

/**
 * The POC clock and its review meetings. #285, Clients SRS CLI 31 to CLI 34, TDD 6. Every day
 * counted: a POC does not pause for a weekend or a public holiday.
 */

const START = '2026-11-02';
const ADB = { clientName: 'ADB', productName: 'Federation' };

describe('a POC', () => {
  it('runs ten weeks', () => {
    expect(POC_DAYS).toBe(70);
  });

  /* AC L09. Done when: a POC starting 2 November has a decision date of 11 January. */
  it('started on 2 November is decided by 11 January', () => {
    expect(decisionDateOf(START)).toBe('2027-01-11');
  });

  it('counts across a month end and a leap day like any other day', () => {
    expect(decisionDateOf('2028-01-15')).toBe('2028-03-25');
    expect(decisionDateOf('2027-01-15')).toBe('2027-03-26');
  });
});

describe('the phase', () => {
  /* CLI 32, TDD 15: days 1, 21, 22, 42, 43, 70, and a POC extended to day 100. Done when: the
     phase changes on its own as the weeks pass. */
  it('is Foundation in weeks 1 to 3, Deepening in 4 to 6, Converting in 7 to 10 and beyond', () => {
    const on = (day: number) => phaseOf(START, daysAfter(START, day - 1));

    expect(on(1)).toBe('FOUNDATION');
    expect(on(21)).toBe('FOUNDATION');
    expect(on(22)).toBe('DEEPENING');
    expect(on(42)).toBe('DEEPENING');
    expect(on(43)).toBe('CONVERTING');
    expect(on(70)).toBe('CONVERTING');
    expect(on(100)).toBe('CONVERTING');
  });

  it('counts the start as day 1', () => {
    expect(dayOf(START, START)).toBe(1);
    expect(dayOf(START, '2026-11-08')).toBe(7);
  });

  it('counts down to the decision, and past it', () => {
    expect(daysToDecision('2027-01-11', START)).toBe(70);
    expect(daysToDecision('2027-01-11', '2027-01-11')).toBe(0);
    expect(daysToDecision('2027-01-11', '2027-01-14')).toBe(-3);
  });
});

describe('the review meetings', () => {
  /* CLI 33, AC L09. Done when: a POC starting 2 November has reviews on 9 November, 14 December
     and 4 January. */
  it('fall on 9 November, 14 December and 4 January for a POC started 2 November', () => {
    expect(reviewStepsOf(START, ADB)).toEqual([
      {
        kind: 'DAY7',
        dueOn: '2026-11-09',
        description: 'Day 7 showcase with ADB on the Federation POC',
      },
      {
        kind: 'WEEK6',
        dueOn: '2026-12-14',
        description: 'Week 6 midpoint review with ADB on the Federation POC',
      },
      {
        kind: 'WEEK9',
        dueOn: '2027-01-04',
        description: 'Week 9 activation review with ADB on the Federation POC',
      },
    ]);
  });

  /* CLI 34, TDD 6.2. Without the senior decision maker, due again seven days after the meeting. */
  it('is due again a week after one the senior decision maker missed', () => {
    expect(rescheduledReviewOf('WEEK6', '2026-12-15', ADB)).toEqual({
      dueOn: '2026-12-22',
      description:
        'Week 6 midpoint review with ADB on the Federation POC, again: the senior decision ' +
        'maker was not there',
    });
  });
});

describe('a review recorded', () => {
  const today = '2026-11-20';
  const review = { reviewKind: 'DAY7', heldOn: '2026-11-09', dmAttended: true };

  it('says which review, when, whether the decision maker came, and optionally more', () => {
    expect(readReview({ ...review, withWhom: '  Ama (CCO) ', outcome: '' }, today)).toEqual({
      kind: 'DAY7',
      heldOn: '2026-11-09',
      dmAttended: true,
      withWhom: 'Ama (CCO)',
      outcome: null,
    });
  });

  it('is refused, naming the field, where any of the three is missing or wrong', () => {
    const field = (body: unknown) => {
      try {
        readReview(body, today);
        return null;
      } catch (error) {
        return (error as { field?: string }).field;
      }
    };

    expect(field({ ...review, reviewKind: 'DAY8' })).toBe('reviewKind');
    expect(field({ ...review, heldOn: '09/11/2026' })).toBe('heldOn');
    expect(field({ ...review, heldOn: '2026-11-21' })).toBe('heldOn');
    expect(field({ ...review, dmAttended: 'yes' })).toBe('dmAttended');
    expect(field({ ...review, dmAttended: undefined })).toBe('dmAttended');
    expect(field({ ...review, withWhom: 7 })).toBe('withWhom');
  });
});

describe('a new CS lead', () => {
  it('is somebody', () => {
    expect(readNewLead({ employeeId: '12' })).toBe('12');
    expect(() => readNewLead({})).toThrow('Choose who is to run the POC.');
    expect(() => readNewLead({ employeeId: 'x' })).toThrow();
  });
});

describe('daysAfter', () => {
  it('counts every day, weekends included', () => {
    expect(daysAfter('2026-11-20', 0)).toBe('2026-11-20');
    expect(daysAfter('2026-11-20', 1)).toBe('2026-11-21');
    expect(daysAfter('2026-12-25', 7)).toBe('2027-01-01');
  });

  it('counts only forward, in whole days', () => {
    expect(() => daysAfter('2026-11-20', -1)).toThrow();
    expect(() => daysAfter('2026-11-20', 1.5)).toThrow();
    expect(() => daysAfter('20/11/2026', 1)).toThrow();
  });
});
