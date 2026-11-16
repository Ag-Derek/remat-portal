/**
 * Granting and ending the two clients roles. #274, Clients SRS CLI 94, TDD 3.
 *
 * Refuses any caller who is not a portal System Administrator, and is reachable from nothing a
 * BD manager can do.
 */

import type { Actor } from '../../core/auth/actor.js';
import type { Guard } from '../../core/auth/policy.js';
import { type CalendarDate, currentDate } from '../../core/calendar/time.js';
import { isCurrentOn } from '../../core/organisation/employee/current.js';
import type { Employee } from '../../core/organisation/employee/employee.js';
import type { EmployeeRepository } from '../../core/organisation/employee/employee.db.js';
import { accessOf } from './access.js';
import { type ClientsAccess, clientsPolicy } from './policy.js';
import {
  type ClientsRole,
  ClientsGrantAlreadyEnded,
  ClientsGranteeNotCurrent,
  ClientsGranteeNotFound,
  ClientsGrantNotFound,
  type Grant,
  readGrantRequest,
} from './role.js';
import type { ClientsRoleRepository } from './role.db.js';

/** Somebody, as the roles screen names them. */
export interface PersonNamed {
  id: string;
  name: string;
  jobTitle: string | null;
}

/** A live grant, with the people on it named. */
export interface GrantOnTheScreen {
  id: string;
  role: ClientsRole;
  holder: PersonNamed & {
    /** False where they have left, not started or are suspended: a grant to end. */
    current: boolean;
  };
  grantedBy: PersonNamed;
  grantedAt: Date;
}

/** The roles screen. */
export interface RolesScreen {
  today: CalendarDate;
  /** Every live grant, BD managers first, then by surname. */
  grants: GrantOnTheScreen[];
  /** Who a role may be granted to: everybody at the company today, by surname. */
  people: PersonNamed[];
}

export class RoleService {
  constructor(
    private readonly guard: Guard,
    private readonly grants: ClientsRoleRepository,
    private readonly employees: EmployeeRepository,
  ) {}

  /** What clients knows about who is asking: the roles they hold today. */
  private accessOf(actor: Actor): Promise<ClientsAccess> {
    return accessOf(actor, this.grants);
  }

  /** Who holds what, and who could. */
  async screen(actor: Actor): Promise<RolesScreen> {
    this.guard.enforce(clientsPolicy.manageRoles(actor, await this.accessOf(actor)));

    const today = currentDate();
    const [live, everybody] = await Promise.all([this.grants.live(), this.employees.list()]);
    const byId = new Map(everybody.map((employee) => [employee.id, employee]));

    return {
      today,
      grants: live
        .flatMap((grant) => {
          const holder = byId.get(grant.employeeId);
          const grantor = byId.get(grant.grantedBy);

          /* Both are foreign keys to employee, and no employee is ever deleted. */
          return holder === undefined || grantor === undefined
            ? []
            : [
                {
                  id: grant.id,
                  role: grant.role,
                  holder: { ...named(holder), current: isCurrentOn(holder, today) },
                  grantedBy: named(grantor),
                  grantedAt: grant.grantedAt,
                },
              ];
        })
        .sort(
          (a, b) =>
            Number(b.role === 'BD_MANAGER') - Number(a.role === 'BD_MANAGER') ||
            bySurname(byId.get(a.holder.id), byId.get(b.holder.id)),
        ),
      people: everybody
        .filter((employee) => isCurrentOn(employee, today))
        .sort(bySurname)
        .map(named),
    };
  }

  /** Grants a role to somebody at the company today. */
  async grant(actor: Actor, body: unknown): Promise<Grant> {
    /* Before the body is read, so that somebody refused learns nothing from a 400. */
    this.guard.enforce(clientsPolicy.manageRoles(actor, await this.accessOf(actor)));

    const request = readGrantRequest(body);
    const grantee = await this.employees.findById(request.employeeId);

    if (grantee === undefined) {
      throw new ClientsGranteeNotFound();
    }
    if (!isCurrentOn(grantee, currentDate())) {
      throw new ClientsGranteeNotCurrent(nameOf(grantee));
    }

    /* `manageRoles` refuses an actor with no employee behind it. */
    return this.grants.grant(grantee.id, request.role, actor.employeeId ?? '', nameOf(grantee));
  }

  /** Ends a live grant, as withdrawn by this administrator. */
  async end(actor: Actor, grantId: string): Promise<Grant> {
    this.guard.enforce(clientsPolicy.manageRoles(actor, await this.accessOf(actor), grantId));

    if (!/^\d{1,18}$/.test(grantId) || (await this.grants.findById(grantId)) === undefined) {
      throw new ClientsGrantNotFound();
    }

    const ended = await this.grants.end(grantId, actor.employeeId, 'REVOKED');

    if (ended === undefined) {
      throw new ClientsGrantAlreadyEnded();
    }

    return ended;
  }
}

function nameOf(employee: Employee): string {
  return `${employee.firstName} ${employee.lastName}`;
}

function named(employee: Employee): PersonNamed {
  return { id: employee.id, name: nameOf(employee), jobTitle: employee.jobTitle };
}

function bySurname(a: Employee | undefined, b: Employee | undefined): number {
  return (
    (a?.lastName ?? '').localeCompare(b?.lastName ?? '') ||
    (a?.firstName ?? '').localeCompare(b?.firstName ?? '')
  );
}
