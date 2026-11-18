import { useEffect, useState } from 'react';
import {
  type ClientDocument,
  type ClientPage,
  clientDocuments,
  documentDownloadPath,
  isNotSignedIn,
  removeDocument,
} from '../../api';
import { AddButton } from '../../ActionButtons';
import { day } from '../../format';
import { Notice, type Problem, problemFrom } from '../../problem';
import { LOGGED } from './Activity';
import { AttachFileDialog, sizeInWords } from './AttachFile';

/**
 * A client's documents: every file on its deals and its activities, the latest first. #281,
 * Clients SRS CLI 67 to CLI 70.
 *
 * Each says what it is on, "CreditStudio deal" or "Proposal sent, 3 Nov · CreditStudio", and who
 * attached it when, and its name opens it (NFR CLI SEC 03). A file the virus scanner has not
 * cleared says so, and is not offered to open. Attaching here is to a deal;
 * a file goes on an activity from the activity itself, by whoever logged it.
 */
export function ClientDocuments({
  client,
  onChanged,
  onSignedOut,
}: {
  client: ClientPage;
  onChanged: () => void;
  onSignedOut: () => void;
}) {
  const [documents, setDocuments] = useState<ClientDocument[] | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [attaching, setAttaching] = useState(false);
  const on = (documents ?? []).filter((document) => document.removed === null);
  const removed = (documents ?? []).filter((document) => document.removed !== null);

  /* Read again whenever the page is, which it is after anything attaches a file. */
  useEffect(() => {
    let current = true;

    clientDocuments(client.id)
      .then((found) => {
        if (current) {
          setDocuments(found);
          setProblem(undefined);
        }
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        if (current) setProblem(problemFrom(error));
      });

    return () => {
      current = false;
    };
  }, [client, onSignedOut]);

  return (
    <section className="clients-panel" aria-labelledby="clients-documents-heading">
      <header className="clients-side-head">
        <h3 id="clients-documents-heading">Documents</h3>
        {client.may.contribute && client.opportunities.length > 0 ? (
          <AddButton
            label="Attach a file to a deal"
            onClick={() => {
              setAttaching(true);
            }}
          />
        ) : null}
      </header>

      {problem === undefined ? null : <Notice problem={problem} />}

      {documents === undefined ? null : on.length === 0 ? (
        <p className="muted">No files yet.</p>
      ) : (
        <ul className="clients-side-list clients-documents">
          {on.map((document) => (
            <DocumentRow
              key={document.id}
              document={document}
              onChanged={onChanged}
              onSignedOut={onSignedOut}
            />
          ))}
        </ul>
      )}

      {/* Taken off, and kept on the record saying so. */}
      {removed.length === 0 ? null : (
        <details className="clients-ended">
          <summary>
            {removed.length === 1 ? '1 removed' : `${String(removed.length)} removed`}
          </summary>
          <ul className="clients-side-list clients-documents">
            {removed.map((document) => (
              <DocumentRow
                key={document.id}
                document={document}
                onChanged={onChanged}
                onSignedOut={onSignedOut}
              />
            ))}
          </ul>
        </details>
      )}

      {attaching ? (
        <AttachFileDialog
          target={{ kind: 'DEAL', client }}
          onSaved={() => {
            setAttaching(false);
            onChanged();
          }}
          onClose={() => {
            setAttaching(false);
          }}
          onSignedOut={onSignedOut}
        />
      ) : null}
    </section>
  );
}

/**
 * One file: its name, which opens it once it is cleared; what it is on; who attached it when. Its
 * uploader may take it off within a day, after saying so twice, since the file itself is then gone.
 */
function DocumentRow({
  document,
  onChanged,
  onSignedOut,
}: {
  document: ClientDocument;
  onChanged: () => void;
  onSignedOut: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);

  const remove = () => {
    setBusy(true);
    setProblem(undefined);

    removeDocument(document.id)
      .then(onChanged)
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setProblem(problemFrom(error));
      })
      .finally(() => {
        setBusy(false);
        setConfirming(false);
      });
  };

  return (
    <li className={document.removed === null ? undefined : 'is-ended'}>
      <div>
        <strong>
          {document.downloadable ? (
            <a href={documentDownloadPath(document.id)} download={document.filename}>
              {document.filename}
            </a>
          ) : (
            document.filename
          )}
        </strong>
        <small>
          {onInWords(document)} · {sizeInWords(document.sizeBytes)}
          <br />
          {document.uploadedBy.name}, {day(document.uploadedAt.slice(0, 10))}
          {document.removed !== null
            ? ` · Removed by ${document.removed.by.name}, ${day(document.removed.at.slice(0, 10))}`
            : document.scanStatus === 'PENDING'
              ? ' · Waiting for its virus check'
              : null}
        </small>
      </div>
      {document.may.remove ? (
        <span className="clients-setup-buttons">
          {confirming ? (
            <>
              <button type="button" className="linkish" disabled={busy} onClick={remove}>
                Remove it for good
              </button>
              <button
                type="button"
                className="linkish"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                }}
              >
                Keep it
              </button>
            </>
          ) : (
            <button
              type="button"
              className="linkish"
              title="Whoever attached a file may remove it for 24 hours"
              onClick={() => {
                setConfirming(true);
              }}
            >
              Remove
            </button>
          )}
        </span>
      ) : null}
      {problem === undefined ? null : <Notice problem={problem} />}
    </li>
  );
}

/** "CreditStudio deal", or "Proposal sent, 3 Nov · CreditStudio". */
function onInWords(document: ClientDocument): string {
  if (document.on.kind === 'DEAL') {
    return `${document.on.productName} deal`;
  }

  const about = document.on.productName === null ? '' : ` · ${document.on.productName}`;

  return `${LOGGED[document.on.activityKind].name}, ${day(document.on.happenedOn)}${about}`;
}
