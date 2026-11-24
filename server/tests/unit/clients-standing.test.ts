import { describe, expect, it } from 'vitest';
import type { Employee } from '../../src/core/organisation/employee/employee.js';
import { dashboardOf } from '../../src/apps/clients/dashboard.js';
import type { Opportunity } from '../../src/apps/clients/opportunity.js';
import type { PipelineDeal } from '../../src/apps/clients/pipeline.js';
import type { PocView } from '../../src/apps/clients/poc.js';
import { ClientsStandings, type Standing, standingOf } from '../../src/apps/clients/standing.js';

/** Who can no longer look after their clients, deals and POCs. #289, Clients SRS CLI 96. */

const TODAY = '2026-11-24';

function anEmployee(changes: Partial<Employee> = {}): Employee {
  return {
    id: '100',
    employeeNumber: 'E100',
    firstName: 'Kofi',
    lastName: 'Mensah',
    workEmail: 'kofi@example.com',
    jobTitle: null,
    departmentId: '1',
    managerId: null,
    workPatternId: '1',
    startDate: '2024-01-01',
    exitDate: null,
    employmentType: 'FULL_TIME',
    employmentStatus: 'ACTIVE',
    gender: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...changes,
  } as Employee;
}

describe('whether somebody can look after their things', () => {
  it('can, when current staff holding a role', () => {
    expect(standingOf(anEmployee(), true, TODAY)).toBeNull();
  });

  it('can, on their last day, and cannot the day after', () => {
    expect(standingOf(anEmployee({ exitDate: TODAY }), true, TODAY)).toBeNull();
    expect(standingOf(anEmployee({ exitDate: '2026-11-23' }), true, TODAY)).toEqual({
      reason: 'LEFT',
      exitDate: '2026-11-23',
    });
  });

  it('cannot while suspended, though they keep their role', () => {
    expect(standingOf(anEmployee({ employmentStatus: 'SUSPENDED' }), true, TODAY)).toEqual({
      reason: 'SUSPENDED',
      exitDate: null,
    });
  });

  it('cannot before they start', () => {
    expect(standingOf(anEmployee({ startDate: '2026-12-01' }), true, TODAY)).toMatchObject({
      reason: 'NOT_STARTED',
    });
  });

  it('cannot without a live role, and says having left first', () => {
    expect(standingOf(anEmployee(), false, TODAY)).toEqual({ reason: 'NO_ROLE', exitDate: null });
    expect(standingOf(anEmployee({ exitDate: '2026-11-01' }), false, TODAY)).toMatchObject({
      reason: 'LEFT',
    });
  });

  it('cannot with no record at all', () => {
    expect(standingOf(undefined, true, TODAY)).toMatchObject({ reason: 'NO_ROLE' });
  });

  it('is asked of several at once, naming only those who cannot', async () => {
    const standings = new ClientsStandings(
      { liveHolderIds: () => Promise.resolve(['1', '2']) },
      {
        findAllById: (ids) =>
          Promise.resolve(
            [anEmployee({ id: '1' }), anEmployee({ id: '2', exitDate: '2026-11-01' })].filter(
              (one) => ids.includes(one.id),
            ),
          ),
      },
      () => TODAY,
    );

    const found = await standings.of(['1', '2', '3', '1']);

    expect([...found]).toEqual([
      ['2', { reason: 'LEFT', exitDate: '2026-11-01' }],
      ['3', { reason: 'NO_ROLE', exitDate: null }],
    ]);
    expect(await standings.of([])).toEqual(new Map());
  });
});

describe('the dashboard list of what needs reassigning', () => {
  const kofi = { id: '100', name: 'Kofi Mensah' };
  const ama = { id: '101', name: 'Ama Owusu' };
  const here = { id: '102', name: 'Mavis Ansah' };
  const left: Standing = { reason: 'LEFT', exitDate: '2026-11-01' };
  const noRole: Standing = { reason: 'NO_ROLE', exitDate: null };

  function aDeal(id: string, owner: typeof kofi, client: string, product: string): PipelineDeal {
    return {
      deal: {
        id,
        client: { id: `c-${client}`, name: client },
        product: { id: 'p', name: product, lineId: 'l', lineName: 'Symphony' },
        owner,
        stage: 'PROPOSAL',
        outcome: 'OPEN',
        value: null,
        probability: null,
      } as Opportunity,
      clientTypeId: '5',
      clientType: 'Bank',
      nextStep: null,
      lastContact: null,
    };
  }

  function aPoc(id: string, lead: typeof kofi, standing: Standing | null, outcome = 'OPEN') {
    return {
      id,
      client: { id: 'c-Ecobank', name: 'Ecobank', type: 'Bank' },
      deal: { productName: 'Federation', outcome },
      csLead: lead,
      csLeadStanding: standing,
      health: 'ON_TRACK',
      flags: [],
      daysToDecision: 10,
    } as unknown as PocView;
  }

  it("groups each person's clients, open deals and running POCs, by name", () => {
    const { reassign } = dashboardOf(
      [
        aDeal('d1', kofi, 'Zenith', 'CreditStudio'),
        aDeal('d2', kofi, 'Ecobank', 'Federation'),
        aDeal('d3', here, 'ADB', 'CreditStudio'),
        aDeal('d4', ama, 'GT Bank', 'Cloud9'),
      ],
      [aPoc('p1', kofi, left), aPoc('p2', kofi, left, 'WON'), aPoc('p3', here, null)],
      [],
      TODAY,
      [
        { id: 'c-Zenith', name: 'Zenith', owner: kofi },
        { id: 'c-Access', name: 'Access', owner: kofi },
        { id: 'c-ADB', name: 'ADB', owner: here },
      ],
      new Map([
        [kofi.id, left],
        [ama.id, noRole],
      ]),
    );

    expect(reassign).toEqual([
      {
        person: ama,
        standing: noRole,
        clients: [],
        deals: [{ id: 'd4', client: { id: 'c-GT Bank', name: 'GT Bank' }, productName: 'Cloud9' }],
        pocs: [],
      },
      {
        person: kofi,
        standing: left,
        clients: [
          { id: 'c-Access', name: 'Access' },
          { id: 'c-Zenith', name: 'Zenith' },
        ],
        deals: [
          { id: 'd2', client: { id: 'c-Ecobank', name: 'Ecobank' }, productName: 'Federation' },
          { id: 'd1', client: { id: 'c-Zenith', name: 'Zenith' }, productName: 'CreditStudio' },
        ],
        /* The one that ended stays as it is. */
        pocs: [
          { id: 'p1', client: { id: 'c-Ecobank', name: 'Ecobank' }, productName: 'Federation' },
        ],
      },
    ]);
  });

  it('is empty where everybody can look after their things', () => {
    expect(
      dashboardOf([aDeal('d1', here, 'ADB', 'Cloud9')], [aPoc('p1', here, null)], [], TODAY)
        .reassign,
    ).toEqual([]);
  });
});
