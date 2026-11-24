import { useCallback, useEffect, useState } from 'react';
import {
  companyPipeline,
  type CompanyPipelineView,
  type DealStage,
  isNotSignedIn,
  type Money,
  type PipelineFilters,
} from '../../api';
import { money } from '../../format';
import { Notice, type Problem, problemFrom } from '../../problem';
import { ClientSearch } from './ClientSearch';
import { STAGE_NAME } from './Deals';
import { standingInWords } from './ui';

/**
 * The company pipeline: every open deal, whoever owns it (CLI 98), laid out as the mockup's second
 * page has it. Above, the weighted pipeline, the value recorded, and how many opportunities and
 * clients, each sum per currency and never one across them (CLI 75, CLI 76). Below, client,
 * product, owner, stage, value, probability and weighted value. By client A to Z, so a client's
 * deals sit together (the user, 24 November 2026), and every deal is shown: there are too few to
 * need pages (TDD 17, item 7).
 *
 * The server filters, weighs and totals (the user, 24 November 2026), so the figures always
 * describe the deals shown: by line or product (a line includes every product in it, CLI 09),
 * stage, owner and client type. Each filter offers only what some open deal has. Each deal opens
 * its client's page. On a phone each row becomes a card of labelled lines (NFR CLI USA 02).
 */

const EVERY: PipelineFilters = { line: '', product: '', stage: '', owner: '', clientType: '' };

export function CompanyPipeline({ onSignedOut }: { onSignedOut: () => void }) {
  const [view, setView] = useState<CompanyPipelineView | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [filters, setFilters] = useState<PipelineFilters>(EVERY);

  const load = useCallback(() => {
    companyPipeline(filters)
      .then((found) => {
        setView(found);
        setProblem(undefined);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setProblem(problemFrom(error));
      });
  }, [filters, onSignedOut]);

  useEffect(load, [load]);

  const change = (more: Partial<PipelineFilters>) => {
    setFilters((now) => ({ ...now, ...more }));
  };

  const filtering = Object.values(filters).some((value) => value !== '');
  /* "line:3", "product:12", or '' for every product. */
  const productChoice =
    filters.product !== ''
      ? `product:${filters.product}`
      : filters.line !== ''
        ? `line:${filters.line}`
        : '';

  return (
    <section className="clients-pipeline" aria-label="Company pipeline">
      {/* Every client, those with no open deal too, which nothing below reaches (#289). */}
      <ClientSearch onSignedOut={onSignedOut} />

      {problem === undefined ? null : <Notice problem={problem} onRetry={load} />}

      {view === undefined ? null : view.choices.stages.length === 0 ? (
        <div className="notice plain">
          <p>Nobody has an open deal. Every open deal, whoever owns it, appears here.</p>
        </div>
      ) : (
        <>
          <PipelineSummary totals={view.totals} />

          <div className="filter-bar clients-toolbar">
            <label>
              <span className="visually-hidden">Product</span>
              <select
                value={productChoice}
                onChange={(event) => {
                  const [kind, id] = event.target.value.split(':');
                  change({
                    line: kind === 'line' ? (id ?? '') : '',
                    product: kind === 'product' ? (id ?? '') : '',
                  });
                }}
              >
                <option value="">All products</option>
                {view.choices.lines.map((line) => (
                  <optgroup key={line.id} label={line.name}>
                    <option value={`line:${line.id}`}>All of {line.name}</option>
                    {line.products
                      .filter((product) => product.name !== line.name)
                      .map((product) => (
                        <option key={product.id} value={`product:${product.id}`}>
                          {product.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label>
              <span className="visually-hidden">Stage</span>
              <select
                value={filters.stage}
                onChange={(event) => {
                  change({ stage: event.target.value as DealStage | '' });
                }}
              >
                <option value="">All stages</option>
                {view.choices.stages.map((one) => (
                  <option key={one} value={one}>
                    {STAGE_NAME[one]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="visually-hidden">Owner</span>
              <select
                value={filters.owner}
                onChange={(event) => {
                  change({ owner: event.target.value });
                }}
              >
                <option value="">All owners</option>
                {view.choices.owners.map((owner) => (
                  <option key={owner.id} value={owner.id}>
                    {owner.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="visually-hidden">Client type</span>
              <select
                value={filters.clientType}
                onChange={(event) => {
                  change({ clientType: event.target.value });
                }}
              >
                <option value="">All client types</option>
                {view.choices.clientTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
            </label>
            <span className="clients-toolbar-note">Sorted by client</span>
          </div>

          {view.deals.length === 0 ? (
            <div className="notice plain">
              <p>No open deal matches that. Clear a filter to see them.</p>
            </div>
          ) : (
            <div className="clients-panel">
              <table className="clients-deals">
                <thead>
                  <tr>
                    <th scope="col">Client</th>
                    <th scope="col">Product</th>
                    <th scope="col">Owner</th>
                    <th scope="col">Stage</th>
                    <th scope="col" className="is-figure">
                      Value
                    </th>
                    <th scope="col" className="is-figure">
                      Probability
                    </th>
                    <th scope="col" className="is-figure">
                      Weighted
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {view.deals.map((entry) => (
                    <CompanyRow key={entry.deal.id} entry={entry} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {filtering ? (
            <p className="clients-footnote">
              The figures above are for the deals shown. Clear the filters for the whole company.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * The weighted pipeline large, with what it is under it; then the value recorded, and how many
 * opportunities and clients. Each sum is per currency, side by side (CLI 75).
 */
export function PipelineSummary({ totals }: { totals: CompanyPipelineView['totals'] }) {
  return (
    <dl className="clients-pipeline-summary">
      <div className="clients-pipeline-weighted">
        <dt>Weighted pipeline</dt>
        <dd>
          <Figures amounts={totals.weighted} none="Nothing to weigh" />
          <small className="muted">Each value times its probability of close</small>
          <LeftOut line={notCountedLine(totals)} />
        </dd>
      </div>
      <div>
        <dt>Recorded value</dt>
        <dd>
          <Figures amounts={totals.recorded} none="No value" />
          <LeftOut line={noValueLine(totals)} />
        </dd>
      </div>
      <div>
        <dt>Opportunities</dt>
        <dd>
          <span className="clients-figure">{totals.opportunities}</span>
        </dd>
      </div>
      <div>
        <dt>Clients</dt>
        <dd>
          <span className="clients-figure">{totals.clients}</span>
        </dd>
      </div>
    </dl>
  );
}

/**
 * What a total leaves out, beside it (CLI 77): in amber where something is, so the figure is not
 * read as complete; quietly where nothing is, so it is plain the count was not forgotten.
 */
function LeftOut({ line }: { line: { words: string; missing: boolean } }) {
  return <small className={line.missing ? 'clients-gap' : 'muted'}>{line.words}</small>;
}

type Totals = CompanyPipelineView['totals'];

/** "21 of the 30 are not counted: 18 have no value, 3 have no probability." */
function notCountedLine({ opportunities, noValue, noProbability }: Totals) {
  const left = noValue + noProbability;
  if (left === 0) {
    return { words: 'Every deal is counted.', missing: false };
  }

  const why = [
    noValue === 0 ? null : `${String(noValue)} ${noValue === 1 ? 'has' : 'have'} no value`,
    noProbability === 0
      ? null
      : `${String(noProbability)} ${noProbability === 1 ? 'has' : 'have'} no probability`,
  ]
    .filter((part) => part !== null)
    .join(', ');

  return {
    words: `${String(left)} of the ${String(opportunities)} ${left === 1 ? 'is' : 'are'} not counted: ${why}.`,
    missing: true,
  };
}

/** "18 have no value." */
function noValueLine({ noValue }: Totals) {
  return noValue === 0
    ? { words: 'Every deal has a value.', missing: false }
    : { words: `${String(noValue)} ${noValue === 1 ? 'has' : 'have'} no value.`, missing: true };
}

/** One figure per currency side by side, or a named gap where there is none (CLI 06). */
function Figures({ amounts, none }: { amounts: Money[]; none: string }) {
  if (amounts.length === 0) {
    return <span className="clients-figure is-missing">{none}</span>;
  }

  return (
    <span className="clients-figure-group">
      {amounts.map((amount) => (
        <span key={amount.currency} className="clients-figure">
          {money(amount)}
        </span>
      ))}
    </span>
  );
}

function CompanyRow({ entry }: { entry: CompanyPipelineView['deals'][number] }) {
  const { deal } = entry;

  return (
    <tr>
      <td className="clients-pipeline-deal">
        <a href={`#/clients/client/${deal.client.id}`}>{deal.client.name}</a>
        <small>{entry.clientType}</small>
      </td>
      <td data-label="Product">{deal.product.name}</td>
      <td data-label="Owner">
        <span>{deal.owner.name}</span>
        {/* CLI 96, #289: they cannot look after it any more. */}
        {entry.ownerStanding === null ? null : (
          <small>
            <span className="clients-gap">
              {standingInWords(entry.ownerStanding)} · needs a new owner
            </span>
          </small>
        )}
      </td>
      <td data-label="Stage">
        <span className="clients-stage-chip">{STAGE_NAME[deal.stage]}</span>
      </td>
      <td data-label="Value" className="is-figure">
        {deal.value === null ? (
          <span className="clients-gap">No value</span>
        ) : (
          <span>{money(deal.value)}</span>
        )}
      </td>
      <td data-label="Probability" className="is-figure">
        {deal.probability === null ? (
          <span className="clients-gap">No probability</span>
        ) : (
          <span>{`${String(deal.probability)}%`}</span>
        )}
      </td>
      <td data-label="Weighted" className="is-figure">
        {entry.weighted === null ? (
          <span className="clients-gap">Not counted</span>
        ) : (
          <strong>{money(entry.weighted)}</strong>
        )}
      </td>
    </tr>
  );
}
