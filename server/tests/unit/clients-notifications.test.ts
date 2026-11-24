import { describe, expect, it } from 'vitest';
import { signedInAs, theSystem } from '../../src/core/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/core/auth/policy.js';
import type { CalendarDate } from '../../src/core/calendar/time.js';
import type { WorkingWeek } from '../../src/core/calendar/working-days.js';
import type { NewOutboxEmail } from '../../src/core/notification/outbox.js';
import { clientsLinks, nextStepsEmail, type Recipient } from '../../src/apps/clients/email.js';
import {
  ClientsDailyNotifications,
  isTimeToNotify,
} from '../../src/apps/clients/notifications.job.js';
import {
  lastWorkingRunOf,
  missedMorningsOf,
  reminderWindowOf,
  remindersOf,
  type StepToRemind,
} from '../../src/apps/clients/reminders.js';
import type { Standing } from '../../src/apps/clients/standing.js';
import type { Poc, PocFlag } from '../../src/apps/clients/poc.js';
import {
  alertsByPerson,
  flaggedOf,
  toldAbout,
  toldToKeyOf,
} from '../../src/apps/clients/poc-alerts.js';
import type { Grant } from '../../src/apps/clients/role.js';
import type { Employee } from '../../src/core/organisation/employee/employee.js';
import { pocAlertsEmail } from '../../src/apps/clients/email.js';
import { recordingDenials } from '../support/recording-denials.js';

/**
 * The clients morning notifications. #290.
 *
 * November 2026: Monday the 23rd, Friday the 27th, Saturday the 28th, Monday the 30th.
 */

const MONDAY_TO_FRIDAY: WorkingWeek = { workingDays: [1, 2, 3, 4, 5], holidays: new Set() };

function withHolidays(...days: CalendarDate[]): WorkingWeek {
  return { workingDays: [1, 2, 3, 4, 5], holidays: new Set(days) };
}

const AMA: Recipient = { id: '11', firstName: 'Ama', workEmail: 'ama@rematholdings.com' };
const KOFI: Recipient = { id: '12', firstName: 'Kofi', workEmail: 'kofi@rematholdings.com' };
/** A BD manager, and Ama's line manager. */
const KWAME: Recipient = { id: '13', firstName: 'Kwame', workEmail: 'kwame@rematholdings.com' };
/** Kofi's line manager, who holds no BD manager role. */
const EFUA: Recipient = { id: '14', firstName: 'Efua', workEmail: 'efua@rematholdings.com' };

/** Everybody, with their line manager. */
const PEOPLE = [
  { ...AMA, managerId: KWAME.id },
  { ...KOFI, managerId: EFUA.id },
  { ...KWAME, managerId: null },
  { ...EFUA, managerId: null },
];

let nextId = 0;

/** A running POC led by `lead`, started 63 days before Friday the 27th, On Track, used well. */
function aPoc(changes: Partial<Poc> = {}, lead: Recipient = AMA): Poc {
  nextId += 1;
  return {
    id: String(nextId),
    client: { id: '1', name: 'ADB', type: 'Bank' },
    lineName: 'Symphony',
    deal: {
      id: String(nextId),
      productName: 'Federation',
      stage: 'POC',
      outcome: 'OPEN',
      endedOn: null,
      owner: { id: lead.id, name: `${lead.firstName} Mensah` },
    },
    csLead: { id: lead.id, name: `${lead.firstName} Mensah` },
    startedOn: '2026-09-26',
    decisionOn: '2026-12-05',
    extension: null,
    health: 'ON_TRACK',
    healthSince: new Date('2026-09-26T09:00:00Z'),
    healthAnswered: false,
    usage: { measuredOn: '2026-11-20', enrolled: 10, active: 8, percent: 80 },
    ...changes,
  };
}

function aStep(dueOn: CalendarDate, changes: Partial<StepToRemind> = {}): StepToRemind {
  nextId += 1;
  return {
    id: String(nextId),
    client: { id: '1', name: 'Testbank' },
    productName: 'CreditStudio',
    description: 'Send the revised proposal',
    dueOn,
    ownerId: AMA.id,
    ...changes,
  };
}

/* ----------------------------------------------------------------------- task 1 */

describe('the time the notifications go', () => {
  it('is 07:30, Accra being UTC, and not a minute before', () => {
    expect(isTimeToNotify(new Date('2026-11-24T07:29:59.999Z'))).toBe(false);
    expect(isTimeToNotify(new Date('2026-11-24T07:30:00Z'))).toBe(true);
  });

  it('stays due for the rest of the day, so a server down at 07:30 still runs them', () => {
    expect(isTimeToNotify(new Date('2026-11-24T13:05:00Z'))).toBe(true);
    expect(isTimeToNotify(new Date('2026-11-24T23:59:59Z'))).toBe(true);
    expect(isTimeToNotify(new Date('2026-11-25T00:00:00Z'))).toBe(false);
  });
});

/* ------------------------------------------------------------- task 2: the rules */

describe('the due dates a morning reminds of', () => {
  it('on a Wednesday: Tuesday’s, now overdue, and Wednesday’s, due', () => {
    expect(reminderWindowOf('2026-11-25', MONDAY_TO_FRIDAY)).toEqual({
      from: '2026-11-24',
      before: '2026-11-26',
    });
  });

  it('on a Friday: the weekend’s too, the working day before them', () => {
    expect(reminderWindowOf('2026-11-27', MONDAY_TO_FRIDAY)).toEqual({
      from: '2026-11-26',
      before: '2026-11-30',
    });
  });

  it('on a Monday: Friday’s and the weekend’s, overdue for the first working day', () => {
    expect(reminderWindowOf('2026-11-30', MONDAY_TO_FRIDAY)).toEqual({
      from: '2026-11-27',
      before: '2026-12-01',
    });
  });

  it('none on a weekend or a public holiday', () => {
    expect(reminderWindowOf('2026-11-28', MONDAY_TO_FRIDAY)).toBeNull();
    expect(reminderWindowOf('2026-11-29', MONDAY_TO_FRIDAY)).toBeNull();
    expect(reminderWindowOf('2026-11-25', withHolidays('2026-11-25'))).toBeNull();
  });

  it('a holiday counts as a day off on either side', () => {
    /* Thursday the 26th a holiday: Wednesday carries it, and Friday finds it overdue. */
    const week = withHolidays('2026-11-26');

    expect(reminderWindowOf('2026-11-25', week)).toEqual({
      from: '2026-11-24',
      before: '2026-11-27',
    });
    expect(reminderWindowOf('2026-11-27', week)).toEqual({
      from: '2026-11-25',
      before: '2026-11-30',
    });
  });
});

describe('who is reminded of what', () => {
  it('splits each owner’s steps into due and overdue, against the morning', () => {
    const friday = aStep('2026-11-27');
    const saturday = aStep('2026-11-28');
    const thursday = aStep('2026-11-26');

    expect(remindersOf('2026-11-27', [saturday, thursday, friday])).toEqual([
      { ownerId: AMA.id, due: [friday, saturday], overdue: [thursday] },
    ]);
  });

  it('one entry per owner', () => {
    const ama = aStep('2026-11-27');
    const kofi = aStep('2026-11-27', { ownerId: KOFI.id });

    expect(remindersOf('2026-11-27', [ama, kofi])).toEqual([
      { ownerId: AMA.id, due: [ama], overdue: [] },
      { ownerId: KOFI.id, due: [kofi], overdue: [] },
    ]);
  });

  it('by due date, then client, then what it says', () => {
    const zed = aStep('2026-11-27', { client: { id: '2', name: 'Zenith' } });
    const adb = aStep('2026-11-27', { client: { id: '3', name: 'ADB' }, description: 'B' });
    const adbFirst = aStep('2026-11-27', { client: { id: '3', name: 'ADB' }, description: 'A' });

    expect(remindersOf('2026-11-27', [zed, adb, adbFirst])[0].due).toEqual([adbFirst, adb, zed]);
  });
});

/* ------------------------------------------------------------- task 2: the email */

describe('the next steps email', () => {
  const links = clientsLinks('https://portal.example.com/');

  it('goes to the owner, says what is due and what is overdue, and links to My pipeline', () => {
    const email = nextStepsEmail({
      owner: AMA,
      day: '2026-11-27',
      steps: {
        ownerId: AMA.id,
        due: [
          aStep('2026-11-27'),
          aStep('2026-11-28', {
            client: { id: '2', name: 'Agrobank' },
            productName: null,
            description: 'Call the CFO',
          }),
        ],
        overdue: [aStep('2026-11-26', { description: 'Collect the signed NDA' })],
      },
      links,
    });

    expect(email).toMatchObject({
      kind: 'CLIENTS_NEXT_STEPS',
      recipientEmployeeId: AMA.id,
      to: AMA.workEmail,
      subject: 'Your next steps: 2 due, 1 overdue',
      dedupeKey: `CLIENTS_NEXT_STEPS:${AMA.id}:2026-11-27`,
    });
    expect(email.text).toContain('Hello Ama,');
    expect(email.text).toContain('Due today: Testbank · CreditStudio: Send the revised proposal');
    expect(email.text).toContain('Due 28 November 2026: Agrobank: Call the CFO');
    expect(email.text).toContain(
      'Overdue, was due 26 November 2026: Testbank · CreditStudio: Collect the signed NDA',
    );
    expect(email.text).toContain('https://portal.example.com/#/clients');
    expect(email.html).toContain('Collect the signed NDA');
  });

  it('names only what there is', () => {
    const email = nextStepsEmail({
      owner: AMA,
      day: '2026-11-30',
      steps: { ownerId: AMA.id, due: [], overdue: [aStep('2026-11-27')] },
      links,
    });

    expect(email.subject).toBe('Your next steps: 1 overdue');
  });
});

/* --------------------------------------------------------------- the job itself */

/** What a test makes fail. */
interface Failing {
  /** The company calendar, before either part starts. */
  calendar?: boolean;
  /** Reading the next steps: the next steps part. */
  steps?: boolean;
  /** These people's emails cannot be queued. */
  people?: string[];
  /** These people's next steps emails throw on the way to the outbox. */
  throwFor?: string[];
}

/** The job, with everything it reads and writes kept in memory. */
function aJob(
  at: { now: Date; today: CalendarDate },
  open: { step: StepToRemind; owner: Recipient }[] = [],
  options: {
    cannot?: string[];
    week?: WorkingWeek;
    queueFails?: boolean;
    pocs?: Poc[];
    /** Who is told already, as `toldKeyOf` keys. */
    told?: Set<string>;
    /** Days the job ran for already. */
    ranOn?: CalendarDate[];
    /** What fails (task 6), which a test may change between runs. */
    failing?: Failing;
  } = {},
) {
  const days = new Set<CalendarDate>(options.ranOn ?? []);
  const queued: NewOutboxEmail[] = [];
  const keys = new Set<string>();
  const told = options.told ?? new Set<string>();
  const failing = options.failing ?? {};

  const job = new ClientsDailyNotifications(
    new Guard(recordingDenials()),
    {
      runs: {
        hasRunOn: (day: CalendarDate) => Promise.resolve(days.has(day)),
        daysRunBefore: (day: CalendarDate) =>
          Promise.resolve(
            [...days]
              .filter((one) => one < day)
              .sort()
              .reverse(),
          ),
        record: (day: CalendarDate) => {
          days.add(day);
          return Promise.resolve();
        },
      },
      calendar: {
        weekAround: () =>
          failing.calendar === true
            ? Promise.reject(new Error('The calendar cannot be read.'))
            : Promise.resolve(options.week ?? MONDAY_TO_FRIDAY),
      },
      reminders: {
        openStepsDueIn: (window) =>
          failing.steps === true
            ? Promise.reject(new Error('The next steps cannot be read.'))
            : Promise.resolve(
                open.filter(({ step }) => step.dueOn >= window.from && step.dueOn < window.before),
              ),
      },
      pocs: { running: () => Promise.resolve(options.pocs ?? []) },
      pocAlerts: {
        toldOf: () => Promise.resolve(new Set(told)),
        /* As the repository does: the email and its flags together, or neither. */
        queueWith: (email, recipientId, flags) => {
          if (options.queueFails === true || failing.people?.includes(recipientId) === true) {
            return Promise.reject(new Error('The outbox is down.'));
          }
          for (const flag of flags) {
            told.add(toldToKeyOf(recipientId, flag));
          }
          if (keys.has(email.dedupeKey ?? '')) {
            return Promise.resolve('ALREADY_QUEUED' as const);
          }
          keys.add(email.dedupeKey ?? '');
          queued.push(email);
          return Promise.resolve('QUEUED' as const);
        },
      },
      employees: {
        findAllById: (ids) =>
          Promise.resolve(
            PEOPLE.filter((person) => ids.includes(person.id)) as unknown as Employee[],
          ),
      },
      grants: {
        live: () =>
          Promise.resolve([{ employeeId: KWAME.id, role: 'BD_MANAGER' }] as unknown as Grant[]),
      },
      standings: {
        of: (ids) =>
          Promise.resolve(
            new Map<string, Standing>(
              [...ids]
                .filter((id) => options.cannot?.includes(id) === true)
                .map((id) => [id, { reason: 'LEFT', exitDate: '2026-11-20' }]),
            ),
          ),
      },
      outbox: {
        queue: (email) => {
          if (failing.throwFor?.includes(email.recipientEmployeeId ?? '') === true) {
            return Promise.reject(new Error('The email could not be built.'));
          }
          if (
            options.queueFails === true ||
            failing.people?.includes(email.recipientEmployeeId ?? '') === true
          ) {
            return Promise.resolve({ email: null, alreadyQueued: false, couldNotQueue: 'down' });
          }
          if (email.dedupeKey !== null && email.dedupeKey !== undefined) {
            if (keys.has(email.dedupeKey)) {
              return Promise.resolve({ email: null, alreadyQueued: true, couldNotQueue: null });
            }
            keys.add(email.dedupeKey);
          }
          queued.push(email);
          return Promise.resolve({ email: null, alreadyQueued: false, couldNotQueue: null });
        },
      },
      links: clientsLinks('https://portal.example.com'),
    },
    () => at.now,
    () => at.today,
  );

  return { job, days, queued, told };
}

const SYSTEM = theSystem('the clients morning notifications');

describe('the daily run', () => {
  it('does nothing before 07:30', async () => {
    const { job, days } = aJob({ now: new Date('2026-11-24T07:29:00Z'), today: '2026-11-24' });

    expect(await job.run(SYSTEM)).toBeUndefined();
    expect([...days]).toEqual([]);
  });

  it('runs at 07:30 and records the day', async () => {
    const now = new Date('2026-11-24T07:30:00Z');
    const { job, days } = aJob({ now, today: '2026-11-24' });

    expect(await job.run(SYSTEM)).toMatchObject({ ranFor: '2026-11-24', ranAt: now });
    expect([...days]).toEqual(['2026-11-24']);
  });

  it('runs once a day however often it is asked, and again the next day', async () => {
    const at = { now: new Date('2026-11-24T07:30:00Z'), today: '2026-11-24' };
    const { job, days } = aJob(at);

    await job.run(SYSTEM);
    at.now = new Date('2026-11-24T07:31:00Z');
    expect(await job.run(SYSTEM)).toBeUndefined();
    at.now = new Date('2026-11-24T18:00:00Z');
    expect(await job.run(SYSTEM)).toBeUndefined();

    at.now = new Date('2026-11-25T07:30:00Z');
    at.today = '2026-11-25';
    expect((await job.run(SYSTEM))?.ranFor).toBe('2026-11-25');
    expect([...days]).toEqual(['2026-11-24', '2026-11-25']);
  });

  it('is the system’s to run, and nobody else’s', async () => {
    const { job, days } = aJob({ now: new Date('2026-11-24T07:30:00Z'), today: '2026-11-24' });
    const admin = signedInAs('1', { roles: ['EMPLOYEE', 'SYS_ADMIN'], isManager: false });

    await expect(job.run(admin)).rejects.toBeInstanceOf(NotAuthorised);
    expect([...days]).toEqual([]);
  });
});

describe('the next steps a run reminds of', () => {
  const FRIDAY = { now: new Date('2026-11-27T07:30:00Z'), today: '2026-11-27' };

  it('one email per owner, with what is due and what has just become overdue', async () => {
    const { job, queued } = aJob(FRIDAY, [
      { step: aStep('2026-11-27'), owner: AMA },
      { step: aStep('2026-11-29'), owner: AMA },
      { step: aStep('2026-11-26'), owner: AMA },
      { step: aStep('2026-11-27', { ownerId: KOFI.id }), owner: KOFI },
    ]);

    const run = await job.run(SYSTEM);

    expect(run?.nextSteps).toEqual({
      emailed: 2,
      steps: 4,
      skipped: 0,
      alreadyQueued: 0,
      couldNotQueue: 0,
    });
    expect(queued.map((email) => [email.to, email.subject])).toEqual([
      [AMA.workEmail, 'Your next steps: 2 due, 1 overdue'],
      [KOFI.workEmail, 'Your next steps: 1 due'],
    ]);
  });

  it('nothing for a step overdue before its first working day overdue, or due after the weekend', async () => {
    const { job, queued } = aJob(FRIDAY, [
      { step: aStep('2026-11-25'), owner: AMA },
      { step: aStep('2026-11-30'), owner: AMA },
    ]);

    expect((await job.run(SYSTEM))?.nextSteps.emailed).toBe(0);
    expect(queued).toEqual([]);
  });

  it('skips an owner who can no longer look after their steps', async () => {
    const { job, queued } = aJob(
      FRIDAY,
      [
        { step: aStep('2026-11-27'), owner: AMA },
        { step: aStep('2026-11-26'), owner: AMA },
        { step: aStep('2026-11-27', { ownerId: KOFI.id }), owner: KOFI },
      ],
      { cannot: [AMA.id] },
    );

    expect((await job.run(SYSTEM))?.nextSteps).toMatchObject({ emailed: 1, skipped: 2 });
    expect(queued.map((email) => email.to)).toEqual([KOFI.workEmail]);
  });

  it('sends none on a weekend, and still records the day', async () => {
    const { job, queued, days } = aJob(
      { now: new Date('2026-11-28T07:30:00Z'), today: '2026-11-28' },
      [{ step: aStep('2026-11-28'), owner: AMA }],
    );

    expect((await job.run(SYSTEM))?.nextSteps.emailed).toBe(0);
    expect(queued).toEqual([]);
    expect([...days]).toEqual(['2026-11-28']);
  });

  it('counts an email that could not be queued', async () => {
    const { job } = aJob(FRIDAY, [{ step: aStep('2026-11-27'), owner: AMA }], {
      queueFails: true,
    });

    expect((await job.run(SYSTEM))?.nextSteps).toMatchObject({ emailed: 0, couldNotQueue: 1 });
  });
});

/* ---------------------------------------------------------- task 3: POC alerts */

const FRIDAY_MORNING = new Date('2026-11-27T07:30:00Z');

/** Past its decision date, Thursday the 26th: flagged from Friday. */
function pastDecision(lead: Recipient = AMA): Poc {
  return aPoc({ decisionOn: '2026-11-26' }, lead);
}

/** At Risk since Tuesday morning with nothing written: flagged 48 hours later. */
function atRisk(since = '2026-11-24T09:00:00Z', lead: Recipient = AMA): Poc {
  return aPoc({ health: 'AT_RISK', healthSince: new Date(since) }, lead);
}

describe('which POCs are flagged', () => {
  it('every running POC with a flag, and its flags', () => {
    const late = pastDecision();
    const fine = aPoc();
    const lowUsage = aPoc({
      usage: { measuredOn: '2026-11-27', enrolled: 10, active: 4, percent: 40 },
    });

    const flagged = flaggedOf([late, fine, lowUsage], FRIDAY_MORNING, '2026-11-27');

    expect(flagged.map(({ poc, flags }) => [poc.id, flags.map((flag) => flag.kind)])).toEqual([
      [late.id, ['PAST_DECISION']],
      [lowUsage.id, ['LOW_USAGE']],
    ]);
  });
});

describe('who is told about a POC', () => {
  const managerOf = new Map(PEOPLE.map((person) => [person.id, person.managerId]));
  const bdManagers = new Set([KWAME.id]);
  const PAST: PocFlag = { kind: 'PAST_DECISION', since: new Date('2026-11-27T00:00:00Z') };

  it('its CS lead, and the lead’s line manager who is a BD manager', () => {
    expect(toldAbout(pastDecision(AMA), managerOf, bdManagers)).toEqual([AMA.id, KWAME.id]);
  });

  it('only its CS lead where their manager is not a BD manager, or there is none', () => {
    expect(toldAbout(pastDecision(KOFI), managerOf, bdManagers)).toEqual([KOFI.id]);
    expect(toldAbout(pastDecision(KWAME), managerOf, bdManagers)).toEqual([KWAME.id]);
  });

  it('each person once, with every POC that is theirs to hear of', () => {
    const amas = { poc: pastDecision(AMA), flags: [PAST] };
    const kofis = { poc: pastDecision(KOFI), flags: [PAST] };

    expect(alertsByPerson([amas, kofis], managerOf, bdManagers)).toEqual(
      new Map([
        [AMA.id, [amas]],
        [KWAME.id, [amas]],
        [KOFI.id, [kofis]],
      ]),
    );
  });

  it('nobody a flag they were told, though others not told yet still are', () => {
    const amas = { poc: pastDecision(AMA), flags: [PAST] };
    const told = new Set([toldToKeyOf(AMA.id, { pocId: amas.poc.id, ...PAST })]);

    expect(alertsByPerson([amas], managerOf, bdManagers, told)).toEqual(
      new Map([[KWAME.id, [amas]]]),
    );
  });

  it('the same flag from a new moment is told again', () => {
    const poc = atRisk();
    const flagged = flaggedOf([poc], FRIDAY_MORNING, '2026-11-27');
    const told = new Set([
      toldToKeyOf(AMA.id, {
        pocId: poc.id,
        kind: 'NO_CORRECTIVE_ACTION',
        since: new Date('2026-11-26T09:00:00Z'),
      }),
      toldToKeyOf(KWAME.id, {
        pocId: poc.id,
        kind: 'NO_CORRECTIVE_ACTION',
        since: new Date('2026-11-26T09:00:00Z'),
      }),
    ]);

    expect(alertsByPerson(flagged, managerOf, bdManagers, told).size).toBe(0);

    /* At Risk again, from Wednesday at 07:00: a new moment, so told again. */
    const again = flaggedOf(
      [{ ...poc, healthSince: new Date('2026-11-25T07:00:00Z') }],
      FRIDAY_MORNING,
      '2026-11-27',
    );
    expect(alertsByPerson(again, managerOf, bdManagers, told).get(AMA.id)?.[0].flags).toEqual([
      { kind: 'NO_CORRECTIVE_ACTION', since: new Date('2026-11-27T07:00:00Z') },
    ]);
  });
});

describe('the POC alerts email', () => {
  const links = clientsLinks('https://portal.example.com');

  /* Task 4: the same flags are the same email, whatever order they come in; a new one is not. */
  it('is keyed by the flags it tells', () => {
    const one = pastDecision();
    const other = atRisk();
    const past = { kind: 'PAST_DECISION' as const, since: new Date('2026-11-27T00:00:00Z') };
    const risk = { kind: 'NO_CORRECTIVE_ACTION' as const, since: new Date('2026-11-26T09:00') };
    const keyOf = (alerts: { poc: Poc; flags: PocFlag[] }[]) =>
      pocAlertsEmail({ recipient: AMA, day: '2026-11-27', alerts, links }).dedupeKey;

    const both = keyOf([
      { poc: one, flags: [past] },
      { poc: other, flags: [risk] },
    ]);

    expect(
      keyOf([
        { poc: other, flags: [risk] },
        { poc: one, flags: [past] },
      ]),
    ).toBe(both);
    expect(keyOf([{ poc: one, flags: [past] }])).not.toBe(both);
  });

  it('names the POC, what is wrong and its CS lead, and links to the POC', () => {
    const poc = pastDecision();
    const email = pocAlertsEmail({
      recipient: KWAME,
      day: '2026-11-27',
      alerts: [{ poc, flags: [{ kind: 'PAST_DECISION', since: new Date('2026-11-27') }] }],
      links,
    });

    expect(email).toMatchObject({
      kind: 'CLIENTS_POC_ALERTS',
      recipientEmployeeId: KWAME.id,
      to: KWAME.workEmail,
      subject: 'POC alert: ADB · Federation needs attention',
      dedupeKey: expect.stringMatching(
        new RegExp(`^CLIENTS_POC_ALERTS:${KWAME.id}:2026-11-27:[0-9a-f]{12}$`),
      ) as unknown,
    });
    expect(email.text).toContain('Hello Kwame,');
    expect(email.text).toContain(
      'ADB · Federation: Past its decision date, 26 November 2026. CS lead: Ama Mensah.',
    );
    expect(email.text).toContain(`https://portal.example.com/#/clients/poc/${poc.id}`);
  });

  it('several POCs in one, linking to the POCs tab', () => {
    const lowUsage = aPoc({
      client: { id: '2', name: 'Testbank', type: 'Bank' },
      usage: { measuredOn: '2026-11-27', enrolled: 10, active: 4, percent: 40 },
    });
    const email = pocAlertsEmail({
      recipient: AMA,
      day: '2026-11-27',
      alerts: [
        { poc: pastDecision(), flags: [{ kind: 'PAST_DECISION', since: new Date() }] },
        {
          poc: lowUsage,
          flags: [
            { kind: 'LOW_USAGE', since: new Date() },
            { kind: 'NO_CORRECTIVE_ACTION', since: new Date() },
          ],
        },
      ],
      links,
    });

    expect(email.subject).toBe('POC alerts: 2 POCs need attention');
    expect(email.text).toContain(
      'Testbank · Federation: Below 50% usage at Day 63 (40%): unlikely to convert. ' +
        'No corrective action 48 hours after At Risk. CS lead: Ama Mensah.',
    );
    expect(email.text).toContain('https://portal.example.com/#/clients/pocs');
  });
});

describe('the POC alerts a run sends', () => {
  const FRIDAY = { now: FRIDAY_MORNING, today: '2026-11-27' };

  function alertsIn(queued: NewOutboxEmail[]): [string, string][] {
    return queued
      .filter((email) => email.kind === 'CLIENTS_POC_ALERTS')
      .map((email) => [email.to, email.subject]);
  }

  it('to each CS lead, and to a BD manager over them, once each', async () => {
    const amas = pastDecision(AMA);
    const kofis = atRisk('2026-11-24T09:00:00Z', KOFI);
    const { job, queued } = aJob(FRIDAY, [], { pocs: [amas, kofis, aPoc()] });

    const run = await job.run(SYSTEM);

    expect(run?.pocAlerts).toEqual({
      flags: 2,
      emailed: 3,
      skipped: 0,
      alreadyQueued: 0,
      couldNotQueue: 0,
    });
    expect(alertsIn(queued)).toEqual([
      [AMA.workEmail, 'POC alert: ADB · Federation needs attention'],
      [KWAME.workEmail, 'POC alert: ADB · Federation needs attention'],
      [KOFI.workEmail, 'POC alert: ADB · Federation needs attention'],
    ]);
  });

  it('a flag once: the next morning it is not told again', async () => {
    const at = { ...FRIDAY };
    const { job, queued } = aJob(at, [], { pocs: [pastDecision()] });

    await job.run(SYSTEM);
    at.now = new Date('2026-11-30T07:30:00Z');
    at.today = '2026-11-30';
    const monday = await job.run(SYSTEM);

    expect(monday?.pocAlerts.flags).toBe(0);
    expect(alertsIn(queued)).toHaveLength(2);
  });

  it('none on a weekend: Saturday’s new flag is told on Monday', async () => {
    const at = { now: new Date('2026-11-28T07:30:00Z'), today: '2026-11-28' };
    const { job, queued, told } = aJob(at, [], { pocs: [pastDecision()] });

    expect((await job.run(SYSTEM))?.workingDay).toBe(false);
    expect(queued).toEqual([]);
    expect(told.size).toBe(0);

    at.now = new Date('2026-11-30T07:30:00Z');
    at.today = '2026-11-30';
    expect((await job.run(SYSTEM))?.pocAlerts.flags).toBe(1);
  });

  it('skips a CS lead who cannot take it, and still tells their BD manager', async () => {
    const { job, queued } = aJob(FRIDAY, [], { pocs: [pastDecision(AMA)], cannot: [AMA.id] });

    expect((await job.run(SYSTEM))?.pocAlerts).toMatchObject({
      flags: 1,
      emailed: 1,
      skipped: 1,
    });
    expect(alertsIn(queued).map(([to]) => to)).toEqual([KWAME.workEmail]);
  });

  it('keeps a flag nobody could be told untold, for a morning somebody can', async () => {
    const { job, queued, told } = aJob(FRIDAY, [], {
      pocs: [pastDecision(KOFI)],
      cannot: [KOFI.id],
    });

    expect((await job.run(SYSTEM))?.pocAlerts).toMatchObject({ flags: 0, skipped: 1 });
    expect(queued).toEqual([]);
    expect(told.size).toBe(0);
  });

  it('keeps a flag untold where its email could not be queued', async () => {
    const { job, told } = aJob(FRIDAY, [], { pocs: [pastDecision(KOFI)], queueFails: true });

    expect((await job.run(SYSTEM))?.pocAlerts).toMatchObject({ flags: 0, couldNotQueue: 1 });
    expect(told.size).toBe(0);
  });
});

/* ------------------------------------------------- task 5: missed days caught up */

describe('the mornings a run catches up', () => {
  it('reaches back to the last working morning the job ran', () => {
    /* Ran Monday, missed Tuesday: Wednesday's window starts on Monday, not Tuesday. */
    expect(reminderWindowOf('2026-11-25', MONDAY_TO_FRIDAY, '2026-11-23')).toEqual({
      from: '2026-11-23',
      before: '2026-11-26',
    });
  });

  it('is one morning’s window where none was missed, or there has been no run before', () => {
    const oneMorning = { from: '2026-11-24', before: '2026-11-26' };

    expect(reminderWindowOf('2026-11-25', MONDAY_TO_FRIDAY, '2026-11-24')).toEqual(oneMorning);
    expect(reminderWindowOf('2026-11-25', MONDAY_TO_FRIDAY, null)).toEqual(oneMorning);
  });

  it('counts back from a working morning the job ran, not a weekend it ran on', () => {
    expect(lastWorkingRunOf(['2026-11-29', '2026-11-25', '2026-11-28'], MONDAY_TO_FRIDAY)).toBe(
      '2026-11-25',
    );
    expect(lastWorkingRunOf(['2026-11-28'], MONDAY_TO_FRIDAY)).toBeNull();
    expect(lastWorkingRunOf([], MONDAY_TO_FRIDAY)).toBeNull();
  });

  it('names the working mornings missed', () => {
    expect(missedMorningsOf('2026-11-23', '2026-11-26', MONDAY_TO_FRIDAY)).toEqual([
      '2026-11-24',
      '2026-11-25',
    ]);
    expect(missedMorningsOf('2026-11-25', '2026-11-30', MONDAY_TO_FRIDAY)).toEqual([
      '2026-11-26',
      '2026-11-27',
    ]);
    expect(missedMorningsOf('2026-11-25', '2026-11-26', MONDAY_TO_FRIDAY)).toEqual([]);
    expect(missedMorningsOf(null, '2026-11-26', MONDAY_TO_FRIDAY)).toEqual([]);
  });
});

describe('a run after missed mornings', () => {
  const THURSDAY = { now: new Date('2026-11-26T07:30:00Z'), today: '2026-11-26' };

  /* Done when: after two days without a run, the next run sends what was missed. */
  it('after two days without a run, sends what they would have, in today’s one email', async () => {
    const { job, queued } = aJob(
      THURSDAY,
      [
        /* Told on Monday, overdue since: nothing missed. */
        { step: aStep('2026-11-20', { description: 'Told already' }), owner: AMA },
        /* Due Monday, told then; its first overdue morning, Tuesday, was missed. */
        { step: aStep('2026-11-23', { description: 'Monday’s' }), owner: AMA },
        /* Due on the missed Tuesday and Wednesday. */
        { step: aStep('2026-11-24', { description: 'Tuesday’s' }), owner: AMA },
        { step: aStep('2026-11-25', { description: 'Wednesday’s' }), owner: AMA },
        { step: aStep('2026-11-26', { description: 'Thursday’s' }), owner: AMA },
      ],
      { ranOn: ['2026-11-23'] },
    );

    const run = await job.run(SYSTEM);

    expect(run?.caughtUp).toEqual(['2026-11-24', '2026-11-25']);
    expect(run?.nextSteps).toMatchObject({ emailed: 1, steps: 4 });
    expect(queued.map((email) => email.subject)).toEqual(['Your next steps: 1 due, 3 overdue']);
    expect(queued[0].text).not.toContain('Told already');
    expect(queued[0].text).toContain('Overdue, was due 23 November 2026');
    expect(queued[0].text).toContain('Overdue, was due 24 November 2026');
    expect(queued[0].text).toContain('Overdue, was due 25 November 2026');
    expect(queued[0].text).toContain('Due today: Testbank · CreditStudio: Thursday’s');
  });

  it('reaches past a weekend it ran on, to the last working morning', async () => {
    const { job } = aJob(
      { now: new Date('2026-11-30T07:30:00Z'), today: '2026-11-30' },
      [{ step: aStep('2026-11-26'), owner: AMA }],
      { ranOn: ['2026-11-25', '2026-11-28', '2026-11-29'] },
    );

    const run = await job.run(SYSTEM);

    expect(run?.caughtUp).toEqual(['2026-11-26', '2026-11-27']);
    expect(run?.nextSteps.steps).toBe(1);
  });

  it('catches nothing up on the very first run', async () => {
    const { job, queued } = aJob(THURSDAY, [{ step: aStep('2026-11-24'), owner: AMA }]);

    const run = await job.run(SYSTEM);

    expect(run?.caughtUp).toEqual([]);
    expect(queued).toEqual([]);
  });

  it('tells a POC flag raised while it was down, and not one that has cleared', async () => {
    const { job, queued } = aJob(THURSDAY, [], {
      ranOn: ['2026-11-23'],
      pocs: [
        /* Past its decision date on Tuesday, while nothing ran. */
        aPoc({ decisionOn: '2026-11-23' }),
        /* At Risk on Monday and answered since: no flag now. */
        aPoc({
          health: 'AT_RISK',
          healthSince: new Date('2026-11-21T09:00:00Z'),
          healthAnswered: true,
        }),
      ],
    });

    expect((await job.run(SYSTEM))?.pocAlerts.flags).toBe(1);
    expect(queued.filter((email) => email.kind === 'CLIENTS_POC_ALERTS')).toHaveLength(2);
  });
});

/* ------------------------------------------- task 6: one failure stops nothing else */

describe('one failed send', () => {
  const FRIDAY = { now: new Date('2026-11-27T07:30:00Z'), today: '2026-11-27' };

  it('does not stop the other owners’ next steps', async () => {
    const { job, queued, days } = aJob(
      FRIDAY,
      [
        { step: aStep('2026-11-27'), owner: AMA },
        { step: aStep('2026-11-27', { ownerId: KOFI.id }), owner: KOFI },
        { step: aStep('2026-11-27', { ownerId: KWAME.id }), owner: KWAME },
      ],
      { failing: { people: [AMA.id], throwFor: [KOFI.id] } },
    );

    const run = await job.run(SYSTEM);

    expect(run?.nextSteps).toMatchObject({ emailed: 1, couldNotQueue: 2 });
    expect(queued.map((email) => email.to)).toEqual([KWAME.workEmail]);
    /* Counted and logged, not retried: the day is done. */
    expect(run?.failed).toEqual([]);
    expect([...days]).toEqual(['2026-11-27']);
  });

  it('does not stop the other people’s POC alerts, and leaves only theirs untold', async () => {
    const { job, queued, told } = aJob(FRIDAY, [], {
      pocs: [pastDecision(AMA), pastDecision(KOFI)],
      failing: { people: [AMA.id] },
    });

    const run = await job.run(SYSTEM);

    expect(run?.pocAlerts).toMatchObject({ emailed: 2, couldNotQueue: 1 });
    expect(queued.map((email) => email.to)).toEqual([KWAME.workEmail, KOFI.workEmail]);
    expect([...told].some((key) => key.startsWith(`${AMA.id}|`))).toBe(false);
  });
});

describe('one failed part', () => {
  const FRIDAY = { now: new Date('2026-11-27T07:30:00Z'), today: '2026-11-27' };

  it('does not stop the other, leaves the day open, and is tried again 15 minutes on', async () => {
    const failing: Failing = { steps: true };
    const at = { ...FRIDAY };
    const { job, queued, days } = aJob(at, [{ step: aStep('2026-11-27'), owner: AMA }], {
      pocs: [pastDecision(KOFI)],
      failing,
    });

    const first = await job.run(SYSTEM);

    expect(first?.failed).toEqual([
      { part: 'NEXT_STEPS', because: 'The next steps cannot be read.' },
    ]);
    expect(first?.retryFrom).toEqual(new Date('2026-11-27T07:45:00Z'));
    expect(queued.map((email) => email.kind)).toEqual(['CLIENTS_POC_ALERTS']);
    expect([...days]).toEqual([]);

    /* Not at every minute's ask. */
    at.now = new Date('2026-11-27T07:44:59Z');
    expect(await job.run(SYSTEM)).toBeUndefined();

    /* Fixed by then: the next steps go, and the POC alert is not sent again. */
    failing.steps = false;
    at.now = new Date('2026-11-27T07:45:00Z');
    const again = await job.run(SYSTEM);

    expect(again?.failed).toEqual([]);
    expect(again?.retryFrom).toBeNull();
    expect(again?.pocAlerts.emailed).toBe(0);
    expect(queued.map((email) => email.kind)).toEqual(['CLIENTS_POC_ALERTS', 'CLIENTS_NEXT_STEPS']);
    expect([...days]).toEqual(['2026-11-27']);
  });

  it('keeps being tried every 15 minutes while it fails', async () => {
    const at = { ...FRIDAY };
    const { job, days } = aJob(at, [], { failing: { steps: true } });

    await job.run(SYSTEM);
    at.now = new Date('2026-11-27T07:45:00Z');
    expect((await job.run(SYSTEM))?.retryFrom).toEqual(new Date('2026-11-27T08:00:00Z'));
    expect([...days]).toEqual([]);
  });

  it('a failure before either part starts is tried again 15 minutes on too', async () => {
    const failing: Failing = { calendar: true };
    const at = { ...FRIDAY };
    const { job, days } = aJob(at, [], { failing });

    await expect(job.run(SYSTEM)).rejects.toThrow('The calendar cannot be read.');

    failing.calendar = false;
    at.now = new Date('2026-11-27T07:44:00Z');
    expect(await job.run(SYSTEM)).toBeUndefined();
    at.now = new Date('2026-11-27T07:45:00Z');
    expect((await job.run(SYSTEM))?.ranFor).toBe('2026-11-27');
    expect([...days]).toEqual(['2026-11-27']);
  });
});
