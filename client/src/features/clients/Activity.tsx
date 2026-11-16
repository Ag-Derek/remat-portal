import { type ReactNode, useEffect, useState } from 'react';
import {
  type ClientActivityEntry,
  clientActivity,
  type ClientPage,
  DEAL_STAGES,
  isNotSignedIn,
} from '../../api';
import { moment, money, sentenceCase } from '../../format';
import { Icon, type IconName } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';
import { NotSet, OUTCOME, STAGE_NAME } from './Deals';

/**
 * What has happened at a client, across every deal it has, newest first: each stage a deal moved
 * to, and each change to what it is worth or how likely it is to close. #278, Clients SRS CLI 99.
 *
 * Each entry names its deal, and two dropdowns in its heading narrow it to one deal or to one
 * kind of change, so a client with several deals stays easy to follow. A deal's clock button in the table opens this
 * with that deal chosen. Calls, meetings and proposals join it with activities (#280).
 */

/** How many entries show before "Show more". */
const FIRST_SHOWN = 15;

type Kind = 'ALL' | ClientActivityEntry['kind'];

const KINDS: { value: Kind; label: string }[] = [
  { value: 'ALL', label: 'Everything' },
  { value: 'STAGE', label: 'Stages' },
  { value: 'VALUE', label: 'Values' },
];

export function ClientActivity({
  client,
  dealId,
  onDealChange,
  onSignedOut,
}: {
  client: ClientPage;
  /** The deal chosen, or null for every deal. */
  dealId: string | null;
  onDealChange: (dealId: string | null) => void;
  onSignedOut: () => void;
}) {
  const [entries, setEntries] = useState<ClientActivityEntry[] | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [kind, setKind] = useState<Kind>('ALL');
  const [showAll, setShowAll] = useState(false);

  /* Read again whenever the page is, so a deal just moved shows here at once. */
  useEffect(() => {
    clientActivity(client.id)
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
  }, [client, onSignedOut]);

  const shown = (entries ?? [])
    .filter(worthShowing)
    .filter((entry) => dealId === null || entry.deal.id === dealId)
    .filter((entry) => kind === 'ALL' || entry.kind === kind);
  const visible = showAll ? shown : shown.slice(0, FIRST_SHOWN);

  return (
    <section
      id="clients-activity"
      className="clients-panel clients-activity"
      aria-labelledby="clients-activity-heading"
    >
      <header className="clients-panel-head">
        <h3 id="clients-activity-heading">Activity</h3>

        {/* Narrowed by deal and by kind: two small dropdowns, out of the way at the right. */}
        {client.opportunities.length === 0 ? null : (
          <div className="clients-activity-filters">
            <label>
              <span className="visually-hidden">Which deal</span>
              <select
                className="clients-select-quiet"
                value={dealId ?? ''}
                onChange={(event) => {
                  onDealChange(event.target.value === '' ? null : event.target.value);
                }}
              >
                <option value="">All deals</option>
                {client.opportunities.map((deal) => (
                  <option key={deal.id} value={deal.id}>
                    {deal.product.name}
                    {deal.outcome === 'OPEN' ? '' : ` · ${OUTCOME[deal.outcome]}`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="visually-hidden">What changed</span>
              <select
                className="clients-select-quiet"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as Kind);
                }}
              >
                {KINDS.map((one) => (
                  <option key={one.value} value={one.value}>
                    {one.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </header>

      {problem === undefined ? null : <Notice problem={problem} />}

      {entries === undefined ? null : shown.length === 0 ? (
        <p className="muted clients-activity-empty">
          {entries.length === 0 ? 'Nothing has happened here yet.' : 'Nothing matches these.'}
        </p>
      ) : (
        <ol className="clients-activity-list">
          {visible.map((entry, at) => {
            const told = tell(entry, dealId === null);

            return (
              <li key={`${entry.kind}-${entry.deal.id}-${entry.at}-${String(at)}`}>
                <span className={`clients-activity-icon is-${told.tone}`} aria-hidden="true">
                  <Icon name={told.icon} />
                </span>
                <div>
                  <p className="clients-activity-head">
                    <strong>{told.headline}</strong>
                    <span title={moment(entry.at)}> · {when(entry.at)}</span>
                  </p>
                  {told.body === null ? null : <p className="clients-activity-body">{told.body}</p>}
                  <small>{entry.by.name}</small>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {shown.length > FIRST_SHOWN ? (
        <footer className="clients-activity-more">
          <button
            type="button"
            className="linkish"
            onClick={() => {
              setShowAll(!showAll);
            }}
          >
            {showAll ? 'Show fewer' : `Show all ${String(shown.length)}`}
          </button>
        </footer>
      ) : null}
    </section>
  );
}

/** A deal opened with nothing known about its figures says nothing the stage entry does not. */
function worthShowing(entry: ClientActivityEntry): boolean {
  return !(
    entry.kind === 'VALUE' &&
    entry.opening &&
    entry.value === null &&
    entry.probability === null
  );
}

/** "14 October", or "14 October 2025" for another year. */
function when(iso: string): string {
  const at = new Date(iso);

  return at.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    ...(at.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** An entry as a row shows it: its icon and colour, a headline, and a line under it. */
interface Told {
  icon: IconName;
  /** Blue for a move, amber for a move back, green for money and a win, grey once ended. */
  tone: 'stage' | 'back' | 'won' | 'ended' | 'value';
  headline: ReactNode;
  body: ReactNode | null;
}

/**
 * One entry, in words. The headline names the deal where every deal is showing ("CreditStudio
 * moved to Negotiation"), and not where one is chosen, since it would only repeat the dropdown.
 */
function tell(entry: ClientActivityEntry, named: boolean): Told {
  const product = entry.deal.productName;
  /* "CreditStudio moved to …", or "Moved to …". */
  const said = (verb: string) => (named ? `${product} ${verb}` : sentenceCase(verb));

  if (entry.kind === 'VALUE') {
    const chance =
      entry.probability === null ? (
        <NotSet what="No probability" />
      ) : (
        `${String(entry.probability)}% chance of closing`
      );

    return {
      icon: 'report',
      tone: 'value',
      headline:
        entry.value === null
          ? said(entry.opening ? 'opened with no value' : 'value taken away')
          : said(`${entry.opening ? 'opened at' : 'value now'} ${money(entry.value)}`),
      body: (
        <>
          {chance}
          {SOURCE[entry.source]}.
        </>
      ),
    };
  }

  const to = STAGE_NAME[entry.toStage];

  if (entry.fromStage === null) {
    return { icon: 'plus', tone: 'stage', headline: said('opened'), body: `At ${to}.` };
  }
  if (entry.toOutcome === 'WON') {
    return {
      icon: 'tick',
      tone: 'won',
      headline: said('won'),
      body: entry.note ?? 'Went live, and is on what they use now.',
    };
  }
  if (entry.toOutcome !== 'OPEN') {
    return {
      icon: 'cross',
      tone: 'ended',
      headline: said(`${OUTCOME[entry.toOutcome].toLowerCase()} at ${to}`),
      body: entry.note,
    };
  }

  const back = DEAL_STAGES.indexOf(entry.toStage) < DEAL_STAGES.indexOf(entry.fromStage);

  return {
    icon: back ? 'back' : 'stage',
    tone: back ? 'back' : 'stage',
    headline: said(`${back ? 'moved back to' : 'moved to'} ${to}`),
    body: (
      <>
        {entry.note === null ? null : <>{entry.note} </>}
        <span className="muted">From {STAGE_NAME[entry.fromStage]}.</span>
      </>
    ),
  };
}

/** How a change came about, where it was not somebody editing the deal. */
const SOURCE: Record<Extract<ClientActivityEntry, { kind: 'VALUE' }>['source'], string> = {
  MANUAL: '',
  PROPOSAL: ' from a proposal',
  CONVERSION: ' on its POC converting',
  IMPORT: ' from the workbooks',
};
