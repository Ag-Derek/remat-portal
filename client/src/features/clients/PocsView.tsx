import { useCallback, useEffect, useId, useState } from 'react';
import {
  type ClientsNamed,
  clientsHolders,
  isNotSignedIn,
  movePocLead,
  type Poc,
  type PocPage,
  type PocPhase,
  type PocReviewHeld,
  type PocReviewStep,
  pocPage,
  recordReview,
  type ReviewKind,
  runningPocs,
} from '../../api';
import { AddButton, EditButton } from '../../ActionButtons';
import { day } from '../../format';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';
import { REVIEW_NAME } from './Activity';
import { initialsOf } from './ClientView';
import { Ladder, STAGE_NAME } from './Deals';
import { Dialog, DialogFoot, Field, useSending } from './ui';

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
 * Health, usage, the checklist and the extension join the page with #286, #284 and #287.
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

/** "33 days to go", "Decision today", or "3 days past its decision date". */
function decisionInWords(daysToDecision: number): string {
  if (daysToDecision > 1) return `${String(daysToDecision)} days to go`;
  if (daysToDecision === 1) return '1 day to go';
  if (daysToDecision === 0) return 'Decision today';

  const late = -daysToDecision;
  return `${late === 1 ? '1 day' : `${String(late)} days`} past its decision date`;
}

/** How far through its ten weeks a POC is, as a share for drawing: never more than all of it. */
function shareOf(dayOfPoc: number): number {
  return Math.min(Math.max(dayOfPoc, 1), POC_DAYS) / POC_DAYS;
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
      <span style={{ width: `${String(shareOf(poc.day) * 100)}%` }} />
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
                <td data-label="Where it stands">
                  <span>{PHASE_NAME[poc.phase]}</span>
                  <Meter poc={poc} />
                  <small>Day {String(Math.max(poc.day, 1))} of 70</small>
                </td>
                <td data-label="Decision">
                  <span>{day(poc.decisionOn)}</span>
                  <small className={poc.daysToDecision < 0 ? 'clients-step-when is-overdue' : ''}>
                    {decisionInWords(poc.daysToDecision)}
                  </small>
                </td>
                <td data-label="CS lead">
                  <span>{poc.csLead.name}</span>
                  {poc.csLeadHoldsARole ? null : (
                    <small className="clients-figure-note">Needs a new CS lead</small>
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
  const [open, setOpen] = useState<'review' | 'lead' | undefined>(undefined);

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
              {poc.csLeadHoldsARole ? null : (
                <span className="clients-pill is-missing">
                  No longer has a role · needs a new CS lead
                </span>
              )}

              <span className="clients-pill-divider" aria-hidden="true" />

              <span className={`clients-pill is-phase is-${poc.phase.toLowerCase()}`}>
                {PHASE_NAME[poc.phase]}
              </span>
            </div>
          </header>

          {/* --------------------------------------------------------- the figures */}

          <PocFigures poc={poc} />

          {/* ------------------------------------------------------- the ten weeks */}

          <Timeline poc={poc} />

          <div className="clients-client-body">
            {/* ------------------------------------------------- reviews held */}

            <div className="clients-client-main">
              <ReviewsHeld
                poc={poc}
                onRecord={() => {
                  setOpen('review');
                }}
              />
            </div>

            <aside className="clients-client-side">
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
            <span className="clients-poc-of"> of 70</span>
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

/** Handing the POC, and its open review meetings, to another CS lead: a BD manager's. */
function LeadDialog({ poc, onDone, onClose, onSignedOut }: DialogProps) {
  const [people, setPeople] = useState<ClientsNamed[] | undefined>(undefined);
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

  const choices =
    people === undefined
      ? [poc.csLead]
      : people.some((person) => person.id === poc.csLead.id)
        ? people
        : [poc.csLead, ...people];

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
