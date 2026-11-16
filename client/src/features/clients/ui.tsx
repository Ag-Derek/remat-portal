import { type ReactNode, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, isNotSignedIn } from '../../api';
import { Icon } from '../../Icon';
import { type Problem, problemFrom } from '../../problem';

/**
 * What every clients screen draws the same way: a dialog for adding or changing one thing, a
 * labelled field with the server's sentence under it, an info tip, and a field nobody has filled
 * in. #293, #276.
 */

/** The path after `#/` in the address, `clients/client/7`, kept up to date as it changes. */
export function useAddress(): string {
  return useSyncExternalStore(subscribe, pathInTheAddress, () => '');
}

function subscribe(changed: () => void): () => void {
  window.addEventListener('hashchange', changed);

  return () => {
    window.removeEventListener('hashchange', changed);
  };
}

function pathInTheAddress(): string {
  return window.location.hash.replace(/^#\/?/, '').split('?')[0] ?? '';
}

/**
 * A field nobody has filled in, said by name: "No email", never a blank that cannot be told from
 * one still loading (CLI 06). A gap somebody can see is a gap somebody can fill.
 */
export function Missing({ what }: { what: string }) {
  return <span className="clients-missing">No {what}</span>;
}

/**
 * A dialog over the page, for adding or changing one thing. The browser's own `<dialog>`: it
 * keeps focus inside while open, closes on Escape, and hands focus back to the button that
 * opened it. Clicking the shaded page around it closes it too.
 */
export function Dialog({
  title,
  intro,
  onClose,
  children,
}: {
  title: string;
  intro?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;

    if (element !== null && !element.open) {
      element.showModal();
    }

    return () => {
      element?.close();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="clients-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        /* Escape. Closed by the page, so the page's state and the dialog never disagree. */
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        /* Only the shade around the panel is the dialog itself; the panel fills the rest. */
        if (event.target === dialog.current) {
          onClose();
        }
      }}
    >
      <div className="clients-dialog-panel">
        <header className="clients-dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="iconic" aria-label="Close" onClick={onClose}>
            <Icon name="cross" />
          </button>
        </header>
        {intro === undefined ? null : <p className="muted">{intro}</p>}
        {children}
      </div>
    </dialog>
  );
}

/** A labelled field, its hint, and the server's sentence when it is about this field. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (ids: { id: string; describedBy: string | undefined }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint === undefined ? null : hintId, error === undefined ? null : errorId]
      .filter((one) => one !== null)
      .join(' ') || undefined;

  return (
    <div className={`clients-field${error === undefined ? '' : ' has-error'}`}>
      <label htmlFor={id}>{label}</label>
      {children({ id, describedBy })}
      {hint === undefined ? null : (
        <p id={hintId} className="clients-field-hint">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={errorId} className="clients-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * An info icon whose text appears beside it: on hover, on keyboard focus, and on a tap, since a
 * phone has no hover. A screen reader is given the text as the button's description, so it is
 * read whether or not it is shown. Escape, or a tap elsewhere, puts it away.
 */
export function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const tipId = useId();

  return (
    <span className={`clients-info${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="clients-info-button"
        aria-label="About this page"
        aria-describedby={tipId}
        aria-expanded={open}
        onClick={() => {
          setOpen((was) => !was);
        }}
        onBlur={() => {
          setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
      >
        <Icon name="info" />
      </button>
      <span id={tipId} role="tooltip" className="clients-info-tip">
        {text}
      </span>
    </span>
  );
}

/**
 * Sending one form, and what came of it: busy while it runs, closed when it is done, and the
 * server's sentence kept beside the field it was about.
 *
 * `fieldOfCode` names the field for a refusal the server sends without one, such as a client
 * name already recorded, which is about the name.
 */
export function useSending(
  onDone: () => void,
  onSignedOut: () => void,
  fieldOfCode: Readonly<Record<string, string>> = {},
) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [field, setField] = useState<string | undefined>(undefined);

  const send = (work: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(undefined);
    setField(undefined);

    work()
      .then(() => {
        setBusy(false);
        onDone();
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }

        const found = problemFrom(error);
        setProblem(found);
        setField(found.field ?? (error instanceof ApiError ? fieldOfCode[error.code] : undefined));
        setBusy(false);
      });
  };

  return {
    busy,
    send,
    /** The server's sentence, where it was about this field. */
    errorFor: (name: string) => (field === name ? problem?.what : undefined),
    /** Anything not about one of these fields, for across the foot of the form. */
    other: (fields: readonly string[]) =>
      problem !== undefined && (field === undefined || !fields.includes(field))
        ? problem
        : undefined,
  };
}

/** The foot of a dialog's form: cancel, and the one thing it does. */
export function DialogFoot({
  busy,
  disabled = false,
  doing,
  done,
  onCancel,
}: {
  busy: boolean;
  disabled?: boolean;
  /** "Saving…". */
  doing: string;
  /** "Save". */
  done: string;
  onCancel: () => void;
}) {
  return (
    <footer className="clients-dialog-foot">
      <button type="button" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
      <button type="submit" className="primary" disabled={busy || disabled}>
        {busy ? doing : done}
      </button>
    </footer>
  );
}
