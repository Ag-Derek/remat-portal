import { useEffect, useId, useState } from 'react';
import {
  type ActivityKind,
  addNextStep,
  attachToActivity,
  type ClientActivityEntry,
  type ClientPage,
  clientsHolders,
  type ClientsNamed,
  correctActivity,
  type Currency,
  DOCUMENT_ACCEPT,
  isNotSignedIn,
  logActivity,
  type NextStepDetails,
} from '../../api';
import { Icon, type IconName } from '../../Icon';
import { Notice } from '../../problem';
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
