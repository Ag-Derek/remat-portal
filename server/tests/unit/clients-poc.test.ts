import { describe, expect, it } from 'vitest';
import { daysAfter } from '../../src/core/calendar/time.js';
import {
  askOf,
  dayNumbered,
  dayOf,
  daysToDecision,
  decisionFlagsOf,
  extendedDecisionDateOf,
  decisionDateOf,
  flagsOf,
  InvalidHealth,
  percentOf,
  phaseOf,
  POC_DAYS,
  readAction,
  readExtension,
  readHealth,
  readNewLead,
  readUsage,
  targetChecksOf,
  targetsFor,
  usageFlagsOf,
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

/* ------------------------------------------------------------- its health, #286 */

describe('a POC At Risk', () => {
  const MOVED = new Date('2026-11-20T09:00:00Z');
  const atRisk = { health: 'AT_RISK', healthSince: MOVED, healthAnswered: false } as const;
  const later = (hours: number) => new Date(MOVED.getTime() + hours * 3_600_000);

  /* The SOPs. 48 real hours from the move, weekends and nights counted. */
  it('asks for a corrective action within 48 hours of the move', () => {
    expect(askOf(atRisk)).toEqual({ what: 'CORRECTIVE_ACTION', by: later(48) });
  });

  /* Done when: an At Risk POC with no action after 48 hours shows a flag. */
  it('is flagged once 48 hours pass with none, and not a moment before', () => {
    expect(flagsOf(atRisk, later(47.99))).toEqual([]);
    expect(flagsOf(atRisk, later(48))).toEqual([
      { kind: 'NO_CORRECTIVE_ACTION', since: later(48) },
    ]);
    expect(flagsOf(atRisk, later(500))).toHaveLength(1);
  });

  it('asks for nothing, and is not flagged, once an action answers it, however late', () => {
    const answered = { ...atRisk, healthAnswered: true };

    expect(askOf(answered)).toBeNull();
    expect(flagsOf(answered, later(500))).toEqual([]);
  });

  /* The flag is the health's: another health ends it, and never the other way round. */
  it('asks nothing of On Track', () => {
    expect(askOf({ ...atRisk, health: 'ON_TRACK' })).toBeNull();
    expect(flagsOf({ ...atRisk, health: 'ON_TRACK' }, later(500))).toEqual([]);
  });
});

describe('a POC Stalled', () => {
  const MOVED = new Date('2026-11-20T09:00:00Z');
  const stalled = { health: 'STALLED', healthSince: MOVED, healthAnswered: false } as const;
  const later = (hours: number) => new Date(MOVED.getTime() + hours * 3_600_000);

  /* The SOPs. Seven days of real hours from the move. */
  it('asks for a reset within seven days of the move', () => {
    expect(askOf(stalled)).toEqual({ what: 'RESET', by: later(7 * 24) });
  });

  it('is flagged for an exit decision once seven days pass with none', () => {
    expect(flagsOf(stalled, later(7 * 24 - 0.01))).toEqual([]);
    expect(flagsOf(stalled, later(7 * 24))).toEqual([
      { kind: 'EXIT_DECISION', since: later(7 * 24) },
    ]);
  });

  it('asks for nothing, and is not flagged, once a reset answers it', () => {
    const answered = { ...stalled, healthAnswered: true };

    expect(askOf(answered)).toBeNull();
    expect(flagsOf(answered, later(500))).toEqual([]);
  });
});

describe('usage', () => {
  /* Done when: 28 active out of 64 enrolled shows 44%. Half up, never typed. */
  it('is active over enrolled as a whole percent, rounded half up', () => {
    for (const [active, enrolled, percent] of [
      [28, 64, 44],
      [0, 64, 0],
      [64, 64, 100],
      [1, 2, 50],
      [1, 8, 13],
      [1, 3, 33],
      [2, 3, 67],
      [99, 200, 50],
      [197, 400, 49],
    ] as const) {
      expect(percentOf(active, enrolled)).toBe(percent);
    }
  });

  it('is recorded for a day from the start to today, with whole counts that fit', () => {
    const poc = { startedOn: START };
    const today = '2026-12-01';
    const good = { measuredOn: '2026-11-20', enrolled: 64, active: 28 };

    expect(readUsage(good, poc, today)).toEqual(good);
    expect(readUsage({ ...good, measuredOn: START }, poc, today).measuredOn).toBe(START);
    expect(readUsage({ ...good, measuredOn: today }, poc, today).measuredOn).toBe(today);

    for (const [body, field] of [
      [{ ...good, measuredOn: '2026-11-01' }, 'measuredOn'],
      [{ ...good, measuredOn: '2026-12-02' }, 'measuredOn'],
      [{ ...good, measuredOn: undefined }, 'measuredOn'],
      [{ ...good, enrolled: 0 }, 'enrolled'],
      [{ ...good, enrolled: 6.5 }, 'enrolled'],
      [{ ...good, enrolled: '64' }, 'enrolled'],
      [{ ...good, active: -1 }, 'active'],
      [{ ...good, active: 65 }, 'active'],
      [{ ...good, active: undefined }, 'active'],
    ] as const) {
      expect(() => readUsage(body, poc, today)).toThrow(
        expect.objectContaining({ name: 'InvalidUsage', field }),
      );
    }
  });
});

describe('setting the health', () => {
  it('takes a corrective action with At Risk, a reset with Stalled, and nothing with On Track', () => {
    expect(readHealth({ health: 'STALLED', action: 'Restart with the new COO' }).action).toBe(
      'Restart with the new COO',
    );
    expect(readHealth({ health: 'AT_RISK', action: '  Weekly call with the CCO  ' })).toEqual({
      health: 'AT_RISK',
      note: null,
      action: 'Weekly call with the CCO',
    });
    expect(readHealth({ health: 'AT_RISK', action: ' ' }).action).toBeNull();
    expect(() => readHealth({ health: 'ON_TRACK', action: 'Something' })).toThrow(
      'On Track asks for no corrective action or reset.',
    );
  });

  it('takes a corrective action on its own only with words in it', () => {
    expect(readAction({ action: ' Retrain the branch staff ' })).toBe('Retrain the branch staff');
    for (const body of [{}, { action: '  ' }, { action: 5 }, { action: 'x'.repeat(2001) }]) {
      expect(() => readAction(body)).toThrow(InvalidHealth);
    }
  });
});

/* ------------------------------------------------------------ usage targets, #286 */

describe('the usage targets', () => {
  const reading = (measuredOn: string, active: number, enrolled = 100, replaced = false) => ({
    measuredOn,
    enrolled,
    active,
    percent: percentOf(active, enrolled),
    replaced,
  });

  /* The SOPs, and the user on 20 November 2026 for every other type. */
  it("are a bank's 50% by Day 30, and everybody else's 40% by Day 21, then 70% by Day 63", () => {
    expect(targetsFor('Bank')).toEqual([
      { percent: 50, byDay: 30 },
      { percent: 70, byDay: 63 },
    ]);
    for (const type of ['Broker', 'Microfinance institution', 'Digital lender', 'DFI']) {
      expect(targetsFor(type)).toEqual([
        { percent: 40, byDay: 21 },
        { percent: 70, byDay: 63 },
      ]);
    }
  });

  it('fall on the day so numbered, the start being Day 1', () => {
    expect(dayNumbered(START, 1)).toBe(START);
    expect(dayNumbered(START, 21)).toBe('2026-11-22');
    expect(dayNumbered(START, 30)).toBe('2026-12-01');
    expect(dayNumbered(START, 63)).toBe('2027-01-03');
  });

  it('are upcoming before their day, then met or missed on the latest reading by it', () => {
    const bank = { startedOn: START, client: { type: 'Bank' } };
    const readings = [
      reading('2026-12-10', 80),
      reading('2026-12-01', 55),
      reading('2026-12-01', 30, 100, true),
      reading('2026-11-20', 20),
    ];

    expect(targetChecksOf(bank, readings, '2026-11-30').map((one) => one.status)).toEqual([
      'UPCOMING',
      'UPCOMING',
    ]);

    const [day30, day63] = targetChecksOf(bank, readings, '2027-01-03');
    /* The replaced reading of 1 December does not count; the one that replaced it does. */
    expect(day30).toMatchObject({
      dueOn: '2026-12-01',
      status: 'MET',
      reading: { measuredOn: '2026-12-01', percent: 55 },
    });
    expect(day63).toMatchObject({ dueOn: '2027-01-03', status: 'MET', reading: { percent: 80 } });
  });

  it('are missed below the target, and say so where nothing was read by the day', () => {
    const broker = { startedOn: START, client: { type: 'Broker' } };

    const [day21, day63] = targetChecksOf(
      broker,
      [reading('2026-12-30', 69), reading('2026-11-25', 90)],
      '2027-01-03',
    );
    /* 90% on Day 24 is too late for Day 21. */
    expect(day21).toMatchObject({ status: 'NO_READING', reading: null });
    expect(day63).toMatchObject({ status: 'MISSED', reading: { percent: 69 } });
  });
});

describe('the usage flags', () => {
  const DAY_63 = '2027-01-03';
  const used = (active: number, enrolled: number) => ({
    startedOn: START,
    usage: { measuredOn: '2027-01-01', enrolled, active, percent: percentOf(active, enrolled) },
  });

  /* Done when: 28 active out of 64 enrolled at Day 63 shows 44% and the low usage flag. */
  it('flag below 50% from Day 63 as unlikely to convert', () => {
    expect(usageFlagsOf(used(28, 64), '2027-01-02')).toEqual([]);
    expect(usageFlagsOf(used(28, 64), DAY_63)).toEqual([
      { kind: 'LOW_USAGE', since: new Date(`${DAY_63}T00:00:00Z`) },
    ]);
    expect(usageFlagsOf(used(28, 64), '2027-02-01')).toHaveLength(1);
  });

  /* Judged on the shown figure: 49.5% shows as 50%, which is not below 50%. */
  it('judge the whole percent shown', () => {
    expect(usageFlagsOf(used(99, 200), DAY_63)).toEqual([]);
    expect(usageFlagsOf(used(32, 64), DAY_63)).toEqual([]);
    expect(usageFlagsOf(used(197, 400), DAY_63)).toHaveLength(1);
  });

  /* The user, 20 November 2026. Nothing recorded by Day 63 is flagged too. */
  it('flag a POC with no usage recorded by Day 63', () => {
    const none = { startedOn: START, usage: null };

    expect(usageFlagsOf(none, '2027-01-02')).toEqual([]);
    expect(usageFlagsOf(none, DAY_63)).toEqual([
      { kind: 'NO_USAGE', since: new Date(`${DAY_63}T00:00:00Z`) },
    ]);
  });
});

describe('the decision flag', () => {
  /* #286, CLI 50. Past its decision date from the day after it. */
  it('is raised the day after the decision date, and not on it', () => {
    const poc = { decisionOn: '2027-01-11' };

    expect(decisionFlagsOf(poc, '2027-01-11')).toEqual([]);
    expect(decisionFlagsOf(poc, '2027-01-12')).toEqual([
      { kind: 'PAST_DECISION', since: new Date('2027-01-12T00:00:00Z') },
    ]);
    expect(decisionFlagsOf(poc, '2027-03-01')).toHaveLength(1);
  });
});

describe('an extension', () => {
  /* CLI 31, #287. Ten weeks, then up to 30 days more. */
  it('moves the decision date by its days', () => {
    expect(extendedDecisionDateOf(START, 1)).toBe('2027-01-12');
    expect(extendedDecisionDateOf(START, 30)).toBe('2027-02-10');
  });

  it('is 1 to 30 whole days, with a plan in words', () => {
    expect(readExtension({ days: 30, plan: ' Two branches more ' })).toEqual({
      days: 30,
      plan: 'Two branches more',
    });
    for (const [body, field] of [
      [{ days: 0, plan: 'x' }, 'days'],
      [{ days: 31, plan: 'x' }, 'days'],
      [{ days: '10', plan: 'x' }, 'days'],
      [{ days: 10, plan: '' }, 'plan'],
      [{ days: 10, plan: 'x'.repeat(4001) }, 'plan'],
    ] as const) {
      expect(() => readExtension(body)).toThrow(
        expect.objectContaining({ name: 'InvalidExtension', field }),
      );
    }
  });
});
