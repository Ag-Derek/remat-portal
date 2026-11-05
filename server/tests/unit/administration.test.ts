import { describe, expect, it } from 'vitest';
import { signedInAs, theSystem } from '../../src/core/auth/actor.js';
import type { AuditEntry } from '../../src/core/audit/audit.js';
import type { Employee } from '../../src/core/organisation/employee/employee.js';
import { problemFor } from '../../src/core/http/problems.js';
import {
  assertCanTakeReports,
  CannotTakeTheirOwnReports,
  historyOf,
  InvalidAdministrationForm,
  loginsToCreate,
  ManagerNotCurrent,
  NobodyToReassign,
  readEmployeeChanges,
  readNewEmployee,
  readReassignment,
  readTeamLead,
  reportsStillHere,
  setsAnExitDate,
  type StaffRecord,
  standingOf,
  StillHasReports,
} from '../../src/apps/directory/administration.js';
import { directoryPolicy } from '../../src/apps/directory/policy.js';

/** HR's Administration tab, as rules. */

const TODAY = '2026-10-29';

const hrOfficer = signedInAs('hr', { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
const hrAdmin = signedInAs('head', { roles: ['EMPLOYEE', 'HR_ADMIN'], isManager: true });
const sysAdmin = signedInAs('it', { roles: ['EMPLOYEE', 'SYS_ADMIN'], isManager: false });
const manager = signedInAs('nii', { roles: ['EMPLOYEE'], isManager: true });
const employee = signedInAs('kofi', { roles: ['EMPLOYEE'], isManager: false });

describe('who may administer records', () => {
  it('is HR, either desk', () => {
    expect(directoryPolicy.administer(hrOfficer).allowed).toBe(true);
    expect(directoryPolicy.administer(hrAdmin, 'kofi').allowed).toBe(true);
  });

  it('is nobody else, a manager and a system administrator included', () => {
    for (const actor of [manager, employee, sysAdmin]) {
      expect(directoryPolicy.administer(actor, 'kofi').allowed).toBe(false);
    }
  });

  it('refuses openly, so the route answers 403 rather than 404', () => {
    const refused = directoryPolicy.administer(employee, 'kofi');

    expect(refused.told).toMatch(/added and changed by HR/);
  });

  it('decides on the actor alone, so an id that is nobody is refused the same way', () => {
    expect(directoryPolicy.administer(employee, 'nobody')).toMatchObject({
      allowed: false,
      told: directoryPolicy.administer(employee, 'kofi').told,
    });
  });

  it('lets HR and system administrators see who is waiting for a login, and nobody else', () => {
    expect(directoryPolicy.loginsToCreate(sysAdmin).allowed).toBe(true);
    expect(directoryPolicy.loginsToCreate(hrOfficer).allowed).toBe(true);
    expect(directoryPolicy.loginsToCreate(manager).allowed).toBe(false);
    expect(directoryPolicy.loginsToCreate(manager).told).not.toBeNull();
  });
});

describe('where somebody stands', () => {
  it('is current, starting, leaving, left or suspended', () => {
    expect(standingOf(person({ id: 'a' }), TODAY)).toBe('CURRENT');
    expect(standingOf(person({ id: 'a', startDate: '2026-11-02' }), TODAY)).toBe('STARTING');
    expect(standingOf(person({ id: 'a', exitDate: '2026-11-30' }), TODAY)).toBe('LEAVING');
    expect(
      standingOf(
        person({ id: 'a', exitDate: '2026-09-30', employmentStatus: 'TERMINATED' }),
        TODAY,
      ),
    ).toBe('LEFT');
    expect(standingOf(person({ id: 'a', employmentStatus: 'SUSPENDED' }), TODAY)).toBe('SUSPENDED');
  });

  it('keeps somebody on their last day as leaving, not left', () => {
    expect(standingOf(person({ id: 'a', exitDate: TODAY }), TODAY)).toBe('LEAVING');
  });
});

describe('the exit date rule', () => {
  const head = person({ id: 'head' });
  const team = [
    head,
    person({ id: 'a', managerId: 'head' }),
    person({ id: 'joiner', managerId: 'head', startDate: '2026-11-02' }),
    person({
      id: 'gone',
      managerId: 'head',
      exitDate: '2026-01-31',
      employmentStatus: 'TERMINATED',
    }),
  ];

  it('counts reports still here, joiners included, and not reports who have left', () => {
    expect(reportsStillHere(head, team, TODAY).map((one) => one.id)).toEqual(['a', 'joiner']);
  });

  it('applies when an exit date is being set, or the record is being terminated', () => {
    expect(setsAnExitDate({ exitDate: '2026-12-31' }, head)).toBe(true);
    expect(
      setsAnExitDate(
        { employmentStatus: 'TERMINATED' },
        person({ id: 'head', exitDate: '2026-12-31' }),
      ),
    ).toBe(true);
  });

  it('does not apply to clearing an exit date, or to an edit that leaves one alone', () => {
    const serving = person({ id: 'head', exitDate: '2026-12-31' });

    expect(setsAnExitDate({ exitDate: null }, serving)).toBe(false);
    expect(setsAnExitDate({ firstName: 'Kojo' }, serving)).toBe(false);
    expect(setsAnExitDate({ exitDate: '2026-12-31' }, serving)).toBe(false);
    expect(setsAnExitDate({ firstName: 'Kojo' }, head)).toBe(false);
  });

  it('names who is still reporting and says what to do, beside the exit date box', () => {
    const refusal = new StillHasReports(
      person({ id: 'head', firstName: 'Nii', lastName: 'Lartey' }),
      [person({ id: 'a', firstName: 'Kojo', lastName: 'Antwi' })],
    );

    expect(refusal.message).toMatch(
      /Nii Lartey still has 1 person reporting to them \(Kojo Antwi\)/,
    );
    expect(refusal.message).toMatch(/Move their reports to another manager first/);
    expect(problemFor(refusal)).toMatchObject({ status: 409, body: { field: 'exitDate' } });
  });

  it('shortens a long list of names', () => {
    const reports = ['A', 'B', 'C', 'D', 'E'].map((name) =>
      person({ id: name, firstName: name, lastName: 'X' }),
    );

    expect(new StillHasReports(head, reports).message).toMatch(/A X, B X, C X and 2 more/);
  });
});

describe('moving reports', () => {
  const everybody = [
    person({ id: 'ceo' }),
    person({ id: 'nii', managerId: 'ceo' }),
    person({ id: 'adwoa', managerId: 'nii' }),
    person({ id: 'kojo', managerId: 'adwoa' }),
    person({ id: 'efua', managerId: 'ceo' }),
  ];
  const byId = (id: string) => everybody.find((one) => one.id === id)!;

  it('may go to somebody outside the people moving', () => {
    expect(() => {
      assertCanTakeReports(byId('efua'), [byId('adwoa')], everybody);
    }).not.toThrow();
  });

  it('may not go to one of the people moving', () => {
    expect(() => {
      assertCanTakeReports(byId('adwoa'), [byId('adwoa')], everybody);
    }).toThrow(CannotTakeTheirOwnReports);
  });

  it('may not go to somebody below one of the people moving, which would close a loop', () => {
    expect(() => {
      assertCanTakeReports(byId('kojo'), [byId('adwoa')], everybody);
    }).toThrow(/close a loop/);
  });

  it('reads who to move to, and every report or a chosen few', () => {
    expect(readReassignment({ toManagerId: ' efua ' })).toEqual({
      toManagerId: 'efua',
      employeeIds: null,
    });
    expect(readReassignment({ toManagerId: 'efua', employeeIds: ['a', 'a', 'b'] })).toEqual({
      toManagerId: 'efua',
      employeeIds: ['a', 'b'],
    });
  });

  it('refuses no manager, and an empty choice', () => {
    expect(() => readReassignment({})).toThrow(InvalidAdministrationForm);
    expect(() => readReassignment({ toManagerId: 'efua', employeeIds: [] })).toThrow(
      NobodyToReassign,
    );
  });
});

describe('marking a team lead', () => {
  it('reads true or false', () => {
    expect(readTeamLead({ teamLead: true })).toBe(true);
    expect(readTeamLead({ teamLead: false })).toBe(false);
  });

  it('refuses anything else, naming the field', () => {
    for (const body of [{}, { teamLead: 'true' }, { teamLead: 1 }, null, 'true']) {
      expect(() => readTeamLead(body)).toThrow(
        expect.objectContaining({ name: 'InvalidAdministrationForm', field: 'teamLead' }),
      );
    }
  });
});

describe('a new record handed to whoever creates logins', () => {
  const records: StaffRecord[] = [
    record(person({ id: 'kojo', lastName: 'Antwi', startDate: '2026-11-02' }), 'NONE'),
    record(person({ id: 'later', lastName: 'Later', startDate: '2027-01-04' }), 'NONE'),
    record(person({ id: 'here', lastName: 'Here' }), 'ACTIVE'),
    record(person({ id: 'shut', lastName: 'Shut' }), 'CLOSED'),
    record(
      person({ id: 'gone', exitDate: '2026-01-31', employmentStatus: 'TERMINATED' }),
      'NONE',
      'LEFT',
    ),
  ];

  it('lists everybody without a login who has not gone, soonest start first', () => {
    expect(loginsToCreate(records, TODAY).map((one) => one.person.employeeId)).toEqual([
      'kojo',
      'later',
    ]);
  });

  it('flags a start date inside a fortnight', () => {
    const [kojo, later] = loginsToCreate(records, TODAY);

    expect(kojo?.soon).toBe(true);
    expect(later?.soon).toBe(false);
  });

  it('flags the fourteenth day and not the fifteenth', () => {
    const on = (startDate: string) =>
      loginsToCreate([record(person({ id: 'x', startDate }), 'NONE')], TODAY)[0]?.soon;

    expect(on('2026-11-12')).toBe(true);
    expect(on('2026-11-13')).toBe(false);
  });
});

describe('what the form may send', () => {
  it('passes the fields HR keeps through to the record’s own rules', () => {
    expect(
      readNewEmployee({ firstName: 'Kojo', lastName: 'Antwi', managerId: null, jobTitle: '' }),
    ).toEqual({ firstName: 'Kojo', lastName: 'Antwi', managerId: null, jobTitle: '' });
  });

  it('refuses what the person keeps themselves, naming it', () => {
    expect(() => readEmployeeChanges({ workMobile: '0244 000 000' })).toThrow(
      /kept by the person themselves/,
    );
  });

  it('refuses a field that is not on the record, and a value that is not text', () => {
    expect(() => readEmployeeChanges({ salary: '1' })).toThrow(/not a field/);
    expect(() => readEmployeeChanges({ firstName: 3 })).toThrow(/must be text/);
  });

  it('refuses an edit with nothing in it', () => {
    expect(() => readEmployeeChanges({})).toThrow(/Nothing was sent/);
  });
});

describe('a record’s history', () => {
  it('shows each change’s old and new value, who and when, newest first', () => {
    const history = historyOf(
      [
        entry('2026-10-01T09:00:00Z', { job_title: 'Officer' }, { job_title: 'Senior officer' }),
        entry(
          '2026-10-02T09:00:00Z',
          { manager_id: '7', department_id: '7', updated_at: 'a' },
          { manager_id: '8', department_id: '8', updated_at: 'b' },
        ),
      ],
      {
        departments: new Map([
          ['7', 'Finance'],
          ['8', 'Operations'],
        ]),
        employees: new Map([
          ['7', 'Yaw Boateng'],
          ['8', 'Efua Darko'],
        ]),
        patterns: new Map(),
      },
    );

    expect(history.map((one) => one.at.toISOString())).toEqual([
      '2026-10-02T09:00:00.000Z',
      '2026-10-01T09:00:00.000Z',
    ]);
    /* The same id names a department in one column and a person in the other. */
    expect(history[0]?.changes).toEqual([
      { field: 'department_id', label: 'Department', from: 'Finance', to: 'Operations' },
      { field: 'manager_id', label: 'Reports to', from: 'Yaw Boateng', to: 'Efua Darko' },
    ]);
    expect(history[1]?.changes).toEqual([
      { field: 'job_title', label: 'Job title', from: 'Officer', to: 'Senior officer' },
    ]);
    expect(history[0]?.by).toBe('Ama Mensah');
  });

  it('leaves out an entry that moved only bookkeeping', () => {
    expect(
      historyOf([entry('2026-10-01T09:00:00Z', { updated_at: 'a' }, { updated_at: 'b' })], {
        departments: new Map(),
        employees: new Map(),
        patterns: new Map(),
      }),
    ).toEqual([]);
  });
});

describe('how the refusals are answered', () => {
  it('answers each rule that something on record refuses with a 409, naming the box', () => {
    expect(problemFor(new ManagerNotCurrent(person({ id: 'x' })))).toMatchObject({
      status: 409,
      body: { error: 'ManagerNotCurrent', field: 'managerId' },
    });
  });

  it('answers a form mistake with a 400', () => {
    expect(problemFor(new InvalidAdministrationForm('salary', 'no'))).toMatchObject({
      status: 400,
      body: { field: 'salary' },
    });
    expect(problemFor(new NobodyToReassign()).status).toBe(400);
  });

  it('is never refused for the system, which holds every role', () => {
    expect(directoryPolicy.administer(theSystem('an administration unit test')).allowed).toBe(true);
  });
});

function record(
  employee: Employee,
  login: StaffRecord['login'],
  standing: StaffRecord['standing'] = standingOf(employee, TODAY),
): StaffRecord {
  return { employee, departmentName: 'Operations', manager: null, standing, login, reports: 0 };
}

function entry(
  at: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): AuditEntry {
  return {
    id: at,
    occurredAt: new Date(at),
    action: 'UPDATE',
    entity: 'employee',
    entityId: 'kojo',
    before,
    after,
    actor: 'Ama Mensah',
    actorEmployeeId: 'head',
  };
}

function person(fields: Partial<Employee> & { id: string }): Employee {
  return {
    employeeNumber: `RH-${fields.id}`,
    firstName: 'Someone',
    lastName: 'Somebody',
    workEmail: `${fields.id}@rematholdings.com`,
    jobTitle: 'Operations Officer',
    departmentId: 'ops',
    managerId: null,
    workPatternId: 'standard',
    startDate: '2020-01-06',
    exitDate: null,
    employmentType: 'FULL_TIME',
    employmentStatus: 'ACTIVE',
    gender: null,
    createdAt: new Date('2020-01-01T00:00:00Z'),
    updatedAt: new Date('2020-01-01T00:00:00Z'),
    ...fields,
  };
}
