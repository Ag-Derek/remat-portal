import { useCallback, useEffect, useState } from 'react';
import { type ClientsViews, clientsViews, isNotSignedIn } from '../../api';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';
import { ClientView } from './ClientView';
import { NewClientDialog } from './NewClient';
import { LogActivityPage } from './LogActivity';
import { MyPipeline } from './MyPipeline';
import { PocsList, PocView } from './PocsView';
import { ProposalsView } from './ProposalsView';
import { RolesView } from './RolesView';
import { SetupView } from './SetupView';
import { useAddress } from './ui';

/**
 * Clients, the business development pipeline. #274, #293.
 *
 * Reached only under `npm run web` while it is being built (see `CLIENTS_OPEN` in App.tsx); a
 * build has no card and sends `#/clients` back to the portal.
 *
 * The views so far: My pipeline at `#/clients`, which Clients opens on (CLI 97), each client in it
 * opening at `#/clients/client/{id}` (#276); setup, a BD manager's, at `#/clients/setup`; roles, a System
 * Administrator's, at `#/clients/roles`; past proposals, anybody's with a role, at
 * `#/clients/proposals` (#281); and the POCs running at `#/clients/pocs`, one at
 * `#/clients/poc/{id}` (#285). Which tabs are drawn is the server's answer, from
 * `/api/clients/me`: the page asks rather than decides, and every route refuses whoever it
 * refuses whatever is drawn.
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

  /* Whether they read the pipeline and the clients at all: anybody with a role, whom the POC
     list is open to as well (CLI 90). */
  const reads = views?.pocs === true;
  const [addingClient, setAddingClient] = useState(false);

  /* For anybody without it, a view's address is the pipeline: the address says nothing about a
     screen they cannot have, not even that it exists. */
  const showing: ClientsView =
    (view.name === 'setup' && views?.setUp === true) ||
    (view.name === 'roles' && views?.manageRoles === true) ||
    (view.name === 'proposals' && views?.pastProposals === true) ||
    (view.name === 'pocs' && views?.pocs === true) ||
    (view.name === 'log' && reads) ||
    view.name === 'client' ||
    view.name === 'poc'
      ? view.name
      : 'pipeline';

  /* One client's page, a POC's and the logging page have their own way back, and need the room. */
  const onItsOwn = showing === 'client' || showing === 'poc' || showing === 'log';

  return (
    <div className="portal">
      <main className="portal-page clients">
        {onItsOwn ? null : (
          <header className="clients-head">
            <a className="back" href="#/" aria-label="Back to Remat Portal">
              <Icon name="back" />
            </a>
            <div>
              <h1>Clients</h1>
              <p className="muted">{longToday()}</p>
            </div>

            {reads ? (
              <div className="clients-head-actions">
                <a className="button-link primary" href="#/clients/log">
                  Log an activity
                </a>
                <button
                  type="button"
                  onClick={() => {
                    setAddingClient(true);
                  }}
                >
                  Add a client
                </button>
              </div>
            ) : null}
          </header>
        )}

        {addingClient ? (
          <NewClientDialog
            onSignedOut={onSignedOut}
            onClose={() => {
              setAddingClient(false);
            }}
          />
        ) : null}

        {!onItsOwn &&
        (views?.setUp === true ||
          views?.manageRoles === true ||
          views?.pastProposals === true ||
          views?.pocs === true) ? (
          <nav className="directory-views" aria-label="Clients views">
            {reads ? (
              <a href="#/clients" aria-current={showing === 'pipeline' ? 'page' : undefined}>
                My pipeline
              </a>
            ) : null}
            {views.pocs ? (
              <a href="#/clients/pocs" aria-current={showing === 'pocs' ? 'page' : undefined}>
                POCs
              </a>
            ) : null}
            {views.pastProposals ? (
              <a
                href="#/clients/proposals"
                aria-current={showing === 'proposals' ? 'page' : undefined}
              >
                Past proposals
              </a>
            ) : null}
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
        ) : showing === 'proposals' ? (
          <ProposalsView onSignedOut={onSignedOut} />
        ) : showing === 'pocs' ? (
          <PocsList onSignedOut={onSignedOut} />
        ) : showing === 'poc' && view.id !== undefined ? (
          <PocView key={view.id} id={view.id} onSignedOut={onSignedOut} />
        ) : showing === 'log' ? (
          <LogActivityPage
            key={`${view.id ?? ''}-${view.dealId ?? ''}`}
            clientId={view.id ?? null}
            dealId={view.dealId ?? null}
            onSignedOut={onSignedOut}
          />
        ) : showing === 'client' && view.id !== undefined ? (
          <ClientView key={view.id} id={view.id} onSignedOut={onSignedOut} />
        ) : (
          /* The default view: what I have to do, soonest first (CLI 97). */
          <MyPipeline onSignedOut={onSignedOut} />
        )}
      </main>
    </div>
  );
}

type ClientsView = 'pipeline' | 'client' | 'log' | 'setup' | 'roles' | 'proposals' | 'pocs' | 'poc';

/**
 * Which view the address names, and the client, POC or deal for one. Logging is at `clients/log`
 * from My pipeline, and at `clients/client/{id}/log`, with a deal after it where one was chosen,
 * from a client's page. Anything else is My pipeline.
 */
function viewOf(path: string): { name: ClientsView; id?: string; dealId?: string } {
  const log = /^clients\/client\/(\d{1,18})\/log(?:\/(\d{1,18}))?$/.exec(path);

  if (log !== null) {
    return { name: 'log', id: log[1], dealId: log[2] };
  }
  if (path === 'clients/log') {
    return { name: 'log' };
  }

  const client = /^clients\/client\/(\d{1,18})$/.exec(path);

  if (client !== null) {
    return { name: 'client', id: client[1] };
  }
  const poc = /^clients\/poc\/(\d{1,18})$/.exec(path);

  if (poc !== null) {
    return { name: 'poc', id: poc[1] };
  }
  if (path === 'clients/pocs') {
    return { name: 'pocs' };
  }
  if (path === 'clients/roles') {
    return { name: 'roles' };
  }
  if (path === 'clients/proposals') {
    return { name: 'proposals' };
  }

  return path === 'clients/setup' || path.startsWith('clients/setup/')
    ? { name: 'setup' }
    : { name: 'pipeline' };
}

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "Friday 20 November 2026": the company's today, which is the UTC day, Accra being on UTC. */
function longToday(): string {
  const now = new Date();

  return `${WEEKDAY_NAMES[now.getUTCDay()] ?? ''} ${String(now.getUTCDate())} ${
    MONTH_NAMES[now.getUTCMonth()] ?? ''
  } ${String(now.getUTCFullYear())}`;
}
