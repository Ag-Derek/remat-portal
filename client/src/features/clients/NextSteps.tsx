import { useState } from 'react';
import {
  type ClientNextStep,
  type ClientPage,
  closeNextStep,
  isNotSignedIn,
  reopenNextStep,
} from '../../api';
import { AddButton } from '../../ActionButtons';
import { day } from '../../format';
import { Notice, type Problem, problemFrom } from '../../problem';
import { NextStepDialog } from './LogActivity';

/**
 * A client's next steps: what happens next, by when, and whose it is. #280, Clients SRS CLI 63,
 * CLI 64.
 *
 * Open ones first, soonest due first, each marked overdue once the day it was due has passed:
 * the server works that out on every read, and nothing ever closes a step by itself. Closed ones
 * are folded away under them, the last closed first.
 *
 * A step is closed by its owner alone, and reopened by its owner or a BD manager; the buttons are
 * the server's answer in each step's `may`.
 */
export function ClientNextSteps({
  client,
  onChanged,
  onSignedOut,
}: {
  client: ClientPage;
  onChanged: () => void;
  onSignedOut: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const open = client.nextSteps.filter((step) => step.done === null);
  const closed = client.nextSteps.filter((step) => step.done !== null);

  return (
    <section className="clients-panel" aria-labelledby="clients-steps-heading">
      <header className="clients-side-head">
        <h3 id="clients-steps-heading">Next steps</h3>
        {client.may.contribute ? (
          <AddButton
            label="Add a next step"
            onClick={() => {
              setAdding(true);
            }}
          />
        ) : null}
      </header>

      {open.length === 0 ? (
        <p className="muted">Nothing planned.</p>
      ) : (
        <ul className="clients-side-list clients-steps">
          {open.map((step) => (
            <StepRow key={step.id} step={step} onChanged={onChanged} onSignedOut={onSignedOut} />
          ))}
        </ul>
      )}

      {closed.length === 0 ? null : (
        <details className="clients-ended">
          <summary>{closed.length === 1 ? '1 closed' : `${String(closed.length)} closed`}</summary>
          <ul className="clients-side-list clients-steps">
            {closed.map((step) => (
              <StepRow key={step.id} step={step} onChanged={onChanged} onSignedOut={onSignedOut} />
            ))}
          </ul>
        </details>
      )}

      {adding ? (
        <NextStepDialog
          client={client}
          onSaved={() => {
            setAdding(false);
            onChanged();
          }}
          onClose={() => {
            setAdding(false);
          }}
          onSignedOut={onSignedOut}
        />
      ) : null}
    </section>
  );
}

function StepRow({
  step,
  onChanged,
  onSignedOut,
}: {
  step: ClientNextStep;
  onChanged: () => void;
  onSignedOut: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const deal = step.deal === null ? '' : ` · ${step.deal.productName}`;

  const closeOrReopen = () => {
    setBusy(true);
    setProblem(undefined);

    (step.done === null ? closeNextStep(step.id) : reopenNextStep(step.id))
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
      });
  };

  return (
    <li className={step.done === null ? undefined : 'is-ended'}>
      <div>
        <strong>{step.description}</strong>
        <small>
          {step.done === null ? (
            <>
              <When step={step} /> · {step.owner.name}
              {deal}
            </>
          ) : (
            <>
              Closed {day(step.done.at.slice(0, 10))} by {step.done.by.name}
              {deal}
            </>
          )}
        </small>
      </div>
      {step.may.close || step.may.reopen ? (
        <span className="clients-setup-buttons">
          <button type="button" className="linkish" disabled={busy} onClick={closeOrReopen}>
            {step.may.close ? 'Done' : 'Reopen'}
          </button>
        </span>
      ) : null}
      {problem === undefined ? null : <Notice problem={problem} />}
    </li>
  );
}

/** "Overdue, was due 1 October", "Due today", or "Due 3 November". */
function When({ step }: { step: ClientNextStep }) {
  if (step.overdue) {
    return <span className="clients-step-when is-overdue">Overdue, was due {day(step.dueOn)}</span>;
  }

  /* Accra is UTC all year, so the browser's UTC day is the company's. */
  if (step.dueOn === new Date().toISOString().slice(0, 10)) {
    return <span className="clients-step-when is-today">Due today</span>;
  }

  return <span className="clients-step-when">Due {day(step.dueOn)}</span>;
}
