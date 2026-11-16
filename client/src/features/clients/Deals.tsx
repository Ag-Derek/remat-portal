import { useEffect, useState } from 'react';
import {
  type ClientPage,
  type ClientsOfferedProduct,
  changeDeal,
  type Currency,
  type Deal,
  dealHistory,
  type DealValueChange,
  isNotSignedIn,
  type Money,
  offeredProducts,
  openDeal,
  type WaitingOnWhat,
} from '../../api';
import { AddButton, EditButton } from '../../ActionButtons';
import { moment, money } from '../../format';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';
import { Dialog, DialogFoot, Field, useSending } from './ui';

/**
 * A client's opportunities, which are also called deals: the figures across the top of the client
 * page, the open ones as a table, the ended ones folded away beneath, and opening and editing one.
 * #277, Clients SRS CLI 10 to CLI 17, CLI 75 to CLI 77, CLI 99.
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
  onSignedOut,
}: {
  client: ClientPage;
  onChanged: () => void;
  onSignedOut: () => void;
}) {
  /* The dialog open: a new one, or one being edited. */
  const [open, setOpen] = useState<{ deal?: Deal } | null>(null);
  /* The deal whose past values are showing, if any. */
  const [history, setHistory] = useState<Deal | null>(null);
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
          <p className="muted">{summaryOf(live, client.name)}</p>
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
          onHistory={setHistory}
        />
      )}

      {ended.length === 0 ? null : (
        <details className="clients-ended">
          <summary>
            {ended.length === 1
              ? '1 ended opportunity'
              : `${String(ended.length)} ended opportunities`}
          </summary>
          <DealTable deals={ended} onEdit={() => undefined} onHistory={setHistory} />
        </details>
      )}

      {history === null ? null : (
        <HistoryDialog
          deal={history}
          onClose={() => {
            setHistory(null);
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

/** "Four products in play: CreditStudio, Cloud9, …", or that there are none. */
function summaryOf(live: readonly Deal[], clientName: string): string {
  if (live.length === 0) {
    return `Nothing is in play with ${clientName} right now.`;
  }

  const products = live.map((deal) => deal.product.name).join(', ');

  return live.length === 1
    ? `One product in play: ${products}.`
    : `${String(live.length)} products in play: ${products}.`;
}

/**
 * Opportunities as a table: product, expected close, what it is waiting on, and its value with
 * the probability under it. Its past values are open to anybody reading it (#277). Edit is offered
 * where the server says this person may: its owner or a BD manager, while it is open (CLI 13). An
 * ended one says how it ended instead.
 *
 * On a phone each row becomes a card of its own, every cell labelled, since four columns do not
 * fit beside each other there (NFR CLI USA 02).
 */
function DealTable({
  deals,
  onEdit,
  onHistory,
}: {
  deals: readonly Deal[];
  onEdit: (deal: Deal) => void;
  onHistory: (deal: Deal) => void;
}) {
  return (
    <table className="clients-deals">
      <thead>
        <tr>
          <th scope="col">Product</th>
          <th scope="col">Expected close</th>
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
              <small>
                {deal.product.lineName} · {deal.owner.name}
              </small>
              {deal.statedInterest === null ? null : (
                <small className="clients-deal-interest">“{deal.statedInterest}”</small>
              )}
            </td>
            <td data-label="Expected close">
              {deal.expectedClose === null ? (
                <NotSet what="Not set" />
              ) : (
                `${deal.expectedClose.half} ${String(deal.expectedClose.year)}`
              )}
            </td>
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
            <td className="clients-deals-actions">
              <span className="clients-deal-buttons">
                {deal.outcome === 'OPEN' ? null : (
                  <span className="tag">{OUTCOME[deal.outcome]}</span>
                )}
                <button
                  type="button"
                  className="iconic action-icon is-history"
                  title="Past values"
                  onClick={() => {
                    onHistory(deal);
                  }}
                >
                  <Icon name="history" />
                  <span className="visually-hidden">
                    Past values of the {deal.product.name} opportunity
                  </span>
                </button>
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
function NotSet({ what }: { what: string }) {
  return <span className="clients-not-set">{what}</span>;
}

/** "Paperwork", with the note under it; for "other", the note is what it waits on. */
function WaitingOnCell({ waiting }: { waiting: Deal['waitingOn'] }) {
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

const OUTCOME: Record<Deal['outcome'], string> = {
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

/* ------------------------------------------------------------------ its past values */

/**
 * What a deal was worth and how likely to close, each time either changed, newest first, with who
 * changed it and when (#277). The oldest is what it was opened with. Whatever changed at each step
 * is the darker figure, so the eye finds what moved.
 */
function HistoryDialog({
  deal,
  onClose,
  onSignedOut,
}: {
  deal: Deal;
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const [history, setHistory] = useState<DealValueChange[] | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);

  useEffect(() => {
    dealHistory(deal.id)
      .then(setHistory)
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setProblem(problemFrom(error));
      });
  }, [deal.id, onSignedOut]);

  return (
    <Dialog
      title={`Past values: ${deal.product.name}`}
      intro="Its value and chance of closing each time either changed, newest first."
      onClose={onClose}
    >
      {problem === undefined ? null : <Notice problem={problem} />}
      {history === undefined ? null : (
        <ol className="clients-history">
          {history.map((change, at) => {
            /* The one before it in time, which is the next one down the list. */
            const before = history[at + 1];
            const valueMoved = before === undefined || !sameMoney(before.value, change.value);
            const chanceMoved = before === undefined || before.probability !== change.probability;

            return (
              <li key={`${change.changedAt}-${String(at)}`}>
                <div className="clients-history-figures">
                  <span className={valueMoved ? 'is-moved' : undefined}>
                    {change.value === null ? <NotSet what="No value" /> : money(change.value)}
                  </span>
                  <span className={chanceMoved ? 'is-moved' : undefined}>
                    {change.probability === null ? (
                      <NotSet what="No probability" />
                    ) : (
                      `${String(change.probability)}%`
                    )}
                  </span>
                  {at === 0 ? <span className="tag">Now</span> : null}
                </div>
                <small>
                  {before === undefined ? 'Opened' : 'Changed'} by {change.changedBy.name}
                  {SOURCE[change.source]} · {moment(change.changedAt)}
                </small>
              </li>
            );
          })}
        </ol>
      )}
      <footer className="clients-dialog-foot">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </footer>
    </Dialog>
  );
}

/** How a change came about, where it was not somebody editing the deal. */
const SOURCE: Record<DealValueChange['source'], string> = {
  MANUAL: '',
  PROPOSAL: ', from a proposal',
  CONVERSION: ', on its POC converting',
  IMPORT: ', from the workbooks',
};

function sameMoney(one: Money | null, other: Money | null): boolean {
  return (
    one?.amountMinor === other?.amountMinor && (one?.currency ?? null) === (other?.currency ?? null)
  );
}

/* ------------------------------------------------------------- opening and editing one */

const DEAL_FIELDS = [
  'productId',
  'value',
  'probability',
  'expectedClose',
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
  const [half, setHalf] = useState<'' | 'H1' | 'H2'>(deal?.expectedClose?.half ?? '');
  const [year, setYear] = useState(
    deal?.expectedClose == null ? '' : String(deal.expectedClose.year),
  );
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

  const lines = [...new Set((products ?? []).map((product) => product.lineName))];
  const thisYear = new Date().getFullYear();
  /* The next five years, and the one a deal already has, even if it has slipped past. */
  const years = [
    ...new Set([
      ...(deal?.expectedClose == null ? [] : [deal.expectedClose.year]),
      ...Array.from({ length: 5 }, (_, offset) => thisYear + offset),
    ]),
  ].sort((one, other) => one - other);

  const submit = () => {
    const details = {
      value: amount.trim() === '' ? null : { amount: amount.trim(), currency },
      probability: probability.trim() === '' ? null : Number(probability),
      expectedClose:
        half === '' && year === '' ? null : { half, year: year === '' ? null : Number(year) },
      waitingOn: waitingOn === '' ? null : { on: waitingOn, note: waitingNote },
      statedInterest,
    };

    sending.send(() =>
      deal === undefined
        ? openDeal({ clientId: client.id, productId, ...details })
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
      intro={
        deal === undefined
          ? 'You will own it. Only the product is needed: anything left empty shows on the deal as missing, for somebody to fill in.'
          : 'Anything left empty shows on the deal as missing, for somebody to fill in.'
      }
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

        <Field
          label="Value"
          hint="Optional. Cedis or dollars, with at most two figures after the point."
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

        <Field
          label="Probability of closing, %"
          hint="Optional. A whole number from 0 to 100."
          error={sending.errorFor('probability')}
        >
          {({ id, describedBy }) => (
            <input
              id={id}
              type="number"
              min={0}
              max={100}
              step={1}
              value={probability}
              aria-describedby={describedBy}
              disabled={sending.busy}
              onChange={(event) => {
                setProbability(event.target.value);
              }}
            />
          )}
        </Field>

        <Field
          label="Expected to close"
          hint="Optional. H1 is January to June, H2 July to December."
          error={sending.errorFor('expectedClose')}
        >
          {({ id, describedBy }) => (
            <span className="clients-deal-close">
              <select
                id={id}
                aria-label="Half"
                aria-describedby={describedBy}
                value={half}
                disabled={sending.busy}
                onChange={(event) => {
                  setHalf(event.target.value as '' | 'H1' | 'H2');
                }}
              >
                <option value="">Half</option>
                <option value="H1">H1</option>
                <option value="H2">H2</option>
              </select>
              <select
                aria-label="Year"
                value={year}
                disabled={sending.busy}
                onChange={(event) => {
                  setYear(event.target.value);
                }}
              >
                <option value="">Year</option>
                {years.map((one) => (
                  <option key={one} value={String(one)}>
                    {one}
                  </option>
                ))}
              </select>
            </span>
          )}
        </Field>

        <Field
          label="Waiting on"
          hint="Optional. What is holding it up today."
          error={sending.errorFor('waitingOn')}
        >
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
          <Field
            label={waitingOn === 'OTHER' ? 'What it is waiting on' : 'More about it'}
            hint={waitingOn === 'OTHER' ? undefined : 'Optional.'}
          >
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
          hint="Optional. What the client said they want, in their own words."
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

/** An amount as somebody would type it back: "75600", or "125000.50" where there are pesewas. */
function amountAsTyped(value: { amountMinor: number }): string {
  return value.amountMinor % 100 === 0
    ? String(value.amountMinor / 100)
    : (value.amountMinor / 100).toFixed(2);
}

/** A refusal about no field on the form, across its foot. */
function Other({ problem }: { problem: Problem | undefined }) {
  return problem === undefined ? null : <Notice problem={problem} />;
}
