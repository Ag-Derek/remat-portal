import { describe, expect, it } from 'vitest';
import { type Employee, EmployeeNotFound } from '../../src/core/organisation/employee/employee.js';
import { managerChainOf } from '../../src/core/organisation/employee/manager-chain.js';

/**
 * The managers above somebody who are still here, nearest first. SRS CMP 38.
 *
 * Ama heads the organisation; Yaw reports to her; Efua reports to Yaw; Kofi reports to Efua.
 */

const TODAY = '2026-11-05';

function person(id: string, managerId: string | null, fields: Partial<Employee> = {}): Employee {
  return {
    id,
    employeeNumber: `RH-${id}`,
    firstName: id.charAt(0).toUpperCase() + id.slice(1),
    lastName: 'Mensah',
    workEmail: `${id}@rematholdings.com`,
    jobTitle: null,
    departmentId: 'ops',
    managerId,
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

const left = { employmentStatus: 'TERMINATED', exitDate: '2026-10-30' } as const;

function organisation(changes: Record<string, Partial<Employee>> = {}): Employee[] {
  return [
    person('ama', null, changes.ama),
    person('yaw', 'ama', changes.yaw),
    person('efua', 'yaw', changes.efua),
    person('kofi', 'efua', changes.kofi),
  ];
}

function chainOf(employeeId: string, employees: readonly Employee[]): string[] {
  return managerChainOf(employeeId, employees, TODAY).map((one) => one.id);
}

describe('the managers above somebody', () => {
  it('are their manager and everybody above, nearest first', () => {
    expect(chainOf('kofi', organisation())).toEqual(['efua', 'yaw', 'ama']);
  });

  it('step over a manager who has departed, to the one they reported to', () => {
    expect(chainOf('kofi', organisation({ efua: left }))).toEqual(['yaw', 'ama']);
  });

  it('step over a departed manager further up and keep the rest', () => {
    expect(chainOf('kofi', organisation({ yaw: left }))).toEqual(['efua', 'ama']);
  });

  it('are nobody when the whole line above has departed', () => {
    expect(chainOf('kofi', organisation({ ama: left, yaw: left, efua: left }))).toEqual([]);
  });

  it('are nobody for the employee with no manager', () => {
    expect(chainOf('ama', organisation())).toEqual([]);
  });

  it('include a manager through their last day', () => {
    const lastDay = { employmentStatus: 'TERMINATED', exitDate: TODAY } as const;

    expect(chainOf('kofi', organisation({ efua: lastDay }))).toEqual(['efua', 'yaw', 'ama']);
  });

  it('step over a manager who is suspended, or who has not started', () => {
    const employees = organisation({
      efua: { employmentStatus: 'SUSPENDED' },
      yaw: { startDate: '2026-12-01' },
    });

    expect(chainOf('kofi', employees)).toEqual(['ama']);
  });

  it('do not depend on whether the employee themselves is still here', () => {
    expect(chainOf('kofi', organisation({ kofi: left }))).toEqual(['efua', 'yaw', 'ama']);
  });

  it('end where the records they were given end', () => {
    expect(chainOf('kofi', organisation().slice(1))).toEqual(['efua', 'yaw']);
  });

  it('survive a reporting line that loops, naming nobody twice', () => {
    const employees = [person('yaw', 'nii'), person('nii', 'yaw'), person('kofi', 'yaw')];

    expect(chainOf('kofi', employees)).toEqual(['yaw', 'nii']);
  });

  it('refuse an employee who is not among the records', () => {
    expect(() => managerChainOf('nobody', organisation(), TODAY)).toThrow(EmployeeNotFound);
  });
});
