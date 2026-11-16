/**
 * Who may use clients: its two granted roles. #274, Clients SRS CLI 88, CLI 94, TDD 4.8.
 *
 * Granted by a portal System Administrator and nobody else. Any number of people may hold
 * either role at once; a person holds each once at a time. A grant is ended, never deleted, so
 * the rows are the history of who held what and who decided it.
 */

/** The two roles, and nothing else is assignable (CLI 88). */
export const CLIENTS_ROLES = ['BD_MANAGER', 'ASSOCIATE'] as const;

export type ClientsRole = (typeof CLIENTS_ROLES)[number];

/** Why a grant ended. */
export type EndedReason = 'REVOKED' | 'LEFT';

/** One grant, live or ended. */
export interface Grant {
  id: string;
  employeeId: string;
  role: ClientsRole;
  grantedBy: string;
  grantedAt: Date;
  endedAt: Date | null;
  /** Null where it ended because the holder left and nobody acted (CLI 95). */
  endedBy: string | null;
  endedReason: EndedReason | null;
}

/** What the roles screen asks for. */
export interface GrantRequest {
  employeeId: string;
  role: ClientsRole;
}

/** The request body, checked. */
export class InvalidGrant extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidGrant';
    this.field = field;
  }
}

/** What the roles screen sent, checked. Ids are digits, as every BIGSERIAL is. */
export function readGrantRequest(body: unknown): GrantRequest {
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const { employeeId, role } = fields;

  if (typeof employeeId !== 'string' || !/^\d{1,18}$/.test(employeeId)) {
    throw new InvalidGrant('employeeId', 'Choose who to grant the role to.');
  }
  if (typeof role !== 'string' || !(CLIENTS_ROLES as readonly string[]).includes(role)) {
    throw new InvalidGrant('role', 'Choose BD manager or associate.');
  }

  return { employeeId, role: role as ClientsRole };
}

/** How each role is named on a screen and in a sentence. */
export function roleName(role: ClientsRole): string {
  return role === 'BD_MANAGER' ? 'BD manager' : 'associate';
}

/** They already hold it, and a person holds each role once at a time. */
export class ClientsRoleAlreadyHeld extends Error {
  constructor(name: string, role: ClientsRole) {
    super(`${name} is already ${articled(role)} in clients.`);
    this.name = 'ClientsRoleAlreadyHeld';
  }
}

/** Granted only to somebody at the company today. */
export class ClientsGranteeNotCurrent extends Error {
  constructor(name: string) {
    super(
      `${name} is not at the company today, so cannot be given a role in clients. ` +
        'Choose somebody who is.',
    );
    this.name = 'ClientsGranteeNotCurrent';
  }
}

/** Ending a grant twice would rewrite who ended it and when. */
export class ClientsGrantAlreadyEnded extends Error {
  constructor() {
    super('That role has already ended. Refresh the page to see who holds what now.');
    this.name = 'ClientsGrantAlreadyEnded';
  }
}

/** No such grant. */
export class ClientsGrantNotFound extends Error {
  constructor() {
    super('No role in clients matches that. Refresh the page to see who holds what now.');
    this.name = 'ClientsGrantNotFound';
  }
}

/** The person named is nobody with a record. */
export class ClientsGranteeNotFound extends Error {
  constructor() {
    super('Nobody with that record could be found. Choose somebody from the list.');
    this.name = 'ClientsGranteeNotFound';
  }
}

function articled(role: ClientsRole): string {
  return role === 'BD_MANAGER' ? 'a BD manager' : 'an associate';
}
