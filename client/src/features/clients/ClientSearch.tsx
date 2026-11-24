import { useEffect, useId, useState } from 'react';
import { type ClientAtAGlance, clientsAtAGlance, isNotSignedIn } from '../../api';
import { Icon } from '../../Icon';

/**
 * Searching every client from the company pipeline (#289): those with an open deal, and those with
 * none, a live customer, a lost or exited one, one just added, which nothing else on the pipeline
 * reaches. As the user chose on 24 November 2026: a box, and under it, as you type, every client
 * whose name has what was typed in it, ignoring case and extra spaces, each saying where it stands
 * and opening its client page. The table under it is not touched.
 *
 * Every client is read once, on the first keystroke, and looked through here: there are tens.
 */
export function ClientSearch({ onSignedOut }: { onSignedOut: () => void }) {
  const [typed, setTyped] = useState('');
  const [clients, setClients] = useState<ClientAtAGlance[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const resultsId = useId();

  const wanted = normalised(typed);

  useEffect(() => {
    if (wanted === '' || clients !== undefined) {
      return;
    }

    clientsAtAGlance()
      .then((found) => {
        setClients(found);
        setFailed(false);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setFailed(true);
      });
  }, [wanted, clients, onSignedOut]);

  const found =
    wanted === '' || clients === undefined
      ? []
      : clients.filter((client) => normalised(client.name).includes(wanted));

  return (
    <div className="clients-search">
      <label className="filter-search">
        <Icon name="search" />
        <span className="visually-hidden">Search every client</span>
        <input
          type="search"
          value={typed}
          placeholder="Search every client"
          aria-controls={resultsId}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setTyped('');
            }
          }}
        />
      </label>

      <div id={resultsId} aria-live="polite">
        {wanted === '' ? null : failed ? (
          <p className="clients-search-none">
            The clients could not be read. Try again in a moment.
          </p>
        ) : clients === undefined ? null : found.length === 0 ? (
          <p className="clients-search-none">No client has that in its name.</p>
        ) : (
          <ul className="clients-search-results" aria-label="Clients found">
            {found.map((client) => (
              <li key={client.id}>
                <a href={`#/clients/client/${client.id}`}>
                  <span className="clients-search-name">{client.name}</span>
                  <small>
                    {client.type.name} · {client.owner.name}
                  </small>
                  <small className="clients-search-stands">{whereItStands(client)}</small>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const ENDED_AS: Record<NonNullable<ClientAtAGlance['lastEnded']>['outcome'], string> = {
  WON: 'Won',
  LOST: 'Lost',
  EXITED: 'Exited',
};

/**
 * One short line: its open deals; or, with none, what it uses; or how its latest deal ended; or
 * that it has had none (the user, 24 November 2026).
 */
function whereItStands(client: ClientAtAGlance): string {
  if (client.openDeals > 0) {
    return client.openDeals === 1 ? '1 open deal' : `${String(client.openDeals)} open deals`;
  }
  if (client.using.length > 0) {
    return `Uses ${client.using.join(', ')} · no open deal`;
  }
  if (client.lastEnded !== null) {
    return `${ENDED_AS[client.lastEnded.outcome]} (${client.lastEnded.productName}) · no open deal`;
  }

  return 'No deals yet';
}

/** Lower case, with every run of spaces one, and none at either end. */
function normalised(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}
