import { useCallback, useEffect, useState } from 'react';
import { type DealStage, isNotSignedIn, myPipeline, type PipelineEntry } from '../../api';
import { money, weekday } from '../../format';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';
import { STAGE_NAME, WaitingOnCell } from './Deals';

/**
 * My pipeline: the open deals I own, soonest next step first, so what is overdue is at the top and
 * what is due today under it (CLI 97). What Clients opens on, laid out as the mockup has it: a
 * search and two filters over one table, client, product, stage, what it waits on, its value, when
 * the client was last spoken to, and what happens next.
 *
 * One request, which the server answers in one query (TDD 7). Each deal opens its client's page.
 * Filtering by a line includes every product in it (CLI 09). On a phone, or any panel too narrow
 * for seven columns, each row becomes a card of labelled lines, as the client page's deals do (NFR
 * CLI USA 02).
 */

/** Longer than this since anybody spoke to the client, and it is shown in amber. */
const QUIET_AFTER_DAYS = 14;

export function MyPipeline({ onSignedOut }: { onSignedOut: () => void }) {
  const [entries, setEntries] = useState<PipelineEntry[] | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [search, setSearch] = useState('');
  /* "line:Symphony", "product:12", or '' for every product. */
  const [product, setProduct] = useState('');
  const [stage, setStage] = useState<DealStage | ''>('');

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
  const all = entries ?? [];
  const wanted = search.trim().replace(/\s+/g, ' ').toLowerCase();
  const shown = all.filter(
    (entry) =>
      entry.deal.client.name.replace(/\s+/g, ' ').toLowerCase().includes(wanted) &&
      (product === '' ||
        product === `line:${entry.deal.product.lineName}` ||
        product === `product:${entry.deal.product.id}`) &&
      (stage === '' || entry.deal.stage === stage),
  );

  /* The lines and products, and the stages, that the deals have, so no choice finds nothing. */
  const lines = [...new Set(all.map((entry) => entry.deal.product.lineName))].sort();
  const productsOf = (line: string) =>
    [
      ...new Map(
        all
          .filter((entry) => entry.deal.product.lineName === line)
          .map((entry) => [entry.deal.product.id, entry.deal.product.name]),
      ),
    ].sort((one, other) => one[1].localeCompare(other[1]));
  const stages = (Object.keys(STAGE_NAME) as DealStage[]).filter((one) =>
    all.some((entry) => entry.deal.stage === one),
  );
  const clients = new Set(shown.map((entry) => entry.deal.client.id)).size;

  return (
    <section className="clients-pipeline" aria-label="My pipeline">
      {problem === undefined ? null : <Notice problem={problem} onRetry={load} />}

      {entries === undefined ? null : entries.length === 0 ? (
        <div className="notice plain">
          <p>You have no open deals. Deals you open, or are given, appear here.</p>
        </div>
      ) : (
        <>
          <div className="filter-bar clients-toolbar">
            <label className="filter-search">
              <Icon name="search" />
              <span className="visually-hidden">Search a client</span>
              <input
                type="search"
                value={search}
                placeholder="Search a client"
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
              />
            </label>
            <label>
              <span className="visually-hidden">Product</span>
              <select
                value={product}
                onChange={(event) => {
                  setProduct(event.target.value);
                }}
              >
                <option value="">All products</option>
                {lines.map((line) => (
                  <optgroup key={line} label={line}>
                    <option value={`line:${line}`}>All of {line}</option>
                    {productsOf(line)
                      .filter(([, name]) => name !== line)
                      .map(([id, name]) => (
                        <option key={id} value={`product:${id}`}>
                          {name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label>
              <span className="visually-hidden">Stage</span>
              <select
                value={stage}
                onChange={(event) => {
                  setStage(event.target.value as DealStage | '');
                }}
              >
                <option value="">All stages</option>
                {stages.map((one) => (
                  <option key={one} value={one}>
                    {STAGE_NAME[one]}
                  </option>
                ))}
              </select>
            </label>
            <span className="clients-toolbar-note">Sorted by what is due next</span>
          </div>

          {shown.length === 0 ? (
            <div className="notice plain">
              <p>None of your deals match that. Clear the search or a filter to see them.</p>
            </div>
          ) : (
            <div className="clients-panel">
              <table className="clients-deals">
                <thead>
                  <tr>
                    <th scope="col">Client</th>
                    <th scope="col">Product</th>
                    <th scope="col">Stage</th>
                    <th scope="col">Waiting on</th>
                    <th scope="col" className="is-figure">
                      Value
                    </th>
                    <th scope="col">Last contact</th>
                    <th scope="col">Next step</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((entry) => (
                    <PipelineRow key={entry.deal.id} entry={entry} today={today} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="clients-footnote">
            {shown.length === 1 ? '1 opportunity' : `${String(shown.length)} opportunities`} across{' '}
            {clients === 1 ? '1 client' : `${String(clients)} clients`}
            {shown.length === all.length ? '.' : `, of the ${String(all.length)} you own.`}
          </p>
        </>
      )}
    </section>
  );
}

function PipelineRow({ entry, today }: { entry: PipelineEntry; today: string }) {
  const { deal, nextStep } = entry;
  const close = deal.expectedClose === null ? null : deal.expectedClose.half;

  return (
    <tr className={entry.overdue ? 'is-overdue' : undefined}>
      <td className="clients-pipeline-deal">
        <a href={`#/clients/client/${deal.client.id}`}>{deal.client.name}</a>
        <small>{entry.clientType}</small>
      </td>
      <td data-label="Product">{deal.product.name}</td>
      <td data-label="Stage">
        <span className="clients-stage-chip">{STAGE_NAME[deal.stage]}</span>
      </td>
      <td data-label="Waiting on">
        <WaitingOnCell waiting={deal.waitingOn} />
      </td>
      <td data-label="Value" className="is-figure">
        {deal.value === null ? (
          <span className="clients-gap">No value</span>
        ) : (
          <span>{money(deal.value)}</span>
        )}
        <small>
          {[deal.probability === null ? null : `${String(deal.probability)}%`, close]
            .filter((part) => part !== null)
            .join(' · ') || <span className="clients-gap">No probability</span>}
        </small>
      </td>
      <td data-label="Last contact">
        <LastContact on={entry.lastContact} today={today} />
      </td>
      <td data-label="Next step" className="clients-pipeline-next">
        {nextStep === null ? (
          <span className="clients-gap">No next step</span>
        ) : (
          <>
            <span className={entry.overdue ? 'is-overdue' : undefined}>
              {nextStep.description}
              {nextStep.owner.id === deal.owner.id ? null : ` · ${nextStep.owner.name}’s`}
            </span>
            <When dueOn={nextStep.dueOn} overdue={entry.overdue} today={today} />
          </>
        )}
      </td>
    </tr>
  );
}

/** "5 days overdue", "Due today", or "Fri 23 Oct". */
function When({ dueOn, overdue, today }: { dueOn: string; overdue: boolean; today: string }) {
  if (overdue) {
    const late = daysBetween(dueOn, today);
    return (
      <small className="clients-step-when is-overdue">
        {late === 1 ? '1 day overdue' : `${String(late)} days overdue`}
      </small>
    );
  }
  if (dueOn === today) {
    return <small className="clients-step-when is-today">Due today</small>;
  }

  return <small className="clients-step-when">{weekday(dueOn)}</small>;
}

/** "7 days ago", amber once it has been quiet a while, and a red "Never" where nobody has. */
function LastContact({ on, today }: { on: string | null; today: string }) {
  if (on === null) {
    return <span className="clients-never">Never</span>;
  }

  const ago = daysBetween(on, today);
  const words = ago === 0 ? 'Today' : ago === 1 ? 'Yesterday' : `${String(ago)} days ago`;

  return <span className={ago > QUIET_AFTER_DAYS ? 'clients-gap' : undefined}>{words}</span>;
}

/** Whole days from one calendar day to another. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Accra is UTC all year, so the browser's UTC day is the company's. */
function todayInAccra(): string {
  return new Date().toISOString().slice(0, 10);
}
