import { useCallback, useEffect, useRef, useState } from 'react';
import {
  askForLeave,
  type FormRule,
  isNotSignedIn,
  nameCover,
  type Quote,
  type QuoteWarning,
  type RequestableLeaveType,
  type RequestForm,
  removePlan,
  requestForm,
  quoteLeave,
  type Submitted,
} from '../../api';
import { days, inDays, period, sentenceCase } from '../../format';
import { Icon, iconForLeaveType } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';
import { Evidence } from './Attachments';
import { CoverFields, type CoverDraft, NO_COVER, partsOf } from '../cover/CoverFields';

/**
 * How long a reason may be.
 *
 * A cap the browser holds and the database does not: `leave_request.reason` is TEXT with only
 * a not-blank CHECK on it. It is here because the design asks for a counter and a counter needs
 * a denominator — it refuses nothing the server would have taken. Move it into a migration and
 * the validator if it is ever a rule rather than a courtesy.
 */
const REASON_LIMIT = 500;

/** What an input the refusal named points a screen reader at. */
const REFUSAL_ID = 'ask-refusal';

/** #226. Nobody was named, the cover was named, or the server's refusal of it. */
type CoverOutcome = 'NONE' | 'NAMED' | Problem;

/**
 * Asking for leave, told the rules while you fill it in. FR 10, FR 11, FR 13, FR 17, FR 32f.
 *
 * The story's failure is finding out *after* — a fortnight submitted and then a message
 * saying it needed a certificate, or that compassionate leave was never anybody's to promise.
 * So the screen is arranged around when each fact becomes true rather than around the shape
 * of the record being written:
 *
 *   **The moment a kind of leave is chosen**, its rules appear, because they are properties
 *   of the type and were true before anybody opened the page. That is where the second and
 *   third criteria are met, and neither of them waits for a date.
 *
 *   **The moment there are two dates**, the cost appears beside them and is re-asked every
 *   time either moves. The server counts it; nothing here does arithmetic on a day.
 *
 * Two columns, and which side a thing is on carries meaning: the left is what somebody is
 * deciding, the right is what the system says about it. On a narrow screen they stack in
 * that order, so the answer never sits above the question it is about.
 */
export function NewRequestPage({ onSignedOut }: { onSignedOut: () => void }) {
  const [form, setForm] = useState<RequestForm | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);

  const [leaveTypeId, setLeaveTypeId] = useState(() => prefilled('leaveTypeId'));
  const [from, setFrom] = useState(() => prefilled('from'));
  const [to, setTo] = useState(() => prefilled('to'));
  /** The plan this was opened from, removed once the request is in. */
  const fromPlan = useRef(prefilled('plan'));
  const [reason, setReason] = useState('');
  /** FR 18. Optional; the server keeps it only for leave already started. */
  const [lateEntryReason, setLateEntryReason] = useState('');
  /** FR 17. Answered about one period, so it is cleared whenever the period moves. */
  const [acknowledged, setAcknowledged] = useState(false);
  /**
   * FR 12, FR 13. What has been uploaded and not yet asked for leave with.
   *
   * Ids and never files: the bytes went to the server when they were chosen, so this holds
   * what to *name* on submission. It is not cleared when the dates move, unlike the
   * acknowledgement above — a certificate is about the person, not about the period.
   */
  const [evidence, setEvidence] = useState<string[]>([]);
  /** #226. Who colleagues contact while this leave is under way. Optional. */
  const [cover, setCover] = useState<CoverDraft>(NO_COVER);
  /**
   * What became of the cover once the request was in. Named straight after it, so a refusal
   * leaves the request standing and says where to name it instead.
   */
  const [coverOutcome, setCoverOutcome] = useState<CoverOutcome>('NONE');

  const [quote, setQuote] = useState<Quote | undefined>(undefined);
  const [quoteProblem, setQuoteProblem] = useState<Problem | undefined>(undefined);
  const [pricing, setPricing] = useState(false);

  const [asking, setAsking] = useState(false);
  const [refusal, setRefusal] = useState<Problem | undefined>(undefined);
  const [submitted, setSubmitted] = useState<Submitted | undefined>(undefined);

  /**
   * Which quote is the current one.
   *
   * Two dates typed quickly are two requests in flight, and they can land in either order —
   * a screen without this shows the cost of the date somebody has already changed. The
   * counter is bumped whenever the question changes, and an answer to an older question is
   * dropped rather than rendered.
   */
  const asked = useRef(0);

  const openForm = useCallback(() => {
    setProblem(undefined);

    requestForm()
      .then((next) => {
        setForm(next);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }

        /** The server's own sentence, verbatim. NFR USA 03. */
        setProblem(problemFrom(error));
      });
  }, [onSignedOut]);

  useEffect(openForm, [openForm]);

  /**
   * The cost, re-asked whenever the question changes. The story's first criterion.
   *
   * Waits a moment before asking, which is not about the server — a quote is documented as
   * safe to call on every keystroke — but about the person. A native date input fires a
   * change for every part of a date somebody types, so an undebounced version would show two
   * figures for half-written dates on the way to the one they meant.
   */
  useEffect(() => {
    /* FR 17. The tick answered the period that has just changed, so it goes with it —
       an acknowledgement carried onto different dates is one nobody made. */
    setAcknowledged(false);

    if (leaveTypeId === '' || from === '' || to === '') {
      setQuote(undefined);
      setQuoteProblem(undefined);
      setPricing(false);
      return;
    }

    asked.current += 1;
    const mine = asked.current;

    setPricing(true);

    const waiting = setTimeout(() => {
      quoteLeave({ leaveTypeId, from, to })
        .then((next) => {
          if (mine !== asked.current) {
            return;
          }

          setQuote(next);
          setQuoteProblem(undefined);
        })
        .catch((error: unknown) => {
          if (mine !== asked.current) {
            return;
          }

          if (isNotSignedIn(error)) {
            onSignedOut();
            return;
          }

          /* A refusal about the dates — a period that costs nothing, one that crosses a
             year end, one over leave already booked — and every one of them arrives as the
             sentence the domain wrote, naming what to do instead. The old figure goes:
             showing a cost beside a refusal would be two answers to one question. */
          setQuote(undefined);
          setQuoteProblem(problemFrom(error));
        })
        .finally(() => {
          if (mine === asked.current) {
            setPricing(false);
          }
        });
    }, 300);

    return () => {
      clearTimeout(waiting);
    };
  }, [leaveTypeId, from, to, onSignedOut]);

  const ask = useCallback(() => {
    setAsking(true);
    setRefusal(undefined);

    /* FR 17. Sent as it stands: whether one was owed is the server's answer. And
       FR 13: the ids of what was uploaded, for the same reason — whether this kind
       of leave needed one is not a question a browser answers. */
    askForLeave({
      leaveTypeId,
      from,
      to,
      reason,
      acknowledgesShortNotice: acknowledged,
      lateEntryReason,
      evidence,
    })
      .then(async (next) => {
        /* #226. The cover goes on the request it is for, once there is one. A refusal does not
           take the request back: it is in, and the cover can be named from My requests. */
        const parts = partsOf(cover, next.from, next.to);

        if (parts.length > 0) {
          setCoverOutcome(
            await nameCover(next.requestId, parts).then(
              () => 'NAMED' as const,
              (error: unknown) => problemFrom(error),
            ),
          );
        } else {
          setCoverOutcome('NONE');
        }

        setSubmitted(next);

        /* Asked for from a plan, so the plan has done its job. A failure here leaves the plan
           standing, which is harmless: it can be removed by hand. */
        if (fromPlan.current !== '') {
          void removePlan(fromPlan.current).catch(() => undefined);
          fromPlan.current = '';
        }
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }

        setRefusal(problemFrom(error));
      })
      .finally(() => {
        setAsking(false);
      });
  }, [leaveTypeId, from, to, reason, acknowledged, lateEntryReason, evidence, cover, onSignedOut]);

  const startAgain = useCallback(() => {
    setSubmitted(undefined);
    setFrom('');
    setTo('');
    setReason('');
    setLateEntryReason('');
    setAcknowledged(false);
    /* The files that went on the last request went with it. What is waiting now is whatever
       the panel reads back when it comes round again. FR 13. */
    setEvidence([]);
    setCover(NO_COVER);
    setCoverOutcome('NONE');
    setQuote(undefined);
    setQuoteProblem(undefined);
    setRefusal(undefined);
  }, []);

  if (form === undefined) {
    return (
      <div className="page">
        {problem === undefined ? <Skeleton /> : <Notice problem={problem} onRetry={openForm} />}
      </div>
    );
  }

  const chosen = form.types.find((type) => type.leaveTypeId === leaveTypeId);

  if (submitted !== undefined) {
    return (
      <div className="page">
        <Asked
          submitted={submitted}
          type={chosen}
          perOccasion={quote?.perOccasion ?? null}
          cover={coverOutcome}
          onStartAgain={startAgain}
        />
      </div>
    );
  }

  /**
   * The input the refusal is about, where it named one.
   *
   * `field` has been on the wire and nothing read it, so a refusal about the last
   * day sat under the button with both dates looking equally fine.
   */
  const badField = refusal?.field;
  const marks = (field: string) =>
    badField !== field ? {} : { 'aria-invalid': true, 'aria-describedby': REFUSAL_ID };

  return (
    <div className="page">
      {form.types.length === 0 ? (
        <NothingToAskFor />
      ) : (
        <div className="asking">
          <form
            className="panel"
            onSubmit={(event) => {
              event.preventDefault();
              ask();
            }}
          >
            <h2 className="panel-title">Leave details</h2>

            <label>
              Kind of leave
              <select
                value={leaveTypeId}
                disabled={asking}
                required
                onChange={(event) => {
                  setLeaveTypeId(event.target.value);
                  /* The refusal was about the last type. Leaving it up would attach one
                     kind of leave's answer to another kind's question. */
                  setRefusal(undefined);
                }}
              >
                <option value="">Choose…</option>
                {form.types.map((type) => (
                  <option key={type.leaveTypeId} value={type.leaveTypeId}>
                    {type.name}
                  </option>
                ))}
              </select>
            </label>

            {/* The story's second and third criteria, and they are inside the form rather
                than beside it: they are part of choosing, not commentary on it. */}
            {chosen === undefined ? null : <Rules type={chosen} />}

            <div className="dates">
              <label>
                First day
                <input
                  type="date"
                  value={from}
                  /* FR 18. No earliest day: leave may be entered any time after the fact. */
                  disabled={asking}
                  required
                  {...marks('from')}
                  onChange={(event) => {
                    const day = event.target.value;
                    setFrom(day);

                    /* A last day now before the first is a period nobody meant, and it is
                       the commonest way to get one: somebody moves the start of a booked
                       week forwards. Carried rather than cleared, so the length they had
                       chosen survives the correction. */
                    if (to !== '' && day !== '' && to < day) {
                      setTo(day);
                    }
                  }}
                />
              </label>

              <label>
                Last day
                <input
                  type="date"
                  value={to}
                  /* String comparison, not date arithmetic. Ten character dates sort
                     correctly as text, which is the whole reason they are never parsed. */
                  min={from === '' ? undefined : from}
                  disabled={asking}
                  required
                  {...marks('to')}
                  onChange={(event) => {
                    setTo(event.target.value);
                  }}
                />
              </label>
            </div>

            {/* FR 10. Required only where the type says so, off `reasonRequired` rather
                than off anything decided here. */}
            <label>
              {chosen?.reasonRequired === false ? 'Why (optional)' : 'Why'}
              <textarea
                value={reason}
                rows={4}
                maxLength={REASON_LIMIT}
                disabled={asking}
                required={chosen === undefined || chosen.reasonRequired}
                placeholder={placeholderFor(chosen)}
                {...marks('reason')}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
              {/* `aria-hidden`: `maxLength` already tells a screen reader, and a count read
                  out on every keystroke is unusable. */}
              <small className="counter" aria-hidden="true">
                {String(reason.length)}/{String(REASON_LIMIT)}
              </small>
            </label>

            {/* Who will read it, rather than repeating whether it is needed. */}
            <p className="muted">
              {chosen === undefined
                ? 'Whoever approves this will read what you write here.'
                : `${sentenceCase(chosen.approvedBy)} will read what you write here.`}
            </p>

            {/* FR 18. Optional, and only for leave that has already started. */}
            {from === '' || from >= todayInWholeDays() ? null : (
              <label>
                Why it is being entered late (optional)
                <textarea
                  value={lateEntryReason}
                  rows={2}
                  maxLength={REASON_LIMIT}
                  disabled={asking}
                  {...marks('lateEntryReason')}
                  onChange={(event) => {
                    setLateEntryReason(event.target.value);
                  }}
                />
              </label>
            )}

            {/* FR 12, FR 13. Here rather than after submitting, because FR 13 is
                answered *at* submission: a kind of leave that asks for a certificate refuses
                a request that arrives without one. Shown for every kind, because anybody may
                attach something — whether one is needed is in the rules above, written by
                the server. */}
            <Evidence disabled={asking} onChange={setEvidence} onSignedOut={onSignedOut} />

            {/* #226. Optional. Shown in the directory while the leave is agreed and under way,
                and whoever is named is emailed. */}
            <fieldset className="cover-section">
              <legend>Who covers while you are away (optional)</legend>
              <CoverFields
                from={from}
                to={to}
                draft={cover}
                disabled={asking}
                onChange={setCover}
                onSignedOut={onSignedOut}
              />
            </fieldset>

            {/* FR 17. On the left, because it is something to decide rather than
                something the system is saying. Shown exactly when the server warns. */}
            {quote?.warnings.some((warning) => warning.code === 'SHORT_NOTICE') !== true ? null : (
              <label className="acknowledge">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={asking}
                  required
                  onChange={(event) => {
                    setAcknowledged(event.target.checked);
                  }}
                />
                <span>
                  <strong>This is a short notice request.</strong>I understand the approvers may
                  push back, and I have not planned around it being agreed.
                </span>
              </label>
            )}

            {/* The retry is offered only where trying again could come out
                differently — a dropped connection or a fault at our end. A rule that said no
                is not answered by pressing submit twice. */}
            {refusal === undefined ? null : (
              <Notice problem={refusal} id={REFUSAL_ID} retrying={asking} onRetry={ask} />
            )}

            <button type="submit" className="primary is-big" disabled={asking}>
              {asking ? 'Submitting…' : 'Submit request'}
              <Icon name="ask" />
            </button>
          </form>

          <Cost
            quote={quote}
            problem={quoteProblem}
            pricing={pricing}
            type={chosen}
            waitingForDates={from === '' || to === ''}
          />
        </div>
      )}
    </div>
  );
}

/**
 * What this kind of leave asks of somebody. The story's second and third criteria.
 *
 * Split in two, and the split is the story rather than decoration. The rules that **ask**
 * something — a document, notice, a deadline for entering it late — are the ones somebody can
 * still act on while the form is open, and they are what the story is about. The rest explain
 * how the leave works and are true whether or not anybody reads them, so they sit under a
 * disclosure rather than competing with the first list.
 *
 * Compassionate leave's discretion is in the second group and that is correct: it is not
 * something to go and do, it is something to know before hoping. It is the leave type's own
 * `description`, written by HR, which is why nothing here mentions compassionate leave — the
 * day HR adds a type, its rules appear with it and no deployment is involved. FR 31.
 */
function Rules({ type }: { type: RequestableLeaveType }) {
  const asks = type.rules.filter((rule) => rule.asks);
  const explains = type.rules.filter((rule) => !rule.asks);

  return (
    <div className="rulebook">
      {asks.length === 0 ? null : (
        <>
          <h3>Before you ask</h3>
          <ul className="asks">
            {asks.map((rule) => (
              <Rule key={rule.kind} rule={rule} />
            ))}
          </ul>
        </>
      )}

      {explains.length === 0 ? null : (
        <details className="breakdown">
          <summary>How {type.name.toLowerCase()} works</summary>
          <ul className="explains">
            {explains.map((rule) => (
              <Rule key={rule.kind} rule={rule} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * One rule.
 *
 * `is-<kind>` carries whatever emphasis the kind deserves and never carries the meaning:
 * the sentence says the whole thing on its own, which is the rule the stylesheet sets out
 * about one man in twelve.
 */
function Rule({ rule }: { rule: FormRule }) {
  return (
    <li className={`rule is-${rule.kind.toLowerCase().replace(/_/g, '-')}`}>{rule.inWords}</li>
  );
}

/**
 * What the leave would cost. The story's first criterion.
 *
 * Every figure on it was computed by the server and no browser recalculates one — the same
 * rule the balance screen is built on, and it matters more here, because this is the number
 * somebody commits a fortnight on.
 *
 * It has four states and they are four different pieces of news: nothing chosen yet, being
 * counted, counted, and refused. A refusal replaces the figure rather than sitting beside it,
 * because a cost shown next to "these dates cost no leave at all" is two answers to one
 * question.
 */
function Cost({
  quote,
  problem,
  pricing,
  type,
  waitingForDates,
}: {
  quote: Quote | undefined;
  problem: Problem | undefined;
  pricing: boolean;
  type: RequestableLeaveType | undefined;
  waitingForDates: boolean;
}) {
  if (problem !== undefined) {
    /* No retry: the quote re-asks itself the moment either date moves, so a button here would
       be a second way to do what changing a date already does. */
    return (
      <aside className="cost">
        <Notice problem={problem} />
      </aside>
    );
  }

  if (quote === undefined) {
    return (
      <aside className="cost">
        <p className="notice plain">
          {type === undefined
            ? 'Choose a kind of leave to see what it asks of you.'
            : waitingForDates
              ? 'Pick a first and last day, and what this costs appears here as you change them.'
              : 'Counting…'}
        </p>
      </aside>
    );
  }

  return (
    /* `aria-busy` while a newer count is on its way, so the figure on screen is announced as
       stale rather than silently replaced under somebody reading it. */
    <aside className="cost" aria-busy={pricing}>
      <h2 className="summary-title">Leave summary</h2>

      <div className="card">
        <div className="summary-head">
          <span className="chip">
            <Icon name={iconForLeaveType(type?.name ?? '')} />
          </span>

          <div>
            <p className="summary-what">{type?.name ?? 'Leave'}</p>
            <div className="headline">
              <span className="figure">{days(quote.days)}</span>
              <span className="of">{quote.days === 1 ? 'day' : 'days'} of leave</span>
            </div>
          </div>
        </div>

        {/* FR 24. The two figures differ whenever a weekend or a public holiday falls inside
            the period, and that difference is the single thing people query. */}
        <p className="headline-note">
          {quote.calendarDays === quote.days
            ? `${inDays(quote.calendarDays)} away, all of them counted.`
            : `${inDays(quote.calendarDays)} away, ${inDays(quote.days)} charged.`}
        </p>

        {/* NFR USA 03. "Nine days off cost you seven" is an assertion; this is the reason,
            and it is what stops somebody querying the figure. */}
        {quote.free.length === 0 ? null : (
          <section className="summary-part">
            <h3>
              <Icon name="balances" />
              No cost on
            </h3>
            <ul className="free">
              {quote.free.map((day) => (
                <li key={day.date}>{day.inWords}</li>
              ))}
            </ul>
          </section>
        )}

        <section className="summary-part">
          <h3>
            <Icon name="balances" />
            Leave period
          </h3>
          {/* The dates alone. The calendar day count sat here beside the charged count at the
              top of the panel — "6 days" under a headline reading "4 days of leave" — and two
              different day figures on one card read as a contradiction rather than as FR 24's
              distinction. The line under the headline still says both, in one breath. */}
          <p className="period">
            <span>{period(quote.from, quote.to)}</span>
          </p>
        </section>

        <section className="summary-part">
          <h3>
            <Icon name="balances" />
            What it leaves you
          </h3>
          <dl className="standing">
            <dt>{quote.perOccasion === null ? 'You have' : 'You can take'}</dt>
            <dd>{inDays(quote.availableNow)}</dd>
            <dt>After this</dt>
            <dd className={quote.availableAfter < 0 ? 'overdrawn' : undefined}>
              {inDays(quote.availableAfter)}
            </dd>
          </dl>
          {/* FR 32g. Said, because a balance of nought otherwise reads as nothing to take. */}
          {quote.perOccasion === null ? null : (
            <p className="muted">
              {quote.leaveTypeName} is {inDays(quote.perOccasion)} for each occasion. The days are
              added when your request is approved.
            </p>
          )}
        </section>

        {/* FR 38a. Said here as well as in the rules, because by now it is about this
            request rather than about the kind of leave. */}
        <p className="rules">
          <Icon name="stage" />
          Goes to {quote.approvedBy}.
        </p>
      </div>

      {quote.warnings
        .filter((warning) => warning.code !== 'SHORT_NOTICE')
        .map((warning) => (
          <Warning key={warning.code} warning={warning} />
        ))}
    </aside>
  );
}

/**
 * Something worth knowing that is not a refusal. FR 13, FR 17, FR 14.
 *
 * **Nothing here decides whether it blocks the request, deliberately.** A short notice
 * request goes through and is flagged to the approver; a request past a sick leave allowance
 * also goes through, because FR 32a makes that allowance a documentation threshold rather
 * than a cap — and the same warning against annual leave is a refusal. Which of those it is
 * depends on `exceedable_with_document`, a column, and a browser that read it would be a
 * second copy of the rule that eventually disagrees with the one that counts. So the button
 * stays enabled and the server answers, with a sentence.
 *
 * `SHORT_NOTICE` is the one that also asks something back — the tick above the button, FR 17.
 * It is rendered off the presence of this warning rather than off a notice
 * window read here, and the server refuses an unacknowledged submission either way.
 */
function Warning({ warning }: { warning: QuoteWarning }) {
  return (
    <p className={`notice warning is-${warning.code.toLowerCase().replace(/_/g, '-')}`}>
      {warning.message}
    </p>
  );
}

/**
 * What happened, once it has been asked for.
 *
 * The screen stays rather than jumping to the history, because the person has just committed
 * to a fortnight and the two things they want are the number it cost and where it has gone —
 * both of which came back with the answer and neither of which needs another request.
 */
function Asked({
  submitted,
  type,
  perOccasion,
  cover,
  onStartAgain,
}: {
  submitted: Submitted;
  type: RequestableLeaveType | undefined;
  /** FR 32g. Set for per-occasion leave, whose days arrive on approval. */
  perOccasion: number | null;
  /** #226. */
  cover: CoverOutcome;
  onStartAgain: () => void;
}) {
  return (
    <div className="panel asked">
      <h2>Asked for</h2>

      <p className="progress">
        {inDays(submitted.days)} of {type?.name.toLowerCase() ?? 'leave'},{' '}
        {period(submitted.from, submitted.to)}.
      </p>

      {/* FR 38a. Where it is now, which is the question somebody asks next. */}
      <p>
        It is with {type?.approvedBy ?? 'whoever approves it'} now. You will be told when it has
        been decided.
      </p>

      {perOccasion === null ? (
        <p className="muted">
          {inDays(submitted.availableAfter)} left of this kind of leave, with these days held
          against it while it is being decided.
        </p>
      ) : (
        <p className="muted">
          The days for this occasion are added to your balance when it is approved.
        </p>
      )}

      {/* #226. The request is in either way; a refusal of the cover says where to try again. */}
      {cover === 'NONE' ? null : cover === 'NAMED' ? (
        <p>
          Your cover has been told. While this leave is under way, colleagues will be pointed to
          them.
        </p>
      ) : (
        <div className="notice warning" role="alert">
          <p>The leave was asked for, but the cover was not saved: {cover.what}</p>
          <p>
            Name it from <a href="#/requests">My requests</a>.
          </p>
        </div>
      )}

      <div className="dates">
        <button type="button" className="primary" onClick={onStartAgain}>
          Ask for something else
        </button>
      </div>
    </div>
  );
}

/**
 * Nobody may ask for anything, which is a real state and not an error.
 *
 * Every type retired at once, or somebody whose record makes them eligible for none — FR 05.
 * Either way it is HR's to fix and the sentence says so, rather than leaving an empty select.
 */
function NothingToAskFor() {
  return (
    <p className="notice plain">
      There are no kinds of leave you can ask for at the moment. Ask HR. This usually means the
      leave types have not been set up yet, or that your record is missing something they depend on.
    </p>
  );
}

/* The shape of the form while it is on its way, rather than a spinner. */
function Skeleton() {
  return (
    <>
      <div className="asking">
        <div className="skeleton is-tall" />
        <div className="skeleton" />
      </div>
    </>
  );
}

/** Today, ten characters, in the reader's own zone. */
function todayInWholeDays(): string {
  const now = new Date();

  return (
    `${String(now.getFullYear()).padStart(4, '0')}-` +
    `${String(now.getMonth() + 1).padStart(2, '0')}-` +
    `${String(now.getDate()).padStart(2, '0')}`
  );
}

/**
 * What to write, in the words of the kind of leave being asked for.
 *
 * Read off the type's own approval chain rather than off its code, so it stays true for a
 * type HR adds. Compassionate leave's own description already says "say what it is for", and
 * this is the same instruction where somebody is about to type.
 */
function placeholderFor(type: RequestableLeaveType | undefined): string {
  if (type === undefined) {
    return 'What this leave is for';
  }

  /** FR 10. An optional box asks for something rather than demanding it. */
  return type.reasonRequired
    ? `What this leave is for, enough that ${type.approvedBy} can decide on it`
    : `Anything ${type.approvedBy} should know. Leave it blank if there is nothing`;
}

/** A value the address carries: from extending sick leave, or asking for a plan. */
function prefilled(name: 'leaveTypeId' | 'from' | 'to' | 'plan'): string {
  const query = window.location.hash.split('?')[1] ?? '';

  return new URLSearchParams(query).get(name) ?? '';
}
