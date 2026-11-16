import { useCallback, useEffect, useState } from 'react';
import {
  type ClientSummary,
  type ClientType,
  clientTypes,
  clientsList,
  createClient,
  isNotSignedIn,
} from '../../api';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';
import { Dialog, DialogFoot, Field, useSending } from './ui';

/**
 * Every client, one record each, with its type and owner. #276, Clients SRS CLI 01, CLI 05.
 *
 * Anybody with a role reads every client (CLI 90) and may add one, becoming its owner. Each opens
 * at `#/clients/client/{id}`.
 */
export function ClientsList({ onSignedOut }: { onSignedOut: () => void }) {
  const [clients, setClients] = useState<ClientSummary[] | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');

  const load = useCallback(() => {
    clientsList()
      .then((found) => {
        setClients(found);
        setProblem(undefined);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setProblem(problemFrom(error));
      });
  }, [onSignedOut]);

  useEffect(load, [load]);

  /* Compared as the server compares names: case and spacing aside. */
  const wanted = filter.trim().replace(/\s+/g, ' ').toLowerCase();
  const shown = (clients ?? []).filter((client) =>
    client.name.replace(/\s+/g, ' ').toLowerCase().includes(wanted),
  );

  return (
    <section className="clients-list">
      <header className="clients-setup-head">
        <div>
          <h2>Clients</h2>
          {clients === undefined ? null : (
            <p className="muted">
              {clients.length === 1 ? '1 client' : `${String(clients.length)} clients`}
            </p>
          )}
        </div>

        <button
          type="button"
          className="primary"
          onClick={() => {
            setCreating(true);
          }}
        >
          <Icon name="plus" />
          New client
        </button>
      </header>

      {creating ? (
        <NewClientDialog
          onSignedOut={onSignedOut}
          onClose={() => {
            setCreating(false);
          }}
        />
      ) : null}

      {problem === undefined ? null : <Notice problem={problem} onRetry={load} />}

      {clients === undefined ? null : clients.length === 0 ? (
        <div className="notice plain">
          <p>There are no clients yet. Use New client to add the first.</p>
        </div>
      ) : (
        <>
          <div className="filter-bar">
            <label>
              <span className="visually-hidden">Find a client by name</span>
              <input
                type="search"
                value={filter}
                placeholder="Find a client by name"
                onChange={(event) => {
                  setFilter(event.target.value);
                }}
              />
            </label>
          </div>

          {shown.length === 0 ? (
            <div className="notice plain">
              <p>No client is called anything like that. Check the spelling, or add it.</p>
            </div>
          ) : (
            <div className="directory-card">
              <table className="directory-table">
                <thead>
                  <tr>
                    <th scope="col">Client</th>
                    <th scope="col">Type</th>
                    <th scope="col">Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((client) => (
                    <tr key={client.id}>
                      <td>
                        <a href={`#/clients/client/${client.id}`}>{client.name}</a>
                      </td>
                      <td>{client.type.name}</td>
                      <td>{client.owner.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Adding a client, owned by whoever adds it. A name already recorded, however it is cased or
 * spaced, is refused by the server with the client's name as it is recorded, said under the box.
 */
function NewClientDialog({
  onClose,
  onSignedOut,
}: {
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const [types, setTypes] = useState<ClientType[] | undefined>(undefined);
  const [name, setName] = useState('');
  const [typeId, setTypeId] = useState('');
  const [note, setNote] = useState('');
  const [loadProblem, setLoadProblem] = useState<Problem | undefined>(undefined);
  const sending = useSending(onClose, onSignedOut);

  useEffect(() => {
    clientTypes()
      .then((found) => {
        const offered = found.filter((type) => type.retiredOn === null);
        setTypes(offered);
        setTypeId(offered[0]?.id ?? '');
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setLoadProblem(problemFrom(error));
      });
  }, [onSignedOut]);

  return (
    <Dialog
      title="New client"
      intro="One record per organisation. You will be its owner."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          sending.send(async () => {
            const id = await createClient({ name, typeId, note });
            /* Straight to its page, where its contacts and products are added. */
            window.location.hash = `#/clients/client/${id}`;
          });
        }}
      >
        <Field
          label="Name"
          hint="As the organisation is known, for example ADB."
          error={sending.errorFor('name')}
        >
          {({ id, describedBy }) => (
            <input
              id={id}
              value={name}
              maxLength={120}
              autoFocus
              autoComplete="off"
              aria-describedby={describedBy}
              aria-invalid={sending.errorFor('name') === undefined ? undefined : true}
              disabled={sending.busy}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>

        <Field label="Type" error={sending.errorFor('typeId')}>
          {({ id, describedBy }) => (
            <select
              id={id}
              value={typeId}
              aria-describedby={describedBy}
              disabled={sending.busy || types === undefined}
              onChange={(event) => {
                setTypeId(event.target.value);
              }}
            >
              {(types ?? []).map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="Note" hint="Optional." error={sending.errorFor('note')}>
          {({ id, describedBy }) => (
            <textarea
              id={id}
              value={note}
              rows={3}
              maxLength={2000}
              aria-describedby={describedBy}
              disabled={sending.busy}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          )}
        </Field>

        {loadProblem === undefined ? null : <Notice problem={loadProblem} />}
        {(() => {
          const other = sending.other(['name', 'typeId', 'note']);
          return other === undefined ? null : <Notice problem={other} />;
        })()}

        <DialogFoot
          busy={sending.busy}
          disabled={name.trim() === '' || typeId === ''}
          doing="Adding…"
          done="Add client"
          onCancel={onClose}
        />
      </form>
    </Dialog>
  );
}
