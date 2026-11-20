import { useEffect, useId, useState } from 'react';
import {
  type ActivityKind,
  addNextStep,
  attachToActivity,
  type ClientActivityEntry,
  type ClientPage,
  clientPage,
  clientsHolders,
  clientsList,
  type ClientsNamed,
  type ClientSummary,
  correctActivity,
  type Currency,
  DOCUMENT_ACCEPT,
  documentDownloadPath,
  isNotSignedIn,
  logActivity,
  type NextStepDetails,
  type PastProposal,
  pastProposals,
} from '../../api';
import { day, money } from '../../format';
import { Icon, type IconName } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';
import { amountAsTyped, OUTCOME } from './Deals';
import { Dialog, DialogFoot, Field, useSending } from './ui';

/**
 * Logging a call, meeting, demo, proposal, financials or note with a client, and what happens next,
 * on one screen and in under a minute (NFR CLI USA 01). #280, Clients SRS CLI 58 to CLI 63. A
 * proposal and the financials need the deal they were sent on, and the financials their amount,
 * which becomes the deal's value (CLI 65, #281).
 *
 * Built for speed: the kind is one tap on a tile, the day starts at today with yesterday a tap
 * away, the client's contacts are chips that fill in who it was with, and a next step's day has
 * chips for the usual gaps. Only the kind and the day are needed. Writing what happens next adds
 * a next step, by default the client owner's; left blank, there is none.
 *
 * The same form corrects an activity within its 24 hours (CLI 62), without the next step, which
 * is closed or reopened on the Next steps card instead.
 */

type LoggedEntry = Extract<ClientActivityEntry, { kind: 'LOGGED' }>;

const KINDS: { value: ActivityKind; label: string; icon: IconName }[] = [
  { value: 'CALL', label: 'Call', icon: 'phone' },
  { value: 'MEETING', label: 'Meeting', icon: 'people' },
  { value: 'DEMO', label: 'Demo', icon: 'eye' },
  { value: 'PROPOSAL', label: 'Proposal', icon: 'send' },
  { value: 'FINANCIALS', label: 'Financials', icon: 'report' },
  { value: 'NOTE', label: 'Note', icon: 'pencil' },
];

/** Today, as a date input wants it. Accra is UTC all year, so the UTC day is the company's. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The day `days` from today. */
function daysFromToday(days: number): string {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + days);

  return day.toISOString().slice(0, 10);
}

export function LogActivityDialog({
  client,
  dealId = null,
  correcting,
  onSaved,
  onClose,
  onSignedOut,
}: {
  client: ClientPage;
  /** A deal to start it about, where it was opened from one. */
  dealId?: string | null;
  /** The activity being corrected, or none to log a new one. */
  correcting?: LoggedEntry;
  onSaved: () => void;
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const [kind, setKind] = useState<ActivityKind>(correcting?.activityKind ?? 'CALL');
  const [happenedOn, setHappenedOn] = useState(correcting?.happenedOn ?? today());
  const [deal, setDeal] = useState(correcting?.deal?.id ?? dealId ?? '');
  const [withWhom, setWithWhom] = useState(correcting?.withWhom ?? '');
  const [outcome, setOutcome] = useState(correcting?.outcome ?? '');
  const [amount, setAmount] = useState(
    correcting?.amount == null ? '' : amountAsTyped(correcting.amount),
  );
  const [currency, setCurrency] = useState<Currency>(correcting?.amount?.currency ?? 'GHS');
  const [step, setStep] = useState<StepState>(blankStep(client));
  /* Files to attach once it is logged, and the activity once it has been (#281). */
  const [files, setFiles] = useState<File[]>([]);
  const [loggedId, setLoggedId] = useState<string | null>(null);
  const sending = useSending(onSaved, onSignedOut);
  const kindLabel = useId();
  /** Sent to the client on one of its deals, which it must then name (#281). */
  const sent = kind === 'PROPOSAL' || kind === 'FINANCIALS';
  const financials = kind === 'FINANCIALS';

  const fields = [
    'kind',
    'happenedOn',
    'opportunityId',
    'withWhom',
    'outcome',
    'amount',
    'file',
    'filename',
  ];
  const stepFields = ['nextStep.description', 'nextStep.dueOn', 'nextStep.ownerId'];
  const other = sending.other([...fields, ...stepFields]);
  const asksAStep = correcting === undefined && step.description.trim() !== '';

  const people = client.contacts
    .filter((contact) => contact.removedAt === null)
    .map((contact) =>
      contact.jobTitle === null ? contact.name : `${contact.name} (${contact.jobTitle})`,
    );

  return (
    <Dialog
      title={correcting === undefined ? 'Log activity' : 'Correct activity'}
      intro={
        correcting === undefined
          ? financials
            ? `With ${client.name}. The financials need when, the deal and the amount.`
            : sent
              ? `With ${client.name}. A proposal needs when and the deal it is for.`
              : `With ${client.name}. Only what it was and when are needed.`
          : 'You can correct this for 24 hours after logging it.'
      }
      wide
      onClose={onClose}
    >
      <form
        className="clients-log"
        onSubmit={(event) => {
          event.preventDefault();
          const activity = {
            opportunityId: deal === '' ? null : deal,
            kind,
            happenedOn,
            withWhom: withWhom.trim() === '' ? null : withWhom,
            outcome: outcome.trim() === '' ? null : outcome,
            ...(financials ? { amount: { amount: amount.trim(), currency } } : {}),
          };

          sending.send(async () => {
            if (correcting !== undefined) {
              await correctActivity(correcting.id, activity);
              return;
            }

            /* Logged once: where a file then fails, sending again attaches what is left rather
               than logging the activity a second time. #281. */
            const id =
              loggedId ??
              (await logActivity(client.id, activity, asksAStep ? stepDetails(step, client) : null))
                .activity.id;
            setLoggedId(id);

            for (const file of files) {
              await attachToActivity(id, file);
              setFiles((left) => left.filter((one) => one !== file));
            }
          });
        }}
      >
        {/* ------------------------------------------------------------ what it was */}

        <div className="clients-field">
          <span id={kindLabel} className="clients-field-label">
            What was it?
          </span>
          <div className="clients-kind-tiles" role="group" aria-labelledby={kindLabel}>
            {KINDS.map((one) => (
              <button
                key={one.value}
                type="button"
                className="clients-kind-tile"
                aria-pressed={kind === one.value}
                disabled={sending.busy}
                onClick={() => {
                  setKind(one.value);
                }}
              >
                <Icon name={one.icon} />
                <span>{one.label}</span>
              </button>
            ))}
          </div>
          {sending.errorFor('kind') === undefined ? null : (
            <p className="clients-field-error" role="alert">
              {sending.errorFor('kind')}
            </p>
          )}
        </div>

        {/* ------------------------------------------------------ when, and about */}

        <div className="clients-field-row">
          <Field label="When" error={sending.errorFor('happenedOn')}>
            {({ id, describedBy }) => (
              <>
                <input
                  id={id}
                  type="date"
                  value={happenedOn}
                  max={today()}
                  required
                  aria-describedby={describedBy}
                  disabled={sending.busy}
                  onChange={(event) => {
                    setHappenedOn(event.target.value);
                  }}
                />
                <QuickDays
                  value={happenedOn}
                  days={[
                    { label: 'Today', on: today() },
                    { label: 'Yesterday', on: daysFromToday(-1) },
                  ]}
                  disabled={sending.busy}
                  onPick={setHappenedOn}
                />
              </>
            )}
          </Field>

          <Field label={sent ? 'For the deal' : 'About'} error={sending.errorFor('opportunityId')}>
            {({ id, describedBy }) => (
              <DealPicker
                id={id}
                describedBy={describedBy}
                client={client}
                value={deal}
                disabled={sending.busy}
                onChange={setDeal}
              />
            )}
          </Field>
        </div>

        {/* --------------------------------------------- what the financials gave, #281 */}

        {financials ? (
          <Field
            label="Amount"
            hint="Becomes the deal's value. What it was before is kept in its history."
            error={sending.errorFor('amount')}
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
                  placeholder="75600"
                  autoComplete="off"
                  required
                  aria-describedby={describedBy}
                  disabled={sending.busy}
                  onChange={(event) => {
                    setAmount(event.target.value);
                  }}
                />
              </span>
            )}
          </Field>
        ) : null}

        {/* ------------------------------------------------------------- with whom */}

        <Field label={sent ? 'Sent to' : 'With'} error={sending.errorFor('withWhom')}>
          {({ id, describedBy }) => (
            <>
              <input
                id={id}
                value={withWhom}
                maxLength={200}
                autoComplete="off"
                placeholder={people[0] ?? 'Who was there'}
                aria-describedby={describedBy}
                disabled={sending.busy}
                onChange={(event) => {
                  setWithWhom(event.target.value);
                }}
              />
              {people.length === 0 ? null : (
                <div className="clients-chips" aria-label={`${client.name}'s contacts`}>
                  {people.map((person) => {
                    const named = namedIn(withWhom, person);

                    return (
                      <button
                        key={person}
                        type="button"
                        className="clients-chip"
                        aria-pressed={named}
                        disabled={sending.busy}
                        onClick={() => {
                          setWithWhom(
                            named ? without(withWhom, person) : alsoWith(withWhom, person),
                          );
                        }}
                      >
                        {named ? <Icon name="tick" /> : <Icon name="plus" />}
                        {person}
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </Field>

        {/* -------------------------------------------------------- what came of it */}

        <Field label="What came of it" error={sending.errorFor('outcome')}>
          {({ id, describedBy }) => (
            <textarea
              id={id}
              value={outcome}
              rows={3}
              maxLength={4000}
              placeholder="What was agreed, what they asked for, what is in the way"
              aria-describedby={describedBy}
              disabled={sending.busy}
              onChange={(event) => {
                setOutcome(event.target.value);
              }}
            />
          )}
        </Field>

        {/* ------------------------------------------------------- its files, #281 */}

        {correcting === undefined ? (
          <Field
            label={sent ? (financials ? 'The financials' : 'The proposal') : 'Files'}
            hint={
              loggedId === null
                ? 'Optional. PDF, Word, Excel, PowerPoint, PNG or JPG, up to 50 MB each.'
                : 'It is logged. Saving again attaches what is left here.'
            }
            error={sending.errorFor('file') ?? sending.errorFor('filename')}
          >
            {({ id, describedBy }) => (
              <input
                id={id}
                type="file"
                multiple
                accept={DOCUMENT_ACCEPT}
                aria-describedby={describedBy}
                disabled={sending.busy}
                onChange={(event) => {
                  setFiles(Array.from(event.target.files ?? []));
                }}
              />
            )}
          </Field>
        ) : null}

        {/* ------------------------------------------------------------- next step */}

        {correcting === undefined && loggedId === null ? (
          <fieldset className={`clients-step-card${asksAStep ? ' is-set' : ''}`}>
            <legend>
              <span className="clients-step-card-icon" aria-hidden="true">
                <Icon name="send" />
              </span>
              Next step
              <span className="clients-step-card-optional">Optional</span>
            </legend>
            <NextStepFields
              client={client}
              value={step}
              onChange={setStep}
              busy={sending.busy}
              errorFor={(name) => sending.errorFor(`nextStep.${name}`)}
              optional
              onSignedOut={onSignedOut}
            />
          </fieldset>
        ) : null}

        {other === undefined ? null : <Notice problem={other} />}

        <DialogFoot
          busy={sending.busy}
          disabled={
            happenedOn === '' ||
            (asksAStep && step.dueOn === '') ||
            (sent && deal === '') ||
            (financials && amount.trim() === '')
          }
          doing="Saving…"
          done={
            correcting !== undefined
              ? 'Save'
              : loggedId !== null
                ? 'Attach the files'
                : asksAStep
                  ? 'Log it, with its next step'
                  : 'Log it'
          }
          onCancel={onClose}
        />
      </form>
    </Dialog>
  );
}

/** Adding a next step on its own, about the client or one of its deals (CLI 63). */
export function NextStepDialog({
  client,
  onSaved,
  onClose,
  onSignedOut,
}: {
  client: ClientPage;
  onSaved: () => void;
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const [step, setStep] = useState<StepState>(blankStep(client));
  const [deal, setDeal] = useState('');
  const sending = useSending(onSaved, onSignedOut);
  const other = sending.other(['description', 'dueOn', 'ownerId', 'opportunityId']);

  return (
    <Dialog
      title="Next step"
      intro={`With ${client.name}: what happens next, by when, and whose it is.`}
      wide
      onClose={onClose}
    >
      <form
        className="clients-log"
        onSubmit={(event) => {
          event.preventDefault();
          sending.send(() =>
            addNextStep(client.id, deal === '' ? null : deal, stepDetails(step, client)),
          );
        }}
      >
        <NextStepFields
          client={client}
          value={step}
          onChange={setStep}
          busy={sending.busy}
          errorFor={sending.errorFor}
          onSignedOut={onSignedOut}
        />

        <Field label="About" error={sending.errorFor('opportunityId')}>
          {({ id, describedBy }) => (
            <DealPicker
              id={id}
              describedBy={describedBy}
              client={client}
              value={deal}
              disabled={sending.busy}
              onChange={setDeal}
            />
          )}
        </Field>

        {other === undefined ? null : <Notice problem={other} />}

        <DialogFoot
          busy={sending.busy}
          disabled={step.description.trim() === '' || step.dueOn === ''}
          doing="Adding…"
          done="Add next step"
          onCancel={onClose}
        />
      </form>
    </Dialog>
  );
}

/* ----------------------------------------------------------------------- the pieces */

/** The client generally, or one of its deals, open or ended. */
function DealPicker({
  id,
  describedBy,
  client,
  value,
  disabled,
  onChange,
}: {
  id: string;
  describedBy: string | undefined;
  client: ClientPage;
  value: string;
  disabled: boolean;
  onChange: (dealId: string) => void;
}) {
  return (
    <select
      id={id}
      value={value}
      aria-describedby={describedBy}
      disabled={disabled}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    >
      <option value="">The client generally</option>
      {client.opportunities.map((one) => (
        <option key={one.id} value={one.id}>
          {one.product.name}
          {one.outcome === 'OPEN' ? '' : ` · ${OUTCOME[one.outcome]}`}
        </option>
      ))}
    </select>
  );
}

/** A few days as chips under a date, the one chosen pressed. */
function QuickDays({
  value,
  days,
  disabled,
  onPick,
}: {
  value: string;
  days: { label: string; on: string }[];
  disabled: boolean;
  onPick: (day: string) => void;
}) {
  return (
    <div className="clients-chips is-quiet">
      {days.map((one) => (
        <button
          key={one.label}
          type="button"
          className="clients-chip"
          aria-pressed={value === one.on}
          disabled={disabled}
          onClick={() => {
            onPick(one.on);
          }}
        >
          {one.label}
        </button>
      ))}
    </div>
  );
}

/** Whether `person` is already among who it was with. */
function namedIn(withWhom: string, person: string): boolean {
  return partsOf(withWhom).includes(person);
}

function alsoWith(withWhom: string, person: string): string {
  return [...partsOf(withWhom), person].join(', ');
}

function without(withWhom: string, person: string): string {
  return partsOf(withWhom)
    .filter((part) => part !== person)
    .join(', ');
}

function partsOf(withWhom: string): string[] {
  return withWhom
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/* --------------------------------------------------------------- the step's own fields */

interface StepState {
  description: string;
  dueOn: string;
  /** Whose it is; the client's owner to start with. */
  ownerId: string;
}

function blankStep(client: ClientPage): StepState {
  return { description: '', dueOn: '', ownerId: client.owner.id };
}

/** What a form sends: whose left out where it is still the client owner's, the default. */
function stepDetails(step: StepState, client: ClientPage): NextStepDetails {
  return {
    description: step.description,
    dueOn: step.dueOn,
    ...(step.ownerId === client.owner.id ? {} : { ownerId: step.ownerId }),
  };
}

/**
 * What happens next, by when, and whose: whose chosen from everybody holding a clients role, who
 * can see it and close it. Anybody else is named in what happens next.
 */
function NextStepFields({
  client,
  value,
  onChange,
  busy,
  errorFor,
  optional = false,
  onSignedOut,
}: {
  client: ClientPage;
  value: StepState;
  onChange: (step: StepState) => void;
  busy: boolean;
  errorFor: (name: string) => string | undefined;
  /** Left blank for none, as when logging an activity. */
  optional?: boolean;
  onSignedOut: () => void;
}) {
  const [holders, setHolders] = useState<ClientsNamed[] | undefined>(undefined);

  useEffect(() => {
    clientsHolders()
      .then(setHolders)
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        /* The client's owner is still offered, and is the default. */
        setHolders([]);
      });
  }, [onSignedOut]);

  /* The client's owner first, whether or not the list has come back yet. */
  const people = [
    client.owner,
    ...(holders ?? []).filter((person) => person.id !== client.owner.id),
  ];

  return (
    <>
      <Field
        label="What happens next"
        hint={
          optional
            ? 'Leave it blank if nothing is planned. Somebody outside the team? Name them here.'
            : 'Somebody outside the team? Name them here.'
        }
        error={errorFor('description')}
      >
        {({ id, describedBy }) => (
          <input
            id={id}
            value={value.description}
            maxLength={300}
            autoComplete="off"
            placeholder="Send the revised proposal"
            aria-describedby={describedBy}
            disabled={busy}
            onChange={(event) => {
              onChange({ ...value, description: event.target.value });
            }}
          />
        )}
      </Field>

      <div className="clients-field-row">
        <Field label="By when" error={errorFor('dueOn')}>
          {({ id, describedBy }) => (
            <>
              <input
                id={id}
                type="date"
                value={value.dueOn}
                min={today()}
                required={!optional || value.description.trim() !== ''}
                aria-describedby={describedBy}
                disabled={busy}
                onChange={(event) => {
                  onChange({ ...value, dueOn: event.target.value });
                }}
              />
              <QuickDays
                value={value.dueOn}
                days={[
                  { label: 'Tomorrow', on: daysFromToday(1) },
                  { label: 'In 3 days', on: daysFromToday(3) },
                  { label: 'Next week', on: daysFromToday(7) },
                ]}
                disabled={busy}
                onPick={(day) => {
                  onChange({ ...value, dueOn: day });
                }}
              />
            </>
          )}
        </Field>

        <Field label="Whose" error={errorFor('ownerId')}>
          {({ id, describedBy }) => (
            <select
              id={id}
              value={value.ownerId}
              aria-describedby={describedBy}
              disabled={busy}
              onChange={(event) => {
                onChange({ ...value, ownerId: event.target.value });
              }}
            >
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                  {person.id === client.owner.id ? ` · owns ${client.name}` : ''}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
    </>
  );
}

/* ------------------------------------------------------------- logging, as a page */

/**
 * Logging an activity as a page of its own, as the mockup draws it: which client and which of its
 * deals, what happened, when, what came of it, the file, and then what. Reached from My pipeline's
 * "Log an activity", choosing the client here, and from a client's page with the client chosen.
 * Saving goes back to where it was opened from.
 *
 * For a proposal or the financials, the proposals and financials sent to clients of the same type
 * for the same product sit underneath, the latest first, as the place to start from (CLI 66).
 */
export function LogActivityPage({
  clientId: startingClient = null,
  dealId: startingDeal = null,
  onSignedOut,
}: {
  /** The client it was opened on, or null where it was opened from My pipeline. */
  clientId?: string | null;
  dealId?: string | null;
  onSignedOut: () => void;
}) {
  const [clients, setClients] = useState<ClientSummary[] | undefined>(undefined);
  const [clientId, setClientId] = useState(startingClient ?? '');
  const [client, setClient] = useState<ClientPage | undefined>(undefined);
  const [loadProblem, setLoadProblem] = useState<Problem | undefined>(undefined);

  const back =
    startingClient === null
      ? { href: '#/clients', label: 'Back to My pipeline' }
      : {
          href: `#/clients/client/${startingClient}`,
          label: `Back to ${client?.id === startingClient ? client.name : 'the client'}`,
        };

  useEffect(() => {
    clientsList()
      .then(setClients)
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setLoadProblem(problemFrom(error));
      });
  }, [onSignedOut]);

  /* The client chosen, with its deals and contacts, each time another is chosen. */
  useEffect(() => {
    if (clientId === '') {
      setClient(undefined);
      return;
    }

    let current = true;
    clientPage(clientId)
      .then((found) => {
        if (current) setClient(found);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        if (current) setLoadProblem(problemFrom(error));
      });

    return () => {
      current = false;
    };
  }, [clientId, onSignedOut]);

  return (
    <section className="clients-log-page">
      <a className="clients-back" href={back.href}>
        <Icon name="back" />
        {back.label}
      </a>

      <header className="clients-page-title">
        <h2>Log an activity</h2>
        <p className="muted">What happened, and what happens next.</p>
      </header>

      {loadProblem === undefined ? null : <Notice problem={loadProblem} />}

      <div className="clients-panel clients-log-card">
        <div className="clients-field">
          <label className="clients-field-label" htmlFor="clients-log-client">
            Client
          </label>
          <select
            id="clients-log-client"
            value={clientId}
            disabled={clients === undefined}
            onChange={(event) => {
              setClientId(event.target.value);
            }}
          >
            <option value="">Choose the client</option>
            {(clients ?? []).map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </select>
        </div>

        {client === undefined || client.id !== clientId ? null : (
          <LogActivityForm
            key={client.id}
            client={client}
            dealId={client.id === startingClient ? startingDeal : null}
            onDone={() => {
              window.location.hash = back.href;
            }}
            onCancel={() => {
              window.location.hash = back.href;
            }}
            onSignedOut={onSignedOut}
          />
        )}
      </div>
    </section>
  );
}

/** The form under the client: everything but which client, which the page chose. */
function LogActivityForm({
  client,
  dealId,
  onDone,
  onCancel,
  onSignedOut,
}: {
  client: ClientPage;
  dealId: string | null;
  onDone: () => void;
  onCancel: () => void;
  onSignedOut: () => void;
}) {
  const [kind, setKind] = useState<ActivityKind>('CALL');
  const [happenedOn, setHappenedOn] = useState(today());
  const [deal, setDeal] = useState(dealId ?? '');
  const [withWhom, setWithWhom] = useState('');
  const [outcome, setOutcome] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('GHS');
  const [step, setStep] = useState<StepState>(blankStep(client));
  const [files, setFiles] = useState<File[]>([]);
  const [loggedId, setLoggedId] = useState<string | null>(null);
  const sending = useSending(onDone, onSignedOut);
  const kindLabel = useId();
  const sent = kind === 'PROPOSAL' || kind === 'FINANCIALS';
  const financials = kind === 'FINANCIALS';
  const chosen = client.opportunities.find((one) => one.id === deal);
  /* Once logged, only the files are left to send; nothing else is sent again. */
  const fixed = sending.busy || loggedId !== null;

  const fields = ['kind', 'happenedOn', 'opportunityId', 'withWhom', 'outcome', 'amount'];
  const stepFields = ['nextStep.description', 'nextStep.dueOn', 'nextStep.ownerId'];
  const other = sending.other([...fields, 'file', 'filename', ...stepFields]);
  const asksAStep = step.description.trim() !== '';
  const fileError = sending.errorFor('file') ?? sending.errorFor('filename');

  const people = client.contacts
    .filter((contact) => contact.removedAt === null)
    .map((contact) =>
      contact.jobTitle === null ? contact.name : `${contact.name} (${contact.jobTitle})`,
    );

  return (
    <>
      <form
        className="clients-log"
        onSubmit={(event) => {
          event.preventDefault();
          const activity = {
            opportunityId: deal === '' ? null : deal,
            kind,
            happenedOn,
            withWhom: withWhom.trim() === '' ? null : withWhom,
            outcome: outcome.trim() === '' ? null : outcome,
            ...(financials ? { amount: { amount: amount.trim(), currency } } : {}),
          };

          sending.send(async () => {
            /* Logged once: where a file then fails, saving again attaches what is left rather
               than logging the activity a second time. #281. */
            const id =
              loggedId ??
              (await logActivity(client.id, activity, asksAStep ? stepDetails(step, client) : null))
                .activity.id;
            setLoggedId(id);

            for (const file of files) {
              await attachToActivity(id, file);
              setFiles((left) => left.filter((one) => one !== file));
            }
          });
        }}
      >
        <Field
          label={sent ? 'For which product' : 'Against which product (optional)'}
          hint={sent ? undefined : 'Leave it general for a catch up call.'}
          error={sending.errorFor('opportunityId')}
        >
          {({ id, describedBy }) => (
            <DealPicker
              id={id}
              describedBy={describedBy}
              client={client}
              value={deal}
              disabled={fixed}
              onChange={setDeal}
            />
          )}
        </Field>

        {/* ---------------------------------------------------------- what happened */}

        <div className="clients-field">
          <span id={kindLabel} className="clients-field-label">
            What happened
          </span>
          <div className="clients-kind-pills" role="radiogroup" aria-labelledby={kindLabel}>
            {KINDS.map((one) => (
              <label key={one.value} className={kind === one.value ? 'is-chosen' : undefined}>
                <input
                  type="radio"
                  name="kind"
                  value={one.value}
                  checked={kind === one.value}
                  disabled={fixed}
                  onChange={() => {
                    setKind(one.value);
                  }}
                />
                {SENT_NAME[one.value] ?? one.label}
              </label>
            ))}
          </div>
          {sending.errorFor('kind') === undefined ? null : (
            <p className="clients-field-error" role="alert">
              {sending.errorFor('kind')}
            </p>
          )}
        </div>

        <div className="clients-field-row">
          <Field label="When" error={sending.errorFor('happenedOn')}>
            {({ id, describedBy }) => (
              <input
                id={id}
                type="date"
                value={happenedOn}
                max={today()}
                required
                aria-describedby={describedBy}
                disabled={fixed}
                onChange={(event) => {
                  setHappenedOn(event.target.value);
                }}
              />
            )}
          </Field>

          {financials ? (
            <Field
              label="Amount in the financials"
              hint={
                chosen === undefined
                  ? 'This becomes the value on the deal.'
                  : `This becomes the value on the ${chosen.product.name} opportunity.`
              }
              error={sending.errorFor('amount')}
            >
              {({ id, describedBy }) => (
                <span className="clients-deal-money">
                  <select
                    aria-label="Currency"
                    value={currency}
                    disabled={fixed}
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
                    placeholder="190000"
                    autoComplete="off"
                    required
                    aria-describedby={describedBy}
                    disabled={fixed}
                    onChange={(event) => {
                      setAmount(event.target.value);
                    }}
                  />
                </span>
              )}
            </Field>
          ) : (
            <WithWhom
              label={sent ? 'Sent to' : 'With'}
              value={withWhom}
              placeholder={people[0] ?? 'Who was there'}
              disabled={fixed}
              error={sending.errorFor('withWhom')}
              onChange={setWithWhom}
            />
          )}
        </div>

        {financials ? (
          <WithWhom
            label="Sent to"
            value={withWhom}
            placeholder={people[0] ?? 'Who they went to'}
            disabled={fixed}
            error={sending.errorFor('withWhom')}
            onChange={setWithWhom}
          />
        ) : null}

        {people.length === 0 ? null : (
          <div className="clients-chips" aria-label={`${client.name}'s contacts`}>
            {people.map((person) => {
              const named = namedIn(withWhom, person);

              return (
                <button
                  key={person}
                  type="button"
                  className="clients-chip"
                  aria-pressed={named}
                  disabled={fixed}
                  onClick={() => {
                    setWithWhom(named ? without(withWhom, person) : alsoWith(withWhom, person));
                  }}
                >
                  {named ? <Icon name="tick" /> : <Icon name="plus" />}
                  {person}
                </button>
              );
            })}
          </div>
        )}

        <Field label="What came of it" error={sending.errorFor('outcome')}>
          {({ id, describedBy }) => (
            <textarea
              id={id}
              value={outcome}
              rows={3}
              maxLength={4000}
              placeholder="What was agreed, what they asked for, what is in the way"
              aria-describedby={describedBy}
              disabled={fixed}
              onChange={(event) => {
                setOutcome(event.target.value);
              }}
            />
          )}
        </Field>

        {/* ------------------------------------------------------------- the file */}

        <div className="clients-field">
          <span className="clients-field-label">
            {financials ? 'The financials' : sent ? 'The proposal itself' : 'Files (optional)'}
          </span>
          <label className="clients-dropzone">
            <Icon name="clip" />
            <span>
              <strong>
                {files.length > 0
                  ? files.map((file) => file.name).join(', ')
                  : sent
                    ? 'Attach the document you sent'
                    : 'Attach anything that goes with it'}
              </strong>
              <small>
                {loggedId !== null
                  ? 'It is logged. Saving again attaches what is left here.'
                  : sent
                    ? 'Every proposal is different, so the file is the only record of what was offered.'
                    : 'PDF, Word, Excel, PowerPoint, PNG or JPG, up to 50 MB each.'}
              </small>
            </span>
            <span className="clients-dropzone-button">Choose a file</span>
            <input
              type="file"
              multiple
              accept={DOCUMENT_ACCEPT}
              className="visually-hidden"
              disabled={sending.busy}
              onChange={(event) => {
                setFiles(Array.from(event.target.files ?? []));
              }}
            />
          </label>
          {fileError === undefined ? null : (
            <p className="clients-field-error" role="alert">
              {fileError}
            </p>
          )}
        </div>

        {/* --------------------------------------------------------- and then what */}

        {loggedId === null ? (
          <div className="clients-log-then">
            <span className="clients-field-label">And then what</span>
            <NextStepFields
              client={client}
              value={step}
              onChange={setStep}
              busy={sending.busy}
              errorFor={(name) => sending.errorFor(`nextStep.${name}`)}
              optional
              onSignedOut={onSignedOut}
            />
            <p className="clients-field-hint">
              This is the one field that does the work. It puts the deal at the top of the pipeline
              on the day, and chases whoever&rsquo;s it is if the day passes.
            </p>
          </div>
        ) : null}

        {other === undefined ? null : <Notice problem={other} />}

        <footer className="clients-log-foot">
          <button type="button" disabled={sending.busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={
              sending.busy ||
              happenedOn === '' ||
              (asksAStep && step.dueOn === '') ||
              (sent && deal === '') ||
              (financials && amount.trim() === '')
            }
          >
            {sending.busy ? 'Saving…' : loggedId !== null ? 'Attach the files' : 'Save it'}
          </button>
        </footer>
      </form>

      {sent && chosen !== undefined ? (
        <PastForTheSame
          client={client}
          productId={chosen.product.id}
          productName={chosen.product.name}
        />
      ) : null}
    </>
  );
}

/** What the kinds sent to a client are called on the page: "Proposal sent". */
const SENT_NAME: Partial<Record<ActivityKind, string>> = {
  PROPOSAL: 'Proposal sent',
  FINANCIALS: 'Financials sent',
};

/** Who it was with, or who it was sent to. */
function WithWhom({
  label,
  value,
  placeholder,
  disabled,
  error,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  error: string | undefined;
  onChange: (withWhom: string) => void;
}) {
  return (
    <Field label={label} error={error}>
      {({ id, describedBy }) => (
        <input
          id={id}
          value={value}
          maxLength={200}
          autoComplete="off"
          placeholder={placeholder}
          aria-describedby={describedBy}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      )}
    </Field>
  );
}

/**
 * The proposals and financials sent to other clients of this type for this product, the latest
 * first: nothing is a template, but the last one written for a client like this is the best place
 * to start (CLI 66, #281). Nothing at all where none has been sent.
 */
function PastForTheSame({
  client,
  productId,
  productName,
}: {
  client: ClientPage;
  productId: string;
  productName: string;
}) {
  const [past, setPast] = useState<PastProposal[]>([]);

  useEffect(() => {
    let current = true;
    pastProposals({ typeId: client.type.id, productId, kind: '' })
      .then((found) => {
        if (current) setPast(found.filter((one) => one.client.id !== client.id).slice(0, 4));
      })
      .catch(() => {
        /* A help beside the form, not the form: without it, the form still works. */
        if (current) setPast([]);
      });

    return () => {
      current = false;
    };
  }, [client.id, client.type.id, productId]);

  if (past.length === 0) {
    return null;
  }

  return (
    <section className="clients-panel clients-log-past" aria-labelledby="clients-log-past">
      <header className="clients-panel-head">
        <div>
          <h3 id="clients-log-past">
            Sent to other {plural(client.type.name)} for {productName}
          </h3>
          <p className="muted">
            Nothing is a template here, but the last one written for a client like this is the best
            place to start.
          </p>
        </div>
      </header>
      <ul className="clients-log-past-list">
        {past.map((one) => (
          <li key={one.id}>
            <strong>{one.client.name}</strong>
            <small>
              {one.kind === 'FINANCIALS' ? 'Financials' : 'Proposal'}
              {one.amount === null ? '' : ` · ${money(one.amount)}`} · {day(one.happenedOn)}
            </small>
            {one.files
              .filter((file) => file.downloadable)
              .map((file) => (
                <a key={file.id} href={documentDownloadPath(file.id)}>
                  {file.filename}
                </a>
              ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "banks", "microfinance institutions", "DFIs". */
function plural(typeName: string): string {
  return typeName === typeName.toUpperCase() ? `${typeName}s` : `${typeName.toLowerCase()}s`;
}
