import { useCallback, useEffect, useState } from 'react';
import { isNotSignedIn, myPipeline, type PipelineEntry } from '../../api';
import { day, money } from '../../format';
import { Notice, type Problem, problemFrom } from '../../problem';
import { NotSet, STAGE_NAME, WaitingOnCell } from './Deals';

/**
 * My pipeline: the open deals I own, soonest next step first, so what is overdue is at the top and
 * what is due today under it (CLI 97). The first thing on Clients, above every client.
 *
 * One request, which the server answers in one query (TDD 7). Each deal opens its client's page.
 * On a phone, or any panel too narrow for six columns, each row becomes a card of labelled lines,
 * as the client page's deals do (NFR CLI USA 02).
 */
export function MyPipeline({ onSignedOut }: { onSignedOut: () => void }) {
  const [entries, setEntries] = useState<PipelineEntry[] | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);

  const load = useCallback(() => {
    myPipeline()
      .then((found) => {
        setEntries(found);
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

  const today = todayInAccra();
  const overdue = entries?.filter((entry) => entry.overdue).length ?? 0;
  const dueToday = entries?.filter((entry) => entry.nextStep?.dueOn === today).length ?? 0;
  const unplanned = entries?.filter((entry) => entry.nextStep === null).length ?? 0;

  return (
    <section className="clients-panel clients-pipeline" aria-labelledby="clients-pipeline-heading">
      <header className="clients-panel-head">
        <div>
          <h2 id="clients-pipeline-heading">My pipeline</h2>
          {entries === undefined ? null : (
            <p className="muted">
              {entries.length === 0
                ? 'You have no open deals. Deals you open, or are given, appear here.'
                : summary(overdue, dueToday, unplanned, entries.length)}
            </p>
          )}
        </div>
      </header>

      {problem === undefined ? null : <Notice problem={problem} onRetry={load} />}

      {entries === undefined || entries.length === 0 ? null : (
        <table className="clients-deals">
          <thead>
            <tr>
              <th scope="col">Deal</th>
              <th scope="col">Next step</th>
              <th scope="col">Stage</th>
              <th scope="col">Waiting on</th>
              <th scope="col" className="is-figure">
                Value
              </th>
              <th scope="col">Last contact</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <PipelineRow key={entry.deal.id} entry={entry} today={today} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function PipelineRow({ entry, today }: { entry: PipelineEntry; today: string }) {
  const { deal, nextStep } = entry;

  return (
    <tr className={entry.overdue ? 'is-overdue' : undefined}>
      <td className="clients-pipeline-deal">
        <a href={`#/clients/client/${deal.client.id}`}>{deal.client.name}</a>
        <small>{deal.product.name}</small>
      </td>
      <td data-label="Next step">
        {nextStep === null ? (
          <NotSet what="Nothing planned" />
        ) : (
          <>
            <When dueOn={nextStep.dueOn} overdue={entry.overdue} today={today} />
            <small>
              {nextStep.description}
              {nextStep.owner.id === deal.owner.id ? null : ` · ${nextStep.owner.name}’s`}
            </small>
          </>
        )}
      </td>
      <td data-label="Stage">{STAGE_NAME[deal.stage]}</td>
      <td data-label="Waiting on">
        <WaitingOnCell waiting={deal.waitingOn} />
      </td>
      <td data-label="Value" className="is-figure">
        {deal.value === null ? <NotSet what="No value" /> : <span>{money(deal.value)}</span>}
        <small>
          {deal.probability === null ? (
            <NotSet what="No probability" />
          ) : (
            `${String(deal.probability)}%`
          )}
        </small>
      </td>
      <td data-label="Last contact">
        {entry.lastContact === null ? (
          <span className="muted">None logged</span>
        ) : (
          day(entry.lastContact)
        )}
      </td>
    </tr>
  );
}

/** "Overdue, was due 1 October", "Due today", or "Due 3 November". */
function When({ dueOn, overdue, today }: { dueOn: string; overdue: boolean; today: string }) {
  if (overdue) {
    return <span className="clients-step-when is-overdue">Overdue, was due {day(dueOn)}</span>;
  }
  if (dueOn === today) {
    return <span className="clients-step-when is-today">Due today</span>;
  }

  return <span className="clients-step-when">Due {day(dueOn)}</span>;
}

/** "2 overdue · 1 due today · 1 with nothing planned", or how many deals where all is in hand. */
function summary(overdue: number, dueToday: number, unplanned: number, all: number): string {
  const parts = [
    overdue === 0 ? null : `${String(overdue)} overdue`,
    dueToday === 0 ? null : `${String(dueToday)} due today`,
    unplanned === 0 ? null : `${String(unplanned)} with nothing planned`,
  ].filter((part) => part !== null);

  return parts.length === 0
    ? `${all === 1 ? '1 open deal' : `${String(all)} open deals`}, nothing due today.`
    : parts.join(' · ');
}

/** Accra is UTC all year, so the browser's UTC day is the company's. */
function todayInAccra(): string {
  return new Date().toISOString().slice(0, 10);
}
