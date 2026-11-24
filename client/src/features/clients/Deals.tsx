import { useEffect, useId, useState } from 'react';
import {
  answerDealPoc,
  type ClientPage,
  clientsHolders,
  type ClientsNamed,
  type ClientsOfferedProduct,
  changeDeal,
  type Currency,
  DEAL_STAGES,
  type Deal,
  type DealStage,
  type EndReason,
  endReasons,
  isNotSignedIn,
  loseDeal,
  type Money,
  moveDeal,
  offeredProducts,
  openDeal,
  type WaitingOnWhat,
} from '../../api';
import { AddButton, EditButton } from '../../ActionButtons';
import { day, money } from '../../format';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';
import { DealChecklistDialog } from './Checklist';
import { Dialog, DialogFoot, Field, useSending } from './ui';

/**
 * A client's opportunities, which are also called deals: the figures across the top of the client
 * page, the open ones as a table, the ended ones folded away beneath, and opening and editing one.
 * #277, Clients SRS CLI 10 to CLI 17, CLI 75 to CLI 77, CLI 99. Each one's stage, moving it, and
 * whether it will have a POC: #278, CLI 18 to CLI 26.
 *
 * Whatever nobody has said about one, its value, probability or expected close, is said by name,
 * "No value", rather than left blank (CLI 06): an opportunity with no value is a gap somebody can
 * fill, and one that looks complete is not.
 */

/* ------------------------------------------------------------------- the figures */

/**
 * How many are open, what they are worth, and how likely they are to close on average. Values are
 * per currency, never added across: cedis and dollars are two figures side by side (CLI 75, AC
 * L20). Beside each figure, how many open ones it leaves out for want of a value or a
 * probability, so that it cannot be read as complete when it is not (CLI 77).
 *
 * No weighted value here: the user found value times probability says little about one client,
 * since a deal that closes brings in its whole value. The company pipeline and the dashboard
 * still owe CLI 76's weighted total (#289).
 */
export function OpportunityFigures({ deals }: { deals: readonly Deal[] }) {
  const open = deals.filter((deal) => deal.outcome === 'OPEN');
  const valued = open.filter((deal) => deal.value !== null);
  const chances = open.flatMap((deal) => (deal.probability === null ? [] : [deal.probability]));

  return (
    <dl className="clients-figures">
      <div>
        <dt>Open opportunities</dt>
        <dd>
          <span className="clients-figure">{open.length}</span>
        </dd>
      </div>
      <div>
        <dt>Recorded value</dt>
        <dd>
          <Totals totals={totalsOf(valued)} />
          <LeftOut count={open.length - valued.length} what="no value" />
        </dd>
      </div>
      <div>
        <dt>Avg. chance of closing</dt>
        <dd>
          {chances.length === 0 ? (
            <span className="clients-figure is-missing">None yet</span>
          ) : (
            <span className="clients-figure">{averageOf(chances)}%</span>
          )}
          <LeftOut count={open.length - chances.length} what="no probability" />
        </dd>
      </div>
    </dl>
  );
}

/** The mean of whole percentages, to the nearest whole one. */
function averageOf(percentages: readonly number[]): number {
  return Math.round(percentages.reduce((sum, one) => sum + one, 0) / percentages.length);
}

/** What the deals are worth, per currency: cedis first, then dollars, leaving out any not used. */
function totalsOf(deals: readonly Deal[]): Money[] {
  const sums = new Map<Currency, number>();

  for (const deal of deals) {
    if (deal.value !== null) {
      const { currency, amountMinor } = deal.value;
      sums.set(currency, (sums.get(currency) ?? 0) + amountMinor);
    }
  }

  return (['GHS', 'USD'] as const)
    .filter((currency) => sums.has(currency))
    .map((currency) => ({ currency, amountMinor: sums.get(currency) ?? 0 }));
}

/** One figure per currency, side by side, or the word for there being none. */
function Totals({ totals }: { totals: Money[] }) {
  if (totals.length === 0) {
    return <span className="clients-figure is-missing">None yet</span>;
  }

  return (
    <span className="clients-figure-group">
      {totals.map((total) => (
        <span key={total.currency} className="clients-figure">
          {money(total)}
        </span>
      ))}
    </span>
  );
}

/** "2 with no value", where a total leaves any open ones out. */
function LeftOut({ count, what }: { count: number; what: string }) {
  return count === 0 ? null : (
    <span className="clients-figure-note">
      {count} with {what}
    </span>
  );
}

/* ------------------------------------------------------------------ the opportunities */

export function ClientDeals({
  client,
  onChanged,
  onShowActivity,
  onSignedOut,
}: {
  client: ClientPage;
  onChanged: () => void;
  /** Shows the page's Activity section for one deal: its clock button. */
  onShowActivity: (dealId: string) => void;
  onSignedOut: () => void;
}) {
  /* The dialog open: a new one, or one being edited. */
  const [open, setOpen] = useState<{ deal?: Deal } | null>(null);
  /* The deal being moved to another stage, if any. */
  const [moving, setMoving] = useState<Deal | null>(null);
  /* The deal being marked lost, if any. #279. */
  const [losing, setLosing] = useState<Deal | null>(null);
  /* The deal whose checklist is open, if any. #284. */
  const [checking, setChecking] = useState<Deal | null>(null);
  const close = () => {
    setOpen(null);
  };

  const live = client.opportunities.filter((deal) => deal.outcome === 'OPEN');
  const ended = client.opportunities.filter((deal) => deal.outcome !== 'OPEN');

  return (
    <section className="clients-panel" aria-labelledby="clients-deals-heading">
      <header className="clients-panel-head">
        <div>
          <h3 id="clients-deals-heading">Open opportunities</h3>
          {live.length === 0 ? (
            <p className="muted">Nothing is in play with {client.name} right now.</p>
          ) : null}
        </div>
        {client.may.contribute ? (
          <AddButton
            label="New opportunity"
            onClick={() => {
              setOpen({});
            }}
          />
        ) : null}
      </header>

      {live.length === 0 ? null : (
        <DealTable
          deals={live}
          onEdit={(deal) => {
            setOpen({ deal });
          }}
          onMove={setMoving}
          onHistory={(deal) => {
            onShowActivity(deal.id);
          }}
          onChecklist={setChecking}
        />
      )}

      {ended.length === 0 ? null : (
        <details className="clients-ended">
          <summary>
            {ended.length === 1
              ? '1 ended opportunity'
              : `${String(ended.length)} ended opportunities`}
          </summary>
          <DealTable
            deals={ended}
            onEdit={() => undefined}
            onMove={() => undefined}
            onHistory={(deal) => {
              onShowActivity(deal.id);
            }}
            onChecklist={setChecking}
          />
        </details>
      )}

      {checking === null ? null : (
        <DealChecklistDialog
          title={`Checklist for the ${checking.product.name} deal`}
          dealId={checking.id}
          onClose={() => {
            setChecking(null);
          }}
          onSignedOut={onSignedOut}
        />
      )}

      {moving === null ? null : (
        <StageDialog
          deal={moving}
          clientName={client.name}
          onMoved={() => {
            setMoving(null);
            onChanged();
          }}
          onAnswered={onChanged}
          onLose={(deal) => {
            setMoving(null);
            setLosing(deal);
          }}
          onClose={() => {
            setMoving(null);
          }}
          onSignedOut={onSignedOut}
        />
      )}

      {losing === null ? null : (
        <LoseDialog
          deal={losing}
          clientName={client.name}
          onLost={() => {
            setLosing(null);
            onChanged();
          }}
          onClose={() => {
            setLosing(null);
          }}
          onSignedOut={onSignedOut}
        />
      )}

      {open === null ? null : (
        <DealDialog
          client={client}
          deal={open.deal}
          onSaved={() => {
            close();
            onChanged();
          }}
          onClose={close}
          onSignedOut={onSignedOut}
        />
      )}
    </section>
  );
}

/**
 * Opportunities as a table: product, stage, expected close, what it is waiting on, and its value
 * with the probability under it. Its history, stages and values, is open to anybody reading it
 * (#277, #278). Moving and editing are offered where the server says this person may: its owner or
 * a BD manager, while it is open (CLI 13), and moving not while it is in its POC (CLI 24). An ended
 * one says how it ended instead.
 *
 * On a phone each row becomes a card of its own, every cell labelled, since four columns do not
 * fit beside each other there (NFR CLI USA 02).
 */
function DealTable({
  deals,
  onEdit,
  onMove,
  onHistory,
  onChecklist,
}: {
  deals: readonly Deal[];
  onEdit: (deal: Deal) => void;
  onMove: (deal: Deal) => void;
  onHistory: (deal: Deal) => void;
  /** Opens its qualification criteria and pre-POC gates (#284). */
  onChecklist: (deal: Deal) => void;
}) {
  return (
    <table className="clients-deals">
      <thead>
        <tr>
          <th scope="col">Product</th>
          <th scope="col">Stage</th>
          <th scope="col">Waiting on</th>
          <th scope="col" className="is-figure">
            Value
          </th>
          <th scope="col">
            <span className="visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {deals.map((deal) => (
          <tr key={deal.id} className={deal.outcome === 'OPEN' ? undefined : 'is-ended'}>
            <td data-label="Product">
              <strong>{deal.product.name}</strong>
              <small>{deal.product.lineName}</small>
              {deal.statedInterest === null ? null : (
                <small className="clients-deal-interest">“{deal.statedInterest}”</small>
              )}
            </td>
            <td data-label="Stage">
              <StageCell deal={deal} />
            </td>
            <td data-label="Waiting on">
              <WaitingOnCell waiting={deal.waitingOn} />
            </td>
            {/* What it is worth, and under it how likely and when: the three a pipeline asks
                together. Each missing one says so by name (CLI 06). */}
            <td data-label="Value" className="is-figure">
              {deal.value === null ? <NotSet what="No value" /> : <span>{money(deal.value)}</span>}
              <small>
                {deal.probability === null ? (
                  <NotSet what="No probability" />
                ) : (
                  `${String(deal.probability)}%`
                )}
                {' · '}
                {deal.expectedClose === null ? (
                  <NotSet what="No close" />
                ) : (
                  `${deal.expectedClose.half} ${String(deal.expectedClose.year)}`
                )}
              </small>
            </td>
            <td className="clients-deals-actions">
              <span className="clients-deal-buttons">
                {deal.outcome === 'OPEN' ? null : (
                  <span className="tag">
                    {OUTCOME[deal.outcome]}
                    {deal.endedOn === null ? null : ` ${day(deal.endedOn)}`}
                  </span>
                )}
                <button
                  type="button"
                  className="iconic action-icon is-history"
                  title="Activity"
                  onClick={() => {
                    onHistory(deal);
                  }}
                >
                  <Icon name="history" />
                  <span className="visually-hidden">
                    Activity on the {deal.product.name} opportunity
                  </span>
                </button>
                {/* #284. Once it has left Discovery, which is when it is given its checklist. */}
                {deal.stage === 'DISCOVERY' ? null : (
                  <button
                    type="button"
                    className="iconic action-icon is-history"
                    title="Checklist"
                    onClick={() => {
                      onChecklist(deal);
                    }}
                  >
                    <Icon name="checklist" />
                    <span className="visually-hidden">
                      Checklist for the {deal.product.name} opportunity
                    </span>
                  </button>
                )}
                {deal.may.move ? (
                  <button
                    type="button"
                    className="iconic action-icon is-edit"
                    title="Move to another stage"
                    onClick={() => {
                      onMove(deal);
                    }}
                  >
                    <Icon name="stage" />
                    <span className="visually-hidden">
                      Move the {deal.product.name} opportunity to another stage
                    </span>
                  </button>
                ) : null}
                {deal.outcome === 'OPEN' && deal.may.change ? (
                  <EditButton
                    label={`Edit the ${deal.product.name} opportunity`}
                    onClick={() => {
                      onEdit(deal);
                    }}
                  />
                ) : null}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Something nobody has said, in amber and by name (CLI 06): plainly a gap to fill, not a blank
 * and not something somebody wrote.
 */
export function NotSet({ what }: { what: string }) {
  return <span className="clients-not-set">{what}</span>;
}

/** "Paperwork", with the note under it; for "other", the note is what it waits on. */
export function WaitingOnCell({ waiting }: { waiting: Deal['waitingOn'] }) {
  if (waiting === null) {
    return <span className="muted">Nothing</span>;
  }

  const label =
    waiting.on === 'OTHER' && waiting.note !== null
      ? waiting.note
      : (WAITING_ON.find((one) => one.value === waiting.on)?.short ?? waiting.on);
  const note = waiting.on === 'OTHER' ? null : waiting.note;

  return (
    <>
      <span>{label}</span>
      {note === null ? null : <small>{note}</small>}
    </>
  );
}

export const OUTCOME: Record<Deal['outcome'], string> = {
  OPEN: 'Open',
  WON: 'Won',
  LOST: 'Lost',
  EXITED: 'Exited',
};

/** What is holding a deal up: as the form offers it, and as the table names it. CLI 16. */
const WAITING_ON: { value: WaitingOnWhat; label: string; short: string }[] = [
  { value: 'DEMO', label: 'A demo', short: 'Demo' },
  { value: 'PROPOSAL_RESPONSE', label: 'A response to the proposal', short: 'Proposal response' },
  { value: 'PAPERWORK', label: 'Paperwork', short: 'Paperwork' },
  { value: 'SIGNATURE', label: 'A signature', short: 'Signature' },
  { value: 'CLIENT_DECISION', label: 'The client’s decision', short: 'Client decision' },
  { value: 'OTHER', label: 'Something else', short: 'Other' },
];

/* ----------------------------------------------------------------------- its stage */

/** How each stage is named on the screen. */
export const STAGE_NAME: Record<DealStage, string> = {
  DISCOVERY: 'Discovery',
  QUALIFICATION: 'Qualification',
  PROPOSAL: 'Proposal',
  NEGOTIATION: 'Negotiation',
  CONTRACT_SIGNED: 'Contract signed',
  POC: 'POC',
  LIVE: 'Live',
};

/**
 * Where a deal stands: the stage by name, a ladder of seven steps filled up to it, green once won,
 * and under it whether it will have a POC, or that nobody has said (CLI 06, CLI 19). A deal lost
 * or exited says why instead, and any note, so the next person to open the client sees what was
 * tried and why it stopped (CLI 55, #279).
 */
function StageCell({ deal }: { deal: Deal }) {
  const at = DEAL_STAGES.indexOf(deal.stage);

  return (
    <>
      <span>
        {STAGE_NAME[deal.stage]}
        <span className="visually-hidden">
          , stage {at + 1} of {DEAL_STAGES.length}
        </span>
      </span>
      <Ladder deal={deal} />
      {deal.ending === null ? (
        <small>
          {deal.hasPoc === null ? (
            <NotSet what="POC not decided" />
          ) : deal.poc !== null ? (
            <PocLabel poc={deal.poc} />
          ) : deal.hasPoc ? (
            'With a POC'
          ) : (
            'No POC'
          )}
        </small>
      ) : (
        <>
          <small className="clients-deal-reason">
            {OUTCOME[deal.outcome]}: <strong>{deal.ending.reason.label}</strong>
          </small>
          {deal.ending.note === null ? null : (
            <small className="clients-deal-interest">{deal.ending.note}</small>
          )}
        </>
      )}
    </>
  );
}

/**
 * The POC a deal is in, which its contract's signing started (#285): since when, and the day it is
 * to be decided by, opening the POC's page.
 */
function PocLabel({ poc }: { poc: NonNullable<Deal['poc']> }) {
  return (
    <span className="clients-deal-poc">
      <a href={`#/clients/poc/${poc.id}`}>In a POC</a> since {day(poc.startedOn)} · decision by{' '}
      {day(poc.decisionOn)}
    </span>
  );
}

/** Seven short steps filled up to where a deal stands: green once won, grey once lost or exited. */
export function Ladder({ deal }: { deal: Pick<Deal, 'stage' | 'outcome'> }) {
  const at = DEAL_STAGES.indexOf(deal.stage);
  const tone = deal.outcome === 'WON' ? ' is-won' : deal.outcome === 'OPEN' ? '' : ' is-ended';

  return (
    <span className={`clients-ladder${tone}`} aria-hidden="true">
      {DEAL_STAGES.map((stage, step) => (
        <i key={stage} className={step <= at ? 'is-reached' : undefined} />
      ))}
    </span>
  );
}

/**
 * Moving a deal to another stage (CLI 20 to CLI 25), next step first.
 *
 * Most moves are one step forward, so that is the one big button, named for where it goes. Any
 * other stage open to it, back or further on, is behind "Other stage", and a move back asks why
 * (CLI 21). Where it cannot go forward at all, the one thing in the way is said once, in the
 * server's words; which stages are open is the server's answer, so the rules are written once.
 *
 * Whether there will be a POC is at the top, a tap to change until the contract is signed and
 * saved at once, since Contract signed waits on it (CLI 19). Once signed, it is said, not asked.
 */
function StageDialog({
  deal: given,
  clientName,
  onMoved,
  onAnswered,
  onLose,
  onClose,
  onSignedOut,
}: {
  deal: Deal;
  clientName: string;
  onMoved: () => void;
  /** The POC question was answered, so the page behind is out of date. */
  onAnswered: () => void;
  /** Mark it lost instead, as it now stands. #279. */
  onLose: (deal: Deal) => void;
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const [deal, setDeal] = useState(given);
  /* A stage chosen under "Other stage"; null for the next step. */
  const [picked, setPicked] = useState<DealStage | null>(null);
  const [othersOpen, setOthersOpen] = useState(false);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const [answering, setAnswering] = useState(false);
  const [answerProblem, setAnswerProblem] = useState<Problem | undefined>(undefined);
  const sending = useSending(onMoved, onSignedOut);
  const pocLabel = useId();

  /* The server lists every stage in order, so what is after this one is ahead of it. */
  const ahead = deal.moves.slice(DEAL_STAGES.indexOf(deal.stage) + 1);
  const next = ahead.find((option) => option.open);
  const open = deal.moves.filter((option) => option.open);
  const target = open.find((option) => option.stage === picked) ?? next;
  const needsNote = target?.needsNote === true;
  const busy = sending.busy || answering;

  const answer = (hasPoc: boolean) => {
    setAnswering(true);
    setAnswerProblem(undefined);

    answerDealPoc(deal.id, hasPoc)
      .then((now) => {
        setDeal(now);
        /* A stage chosen that the answer has closed is no longer chosen. */
        if (!now.moves.some((option) => option.stage === picked && option.open)) {
          setPicked(null);
        }
        setAnswering(false);
        onAnswered();
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setAnswerProblem(problemFrom(error));
        setAnswering(false);
      });
  };

  return (
    <Dialog title={`Move the ${deal.product.name} deal`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (target !== undefined) {
            sending.send(() => moveDeal(deal.id, target.stage, note));
          }
        }}
      >
        <div className="clients-move-where">
          <Ladder deal={deal} />
          <span>
            At <strong>{STAGE_NAME[deal.stage]}</strong> · {clientName}
          </span>
        </div>

        <div className="clients-move-poc">
          <span id={pocLabel}>Will there be a POC?</span>
          {deal.may.decidePoc ? (
            <PocChoice
              labelledBy={pocLabel}
              value={deal.hasPoc}
              disabled={busy}
              onChange={(hasPoc) => {
                if (hasPoc !== null) answer(hasPoc);
              }}
            />
          ) : (
            <span className="muted">{deal.hasPoc ? 'Yes' : 'No'} · settled at signing</span>
          )}
        </div>
        {answerProblem === undefined ? null : <Notice problem={answerProblem} />}

        {target === undefined ? (
          /* Nowhere to go forward by hand: the one thing in the way, said once. */
          <p className="clients-move-blocked">
            <Icon name="info" />
            <span>{ahead[0]?.why ?? 'This deal has nowhere further to go.'}</span>
          </p>
        ) : (
          <>
            <button
              type="submit"
              className={`primary clients-move-go${target.stage === 'LIVE' ? ' is-win' : ''}`}
              disabled={busy || (needsNote && note.trim() === '')}
            >
              {busy ? 'Moving…' : moveLabel(target.stage, target.needsNote)}
            </button>
            {target.stage === 'LIVE' ? (
              <p className="clients-move-sub">
                Adds {deal.product.name} to what {clientName} uses, from today.
              </p>
            ) : target.stage === 'CONTRACT_SIGNED' && deal.hasPoc === true ? (
              <p className="clients-move-sub">
                Starts the ten week POC today, with {deal.owner.name} as its CS lead.
              </p>
            ) : null}
          </>
        )}

        {open.length > 1 || (open.length === 1 && next === undefined) ? (
          <div className="clients-move-others">
            <button
              type="button"
              className="linkish"
              aria-expanded={othersOpen}
              onClick={() => {
                setOthersOpen(!othersOpen);
              }}
            >
              Other stage {othersOpen ? '▴' : '▾'}
            </button>
            {othersOpen ? (
              <div className="clients-move-chips">
                {open.map((option) => (
                  <button
                    key={option.stage}
                    type="button"
                    aria-pressed={target?.stage === option.stage}
                    disabled={busy}
                    onClick={() => {
                      setPicked(option.stage);
                      if (option.needsNote) setNoting(true);
                    }}
                  >
                    {option.needsNote ? '↩ ' : ''}
                    {STAGE_NAME[option.stage]}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {target === undefined ? null : noting || needsNote ? (
          <Field
            label={needsNote ? 'Why is it going back?' : 'Note'}
            hint={needsNote ? 'Needed to move a deal back. Kept with the move.' : undefined}
            error={sending.errorFor('note')}
          >
            {({ id, describedBy }) => (
              <textarea
                id={id}
                value={note}
                rows={2}
                maxLength={2000}
                autoFocus
                aria-describedby={describedBy}
                onChange={(event) => {
                  setNote(event.target.value);
                }}
              />
            )}
          </Field>
        ) : (
          <button
            type="button"
            className="linkish clients-move-add-note"
            onClick={() => {
              setNoting(true);
            }}
          >
            + Add a note
          </button>
        )}

        <Other problem={sending.other(['note'])} />
        <footer className="clients-dialog-foot">
          {/* Ending it here rather than moving it: any time before its POC starts (CLI 51). */}
          {deal.may.lose ? (
            <button
              type="button"
              className="linkish is-danger clients-move-lose"
              disabled={busy}
              onClick={() => {
                onLose(deal);
              }}
            >
              Mark as lost…
            </button>
          ) : null}
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

/**
 * Marking a deal lost (CLI 51), any time before its POC starts: why, from the lost list the BD
 * manager keeps (CLI 54), and optionally a note. It stays at the stage it reached, which is how
 * far it came, and stays on the client's page with its reason (CLI 55). Re-engaging the client
 * later is a new deal at Discovery (CLI 56), which the sentence under the button says.
 */
function LoseDialog({
  deal,
  clientName,
  onLost,
  onClose,
  onSignedOut,
}: {
  deal: Deal;
  clientName: string;
  onLost: () => void;
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const [reasons, setReasons] = useState<EndReason[] | null>(null);
  const [loadProblem, setLoadProblem] = useState<Problem | undefined>(undefined);
  const [reasonId, setReasonId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const sending = useSending(onLost, onSignedOut);
  const reasonLabel = useId();

  useEffect(() => {
    let current = true;

    endReasons()
      .then((lists) => {
        if (current) setReasons(lists.LOST);
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
    <Dialog title={`Mark the ${deal.product.name} deal lost`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (reasonId !== null) {
            sending.send(() => loseDeal(deal.id, reasonId, note));
          }
        }}
      >
        <div className="clients-move-where">
          <Ladder deal={deal} />
          <span>
            Ends at <strong>{STAGE_NAME[deal.stage]}</strong> · {clientName}
          </span>
        </div>

        <div className="clients-lose-reasons">
          <span id={reasonLabel}>Why was it lost?</span>
          {loadProblem !== undefined ? (
            <Notice problem={loadProblem} />
          ) : reasons === null ? (
            <span className="muted">Loading the reasons…</span>
          ) : reasons.length === 0 ? (
            <span className="muted">
              There are no lost reasons to choose from. A BD manager adds them in Setup.
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

        <Field label="Note" hint="Optional. Kept with the deal." error={sending.errorFor('note')}>
          {({ id, describedBy }) => (
            <textarea
              id={id}
              value={note}
              rows={3}
              maxLength={2000}
              aria-describedby={describedBy}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          )}
        </Field>

        <p className="clients-move-sub">
          It leaves the pipeline and stays on {clientName}’s page with its reason. Taking it up
          again later is a new deal, from Discovery.
        </p>

        <Other problem={sending.other(['reasonId', 'note'])} />
        <footer className="clients-dialog-foot">
          <button type="button" disabled={sending.busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="danger" disabled={sending.busy || reasonId === null}>
            {sending.busy ? 'Marking lost…' : 'Mark as lost'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

/** What the one big button says: where the deal goes, and that Live is a win. */
function moveLabel(stage: DealStage, back: boolean): string {
  if (stage === 'LIVE') return 'Mark as won';

  return back ? `Move back to ${STAGE_NAME[stage]}` : `Move to ${STAGE_NAME[stage]} →`;
}

/**
 * Whether a deal will have a POC, as a choice of two or three side by side (CLI 19). "Not sure
 * yet" is offered where the answer can be taken back, in the deal's own form; the move card saves
 * each tap at once, and asks only yes or no.
 */
function PocChoice({
  labelledBy,
  value,
  disabled,
  allowUnsure = false,
  onChange,
}: {
  labelledBy: string;
  value: boolean | null;
  disabled: boolean;
  allowUnsure?: boolean;
  onChange: (hasPoc: boolean | null) => void;
}) {
  const choices: { value: boolean | null; label: string }[] = [
    { value: true, label: 'Yes' },
    { value: false, label: 'No' },
    ...(allowUnsure ? [{ value: null, label: 'Not sure yet' }] : []),
  ];

  return (
    <div className="clients-choice" role="group" aria-labelledby={labelledBy}>
      {choices.map((one) => (
        <button
          key={one.label}
          type="button"
          aria-pressed={value === one.value}
          disabled={disabled}
          onClick={() => {
            onChange(one.value);
          }}
        >
          {one.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- opening and editing one */

const DEAL_FIELDS = [
  'productId',
  'value',
  'probability',
  'expectedClose',
  'hasPoc',
  'waitingOn',
  'statedInterest',
] as const;

/**
 * Opening a deal, owned by whoever opens it (CLI 12), or editing one (CLI 13). Only the product is
 * needed; anything left empty shows on the deal as missing, for somebody to fill in. An edit sends
 * every field, so emptying one takes it away. A deal's product is chosen once.
 */
function DealDialog({
  client,
  deal,
  onSaved,
  onClose,
  onSignedOut,
}: {
  client: ClientPage;
  /** The deal being edited, or none for a new one. */
  deal?: Deal;
  onSaved: () => void;
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const [products, setProducts] = useState<ClientsOfferedProduct[] | undefined>(undefined);
  const [productId, setProductId] = useState('');
  const [amount, setAmount] = useState(deal?.value == null ? '' : amountAsTyped(deal.value));
  const [currency, setCurrency] = useState<Currency>(deal?.value?.currency ?? 'GHS');
  const [probability, setProbability] = useState(
    deal?.probability == null ? '' : String(deal.probability),
  );
  /* A new deal starts expecting to close in the next half year, which is the likeliest and quick
     to change; an existing one keeps what it has, a gap included, so saving never fills one in. */
  const close = deal === undefined ? nextHalfYear() : deal.expectedClose;
  const [half, setHalf] = useState<'' | 'H1' | 'H2'>(close?.half ?? '');
  const [year, setYear] = useState(close == null ? '' : String(close.year));
  const [hasPoc, setHasPoc] = useState<boolean | null>(deal?.hasPoc ?? null);
  /* A new deal's owner, which a BD manager chooses: whoever looks after the client, to start. */
  const assigns = deal === undefined && client.may.reassign;
  const [people, setPeople] = useState<ClientsNamed[] | undefined>(undefined);
  const [ownerId, setOwnerId] = useState(client.owner.id);
  /* Settled once its contract is signed (CLI 19): shown, not offered. */
  const pocSettled = deal !== undefined && !deal.may.decidePoc;
  const pocLabel = useId();
  const [waitingOn, setWaitingOn] = useState<'' | WaitingOnWhat>(deal?.waitingOn?.on ?? '');
  const [waitingNote, setWaitingNote] = useState(deal?.waitingOn?.note ?? '');
  const [statedInterest, setStatedInterest] = useState(deal?.statedInterest ?? '');
  const sending = useSending(onSaved, onSignedOut);

  useEffect(() => {
    if (deal !== undefined) {
      return;
    }

    offeredProducts()
      .then((found) => {
        /* Not one it has an open deal for already (CLI 11): that one is worked, not doubled. */
        const open = new Set(
          client.opportunities
            .filter((deal) => deal.outcome === 'OPEN')
            .map((deal) => deal.product.id),
        );
        const choosable = found.filter((product) => !open.has(product.id));
        setProducts(choosable);
        setProductId(choosable[0]?.id ?? '');
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) onSignedOut();
      });
  }, [deal, client.opportunities, onSignedOut]);

  useEffect(() => {
    if (!assigns) {
      return;
    }

    clientsHolders()
      .then(setPeople)
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) onSignedOut();
      });
  }, [assigns, onSignedOut]);

  const lines = [...new Set((products ?? []).map((product) => product.lineName))];
  const thisYear = new Date().getFullYear();
  /* The next five years, and the one a deal already has, even if it has slipped past. */
  const years = [
    ...new Set([
      ...(close == null ? [] : [close.year]),
      ...Array.from({ length: 5 }, (_, offset) => thisYear + offset),
    ]),
  ].sort((one, other) => one - other);

  const submit = () => {
    const details = {
      value: amount.trim() === '' ? null : { amount: amount.trim(), currency },
      probability: probability.trim() === '' ? null : Number(probability),
      expectedClose: half === '' ? null : { half, year: year === '' ? thisYear : Number(year) },
      waitingOn: waitingOn === '' ? null : { on: waitingOn, note: waitingNote },
      statedInterest,
      /* Not sent once settled, so saving a signed deal never touches it. */
      ...(pocSettled ? {} : { hasPoc }),
    };

    sending.send(() =>
      deal === undefined
        ? openDeal({
            clientId: client.id,
            productId,
            ...details,
            /* Only a BD manager names an owner; anybody else owns what they open. */
            ...(assigns ? { ownerId } : {}),
          })
        : changeDeal(deal.id, details),
    );
  };

  return (
    <Dialog
      title={
        deal === undefined
          ? `New deal with ${client.name}`
          : `The ${deal.product.name} deal with ${client.name}`
      }
      intro={deal === undefined ? undefined : 'Anything left empty shows as missing.'}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {deal !== undefined ? null : products !== undefined && products.length === 0 ? (
          <p className="muted">
            {client.name} has an open deal for every product on offer. Work on those, or end one
            before starting another.
          </p>
        ) : (
          <Field label="Product" error={sending.errorFor('productId')}>
            {({ id, describedBy }) => (
              <select
                id={id}
                value={productId}
                autoFocus
                aria-describedby={describedBy}
                disabled={sending.busy || products === undefined}
                onChange={(event) => {
                  setProductId(event.target.value);
                }}
              >
                {lines.map((line) => (
                  <optgroup key={line} label={line}>
                    {(products ?? [])
                      .filter((product) => product.lineName === line)
                      .map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            )}
          </Field>
        )}

        {assigns ? (
          <Field label="Assign to" error={sending.errorFor('ownerId')}>
            {({ id, describedBy }) => (
              <select
                id={id}
                value={ownerId}
                aria-describedby={describedBy}
                disabled={sending.busy || people === undefined}
                onChange={(event) => {
                  setOwnerId(event.target.value);
                }}
              >
                {(people ?? [client.owner]).map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}

        <div className="clients-field-row is-money">
          <Field label="Value" error={sending.errorFor('value')}>
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

          <Field label="Chance of closing" error={sending.errorFor('probability')}>
            {({ id, describedBy }) => (
              <span className="clients-deal-percent">
                <input
                  id={id}
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={probability}
                  placeholder="0–100"
                  aria-describedby={describedBy}
                  disabled={sending.busy}
                  onChange={(event) => {
                    setProbability(event.target.value);
                  }}
                />
                <span aria-hidden="true">%</span>
              </span>
            )}
          </Field>
        </div>

        <p className="clients-field-group">Expected to close</p>
        <div className="clients-field-row">
          <Field label="Half" error={sending.errorFor('expectedClose')}>
            {({ id, describedBy }) => (
              <select
                id={id}
                aria-describedby={describedBy}
                value={half}
                disabled={sending.busy}
                onChange={(event) => {
                  const chosen = event.target.value as '' | 'H1' | 'H2';
                  setHalf(chosen);
                  if (chosen !== '' && year === '') setYear(String(thisYear));
                }}
              >
                <option value="">Not known yet</option>
                <option value="H1">H1</option>
                <option value="H2">H2</option>
              </select>
            )}
          </Field>
          <Field label="Year">
            {({ id, describedBy }) => (
              <select
                id={id}
                aria-describedby={describedBy}
                value={half === '' ? '' : year}
                disabled={sending.busy || half === ''}
                onChange={(event) => {
                  setYear(event.target.value);
                }}
              >
                {half === '' ? <option value="">—</option> : null}
                {years.map((one) => (
                  <option key={one} value={String(one)}>
                    {one}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>

        <div className="clients-field">
          <span id={pocLabel} className="clients-field-label">
            Will there be a POC?
          </span>
          {pocSettled ? (
            <p className="muted clients-field-static">
              {deal?.hasPoc === true ? 'Yes' : 'No'} · settled when the contract was signed
            </p>
          ) : (
            <PocChoice
              labelledBy={pocLabel}
              value={hasPoc}
              disabled={sending.busy}
              allowUnsure
              onChange={setHasPoc}
            />
          )}
          {sending.errorFor('hasPoc') === undefined ? null : (
            <p className="clients-field-error" role="alert">
              {sending.errorFor('hasPoc')}
            </p>
          )}
        </div>

        <Field label="Waiting on" error={sending.errorFor('waitingOn')}>
          {({ id, describedBy }) => (
            <select
              id={id}
              value={waitingOn}
              aria-describedby={describedBy}
              disabled={sending.busy}
              onChange={(event) => {
                setWaitingOn(event.target.value as '' | WaitingOnWhat);
              }}
            >
              <option value="">Nothing</option>
              {WAITING_ON.map((one) => (
                <option key={one.value} value={one.value}>
                  {one.label}
                </option>
              ))}
            </select>
          )}
        </Field>

        {waitingOn === '' ? null : (
          <Field label={waitingOn === 'OTHER' ? 'What it is waiting on' : 'More about it'}>
            {({ id, describedBy }) => (
              <input
                id={id}
                value={waitingNote}
                maxLength={2000}
                autoComplete="off"
                aria-describedby={describedBy}
                disabled={sending.busy}
                onChange={(event) => {
                  setWaitingNote(event.target.value);
                }}
              />
            )}
          </Field>
        )}

        <Field
          label="Stated interest"
          hint="What the client said they want, in their own words."
          error={sending.errorFor('statedInterest')}
        >
          {({ id, describedBy }) => (
            <textarea
              id={id}
              value={statedInterest}
              rows={3}
              maxLength={2000}
              aria-describedby={describedBy}
              disabled={sending.busy}
              onChange={(event) => {
                setStatedInterest(event.target.value);
              }}
            />
          )}
        </Field>

        <Other problem={sending.other(DEAL_FIELDS)} />
        <DialogFoot
          busy={sending.busy}
          disabled={
            (deal === undefined && productId === '') ||
            (waitingOn === 'OTHER' && waitingNote.trim() === '')
          }
          doing={deal === undefined ? 'Opening…' : 'Saving…'}
          done={deal === undefined ? 'Open deal' : 'Save'}
          onCancel={onClose}
        />
      </form>
    </Dialog>
  );
}

/** The half year after the one today is in: in November 2026, H1 2027. */
function nextHalfYear(): { half: 'H1' | 'H2'; year: number } {
  const today = new Date();

  return today.getMonth() < 6
    ? { half: 'H2', year: today.getFullYear() }
    : { half: 'H1', year: today.getFullYear() + 1 };
}

/** An amount as somebody would type it back: "75600", or "125000.50" where there are pesewas. */
export function amountAsTyped(value: { amountMinor: number }): string {
  return value.amountMinor % 100 === 0
    ? String(value.amountMinor / 100)
    : (value.amountMinor / 100).toFixed(2);
}

/** A refusal about no field on the form, across its foot. */
function Other({ problem }: { problem: Problem | undefined }) {
  return problem === undefined ? null : <Notice problem={problem} />;
}
