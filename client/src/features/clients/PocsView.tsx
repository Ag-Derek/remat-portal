import { useCallback, useEffect, useId, useState } from 'react';
import {
  addPocAction,
  type ClientsHolder,
  clientsHolders,
  convertPoc,
  type Currency,
  type EndReason,
  endReasons,
  exitPoc,
  extendPoc,
  isNotSignedIn,
  movePocLead,
  type Poc,
  type PocFlag,
  type PocHealth,
  type PocHealthChange,
  type PocPage,
  type PocPhase,
  type PocReviewHeld,
  type PocReviewStep,
  type PocTargetCheck,
  type PocUsageReading,
  pocPage,
  recordPocUsage,
  recordReview,
  type ReviewKind,
  runningPocs,
  setPocHealth,
} from '../../api';
import { AddButton, EditButton } from '../../ActionButtons';
import { day, moment } from '../../format';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';
import { REVIEW_NAME } from './Activity';
import { initialsOf } from './ClientView';
import { Ladder, STAGE_NAME } from './Deals';
import { ChecklistGroups } from './Checklist';
import { Dialog, DialogFoot, Field, standingInWords, useSending } from './ui';

/**
 * POCs. #285, Clients SRS CLI 32 to CLI 34, CLI 100, CLI 101.
 *
 * The list, at `#/clients/pocs`: every POC still running, the soonest to be decided first, with
 * its phase and where its ten weeks stand. And one POC's page, at `#/clients/poc/{id}`, laid out
 * as a client's page is: who and what at the top with the CS lead as a pill, a strip of figures,
 * the ten weeks drawn with its phases and reviews, then its review meetings beside what is coming
 * and the deal it is for.
 *
 * A POC starts as its deal's contract is signed. Its phase, day and days to decision are the
 * server's, worked out from the start and today, so they move on their own as the weeks pass.
 * Its health is set by its CS lead or a BD manager, and every change is kept (#286). Usage, the
 * flags, the checklist and the extension join the page with #286, #284 and #287.
 */

const POC_DAYS = 70;

const PHASES: { phase: PocPhase; name: string; weeks: string; from: number; to: number }[] = [
  { phase: 'FOUNDATION', name: 'Foundation', weeks: 'Weeks 1 to 3', from: 1, to: 21 },
  { phase: 'DEEPENING', name: 'Deepening', weeks: 'Weeks 4 to 6', from: 22, to: 42 },
  { phase: 'CONVERTING', name: 'Converting', weeks: 'Weeks 7 to 10', from: 43, to: 70 },
];

const PHASE_NAME: Record<PocPhase, string> = {
  FOUNDATION: 'Foundation',
  DEEPENING: 'Deepening',
  CONVERTING: 'Converting',
};

/** The day of the ten weeks each review falls on, for drawing it. */
const REVIEW_DAY: Record<ReviewKind, number> = { DAY7: 8, WEEK6: 43, WEEK9: 64 };

/** The short name each review goes by on the timeline. */
const REVIEW_SHORT: Record<ReviewKind, string> = {
  DAY7: 'Day 7',
  WEEK6: 'Week 6',
  WEEK9: 'Week 9',
};

const HEALTHS: PocHealth[] = ['ON_TRACK', 'AT_RISK', 'STALLED'];

export const HEALTH_NAME: Record<PocHealth, string> = {
  ON_TRACK: 'On Track',
  AT_RISK: 'At Risk',
  STALLED: 'Stalled',
};

/** Its health as a pill: green, amber or red, with the words, which carry it alone. */
export function HealthPill({ health }: { health: PocHealth }) {
  return (
    <span className={`clients-pill is-health is-${health.toLowerCase().replace('_', '-')}`}>
      <span className="visually-hidden">Health: </span>
      {HEALTH_NAME[health]}
    </span>
  );
}

/** What each flag says. The server raises them; the words are the screen's. */
export const FLAG_NAME: Record<PocFlag['kind'], string> = {
  NO_CORRECTIVE_ACTION: 'No corrective action 48 hours after At Risk',
  EXIT_DECISION: 'Stalled seven days with no reset: decide whether to exit',
  LOW_USAGE: 'Below 50% usage at Day 63: unlikely to convert',
  NO_USAGE: 'No usage recorded by Day 63',
  PAST_DECISION: 'Past its decision date',
};

/** How each target stands, in words. */
const TARGET_STATUS: Record<PocTargetCheck['status'], string> = {
  UPCOMING: 'Coming up',
  MET: 'Met',
  MISSED: 'Missed',
  NO_READING: 'No reading by then',
};

/** What At Risk and Stalled each ask for, as a heading and in a sentence. */
const ASKED: Record<'AT_RISK' | 'STALLED', { title: string; inSentence: string; within: string }> =
  {
    AT_RISK: {
      title: 'Corrective action',
      inSentence: 'a corrective action',
      within: '48 hours',
    },
    STALLED: { title: 'Reset', inSentence: 'a reset', within: 'seven days' },
  };

function askedOf(health: PocHealth) {
  return health === 'ON_TRACK' ? undefined : ASKED[health];
}

/** Its flags, each a short red line. Nothing at all where there are none. */
export function Flags({ flags }: { flags: PocFlag[] }) {
  if (flags.length === 0) return null;

  return (
    <ul className="clients-poc-flags">
      {flags.map((flag) => (
        <li key={flag.kind}>
          <Icon name="info" />
          <span>{FLAG_NAME[flag.kind]}</span>
        </li>
      ))}
    </ul>
  );
}

/** "33 days to go", "Decision today", or "3 days past its decision date". */
export function decisionInWords(daysToDecision: number): string {
  if (daysToDecision > 1) return `${String(daysToDecision)} days to go`;
  if (daysToDecision === 1) return '1 day to go';
  if (daysToDecision === 0) return 'Decision today';

  const late = -daysToDecision;
  return `${late === 1 ? '1 day' : `${String(late)} days`} past its decision date`;
}

/** How far through `length` days a POC is, as a share for drawing: never more than all of it. */
function shareOf(dayOfPoc: number, length = POC_DAYS): number {
  return Math.min(Math.max(dayOfPoc, 1), length) / length;
}

/** How many days it runs: ten weeks, and its extension's days on top (#287). */
function lengthOf(poc: Poc): number {
  return POC_DAYS + (poc.extension?.days ?? 0);
}

/** "of 70", or "of 70 + 21" once extended. */
function ofLength(poc: Poc): string {
  return poc.extension === null
    ? ` of ${String(POC_DAYS)}`
    : ` of ${String(POC_DAYS)} + ${String(poc.extension.days)}`;
}

/** Accra is UTC all year, so the browser's UTC day is the company's. */
function todayInAccra(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A thin bar filled as far as the POC has come; red once it is past its decision date. */
function Meter({ poc }: { poc: Poc }) {
  return (
    <span
      className={`clients-poc-meter${poc.daysToDecision < 0 ? ' is-late' : ''}`}
      aria-hidden="true"
    >
      <span style={{ width: `${String(shareOf(poc.day, lengthOf(poc)) * 100)}%` }} />
    </span>
  );
}

/* ------------------------------------------------------------------------ the list */

export function PocsList({ onSignedOut }: { onSignedOut: () => void }) {
  const [pocs, setPocs] = useState<Poc[] | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);

  const load = useCallback(() => {
    runningPocs()
      .then((found) => {
        setPocs(found);
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

  return (
    <section className="clients-panel clients-pipeline" aria-labelledby="clients-pocs-heading">
      <header className="clients-panel-head">
        <div>
          <h2 id="clients-pocs-heading">POCs</h2>
          {pocs === undefined ? null : (
            <p className="muted">
              {pocs.length === 0
                ? 'No POC is running. One starts when a deal with a POC has its contract signed.'
                : 'Every POC running, the soonest to be decided first.'}
            </p>
          )}
        </div>
      </header>

      {problem === undefined ? null : <Notice problem={problem} onRetry={load} />}

      {pocs === undefined || pocs.length === 0 ? null : (
        <table className="clients-deals">
          <thead>
            <tr>
              <th scope="col">POC</th>
              <th scope="col">Health</th>
              <th scope="col">Usage</th>
              <th scope="col">Where it stands</th>
              <th scope="col">Decision</th>
              <th scope="col">CS lead</th>
            </tr>
          </thead>
          <tbody>
            {pocs.map((poc) => (
              <tr key={poc.id} className={poc.daysToDecision < 0 ? 'is-overdue' : undefined}>
                <td className="clients-pipeline-deal">
                  <a href={`#/clients/poc/${poc.id}`}>{poc.client.name}</a>
                  <small>
                    {poc.deal.productName} · {poc.lineName}
                  </small>
                </td>
                <td data-label="Health">
                  <HealthPill health={poc.health} />
                  <Flags flags={poc.flags} />
                </td>
                <td data-label="Usage">
                  {poc.usage === null ? (
                    <small>None recorded</small>
                  ) : (
                    <>
                      <span className="clients-poc-percent">{String(poc.usage.percent)}%</span>
                      <small>
                        {String(poc.usage.active)} of {String(poc.usage.enrolled)} ·{' '}
                        {day(poc.usage.measuredOn)}
                      </small>
                    </>
                  )}
                </td>
                <td data-label="Where it stands">
                  <span>{PHASE_NAME[poc.phase]}</span>
                  <Meter poc={poc} />
                  <small>
                    Day {String(Math.max(poc.day, 1))}
                    {ofLength(poc)}
                  </small>
                </td>
                <td data-label="Decision">
                  <span>{day(poc.decisionOn)}</span>
                  <small className={poc.daysToDecision < 0 ? 'clients-step-when is-overdue' : ''}>
                    {decisionInWords(poc.daysToDecision)}
                  </small>
                </td>
                <td data-label="CS lead">
                  <span>{poc.csLead.name}</span>
                  {poc.csLeadStanding === null ? null : (
                    <small className="clients-figure-note">
                      {standingInWords(poc.csLeadStanding)} · needs a new CS lead
                    </small>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------ the page */

export function PocView({ id, onSignedOut }: { id: string; onSignedOut: () => void }) {
  const [poc, setPoc] = useState<PocPage | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [open, setOpen] = useState<
    'review' | 'lead' | 'health' | 'action' | 'usage' | 'extend' | 'convert' | 'exit' | undefined
  >(undefined);

  const load = useCallback(() => {
    pocPage(id)
      .then((found) => {
        setPoc(found);
        setProblem(undefined);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setProblem(problemFrom(error));
      });
  }, [id, onSignedOut]);

  useEffect(load, [load]);

  const done = () => {
    setOpen(undefined);
    load();
  };
  const close = () => {
    setOpen(undefined);
  };

  return (
    <section className="clients-client clients-poc">
      <a className="clients-back" href="#/clients/pocs">
        <Icon name="back" />
        All POCs
      </a>

      {problem === undefined ? null : <Notice problem={problem} onRetry={load} />}

      {poc === undefined ? null : (
        <>
          {/* ------------------------------------------------------------ what */}

          <header className="clients-client-head">
            <div>
              <span className="tag">{poc.lineName} POC</span>
              <div className="clients-client-title">
                <h2>{poc.client.name}</h2>
              </div>
              <p className="clients-poc-sub">
                {poc.deal.productName} · started {day(poc.startedOn)}, when the contract was signed
                · <a href={`#/clients/client/${poc.client.id}`}>Open the client</a>
              </p>
            </div>

            <div className="clients-client-pills">
              <span className="clients-pill is-person" title="CS lead">
                <span className="clients-pill-avatar" aria-hidden="true">
                  {initialsOf(poc.csLead.name)}
                </span>
                <span className="visually-hidden">CS lead: </span>
                {poc.csLead.name}
              </span>
              {poc.may.moveLead ? (
                <EditButton
                  label="Change the CS lead"
                  onClick={() => {
                    setOpen('lead');
                  }}
                />
              ) : null}
              {poc.csLeadStanding === null ? null : (
                <span className="clients-pill is-missing">
                  {standingInWords(poc.csLeadStanding)} · needs a new CS lead
                </span>
              )}

              <span className="clients-pill-divider" aria-hidden="true" />

              {poc.deal.outcome === 'OPEN' ? (
                <>
                  <span className={`clients-pill is-phase is-${poc.phase.toLowerCase()}`}>
                    {PHASE_NAME[poc.phase]}
                  </span>
                  <HealthPill health={poc.health} />
                </>
              ) : (
                <span
                  className={`clients-pill is-ended is-${poc.deal.outcome === 'WON' ? 'won' : 'exited'}`}
                >
                  {poc.deal.outcome === 'WON' ? 'Converted' : 'Exited'}
                  {poc.deal.endedOn === null ? '' : ` ${day(poc.deal.endedOn)}`}
                </span>
              )}
            </div>
          </header>

          <Flags flags={poc.flags} />

          {/* --------------------------------------------------------- the figures */}

          <PocFigures poc={poc} />

          {/* ------------------------------------------------------- the ten weeks */}

          <Timeline poc={poc} />

          <div className="clients-client-body">
            {/* ------------------------------------------------- reviews held */}

            <div className="clients-client-main">
              <UsagePanel
                poc={poc}
                onRecord={() => {
                  setOpen('usage');
                }}
              />
              <ReviewsHeld
                poc={poc}
                onRecord={() => {
                  setOpen('review');
                }}
              />
              {/* #284. Its Foundation, Deepening and Converting checks. */}
              <section className="clients-panel" aria-labelledby="clients-poc-checklist">
                <header className="clients-panel-head">
                  <h3 id="clients-poc-checklist">Checklist</h3>
                </header>
                <ChecklistGroups
                  of={{ on: 'POC', id: poc.id }}
                  empty="This product line has no checklist for this kind of client."
                  onSignedOut={onSignedOut}
                />
              </section>
            </div>

            <aside className="clients-client-side">
              <DecisionCard
                poc={poc}
                onExtend={() => {
                  setOpen('extend');
                }}
                onConvert={() => {
                  setOpen('convert');
                }}
                onExit={() => {
                  setOpen('exit');
                }}
              />
              <HealthCard
                poc={poc}
                onSet={() => {
                  setOpen('health');
                }}
                onAct={() => {
                  setOpen('action');
                }}
              />
              <ReviewsComing reviews={poc.reviews} />
              <DealCard poc={poc} />
            </aside>
          </div>

          {open === 'review' ? (
            <ReviewDialog poc={poc} onDone={done} onClose={close} onSignedOut={onSignedOut} />
          ) : null}
          {open === 'lead' ? (
            <LeadDialog poc={poc} onDone={done} onClose={close} onSignedOut={onSignedOut} />
          ) : null}
          {open === 'health' ? (
            <HealthDialog poc={poc} onDone={done} onClose={close} onSignedOut={onSignedOut} />
          ) : null}
          {open === 'action' ? (
            <ActionDialog poc={poc} onDone={done} onClose={close} onSignedOut={onSignedOut} />
          ) : null}
          {open === 'usage' ? (
            <UsageDialog poc={poc} onDone={done} onClose={close} onSignedOut={onSignedOut} />
          ) : null}
          {open === 'extend' ? (
            <ExtendDialog poc={poc} onDone={done} onClose={close} onSignedOut={onSignedOut} />
          ) : null}
          {open === 'convert' ? (
            <ConvertDialog poc={poc} onDone={done} onClose={close} onSignedOut={onSignedOut} />
          ) : null}
          {open === 'exit' ? (
            <ExitDialog poc={poc} onDone={done} onClose={close} onSignedOut={onSignedOut} />
          ) : null}
        </>
      )}
    </section>
  );
}

/** Four cards: the phase, the day of seventy, the decision date, and the reviews that counted. */
function PocFigures({ poc }: { poc: PocPage }) {
  const phase = PHASES.find((one) => one.phase === poc.phase);
  const counted = new Set(poc.held.filter((held) => held.dmAttended).map((held) => held.kind));
  const next = poc.reviews.find((review) => review.done === null);

  return (
    <dl className="clients-figures clients-poc-figures">
      <div>
        <dt>Phase</dt>
        <dd>
          <span className="clients-figure">{PHASE_NAME[poc.phase]}</span>
          <span className="clients-poc-figure-note">{phase?.weeks}</span>
        </dd>
      </div>
      <div>
        <dt>Day</dt>
        <dd>
          <span className="clients-figure">
            {String(Math.max(poc.day, 1))}
            <span className="clients-poc-of">{ofLength(poc)}</span>
          </span>
          <Meter poc={poc} />
        </dd>
      </div>
      <div>
        <dt>Decision by</dt>
        <dd>
          <span className="clients-figure">{day(poc.decisionOn)}</span>
          <span
            className={
              poc.daysToDecision < 0 ? 'clients-poc-figure-note is-late' : 'clients-poc-figure-note'
            }
          >
            {decisionInWords(poc.daysToDecision)}
          </span>
        </dd>
      </div>
      <div>
        <dt>Reviews that counted</dt>
        <dd>
          <span className="clients-figure">
            {String(counted.size)}
            <span className="clients-poc-of"> of 3</span>
          </span>
          <span className="clients-poc-figure-note">
            {next === undefined
              ? 'None still to hold'
              : `Next: ${REVIEW_SHORT[next.kind]}, ${day(next.dueOn)}`}
          </span>
        </dd>
      </div>
    </dl>
  );
}

/**
 * The ten weeks as one bar: its three phases, filled as far as the POC has come, and each review
 * where it falls, ticked once it counted and red once it is late.
 */
function Timeline({ poc }: { poc: PocPage }) {
  const counted = new Set(poc.held.filter((held) => held.dmAttended).map((held) => held.kind));
  const today = todayInAccra();
  const at = (dayOfPoc: number) => `${String(((dayOfPoc - 1) / POC_DAYS) * 100)}%`;

  return (
    <section className="clients-panel clients-poc-timeline" aria-labelledby="clients-poc-weeks">
      <header className="clients-panel-head">
        <h3 id="clients-poc-weeks">Ten weeks</h3>
        <p className="muted">
          {day(poc.startedOn)} to {day(poc.decisionOn)}
        </p>
      </header>

      <div className="clients-poc-track">
        <div className="clients-poc-phases">
          {PHASES.map((one) => (
            <div
              key={one.phase}
              className={one.phase === poc.phase ? 'is-now' : undefined}
              style={{ flexGrow: one.to - one.from + 1 }}
            >
              <strong>{one.name}</strong>
              <small>{one.weeks}</small>
            </div>
          ))}
        </div>

        <div className="clients-poc-line">
          <span
            className="clients-poc-done"
            style={{ width: `${String(shareOf(poc.day) * 100)}%` }}
            aria-hidden="true"
          />
          {(Object.keys(REVIEW_DAY) as ReviewKind[]).map((kind) => {
            const step = poc.reviews.filter((review) => review.kind === kind).at(-1);
            const late = step !== undefined && step.done === null && step.dueOn < today;
            const state = counted.has(kind) ? ' is-counted' : late ? ' is-late' : '';

            return (
              <span
                key={kind}
                className={`clients-poc-review${state}`}
                style={{ left: at(REVIEW_DAY[kind]) }}
                title={`${REVIEW_NAME[kind]}${step === undefined ? '' : `, due ${day(step.dueOn)}`}`}
              >
                <i aria-hidden="true">{counted.has(kind) ? <Icon name="tick" /> : null}</i>
                <small>{REVIEW_SHORT[kind]}</small>
              </span>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/**
 * Its usage: the latest share active, large, with its counts and day, then every reading, the
 * latest day first. A reading a later one for its day replaced is kept, and says so.
 */
function UsagePanel({ poc, onRecord }: { poc: PocPage; onRecord: () => void }) {
  return (
    <section className="clients-panel clients-poc-usage" aria-labelledby="clients-poc-usage">
      <header className="clients-panel-head">
        <h3 id="clients-poc-usage">Usage</h3>
        {poc.may.update ? <AddButton label="Record usage" onClick={onRecord} /> : null}
      </header>

      <ul className="clients-poc-targets" aria-label="Usage targets">
        {poc.targets.map((target) => (
          <li key={target.byDay} className={`is-${target.status.toLowerCase().replace('_', '-')}`}>
            <strong>
              {String(target.percent)}% by Day {String(target.byDay)}
            </strong>
            <small>{day(target.dueOn)}</small>
            <span>
              {TARGET_STATUS[target.status]}
              {target.reading === null ? '' : `: ${String(target.reading.percent)}%`}
            </span>
          </li>
        ))}
      </ul>

      {poc.usage === null ? (
        <p className="muted clients-activity-empty">
          No usage recorded yet. Record the users enrolled and active on a day; the share active is
          worked out.
        </p>
      ) : (
        <>
          <p className="clients-poc-usage-now">
            <span className="clients-figure">{String(poc.usage.percent)}%</span>
            <span>
              active: {String(poc.usage.active)} of {String(poc.usage.enrolled)} enrolled, on{' '}
              {day(poc.usage.measuredOn)}
            </span>
          </p>

          <table className="clients-deals clients-poc-readings">
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Active</th>
                <th scope="col">Enrolled</th>
                <th scope="col">Share</th>
                <th scope="col">Recorded</th>
              </tr>
            </thead>
            <tbody>
              {poc.usageReadings.map((reading) => (
                <UsageRow key={reading.id} reading={reading} />
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function UsageRow({ reading }: { reading: PocUsageReading }) {
  return (
    <tr className={reading.replaced ? 'is-replaced' : undefined}>
      <td data-label="Day">{day(reading.measuredOn)}</td>
      <td data-label="Active">{String(reading.active)}</td>
      <td data-label="Enrolled">{String(reading.enrolled)}</td>
      <td data-label="Share">{String(reading.percent)}%</td>
      <td data-label="Recorded">
        <span>{reading.recordedBy.name}</span>
        <small>
          {moment(reading.recordedAt)}
          {reading.replaced ? ' · replaced by a later reading' : ''}
        </small>
      </td>
    </tr>
  );
}

/** The review meetings recorded, latest first, as the client page's activity is drawn. */
function ReviewsHeld({ poc, onRecord }: { poc: PocPage; onRecord: () => void }) {
  return (
    <section className="clients-panel clients-activity" aria-labelledby="clients-poc-held">
      <header className="clients-panel-head">
        <h3 id="clients-poc-held">Review meetings</h3>
        {poc.may.update ? <AddButton label="Record a review" onClick={onRecord} /> : null}
      </header>

      {poc.held.length === 0 ? (
        <p className="muted clients-activity-empty">
          No review recorded yet. A review counts only with the senior decision maker there.
        </p>
      ) : (
        <ol className="clients-activity-list">
          {poc.held.map((held) => (
            <HeldRow key={held.id} held={held} />
          ))}
        </ol>
      )}
    </section>
  );
}

function HeldRow({ held }: { held: PocReviewHeld }) {
  return (
    <li>
      <span
        className={`clients-activity-icon ${held.dmAttended ? 'is-value' : 'is-back'}`}
        aria-hidden="true"
      >
        <Icon name={held.dmAttended ? 'tick' : 'again'} />
      </span>
      <div>
        <p className="clients-activity-head">
          <strong>
            {REVIEW_NAME[held.kind]}
            {held.withWhom === null ? '' : ` with ${held.withWhom}`}
          </strong>
          <span> · {day(held.heldOn)}</span>
        </p>
        {held.outcome === null ? null : <p className="clients-activity-body">{held.outcome}</p>}
        <small>
          {held.dmAttended ? (
            'Counted: the senior decision maker was there'
          ) : (
            <span className="clients-poc-missed">
              Did not count: the senior decision maker was not there
            </span>
          )}
          {' · '}Recorded by {held.loggedBy.name}
        </small>
      </div>
    </li>
  );
}

/** What is coming, as the client page's next steps are drawn, and those done folded away. */
function ReviewsComing({ reviews }: { reviews: PocReviewStep[] }) {
  const open = reviews.filter((review) => review.done === null);
  const closed = reviews.filter((review) => review.done !== null);
  const today = todayInAccra();

  return (
    <section className="clients-panel" aria-labelledby="clients-poc-coming">
      <header className="clients-side-head">
        <h3 id="clients-poc-coming">Coming up</h3>
      </header>

      {open.length === 0 ? (
        <p className="muted">Every review is done.</p>
      ) : (
        <ul className="clients-side-list clients-steps">
          {open.map((review) => (
            <li key={review.id}>
              <div>
                <strong>{REVIEW_NAME[review.kind]}</strong>
                <small>
                  {review.dueOn < today ? (
                    <span className="clients-step-when is-overdue">
                      Overdue, was due {day(review.dueOn)}
                    </span>
                  ) : review.dueOn === today ? (
                    <span className="clients-step-when is-today">Due today</span>
                  ) : (
                    <span className="clients-step-when">Due {day(review.dueOn)}</span>
                  )}{' '}
                  · {review.owner.name}
                </small>
              </div>
            </li>
          ))}
        </ul>
      )}

      {closed.length === 0 ? null : (
        <details className="clients-ended">
          <summary>{closed.length === 1 ? '1 done' : `${String(closed.length)} done`}</summary>
          <ul className="clients-side-list clients-steps">
            {closed.map((review) => (
              <li key={review.id} className="is-ended">
                <div>
                  <strong>{REVIEW_NAME[review.kind]}</strong>
                  <small>
                    Due {day(review.dueOn)} · closed by {review.done?.by.name}
                  </small>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/**
 * Its health now, who set it and why, what is being done about it, and every change before,
 * folded away. While At Risk with no corrective action, it asks for one, and says by when.
 */
function HealthCard({ poc, onSet, onAct }: { poc: PocPage; onSet: () => void; onAct: () => void }) {
  const [latest, ...earlier] = poc.healthHistory;
  const asked = askedOf(poc.health);
  const late = poc.flags.some(
    (flag) => flag.kind === 'NO_CORRECTIVE_ACTION' || flag.kind === 'EXIT_DECISION',
  );

  return (
    <section className="clients-panel" aria-labelledby="clients-poc-health">
      <header className="clients-side-head">
        <h3 id="clients-poc-health">Health</h3>
        {poc.may.update ? <EditButton label="Set the health" onClick={onSet} /> : null}
      </header>

      {latest === undefined ? null : (
        <ul className="clients-side-list clients-poc-health">
          <HealthRow change={latest} />
        </ul>
      )}

      {poc.asks === null || asked === undefined ? null : (
        <div className={`clients-poc-ask${late ? ' is-late' : ''}`}>
          <p>
            {late
              ? `${asked.title} was due by `
              : `${HEALTH_NAME[poc.health]} asks for ${asked.inSentence} by `}
            {moment(poc.asks.by)}.
          </p>
          {poc.may.update ? (
            <button type="button" onClick={onAct}>
              Write the {asked.title.toLowerCase()}
            </button>
          ) : null}
        </div>
      )}
      {asked !== undefined && poc.asks === null && poc.may.update ? (
        <button type="button" className="linkish clients-poc-more" onClick={onAct}>
          Add another {asked.title.toLowerCase()}
        </button>
      ) : null}

      {earlier.length === 0 ? null : (
        <details className="clients-ended">
          <summary>
            {earlier.length === 1 ? '1 earlier' : `${String(earlier.length)} earlier`}
          </summary>
          <ul className="clients-side-list clients-poc-health">
            {earlier.map((change) => (
              <HealthRow key={change.id} change={change} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function HealthRow({ change }: { change: PocHealthChange }) {
  return (
    <li>
      <div>
        <HealthPill health={change.health} />
        {change.note === null ? null : <p>{change.note}</p>}
        <small>
          {moment(change.setAt)} · {change.setBy.name}
        </small>
        {change.actions.length === 0 ? null : (
          <ul className="clients-poc-actions">
            {change.actions.map((action) => (
              <li key={action.id}>
                <strong>{askedOf(change.health)?.title}</strong>
                <p>{action.body}</p>
                <small>
                  {moment(action.loggedAt)} · {action.loggedBy.name}
                </small>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/**
 * The decision (#287): when it falls, its one extension if it has had it, and the three things
 * that can be done about it, extend, convert or exit. Once it has ended, how it ended. A POC
 * never ends itself when its date passes; only converting or exiting it does.
 */
function DecisionCard({
  poc,
  onExtend,
  onConvert,
  onExit,
}: {
  poc: PocPage;
  onExtend: () => void;
  onConvert: () => void;
  onExit: () => void;
}) {
  const running = poc.deal.outcome === 'OPEN';

  return (
    <section className="clients-panel" aria-labelledby="clients-poc-decision">
      <header className="clients-side-head">
        <h3 id="clients-poc-decision">Decision</h3>
      </header>

      <ul className="clients-side-list">
        <li>
          <div>
            {running ? (
              <>
                <strong>By {day(poc.decisionOn)}</strong>
                <small>{decisionInWords(poc.daysToDecision)}</small>
              </>
            ) : (
              <>
                <strong>
                  {poc.deal.outcome === 'WON' ? 'Converted' : 'Exited'}
                  {poc.deal.endedOn === null ? '' : ` on ${day(poc.deal.endedOn)}`}
                </strong>
                <small>
                  {poc.deal.outcome === 'WON'
                    ? `The ${poc.deal.productName} deal is live and won.`
                    : `The ${poc.deal.productName} deal was exited.`}
                </small>
              </>
            )}
          </div>
        </li>
        {poc.extension === null ? null : (
          <li>
            <div className="clients-poc-extension">
              <strong>Extended by {String(poc.extension.days)} days</strong>
              <p>{poc.extension.plan}</p>
              <small>
                {moment(poc.extension.at)} · {poc.extension.by.name}
              </small>
            </div>
          </li>
        )}
      </ul>

      {running && (poc.may.update || poc.may.extend) ? (
        <div className="clients-poc-decide">
          {poc.may.update ? (
            <>
              <button type="button" className="primary" onClick={onConvert}>
                Convert
              </button>
              <button type="button" onClick={onExit}>
                Exit
              </button>
            </>
          ) : null}
          {poc.may.extend ? (
            <button type="button" className="linkish" onClick={onExtend}>
              Extend once, up to 30 days
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** The deal the POC is for: its product, where it stands on the ladder, and whose it is. */
function DealCard({ poc }: { poc: PocPage }) {
  return (
    <section className="clients-panel" aria-labelledby="clients-poc-deal">
      <header className="clients-side-head">
        <h3 id="clients-poc-deal">The deal</h3>
      </header>
      <ul className="clients-side-list">
        <li>
          <div>
            <strong>{poc.deal.productName}</strong>
            <small>
              {poc.lineName} · {poc.client.type}
            </small>
          </div>
        </li>
        <li>
          <div>
            <strong>{STAGE_NAME[poc.deal.stage]}</strong>
            <Ladder deal={poc.deal} />
          </div>
        </li>
        <li>
          <div>
            <strong>{poc.deal.owner.name}</strong>
            <small>Owns the deal</small>
          </div>
        </li>
      </ul>
    </section>
  );
}

/* ---------------------------------------------------------------------- the dialogs */

interface DialogProps {
  poc: PocPage;
  onDone: () => void;
  onClose: () => void;
  onSignedOut: () => void;
}

/** The first review still open, which is most likely the one being recorded. */
function nextReviewOf(poc: PocPage): ReviewKind {
  return poc.reviews.find((review) => review.done === null)?.kind ?? 'DAY7';
}

const REVIEW_FIELDS = ['reviewKind', 'heldOn', 'dmAttended', 'withWhom', 'outcome'] as const;

/**
 * Recording a review meeting (CLI 34), as logging an activity looks: which review as a tile, the
 * day, and whether the senior decision maker was there as one tap.
 */
function ReviewDialog({ poc, onDone, onClose, onSignedOut }: DialogProps) {
  const [reviewKind, setReviewKind] = useState<ReviewKind>(nextReviewOf(poc));
  const [heldOn, setHeldOn] = useState(todayInAccra());
  const [dmAttended, setDmAttended] = useState<boolean | null>(null);
  const [withWhom, setWithWhom] = useState('');
  const [outcome, setOutcome] = useState('');
  const sending = useSending(onDone, onSignedOut);
  const other = sending.other(REVIEW_FIELDS);
  const kindLabel = useId();
  const dmLabel = useId();

  return (
    <Dialog
      title="Record a review meeting"
      intro={`${poc.client.name} · ${poc.deal.productName} POC`}
      wide
      onClose={onClose}
    >
      <form
        className="clients-log"
        onSubmit={(event) => {
          event.preventDefault();
          if (dmAttended === null) return;
          sending.send(() =>
            recordReview(poc.id, { reviewKind, heldOn, dmAttended, withWhom, outcome }),
          );
        }}
      >
        <div className="clients-field">
          <span id={kindLabel} className="clients-field-label">
            Which review?
          </span>
          <div className="clients-kind-tiles" role="group" aria-labelledby={kindLabel}>
            {(Object.keys(REVIEW_NAME) as ReviewKind[]).map((kind) => (
              <button
                key={kind}
                type="button"
                className="clients-kind-tile"
                aria-pressed={reviewKind === kind}
                disabled={sending.busy}
                onClick={() => {
                  setReviewKind(kind);
                }}
              >
                <Icon name="calendar" />
                <span>{REVIEW_NAME[kind]}</span>
              </button>
            ))}
          </div>
          {sending.errorFor('reviewKind') === undefined ? null : (
            <p className="clients-field-error" role="alert">
              {sending.errorFor('reviewKind')}
            </p>
          )}
        </div>

        <div className="clients-field-row">
          <Field label="Held on" error={sending.errorFor('heldOn')}>
            {({ id, describedBy }) => (
              <input
                id={id}
                type="date"
                value={heldOn}
                max={todayInAccra()}
                required
                aria-describedby={describedBy}
                disabled={sending.busy}
                onChange={(event) => {
                  setHeldOn(event.target.value);
                }}
              />
            )}
          </Field>

          <div className="clients-field">
            <span id={dmLabel} className="clients-field-label">
              Was the senior decision maker there?
            </span>
            <div className="clients-choice" role="group" aria-labelledby={dmLabel}>
              {[
                { value: true, label: 'Yes' },
                { value: false, label: 'No' },
              ].map((one) => (
                <button
                  key={one.label}
                  type="button"
                  aria-pressed={dmAttended === one.value}
                  disabled={sending.busy}
                  onClick={() => {
                    setDmAttended(one.value);
                  }}
                >
                  {one.label}
                </button>
              ))}
            </div>
            <p className="clients-field-hint">
              {dmAttended === false
                ? 'It will not count, and is due again a week after this one.'
                : 'The CCO or COO at a bank, the CEO or MD at a brokerage.'}
            </p>
            {sending.errorFor('dmAttended') === undefined ? null : (
              <p className="clients-field-error" role="alert">
                {sending.errorFor('dmAttended')}
              </p>
            )}
          </div>
        </div>

        <Field label="With" error={sending.errorFor('withWhom')}>
          {({ id, describedBy }) => (
            <input
              id={id}
              value={withWhom}
              maxLength={200}
              autoComplete="off"
              placeholder="Who was there"
              aria-describedby={describedBy}
              disabled={sending.busy}
              onChange={(event) => {
                setWithWhom(event.target.value);
              }}
            />
          )}
        </Field>

        <Field label="What came of it" error={sending.errorFor('outcome')}>
          {({ id, describedBy }) => (
            <textarea
              id={id}
              rows={3}
              value={outcome}
              aria-describedby={describedBy}
              disabled={sending.busy}
              onChange={(event) => {
                setOutcome(event.target.value);
              }}
            />
          )}
        </Field>

        {other === undefined ? null : <Notice problem={other} />}
        <DialogFoot
          busy={sending.busy}
          disabled={dmAttended === null}
          doing="Recording…"
          done="Record"
          onCancel={onClose}
        />
      </form>
    </Dialog>
  );
}

/** Setting its health, with a note if there is something to say: its CS lead's or a BD manager's. */
function HealthDialog({ poc, onDone, onClose, onSignedOut }: DialogProps) {
  const [health, setHealth] = useState<PocHealth>(poc.health);
  const [note, setNote] = useState('');
  const [action, setAction] = useState('');
  const sending = useSending(onDone, onSignedOut);
  const other = sending.other(['health', 'note', 'action']);
  const healthLabel = useId();
  const asked = askedOf(health);

  return (
    <Dialog
      title="Set the health"
      intro={`${poc.client.name} · ${poc.deal.productName} POC · ${HEALTH_NAME[poc.health]} now`}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          sending.send(() =>
            setPocHealth(poc.id, asked === undefined ? { health, note } : { health, note, action }),
          );
        }}
      >
        <div className="clients-field">
          <span id={healthLabel} className="clients-field-label">
            How is it going?
          </span>
          <div className="clients-choice" role="group" aria-labelledby={healthLabel}>
            {HEALTHS.map((one) => (
              <button
                key={one}
                type="button"
                aria-pressed={health === one}
                disabled={sending.busy}
                onClick={() => {
                  setHealth(one);
                }}
              >
                {HEALTH_NAME[one]}
              </button>
            ))}
          </div>
          {sending.errorFor('health') === undefined ? null : (
            <p className="clients-field-error" role="alert">
              {sending.errorFor('health')}
            </p>
          )}
        </div>

        <Field label="Note" error={sending.errorFor('note')}>
          {({ id, describedBy }) => (
            <textarea
              id={id}
              rows={3}
              value={note}
              maxLength={2000}
              placeholder="Why, if there is something to say"
              aria-describedby={describedBy}
              disabled={sending.busy}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          )}
        </Field>

        {asked === undefined ? null : (
          <Field
            label={asked.title}
            hint={`What is being done about it. Asked for within ${asked.within}; leave it blank to write it later.`}
            error={sending.errorFor('action')}
          >
            {({ id, describedBy }) => (
              <textarea
                id={id}
                rows={3}
                value={action}
                maxLength={2000}
                aria-describedby={describedBy}
                disabled={sending.busy}
                onChange={(event) => {
                  setAction(event.target.value);
                }}
              />
            )}
          </Field>
        )}

        {other === undefined ? null : <Notice problem={other} />}
        <DialogFoot
          busy={sending.busy}
          disabled={health === poc.health}
          doing="Saving…"
          done="Save"
          onCancel={onClose}
        />
      </form>
    </Dialog>
  );
}

/**
 * Writing what is being done about its health: the corrective action At Risk asks for, or the
 * reset Stalled asks for. Its CS lead's or a BD manager's.
 */
function ActionDialog({ poc, onDone, onClose, onSignedOut }: DialogProps) {
  const [action, setAction] = useState('');
  const sending = useSending(onDone, onSignedOut);
  const other = sending.other(['action']);

  return (
    <Dialog
      title={askedOf(poc.health)?.title ?? 'What is being done'}
      intro={`${poc.client.name} · ${poc.deal.productName} POC · ${HEALTH_NAME[poc.health]}`}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          sending.send(() => addPocAction(poc.id, action));
        }}
      >
        <Field label="What is being done about it" error={sending.errorFor('action')}>
          {({ id, describedBy }) => (
            <textarea
              id={id}
              rows={4}
              value={action}
              maxLength={2000}
              required
              aria-describedby={describedBy}
              disabled={sending.busy}
              onChange={(event) => {
                setAction(event.target.value);
              }}
            />
          )}
        </Field>

        {other === undefined ? null : <Notice problem={other} />}
        <DialogFoot
          busy={sending.busy}
          disabled={action.trim() === ''}
          doing="Saving…"
          done="Save"
          onCancel={onClose}
        />
      </form>
    </Dialog>
  );
}

const USAGE_FIELDS = ['measuredOn', 'enrolled', 'active'] as const;

/**
 * Recording the users enrolled and active on a day, from the start to today. The share is the
 * server's to work out; nothing here types or reckons it.
 */
function UsageDialog({ poc, onDone, onClose, onSignedOut }: DialogProps) {
  const today = todayInAccra();
  const [measuredOn, setMeasuredOn] = useState(today);
  const [enrolled, setEnrolled] = useState(poc.usage === null ? '' : String(poc.usage.enrolled));
  const [active, setActive] = useState('');
  const sending = useSending(onDone, onSignedOut);
  const other = sending.other(USAGE_FIELDS);
  const sameDay = poc.usageReadings.some((reading) => reading.measuredOn === measuredOn);

  return (
    <Dialog
      title="Record usage"
      intro={`${poc.client.name} · ${poc.deal.productName} POC`}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          sending.send(() =>
            recordPocUsage(poc.id, {
              measuredOn,
              enrolled: Number(enrolled),
              active: Number(active),
            }),
          );
        }}
      >
        <Field
          label="On"
          hint={
            sameDay ? 'That day has a reading already; this one will count instead.' : undefined
          }
          error={sending.errorFor('measuredOn')}
        >
          {({ id, describedBy }) => (
            <input
              id={id}
              type="date"
              value={measuredOn}
              min={poc.startedOn}
              max={today}
              required
              aria-describedby={describedBy}
              disabled={sending.busy}
              onChange={(event) => {
                setMeasuredOn(event.target.value);
              }}
            />
          )}
        </Field>

        <div className="clients-field-row">
          <Field label="Users enrolled" error={sending.errorFor('enrolled')}>
            {({ id, describedBy }) => (
              <input
                id={id}
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={enrolled}
                required
                aria-describedby={describedBy}
                disabled={sending.busy}
                onChange={(event) => {
                  setEnrolled(event.target.value);
                }}
              />
            )}
          </Field>

          <Field label="Users active" error={sending.errorFor('active')}>
            {({ id, describedBy }) => (
              <input
                id={id}
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={active}
                required
                aria-describedby={describedBy}
                disabled={sending.busy}
                onChange={(event) => {
                  setActive(event.target.value);
                }}
              />
            )}
          </Field>
        </div>

        {other === undefined ? null : <Notice problem={other} />}
        <DialogFoot
          busy={sending.busy}
          disabled={enrolled.trim() === '' || active.trim() === ''}
          doing="Recording…"
          done="Record"
          onCancel={onClose}
        />
      </form>
    </Dialog>
  );
}

/**
 * Extending it, once: 1 to 30 days more, and the plan for them. The new decision date is the
 * server's to work out.
 */
function ExtendDialog({ poc, onDone, onClose, onSignedOut }: DialogProps) {
  const [days, setDays] = useState('');
  const [plan, setPlan] = useState('');
  const sending = useSending(onDone, onSignedOut);
  const other = sending.other(['days', 'plan']);

  return (
    <Dialog
      title="Extend the POC"
      intro={`${poc.client.name} · ${poc.deal.productName} POC · decision by ${day(poc.decisionOn)}. A POC is extended once.`}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          sending.send(() => extendPoc(poc.id, Number(days), plan));
        }}
      >
        <Field
          label="Days more"
          hint="From 1 to 30. The decision date moves on by as many."
          error={sending.errorFor('days')}
        >
          {({ id, describedBy }) => (
            <input
              id={id}
              type="number"
              inputMode="numeric"
              min={1}
              max={30}
              step={1}
              value={days}
              required
              aria-describedby={describedBy}
              disabled={sending.busy}
              onChange={(event) => {
                setDays(event.target.value);
              }}
            />
          )}
        </Field>

        <Field label="Plan" hint="What the extra days are for." error={sending.errorFor('plan')}>
          {({ id, describedBy }) => (
            <textarea
              id={id}
              rows={4}
              value={plan}
              maxLength={4000}
              required
              aria-describedby={describedBy}
              disabled={sending.busy}
              onChange={(event) => {
                setPlan(event.target.value);
              }}
            />
          )}
        </Field>

        {other === undefined ? null : <Notice problem={other} />}
        <DialogFoot
          busy={sending.busy}
          disabled={days.trim() === '' || plan.trim() === ''}
          doing="Extending…"
          done="Extend"
          onCancel={onClose}
        />
      </form>
    </Dialog>
  );
}

/**
 * Converting it: the deal goes to Live and is won. A new value may be given, which is kept
 * beside the old one in the deal's history; left blank, the value stays as it is.
 */
function ConvertDialog({ poc, onDone, onClose, onSignedOut }: DialogProps) {
  const [currency, setCurrency] = useState<Currency>('GHS');
  const [amount, setAmount] = useState('');
  const sending = useSending(onDone, onSignedOut);
  const other = sending.other(['value']);

  return (
    <Dialog
      title="Convert the POC"
      intro={`${poc.client.name} · the ${poc.deal.productName} deal goes live, and is won.`}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          sending.send(() =>
            convertPoc(poc.id, amount.trim() === '' ? null : { amount: amount.trim(), currency }),
          );
        }}
      >
        <div className="clients-field-row is-money">
          <Field
            label="New value"
            hint="Optional. Leave it blank to keep the deal's value; the old one is kept either way."
            error={sending.errorFor('value')}
          >
            {({ id, describedBy }) => (
              <span className="clients-deal-money">
                <select
                  aria-label="Currency"
                  value={currency}
                  disabled={sending.busy}
                  onChange={(event) => {
                    setCurrency(event.target.value as Currency);
                  }}
                >
                  <option value="GHS">GHS</option>
                  <option value="USD">USD</option>
                </select>
                <input
                  id={id}
                  inputMode="decimal"
                  value={amount}
                  placeholder="125000"
                  autoComplete="off"
                  aria-describedby={describedBy}
                  disabled={sending.busy}
                  onChange={(event) => {
                    setAmount(event.target.value);
                  }}
                />
              </span>
            )}
          </Field>
        </div>

        {other === undefined ? null : <Notice problem={other} />}
        <DialogFoot busy={sending.busy} doing="Converting…" done="Convert" onCancel={onClose} />
      </form>
    </Dialog>
  );
}

/**
 * Exiting it, by the exit rules: a reason from the exit list a BD manager keeps, and which
 * products the POC ran on. The debrief is made for the BD manager on the server.
 */
function ExitDialog({ poc, onDone, onClose, onSignedOut }: DialogProps) {
  const [reasons, setReasons] = useState<EndReason[] | null>(null);
  const [loadProblem, setLoadProblem] = useState<Problem | undefined>(undefined);
  const [reasonId, setReasonId] = useState<string | null>(null);
  const [note, setNote] = useState(poc.deal.productName);
  const sending = useSending(onDone, onSignedOut);
  const other = sending.other(['reasonId', 'note']);
  const reasonLabel = useId();

  useEffect(() => {
    let current = true;

    endReasons()
      .then((lists) => {
        if (current) setReasons(lists.EXITED);
      })
      .catch((error: unknown) => {
        if (!current) return;
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setLoadProblem(problemFrom(error));
      });

    return () => {
      current = false;
    };
  }, [onSignedOut]);

  return (
    <Dialog
      title="Exit the POC"
      intro={`${poc.client.name} · the ${poc.deal.productName} deal ends exited, at POC. A debrief is set for the BD manager.`}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (reasonId !== null) {
            sending.send(() => exitPoc(poc.id, reasonId, note));
          }
        }}
      >
        <div className="clients-lose-reasons">
          <span id={reasonLabel}>Why was it exited?</span>
          {loadProblem !== undefined ? (
            <Notice problem={loadProblem} />
          ) : reasons === null ? (
            <span className="muted">Loading the reasons…</span>
          ) : reasons.length === 0 ? (
            <span className="muted">
              There are no exit reasons to choose from. A BD manager adds them in Setup.
            </span>
          ) : (
            <div className="clients-move-chips" role="group" aria-labelledby={reasonLabel}>
              {reasons.map((reason) => (
                <button
                  key={reason.id}
                  type="button"
                  aria-pressed={reasonId === reason.id}
                  disabled={sending.busy}
                  onClick={() => {
                    setReasonId(reason.id);
                  }}
                >
                  {reason.label}
                </button>
              ))}
            </div>
          )}
          {sending.errorFor('reasonId') === undefined ? null : (
            <p className="clients-field-error" role="alert">
              {sending.errorFor('reasonId')}
            </p>
          )}
        </div>

        <Field label="Which products the POC ran on" error={sending.errorFor('note')}>
          {({ id, describedBy }) => (
            <textarea
              id={id}
              rows={3}
              value={note}
              maxLength={2000}
              required
              aria-describedby={describedBy}
              disabled={sending.busy}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          )}
        </Field>

        {other === undefined ? null : <Notice problem={other} />}
        <DialogFoot
          busy={sending.busy}
          disabled={reasonId === null || note.trim() === ''}
          doing="Exiting…"
          done="Exit"
          onCancel={onClose}
        />
      </form>
    </Dialog>
  );
}

/** Handing the POC, and its open review meetings, to another CS lead: a BD manager's. */
function LeadDialog({ poc, onDone, onClose, onSignedOut }: DialogProps) {
  const [people, setPeople] = useState<ClientsHolder[] | undefined>(undefined);
  const [employeeId, setEmployeeId] = useState(poc.csLead.id);
  const sending = useSending(onDone, onSignedOut);
  const other = sending.other(['employeeId']);

  useEffect(() => {
    clientsHolders()
      .then(setPeople)
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) onSignedOut();
      });
  }, [onSignedOut]);

  /* Somebody who could take it over (#289), and whoever leads it now. */
  const able = (people ?? []).filter((person) => person.canTakeOver || person.id === poc.csLead.id);
  const choices = able.some((person) => person.id === poc.csLead.id) ? able : [poc.csLead, ...able];

  return (
    <Dialog
      title="Change the CS lead"
      intro="The open review meetings go to the new CS lead too. The deal stays its owner's."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          sending.send(() => movePocLead(poc.id, employeeId));
        }}
      >
        <Field label="CS lead" error={sending.errorFor('employeeId')}>
          {({ id, describedBy }) => (
            <select
              id={id}
              value={employeeId}
              aria-describedby={describedBy}
              disabled={sending.busy || people === undefined}
              onChange={(event) => {
                setEmployeeId(event.target.value);
              }}
            >
              {choices.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        {other === undefined ? null : <Notice problem={other} />}
        <DialogFoot
          busy={sending.busy}
          disabled={employeeId === poc.csLead.id}
          doing="Moving…"
          done="Move"
          onCancel={onClose}
        />
      </form>
    </Dialog>
  );
}
