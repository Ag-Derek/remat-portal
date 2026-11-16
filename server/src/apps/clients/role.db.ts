/** Database access for clients grants. #274, Clients TDD 4.8. */

import type { Kysely, Selectable } from 'kysely';
import type { Database } from '../../core/db/index.js';
import type { ClientsRoleTable } from '../../core/db/schema.js';
import { type ClientsRole, ClientsRoleAlreadyHeld, type EndedReason, type Grant } from './role.js';

/** The unique index that holds a person to one live grant of each role. */
const ONE_LIVE_GRANT = 'uq_clients_role_live';

export class ClientsRoleRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Every live grant, oldest first. */
  async live(): Promise<Grant[]> {
    const rows = await this.db
      .selectFrom('clients_role')
      .selectAll()
      .where('ended_at', 'is', null)
      .orderBy('granted_at')
      .orderBy('id')
      .execute();

    return rows.map(grantFrom);
  }

  /** The roles one person holds today. Empty for most staff. */
  async rolesOf(employeeId: string): Promise<ClientsRole[]> {
    const rows = await this.db
      .selectFrom('clients_role')
      .select('role')
      .where('employee_id', '=', employeeId)
      .where('ended_at', 'is', null)
      .execute();

    return rows.map((row) => row.role as ClientsRole);
  }

  /** Everybody who holds a live grant, once each. */
  async liveHolderIds(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('clients_role')
      .select('employee_id')
      .distinct()
      .where('ended_at', 'is', null)
      .execute();

    return rows.map((row) => row.employee_id);
  }

  /**
   * Ends every live grant one person holds, because they left (CLI 95). Nobody ended them, so
   * `ended_by` stays null. Those already ended are left as they are, so running it twice ends
   * nothing the second time.
   */
  async endAllBecauseTheyLeft(employeeId: string): Promise<Grant[]> {
    const rows = await this.db
      .updateTable('clients_role')
      .set({ ended_at: new Date(), ended_by: null, ended_reason: 'LEFT' })
      .where('employee_id', '=', employeeId)
      .where('ended_at', 'is', null)
      .returningAll()
      .execute();

    return rows.map(grantFrom);
  }

  async findById(id: string): Promise<Grant | undefined> {
    const row = await this.db
      .selectFrom('clients_role')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : grantFrom(row);
  }

  /**
   * Grants a role. A second live grant of the same role is refused by the database, which is
   * the answer even when two administrators press the button at once.
   */
  async grant(
    employeeId: string,
    role: ClientsRole,
    grantedBy: string,
    nameForTheRefusal: string,
  ): Promise<Grant> {
    try {
      const row = await this.db
        .insertInto('clients_role')
        .values({ employee_id: employeeId, role, granted_by: grantedBy })
        .returningAll()
        .executeTakeFirstOrThrow();

      return grantFrom(row);
    } catch (error) {
      if ((error as { constraint?: unknown }).constraint === ONE_LIVE_GRANT) {
        throw new ClientsRoleAlreadyHeld(nameForTheRefusal, role);
      }
      throw error;
    }
  }

  /**
   * Ends a live grant. Undefined where it had already ended, so a second press, or two
   * administrators at once, cannot rewrite who ended it and when.
   */
  async end(id: string, endedBy: string | null, reason: EndedReason): Promise<Grant | undefined> {
    const row = await this.db
      .updateTable('clients_role')
      .set({ ended_at: new Date(), ended_by: endedBy, ended_reason: reason })
      .where('id', '=', id)
      .where('ended_at', 'is', null)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : grantFrom(row);
  }
}

function grantFrom(row: Selectable<ClientsRoleTable>): Grant {
  return {
    id: row.id,
    employeeId: row.employee_id,
    /* The table's CHECKs are what make these two casts safe. */
    role: row.role as ClientsRole,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at,
    endedAt: row.ended_at,
    endedBy: row.ended_by,
    endedReason: row.ended_reason as EndedReason | null,
  };
}
