import { useCallback, useEffect, useState } from 'react';
import { type ClientsViews, clientsViews, isNotSignedIn } from '../../api';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';
import { ClientView } from './ClientView';
import { ClientsList } from './ClientsList';
import { RolesView } from './RolesView';
import { SetupView } from './SetupView';
import { useAddress } from './ui';

/**
 * Clients, the business development pipeline. #274, #293.
 *
 * Reached only under `npm run web` while it is being built (see `CLIENTS_OPEN` in App.tsx); a
 * build has no card and sends `#/clients` back to the portal.
 *
 * The views so far: every client at `#/clients`, and one at `#/clients/client/{id}` (#276);
 * setup, a BD manager's, at `#/clients/setup`; and roles, a System Administrator's, at
 * `#/clients/roles`. Which tabs are
 * drawn is the server's answer, from `/api/clients/me`: the page asks rather than decides, and
 * every route refuses whoever it refuses whatever is drawn.
 */
export function ClientsPage({ onSignedOut }: { onSignedOut: () => void }) {
  const view = viewOf(useAddress());

  /* Undefined until the server has answered. */
  const [views, setViews] = useState<ClientsViews | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);

    clientsViews()
      .then((found) => {
        setViews(found);
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

  /* For anybody without it, a view's address is the pipeline: the address says nothing about a
     screen they cannot have, not even that it exists. */
  const showing: ClientsView =
    (view.name === 'setup' && views?.setUp === true) ||
    (view.name === 'roles' && views?.manageRoles === true) ||
    view.name === 'client'
      ? view.name
      : 'pipeline';

  return (
    <div className="portal">
      <main className="portal-page clients">
        <header className="directory-head">
          <a className="back" href="#/" aria-label="Back to Remat Portal">
            <Icon name="back" />
          </a>

          <h1>Clients</h1>
        </header>

        {views?.setUp === true || views?.manageRoles === true ? (
          <nav className="directory-views" aria-label="Clients views">
            <a
              href="#/clients"
              aria-current={showing === 'pipeline' || showing === 'client' ? 'page' : undefined}
            >
              Clients
            </a>
            {views.setUp ? (
              <a href="#/clients/setup" aria-current={showing === 'setup' ? 'page' : undefined}>
                Setup
              </a>
            ) : null}
            {views.manageRoles ? (
              <a href="#/clients/roles" aria-current={showing === 'roles' ? 'page' : undefined}>
                Roles
              </a>
            ) : null}
          </nav>
        ) : null}

        {problem === undefined ? null : (
          <Notice problem={problem} retrying={loading} onRetry={load} />
        )}

        {/* Blank while the server is still answering, so the pipeline does not flash in front
            of the view the address asked for. */}
        {views === undefined ? null : showing === 'setup' ? (
          <SetupView onSignedOut={onSignedOut} />
        ) : showing === 'roles' ? (
          <RolesView onSignedOut={onSignedOut} />
        ) : showing === 'client' && view.id !== undefined ? (
          <ClientView key={view.id} id={view.id} onSignedOut={onSignedOut} />
        ) : (
          <ClientsList onSignedOut={onSignedOut} />
        )}
      </main>
    </div>
  );
}

type ClientsView = 'pipeline' | 'client' | 'setup' | 'roles';

/** Which view the address names, and the client for one. Anything else is the clients list. */
function viewOf(path: string): { name: ClientsView; id?: string } {
  const client = /^clients\/client\/(\d{1,18})$/.exec(path);

  if (client !== null) {
    return { name: 'client', id: client[1] };
  }
  if (path === 'clients/roles') {
    return { name: 'roles' };
  }

  return path === 'clients/setup' || path.startsWith('clients/setup/')
    ? { name: 'setup' }
    : { name: 'pipeline' };
}
