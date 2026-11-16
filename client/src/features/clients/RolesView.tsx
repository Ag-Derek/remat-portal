import { useCallback, useEffect, useState } from 'react';
import {
  type ClientsGrant,
  type ClientsRole,
  type ClientsRoles,
  clientsRoles,
  endClientsRole,
  grantClientsRole,
  isNotSignedIn,
} from '../../api';
import { RemoveButton } from '../../ActionButtons';
import { momentDate } from '../../format';
import { Notice, type Problem, problemFrom } from '../../problem';

const ROLE_NAMES: Record<ClientsRole, string> = {
  BD_MANAGER: 'BD manager',
  ASSOCIATE: 'Associate',
};

/**
 * Who holds which clients role, a way to grant one, and a way to end each. #274, CLI 94.
 *
 * A portal System Administrator's alone, which the server decides; the page draws this view only
 * where `/api/clients/me` said so.
 */
export function RolesView({ onSignedOut }: { onSignedOut: () => void }) {
  const [roles, setRoles] = useState<ClientsRoles | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);

    clientsRoles()
      .then((found) => {
        setRoles(found);
        setProblem(undefined);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setProblem(problemFrom(error));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [onSignedOut]);

  useEffect(load, [load]);

  return (
    <>
      {problem === undefined ? null : (
        <Notice problem={problem} retrying={loading} onRetry={load} />
      )}
      {roles === undefined ? null : (
        <Roles roles={roles} onChanged={load} onSignedOut={onSignedOut} />
      )}
    </>
  );
}

function Roles({
  roles,
  onChanged,
  onSignedOut,
}: {
  roles: ClientsRoles;
  onChanged: () => void;
  onSignedOut: () => void;
}) {
  const [employeeId, setEmployeeId] = useState('');
  const [role, setRole] = useState<ClientsRole>('ASSOCIATE');
  const [granting, setGranting] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);

  const grant = () => {
    setGranting(true);
    setProblem(undefined);

    grantClientsRole(employeeId, role)
      .then(() => {
        setEmployeeId('');
        onChanged();
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setProblem(problemFrom(error));
      })
      .finally(() => {
        setGranting(false);
      });
  };

  return (
    <>
      <p className="muted">
        Granting a role lets somebody see clients. BD managers can also reassign work, read every
        meeting report and keep the products and lists. Only a portal system administrator can grant
        or end a role.
      </p>

      <form
        className="filter-bar clients-grant"
        onSubmit={(event) => {
          event.preventDefault();
          grant();
        }}
      >
        <label>
          <span className="visually-hidden">Person</span>
          <select
            value={employeeId}
            disabled={granting}
            required
            onChange={(event) => {
              setEmployeeId(event.target.value);
            }}
          >
            <option value="">Choose somebody…</option>
            {roles.people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
                {person.jobTitle === null ? '' : `, ${person.jobTitle}`}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span className="visually-hidden">Role</span>
          <select
            value={role}
            disabled={granting}
            onChange={(event) => {
              setRole(event.target.value as ClientsRole);
            }}
          >
            <option value="ASSOCIATE">Associate</option>
            <option value="BD_MANAGER">BD manager</option>
          </select>
        </label>

        <button type="submit" className="primary" disabled={granting || employeeId === ''}>
          {granting ? 'Granting…' : 'Grant the role'}
        </button>
      </form>

      {problem === undefined ? null : <Notice problem={problem} />}

      {roles.grants.length === 0 ? (
        <div className="notice plain">
          <p>Nobody holds a role in clients yet. Start with a BD manager.</p>
        </div>
      ) : (
        <div className="directory-card">
          <table className="directory-table">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col">Granted</th>
                <th scope="col">
                  <span className="visually-hidden">End</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {roles.grants.map((one) => (
                <GrantRow
                  key={one.id}
                  grant={one}
                  onChanged={onChanged}
                  onSignedOut={onSignedOut}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function GrantRow({
  grant,
  onChanged,
  onSignedOut,
}: {
  grant: ClientsGrant;
  onChanged: () => void;
  onSignedOut: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const roleName = ROLE_NAMES[grant.role];

  const end = () => {
    setBusy(true);

    endClientsRole(grant.id)
      .then(onChanged)
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setProblem(problemFrom(error));
        setBusy(false);
      });
  };

  return (
    <tr>
      <td>
        {grant.holder.name}
        {grant.holder.jobTitle === null ? null : <small> {grant.holder.jobTitle}</small>}
        {grant.holder.current ? null : (
          <small className="clients-gone"> Not at the company today</small>
        )}
      </td>
      <td>{roleName}</td>
      <td>
        {momentDate(grant.grantedAt)}
        <small> by {grant.grantedBy.name}</small>
      </td>
      <td className="clients-end">
        {asking ? (
          <>
            <button type="button" className="linkish" disabled={busy} onClick={end}>
              {busy ? 'Ending…' : 'End it'}
            </button>{' '}
            <button
              type="button"
              className="linkish"
              disabled={busy}
              onClick={() => {
                setAsking(false);
              }}
            >
              Keep it
            </button>
          </>
        ) : (
          <RemoveButton
            label={`End ${grant.holder.name}'s ${roleName.toLowerCase()} role`}
            onClick={() => {
              setAsking(true);
            }}
          />
        )}
        {problem === undefined ? null : <Notice problem={problem} />}
      </td>
    </tr>
  );
}
