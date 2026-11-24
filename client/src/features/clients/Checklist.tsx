import { useCallback, useEffect, useState } from 'react';
import {
  type Check,
  type Checklist,
  type ChecklistGroup,
  type CheckTick,
  checkTicks,
  dealChecklist,
  isNotSignedIn,
  pocChecklist,
  tickCheck,
} from '../../api';
import { moment } from '../../format';
import { Notice, type Problem, problemFrom } from '../../problem';
import { Dialog } from './ui';

/**
 * A deal's or a POC's checks, ticked and unticked, each saying who last did and when, with its
 * whole history a click away. #284, Clients SRS CLI 40, CLI 41.
 *
 * A deal's qualification criteria and pre-POC gates open from its row on the client page; a POC's
 * phase checks sit on its page. Who may tick is the server's to say: its owner, CS lead or a BD
 * manager, while it is open. Everybody else with a role sees them, unticked boxes and all.
 */

const GROUP_NAMES: Record<ChecklistGroup, string> = {
  QUALIFICATION: 'Qualification criteria',
  PRE_POC: 'Pre-POC gates',
  FOUNDATION: 'Foundation',
  DEEPENING: 'Deepening',
  CONVERTING: 'Converting',
};

const GROUP_HINTS: Partial<Record<ChecklistGroup, string>> = {
  QUALIFICATION: 'Every one ticked before the deal goes to Negotiation.',
  PRE_POC: 'Every one ticked before a deal with a POC is signed, which starts the POC.',
};

/** Whose checklist to show: a deal's criteria and gates, or a POC's phase checks. */
export interface ChecklistOf {
  on: 'DEAL' | 'POC';
  id: string;
}

/** Loading a checklist, and ticking it, which answers with the whole list as it now stands. */
function useChecklist({ on, id }: ChecklistOf, onSignedOut: () => void) {
  const [checklist, setChecklist] = useState<Checklist | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);

  const failed = useCallback(
    (error: unknown) => {
      if (isNotSignedIn(error)) {
        onSignedOut();
        return;
      }
      setProblem(problemFrom(error));
    },
    [onSignedOut],
  );

  const reload = useCallback(() => {
    (on === 'DEAL' ? dealChecklist(id) : pocChecklist(id))
      .then((found) => {
        setChecklist(found);
        setProblem(undefined);
      })
      .catch(failed);
  }, [on, id, failed]);

  useEffect(reload, [reload]);

  const tick = (check: Check) => {
    setBusy(check.id);
    setProblem(undefined);
    tickCheck(check.id, !check.ticked)
      .then(setChecklist)
      .catch(failed)
      .finally(() => {
        setBusy(null);
      });
  };

  return { checklist, problem, busy, reload, tick };
}

/** The checks, group by group, the box to tick each, and who last touched it. */
export function ChecklistGroups({
  of,
  empty,
  onSignedOut,
}: {
  of: ChecklistOf;
  /** Said where there are no checks: a line with no checklist. */
  empty: string;
  onSignedOut: () => void;
}) {
  const { checklist, problem, busy, reload, tick } = useChecklist(of, onSignedOut);

  if (checklist === undefined) {
    return problem === undefined ? (
      <p className="muted">Loading…</p>
    ) : (
      <Notice problem={problem} onRetry={reload} />
    );
  }

  const groups = [...new Set(checklist.checks.map((check) => check.group))];

  return (
    <div className="clients-checklist">
      {problem === undefined ? null : <Notice problem={problem} />}
      {checklist.checks.length === 0 ? <p className="muted">{empty}</p> : null}

      {groups.map((group) => {
        const checks = checklist.checks.filter((check) => check.group === group);
        const done = checks.filter((check) => check.ticked).length;

        return (
          <section key={group} className="clients-checklist-group">
            <header>
              <h4>{GROUP_NAMES[group]}</h4>
              <span className={`tag${done === checks.length ? ' is-done' : ''}`}>
                {done} of {checks.length}
              </span>
            </header>
            {GROUP_HINTS[group] === undefined ? null : (
              <p className="clients-field-hint">{GROUP_HINTS[group]}</p>
            )}
            <ul>
              {checks.map((check) => (
                <CheckRow
                  key={check.id}
                  check={check}
                  mayTick={checklist.may.tick}
                  busy={busy === check.id}
                  onTick={() => {
                    tick(check);
                  }}
                  onSignedOut={onSignedOut}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function CheckRow({
  check,
  mayTick,
  busy,
  onTick,
  onSignedOut,
}: {
  check: Check;
  mayTick: boolean;
  busy: boolean;
  onTick: () => void;
  onSignedOut: () => void;
}) {
  const [history, setHistory] = useState<CheckTick[] | null>(null);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const inputId = `clients-check-${check.id}`;

  const showHistory = () => {
    if (history !== null) {
      setHistory(null);
      return;
    }
    checkTicks(check.id)
      .then((ticks) => {
        setHistory(ticks);
        setProblem(undefined);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setProblem(problemFrom(error));
      });
  };

  return (
    <li className={check.ticked ? 'is-ticked' : undefined}>
      <input
        id={inputId}
        type="checkbox"
        checked={check.ticked}
        disabled={!mayTick || busy}
        onChange={onTick}
      />
      <div>
        <label htmlFor={inputId}>
          {check.label}
          {check.pocOnly ? (
            <span className="tag clients-check-poc-only">POC deals only</span>
          ) : null}
        </label>
        <small>
          {check.latest === null ? (
            'Not ticked yet'
          ) : (
            <>
              {check.latest.ticked ? 'Ticked' : 'Unticked'} by {check.latest.by.name},{' '}
              {moment(check.latest.at)}
              {' · '}
              <button
                type="button"
                className="linkish clients-check-history-toggle"
                aria-expanded={history !== null}
                onClick={showHistory}
              >
                {history === null ? 'History' : 'Hide history'}
              </button>
            </>
          )}
        </small>
        {problem === undefined ? null : <Notice problem={problem} />}
        {history === null ? null : (
          <ol className="clients-check-history">
            {history.map((one) => (
              <li key={`${one.at}-${one.by.id}-${String(one.ticked)}`}>
                {one.ticked ? 'Ticked' : 'Unticked'} by {one.by.name}, {moment(one.at)}
              </li>
            ))}
          </ol>
        )}
      </div>
    </li>
  );
}

/** A deal's qualification criteria and pre-POC gates, from its row on the client page. */
export function DealChecklistDialog({
  title,
  dealId,
  onClose,
  onSignedOut,
}: {
  title: string;
  dealId: string;
  onClose: () => void;
  onSignedOut: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose}>
      <ChecklistGroups
        of={{ on: 'DEAL', id: dealId }}
        empty="This product line has no checklist, so nothing has to be ticked before Negotiation."
        onSignedOut={onSignedOut}
      />
    </Dialog>
  );
}
