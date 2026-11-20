import { type ReactNode, useEffect, useState } from 'react';
import {
  type ActivityKind,
  type ReviewKind,
  type ClientActivityEntry,
  clientActivity,
  type ClientPage,
  DEAL_STAGES,
  isNotSignedIn,
} from '../../api';
import { AddButton } from '../../ActionButtons';
import { day, moment, money, sentenceCase } from '../../format';
import { Icon, type IconName } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';
import { NotSet, OUTCOME, STAGE_NAME } from './Deals';
import { AttachFileDialog } from './AttachFile';
import { LogActivityDialog } from './LogActivity';

/**
 * What has happened at a client, newest first by the day it happened: each stage a deal moved to,
 * each change to what it is worth or how likely it is to close (#278), and each call, meeting,
 * demo or note logged there (#280). Clients SRS CLI 99.
 *
 * Each entry names its deal, where it has one, and two dropdowns in its heading narrow it to one
 * deal or to one kind of entry, so a client with several deals stays easy to follow. A deal's
 * clock button in the table opens this with that deal chosen.
 */

/** How many entries show before "Show more". */
const FIRST_SHOWN = 15;

type Kind = 'ALL' | ClientActivityEntry['kind'];

type LoggedEntry = Extract<ClientActivityEntry, { kind: 'LOGGED' }>;

const KINDS: { value: Kind; label: string }[] = [
  { value: 'ALL', label: 'Everything' },
  { value: 'LOGGED', label: 'Calls and meetings' },
  { value: 'STAGE', label: 'Stages' },
  { value: 'VALUE', label: 'Values' },
];

export function ClientActivity({
  client,
  dealId,
  onDealChange,
  onChanged,
  onSignedOut,
}: {
  client: ClientPage;
  /** The deal chosen, or null for every deal. */
  dealId: string | null;
  onDealChange: (dealId: string | null) => void;
  /** Something was logged or corrected, so the page, and this with it, is read again. */
  onChanged: () => void;
  onSignedOut: () => void;
}) {
  /* The dialog open: logging something new, or correcting what was logged. #280. */
  const [logging, setLogging] = useState<{ correcting?: LoggedEntry } | null>(null);
  /* The activity a file is being attached to, by whoever logged it. #281. */
  const [attaching, setAttaching] = useState<LoggedEntry | null>(null);
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
    .filter((entry) => dealId === null || entry.deal?.id === dealId)
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
        <div className="clients-activity-filters">
          {client.opportunities.length === 0 ? null : (
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
          )}
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
        {client.may.contribute ? (
          <AddButton
            label="Log activity"
            onClick={() => {
              setLogging({});
            }}
          />
        ) : null}
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
              <li key={`${entry.kind}-${entry.deal?.id ?? 'client'}-${entry.at}-${String(at)}`}>
                <span className={`clients-activity-icon is-${told.tone}`} aria-hidden="true">
                  <Icon name={told.icon} />
                </span>
                <div>
                  <p className="clients-activity-head">
                    <strong>{told.headline}</strong>
                    {entry.kind === 'LOGGED' ? (
                      /* The day it happened; when it was logged is on hover. */
                      <span title={`Logged ${moment(entry.at)}`}> · {onDay(entry.happenedOn)}</span>
                    ) : (
                      <span title={moment(entry.at)}> · {when(entry.at)}</span>
                    )}
                  </p>
                  {told.body === null ? null : <p className="clients-activity-body">{told.body}</p>}
                  <small>
                    {entry.kind === 'LOGGED' ? `Logged by ${entry.by.name}` : entry.by.name}
                    {entry.kind === 'LOGGED' && entry.may.correct ? (
                      <>
                        {' · '}
                        <button
                          type="button"
                          className="linkish"
                          title="Whoever logged it may correct it for 24 hours"
                          onClick={() => {
                            setLogging({ correcting: entry });
                          }}
                        >
                          Correct
                        </button>
                      </>
                    ) : null}
                    {entry.kind === 'LOGGED' && entry.may.attach ? (
                      <>
                        {' · '}
                        <button
                          type="button"
                          className="linkish"
                          onClick={() => {
                            setAttaching(entry);
                          }}
                        >
                          Attach a file
                        </button>
                      </>
                    ) : null}
                  </small>
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

      {logging === null ? null : (
        <LogActivityDialog
          client={client}
          dealId={dealId}
          correcting={logging.correcting}
          onSaved={() => {
            setLogging(null);
            onChanged();
          }}
          onClose={() => {
            setLogging(null);
          }}
          onSignedOut={onSignedOut}
        />
      )}

      {attaching === null ? null : (
        <AttachFileDialog
          target={{
            kind: 'ACTIVITY',
            activityId: attaching.id,
            what: `the ${LOGGED[attaching.activityKind].name.toLowerCase()} on ${onDay(attaching.happenedOn)}`,
          }}
          onSaved={() => {
            setAttaching(null);
            onChanged();
          }}
          onClose={() => {
            setAttaching(null);
          }}
          onSignedOut={onSignedOut}
        />
      )}
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

/** "14 October", or "14 October 2025" for another year, from a day with no time to it. */
function onDay(iso: string): string {
  return iso.slice(0, 4) === String(new Date().getFullYear()) ? day(iso).slice(0, -5) : day(iso);
}

/** An entry as a row shows it: its icon and colour, a headline, and a line under it. */
interface Told {
  icon: IconName;
  /**
   * Blue for a move, amber for a move back, green for money and a win, grey once ended, and the
   * card's own ink for something somebody logged.
   */
  tone: 'stage' | 'back' | 'won' | 'ended' | 'value' | 'logged';
  headline: ReactNode;
  body: ReactNode | null;
}

/**
 * One entry, in words. The headline names the deal where every deal is showing ("CreditStudio
 * moved to Negotiation"), and not where one is chosen, since it would only repeat the dropdown.
 */
function tell(entry: ClientActivityEntry, named: boolean): Told {
  if (entry.kind === 'LOGGED') {
    return tellLogged(entry, named);
  }

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

/** What each kind of logged activity is called, and drawn as. */
export const LOGGED: Record<ActivityKind, { name: string; icon: IconName }> = {
  CALL: { name: 'Call', icon: 'phone' },
  MEETING: { name: 'Meeting', icon: 'people' },
  DEMO: { name: 'Demo', icon: 'eye' },
  PROPOSAL: { name: 'Proposal sent', icon: 'send' },
  FINANCIALS: { name: 'Financials sent', icon: 'report' },
  REVIEW: { name: 'Review meeting', icon: 'calendar' },
  NOTE: { name: 'Note', icon: 'pencil' },
};

/** Each review meeting by name. #285. */
export const REVIEW_NAME: Record<ReviewKind, string> = {
  DAY7: 'Day 7 showcase',
  WEEK6: 'Week 6 midpoint review',
  WEEK9: 'Week 9 activation review',
};

/**
 * A call, meeting, demo, proposal, financials or note: "Call with Ama Owusu (CCO) · CreditStudio",
 * or "Financials sent for USD 75,600 to Ama Owusu (CCO) · CreditStudio", the deal named where every
 * deal is showing and it has one, and what came of it under it.
 */
function tellLogged(entry: Extract<ClientActivityEntry, { kind: 'LOGGED' }>, named: boolean): Told {
  const what = LOGGED[entry.activityKind];
  const offered = entry.amount === null ? '' : ` for ${money(entry.amount)}`;
  const sent = entry.activityKind === 'PROPOSAL' || entry.activityKind === 'FINANCIALS';
  const withWhom =
    entry.withWhom === null ? '' : sent ? ` to ${entry.withWhom}` : ` with ${entry.withWhom}`;
  const about = named && entry.deal !== null ? ` · ${entry.deal.productName}` : '';

  /* #285. Which review, and, where the senior decision maker was not there, that it did not
     count. */
  if (entry.review !== null) {
    const missed = entry.review.dmAttended
      ? ''
      : ' · did not count: the senior decision maker was not there';

    return {
      icon: what.icon,
      tone: 'logged',
      headline: `${REVIEW_NAME[entry.review.kind]}${withWhom}${about}${missed}`,
      body: entry.outcome,
    };
  }

  return {
    icon: what.icon,
    tone: 'logged',
    headline: `${what.name}${offered}${withWhom}${about}`,
    body: entry.outcome,
  };
}

/** How a change came about, where it was not somebody editing the deal. */
const SOURCE: Record<Extract<ClientActivityEntry, { kind: 'VALUE' }>['source'], string> = {
  MANUAL: '',
  FINANCIALS: ' from the financials',
  CONVERSION: ' on its POC converting',
  IMPORT: ' from the workbooks',
};
