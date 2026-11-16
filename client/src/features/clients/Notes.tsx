import { useState } from 'react';
import {
  addClientNote,
  archiveClientNote,
  changeClientNote,
  type ClientNote,
  type ClientPage,
} from '../../api';
import { AddButton, EditButton } from '../../ActionButtons';
import { moment } from '../../format';
import { Notice } from '../../problem';
import { Dialog, Field, useSending } from './ui';

/**
 * A client's notes: as many as are wanted, each a heading to find it by and the note under it.
 * #278.
 *
 * The card lists the headings, newest first, and opens one at a time on a click, so a client with
 * a dozen notes is still one short list. Anybody with a role adds one; whoever wrote it, or a BD
 * manager, changes or archives it. Archived notes are kept, folded away under the rest, and can
 * be brought back: nothing in clients is deleted (CLI 57).
 */
export function ClientNotes({
  client,
  onChanged,
  onSignedOut,
}: {
  client: ClientPage;
  onChanged: () => void;
  onSignedOut: () => void;
}) {
  /* The dialog open: a new note, or one being changed. */
  const [open, setOpen] = useState<{ note?: ClientNote } | null>(null);

  const current = client.notes.filter((note) => note.archivedAt === null);
  const archived = client.notes.filter((note) => note.archivedAt !== null);

  const edit = (note: ClientNote) => {
    setOpen({ note });
  };

  return (
    <section className="clients-panel" aria-labelledby="clients-notes-heading">
      <header className="clients-side-head">
        <h3 id="clients-notes-heading">Notes</h3>
        {client.may.contribute ? (
          <AddButton
            label="Add a note"
            onClick={() => {
              setOpen({});
            }}
          />
        ) : null}
      </header>

      {current.length === 0 ? (
        <p className="muted">No notes yet.</p>
      ) : (
        <NoteList notes={current} onEdit={edit} />
      )}

      {archived.length === 0 ? null : (
        <details className="clients-ended">
          <summary>
            {archived.length === 1 ? '1 archived' : `${String(archived.length)} archived`}
          </summary>
          <NoteList notes={archived} onEdit={edit} />
        </details>
      )}

      {open === null ? null : (
        <NoteDialog
          clientId={client.id}
          note={open.note}
          onSaved={() => {
            setOpen(null);
            onChanged();
          }}
          onClose={() => {
            setOpen(null);
          }}
          onSignedOut={onSignedOut}
        />
      )}
    </section>
  );
}

/** Headings, each opening its note on a click. */
function NoteList({
  notes,
  onEdit,
}: {
  notes: readonly ClientNote[];
  onEdit: (note: ClientNote) => void;
}) {
  return (
    <ul className="clients-notes">
      {notes.map((note) => (
        <li key={note.id}>
          <details>
            <summary>
              <span className="clients-note-heading">{note.heading}</span>
              <small>
                {note.writtenBy.name} · {moment(note.writtenAt)}
                {note.editedAt === null ? '' : ' · edited'}
              </small>
            </summary>
            <div className="clients-note-open">
              <p className="clients-note-body">{note.body}</p>
              {note.may.change ? (
                <EditButton
                  label={`Change the note "${note.heading}"`}
                  onClick={() => {
                    onEdit(note);
                  }}
                />
              ) : null}
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}

/**
 * Adding a note, or changing one: its heading and the note. A note being changed may be archived
 * from here too, or brought back if it already is; an archived one is only brought back.
 */
function NoteDialog({
  clientId,
  note,
  onSaved,
  onClose,
  onSignedOut,
}: {
  clientId: string;
  /** The note being changed, or none for a new one. */
  note?: ClientNote;
  onSaved: () => void;
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const [heading, setHeading] = useState(note?.heading ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const sending = useSending(onSaved, onSignedOut);
  const isArchived = note !== undefined && note.archivedAt !== null;
  const other = sending.other(['heading', 'body']);

  return (
    <Dialog title={note === undefined ? 'New note' : 'Note'} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          sending.send(() =>
            note === undefined
              ? addClientNote(clientId, { heading, body })
              : changeClientNote(note.id, { heading, body }),
          );
        }}
      >
        <Field label="Heading" error={sending.errorFor('heading')}>
          {({ id, describedBy }) => (
            <input
              id={id}
              value={heading}
              maxLength={120}
              autoFocus={!isArchived}
              autoComplete="off"
              placeholder="How they buy"
              aria-describedby={describedBy}
              disabled={sending.busy || isArchived}
              onChange={(event) => {
                setHeading(event.target.value);
              }}
            />
          )}
        </Field>

        <Field label="Note" error={sending.errorFor('body')}>
          {({ id, describedBy }) => (
            <textarea
              id={id}
              value={body}
              rows={6}
              maxLength={4000}
              aria-describedby={describedBy}
              disabled={sending.busy || isArchived}
              onChange={(event) => {
                setBody(event.target.value);
              }}
            />
          )}
        </Field>

        {other === undefined ? null : <Notice problem={other} />}

        <footer className="clients-dialog-foot">
          {note === undefined ? null : (
            <button
              type="button"
              className={`linkish clients-note-archive${isArchived ? '' : ' is-danger'}`}
              disabled={sending.busy}
              onClick={() => {
                sending.send(() => archiveClientNote(note.id, !isArchived));
              }}
            >
              {isArchived ? 'Bring back' : 'Archive'}
            </button>
          )}
          <button type="button" disabled={sending.busy} onClick={onClose}>
            Cancel
          </button>
          {isArchived ? null : (
            <button
              type="submit"
              className="primary"
              disabled={sending.busy || heading.trim() === '' || body.trim() === ''}
            >
              {sending.busy ? 'Saving…' : note === undefined ? 'Add note' : 'Save'}
            </button>
          )}
        </footer>
      </form>
    </Dialog>
  );
}
