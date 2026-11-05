import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  addEmployee,
  administrationChoices,
  type AdministrationChoices,
  administrationRecord,
  type AdministrationRecord,
  changeEmployee,
  type EmploymentStatus,
  type EmploymentType,
  isNotSignedIn,
  reassignReports,
  type RecordChange,
  type RecordFields,
  setTeamLead,
} from '../../api';
import { moment } from '../../format';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';
import { Access, datesOf } from './AdministrationPage';
import { Avatar } from './person';

const BACK = { href: '#/directory/admin', label: 'Back to administration' };

const EMPLOYMENT_TYPES: { value: EmploymentType; label: string }[] = [
  { value: 'FULL_TIME', label: 'Full time' },
  { value: 'PART_TIME', label: 'Part time' },
  { value: 'CONTRACT', label: 'Contract' },
  { value: 'INTERN', label: 'Intern' },
];

const STATUSES: { value: EmploymentStatus; label: string }[] = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'TERMINATED', label: 'Left the company' },
];

/** What the managed picker offers for the head of the organisation, who reports to nobody. */
const NOBODY = 'nobody';

/** The form, as strings, which is what every box holds. */
interface Draft {
  employeeNumber: string;
  firstName: string;
  lastName: string;
  workEmail: string;
  jobTitle: string;
  departmentId: string;
  managerId: string;
  employmentType: EmploymentType;
  workPatternId: string;
  startDate: string;
  exitDate: string;
  employmentStatus: EmploymentStatus;
  gender: '' | 'MALE' | 'FEMALE';
}

type Field = keyof Draft;

const EMPTY: Draft = {
  employeeNumber: '',
  firstName: '',
  lastName: '',
  workEmail: '',
  jobTitle: '',
  departmentId: '',
  managerId: '',
  employmentType: 'FULL_TIME',
  workPatternId: '',
  startDate: '',
  exitDate: '',
  employmentStatus: 'ACTIVE',
  gender: '',
};

/**
 * Adding somebody, at `#/directory/admin/new`, and changing a record, at
 * `#/directory/admin/<id>`. One form for both, since they are the same fields.
 *
 * The required fields are checked here as somebody types, so a gap is named before Save; the
 * server checks them again and decides, and a refusal it names a box for is said beside that
 * box.
 */
export function EmployeeRecordPage({
  employeeId,
  onSignedOut,
}: {
  /** Undefined for a new record. */
  employeeId: string | undefined;
  onSignedOut: () => void;
}) {
  const [choices, setChoices] = useState<AdministrationChoices | undefined>(undefined);
  const [record, setRecord] = useState<AdministrationRecord | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);

  const failed = useCallback(
    (error: unknown) => {
      if (isNotSignedIn(error)) {
        onSignedOut();
        return;
      }

      setProblem(problemFrom(error));
    },
    [onSignedOut],
  );

  useEffect(() => {
    setRecord(undefined);
    setProblem(undefined);

    Promise.all([
      administrationChoices(),
      employeeId === undefined ? undefined : administrationRecord(employeeId),
    ])
      .then(([offered, found]) => {
        setChoices(offered);
        setRecord(found);
      })
      .catch(failed);
  }, [employeeId, failed]);

  const ready = choices !== undefined && (employeeId === undefined || record !== undefined);

  return (
    <div className="admin-record">
      <a className="directory-back" href={BACK.href}>
        <Icon name="back" />
        {BACK.label}
      </a>

      {employeeId === undefined ? (
        <>
          <h2>Add an employee</h2>
          <p className="muted">
            This creates the person&rsquo;s record for the whole portal. Their login is created
            separately by a system administrator once this is saved.
          </p>
        </>
      ) : record === undefined ? null : (
        <div className="admin-record-head">
          <Avatar person={record} />
          <div>
            <h2>
              {record.firstName} {record.lastName}
            </h2>
            <p className="muted">
              {[record.jobTitle, record.department.name, record.employeeNumber]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <p className="admin-record-standing">
              <span>{datesOf(record, record.today)}</span>
              <Access record={record} />
            </p>
          </div>
        </div>
      )}

      {problem === undefined || ready ? null : <Notice problem={problem} />}

      {!ready ? null : (
        <>
          <RecordForm
            key={record?.employeeId ?? 'new'}
            choices={choices}
            record={record}
            onSaved={(saved) => {
              if (record === undefined) {
                window.location.hash = `#/directory/admin/${encodeURIComponent(saved.employeeId)}`;
              } else {
                setRecord(saved);
              }
            }}
            onSignedOut={onSignedOut}
          />

          {record === undefined || record.reportsStillHere.length === 0 ? null : (
            <Reports
              record={record}
              choices={choices}
              onMoved={() => {
                administrationRecord(record.employeeId).then(setRecord).catch(failed);
              }}
              onSignedOut={onSignedOut}
            />
          )}

          {/* Offered to anybody with a team to draw, and to anybody already marked, so it can
              be taken off again after their reports have moved. */}
          {record === undefined ||
          (record.reportsStillHere.length === 0 && !record.teamLead) ? null : (
            <TeamLead record={record} onChanged={setRecord} onSignedOut={onSignedOut} />
          )}

          {record === undefined ? null : <History history={record.history} />}
        </>
      )}
    </div>
  );
}

function RecordForm({
  choices,
  record,
  onSaved,
  onSignedOut,
}: {
  choices: AdministrationChoices;
  record: AdministrationRecord | undefined;
  onSaved: (record: AdministrationRecord) => void;
  onSignedOut: () => void;
}) {
  const adding = record === undefined;
  const [saved, setSaved] = useState<Draft>(() => (record === undefined ? EMPTY : draftOf(record)));
  const [draft, setDraft] = useState<Draft>(() =>
    record === undefined
      ? { ...EMPTY, workPatternId: choices.patterns.find((one) => one.isDefault)?.id ?? '' }
      : draftOf(record),
  );
  const [touched, setTouched] = useState<Set<Field>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [done, setDone] = useState(false);

  const mistakes = mistakesIn(draft, record);
  const changed = adding ? fieldsOf(draft) : changesBetween(saved, draft);
  const nothingChanged = !adding && Object.keys(changed).length === 0;

  /** The message beside a box: the server's, then this page's once the box has been left. */
  const shown = (field: Field): string | undefined =>
    problem?.field === field
      ? problem.what
      : submitted || touched.has(field)
        ? mistakes[field]
        : undefined;

  const set = (field: Field) => (value: string) => {
    setDraft((was) => ({ ...was, [field]: value }));
    setDone(false);
    if (problem?.field === field) {
      setProblem(undefined);
    }
  };

  const leave = (field: Field) => () => {
    setTouched((was) => new Set(was).add(field));
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);

    if (Object.keys(mistakes).length > 0 || nothingChanged) {
      return;
    }

    setSaving(true);
    setProblem(undefined);

    (adding ? addEmployee(changed) : changeEmployee(record.employeeId, changed))
      .then((after) => {
        setSaved(draftOf(after));
        setDraft(draftOf(after));
        setSubmitted(false);
        setTouched(new Set());
        setDone(true);
        onSaved(after);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }

        setProblem(problemFrom(error));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  /* The head of the organisation reports to nobody, and is the only record offered that. */
  const headsTheOrganisation = record !== undefined && record.manager === null;
  const managers = choices.managers.filter((one) => one.employeeId !== record?.employeeId);
  const managerGone =
    record?.manager != null &&
    !managers.some((one) => one.employeeId === record.manager?.employeeId);

  const box = (field: Field) => ({
    id: `record-${field}`,
    disabled: saving,
    'aria-invalid': shown(field) === undefined ? undefined : true,
    'aria-describedby': `record-${field}-hint`,
    onBlur: leave(field),
  });

  const hint = (field: Field, quiet?: string) => {
    const message = shown(field);

    return message === undefined && quiet === undefined ? null : (
      <small id={`record-${field}-hint`} className={message === undefined ? 'muted' : 'error'}>
        {message ?? quiet}
      </small>
    );
  };

  return (
    <form className="admin-form" onSubmit={save} noValidate>
      <fieldset>
        <legend>The person</legend>

        <div className="admin-field">
          <label htmlFor="record-firstName">First name</label>
          <input
            {...box('firstName')}
            autoComplete="off"
            value={draft.firstName}
            onChange={(event) => {
              set('firstName')(event.target.value);
            }}
          />
          {hint('firstName')}
        </div>

        <div className="admin-field">
          <label htmlFor="record-lastName">Last name</label>
          <input
            {...box('lastName')}
            autoComplete="off"
            value={draft.lastName}
            onChange={(event) => {
              set('lastName')(event.target.value);
            }}
          />
          {hint('lastName')}
        </div>

        <div className="admin-field">
          <label htmlFor="record-employeeNumber">Employee number</label>
          <input
            {...box('employeeNumber')}
            autoComplete="off"
            value={draft.employeeNumber}
            onChange={(event) => {
              set('employeeNumber')(event.target.value);
            }}
          />
          {hint('employeeNumber')}
        </div>

        <div className="admin-field">
          <label htmlFor="record-workEmail">Work email</label>
          <input
            {...box('workEmail')}
            type="email"
            autoComplete="off"
            value={draft.workEmail}
            onChange={(event) => {
              set('workEmail')(event.target.value);
            }}
          />
          {hint('workEmail', 'This is also what they will sign in with.')}
        </div>
      </fieldset>

      <fieldset>
        <legend>The job</legend>

        <div className="admin-field">
          <label htmlFor="record-jobTitle">Job title</label>
          <input
            {...box('jobTitle')}
            autoComplete="off"
            value={draft.jobTitle}
            onChange={(event) => {
              set('jobTitle')(event.target.value);
            }}
          />
          {hint('jobTitle')}
        </div>

        <div className="admin-field">
          <label htmlFor="record-departmentId">Department</label>
          <select
            {...box('departmentId')}
            value={draft.departmentId}
            onChange={(event) => {
              set('departmentId')(event.target.value);
            }}
          >
            <option value="">Choose a department</option>
            {/* A closed department is offered only to the record already in it. */}
            {record !== undefined &&
            !choices.departments.some((one) => one.id === record.department.id) ? (
              <option value={record.department.id}>{record.department.name} (closed)</option>
            ) : null}
            {choices.departments.map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </select>
          {hint('departmentId')}
        </div>

        <div className="admin-field">
          <label htmlFor="record-managerId">Reports to</label>
          <select
            {...box('managerId')}
            value={draft.managerId}
            onChange={(event) => {
              set('managerId')(event.target.value);
            }}
          >
            {headsTheOrganisation ? (
              <option value={NOBODY}>Nobody. They head the organisation</option>
            ) : (
              <option value="">Choose their manager</option>
            )}
            {/* Somebody no longer here stays shown so the form says what the record says. */}
            {managerGone && record?.manager != null ? (
              <option value={record.manager.employeeId} disabled>
                {record.manager.firstName} {record.manager.lastName} (no longer here)
              </option>
            ) : null}
            {managers.map((one) => (
              <option key={one.employeeId} value={one.employeeId}>
                {one.firstName} {one.lastName}
                {one.jobTitle === null ? '' : `, ${one.jobTitle}`}
              </option>
            ))}
          </select>
          {hint(
            'managerId',
            'This decides who approves their leave, and where they sit on the chart.',
          )}
        </div>

        <div className="admin-field">
          <label htmlFor="record-employmentType">Employment type</label>
          <select
            {...box('employmentType')}
            value={draft.employmentType}
            onChange={(event) => {
              set('employmentType')(event.target.value);
            }}
          >
            {EMPLOYMENT_TYPES.map((one) => (
              <option key={one.value} value={one.value}>
                {one.label}
              </option>
            ))}
          </select>
          {hint('employmentType')}
        </div>

        <div className="admin-field">
          <label htmlFor="record-workPatternId">Working pattern</label>
          <select
            {...box('workPatternId')}
            value={draft.workPatternId}
            onChange={(event) => {
              set('workPatternId')(event.target.value);
            }}
          >
            {choices.patterns.map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </select>
          {hint('workPatternId')}
        </div>

        <div className="admin-field">
          <label htmlFor="record-startDate">Start date</label>
          <input
            {...box('startDate')}
            type="date"
            value={draft.startDate}
            onChange={(event) => {
              set('startDate')(event.target.value);
            }}
          />
          {hint('startDate', 'They appear in the directory on this date, not before.')}
        </div>

        {adding ? null : (
          <>
            <div className="admin-field">
              <label htmlFor="record-exitDate">
                Exit date <span className="muted">(optional)</span>
              </label>
              <input
                {...box('exitDate')}
                type="date"
                value={draft.exitDate}
                onChange={(event) => {
                  set('exitDate')(event.target.value);
                }}
              />
              {hint(
                'exitDate',
                record.reportsStillHere.length > 0 && record.exitDate === null
                  ? 'Move their reports, below, before setting an exit date.'
                  : 'Their last day. They leave the directory the day after.',
              )}
            </div>

            <div className="admin-field">
              <label htmlFor="record-employmentStatus">Status</label>
              <select
                {...box('employmentStatus')}
                value={draft.employmentStatus}
                onChange={(event) => {
                  set('employmentStatus')(event.target.value);
                }}
              >
                {STATUSES.map((one) => (
                  <option key={one.value} value={one.value}>
                    {one.label}
                  </option>
                ))}
              </select>
              {hint('employmentStatus')}
            </div>
          </>
        )}
      </fieldset>

      <fieldset>
        <legend>For leave eligibility</legend>

        <div className="admin-field">
          <label htmlFor="record-gender">
            Gender <span className="muted">(optional)</span>
          </label>
          <select
            {...box('gender')}
            value={draft.gender}
            onChange={(event) => {
              set('gender')(event.target.value);
            }}
          >
            <option value="">Prefer not to say</option>
            <option value="FEMALE">Female</option>
            <option value="MALE">Male</option>
          </select>
          {hint(
            'gender',
            'Used only to decide eligibility for maternity and paternity leave. It is never shown in the directory.',
          )}
        </div>
      </fieldset>

      {adding ? (
        <div className="notice plain admin-what-happens">
          <Icon name="info" />
          <div>
            <p>
              <strong>What happens when you save</strong>
            </p>
            <p>
              The record is created and marked <strong>No login yet</strong>. It goes onto the
              system administrators&rsquo; list straight away, flagged if the start date is inside a
              fortnight. Any one of them can create the login and send the invitation. You will see
              the record change to <strong>Login active</strong> here when they have.
            </p>
          </div>
        </div>
      ) : null}

      {/* A refusal that named a box is said beside it; anything else is said here. */}
      {problem === undefined || (problem.field !== undefined && problem.field in draft) ? null : (
        <Notice problem={problem} />
      )}

      {submitted && Object.keys(mistakes).length > 0 ? (
        <p className="error" role="alert">
          Some fields need attention before this can be saved.
        </p>
      ) : null}

      {done ? (
        <p className="notice done" role="status">
          {adding ? 'Record created.' : 'Saved.'}
        </p>
      ) : null}

      <div className="admin-actions">
        {adding ? (
          <a className="admin-cancel" href={BACK.href}>
            Cancel
          </a>
        ) : (
          <button
            type="button"
            disabled={nothingChanged || saving}
            onClick={() => {
              setDraft(saved);
              setProblem(undefined);
              setSubmitted(false);
              setTouched(new Set());
            }}
          >
            Undo changes
          </button>
        )}
        <button type="submit" className="primary" disabled={saving || nothingChanged}>
          {saving ? 'Saving…' : adding ? 'Create record' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

/** Somebody's reports, and moving some or all of them to another manager. */
function Reports({
  record,
  choices,
  onMoved,
  onSignedOut,
}: {
  record: AdministrationRecord;
  choices: AdministrationChoices;
  onMoved: () => void;
  onSignedOut: () => void;
}) {
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(record.reportsStillHere.map((one) => one.employeeId)),
  );
  const [toManagerId, setToManagerId] = useState('');
  const [moving, setMoving] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);

  /* Not the person themselves, and not anybody being moved. */
  const candidates = choices.managers.filter(
    (one) => one.employeeId !== record.employeeId && !chosen.has(one.employeeId),
  );

  const everybody = chosen.size === record.reportsStillHere.length;

  const move = () => {
    setMoving(true);
    setProblem(undefined);

    reassignReports(record.employeeId, toManagerId, everybody ? null : [...chosen])
      .then(() => {
        setToManagerId('');
        onMoved();
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }

        setProblem(problemFrom(error));
      })
      .finally(() => {
        setMoving(false);
      });
  };

  return (
    <section className="admin-panel" aria-labelledby="record-reports">
      <h3 id="record-reports">
        Reports to {record.firstName} ({String(record.reportsStillHere.length)})
      </h3>
      <p className="muted">
        Move them to another manager before setting an exit date. Each person&rsquo;s pending leave
        goes to their new manager with them.
      </p>

      <ul className="admin-reports">
        {record.reportsStillHere.map((one) => (
          <li key={one.employeeId}>
            <label>
              <input
                type="checkbox"
                checked={chosen.has(one.employeeId)}
                disabled={moving}
                onChange={(event) => {
                  setChosen((was) => {
                    const next = new Set(was);

                    if (event.target.checked) {
                      next.add(one.employeeId);
                    } else {
                      next.delete(one.employeeId);
                    }

                    return next;
                  });
                }}
              />
              <span>
                {one.firstName} {one.lastName}
                {one.jobTitle === null ? null : <small>{one.jobTitle}</small>}
              </span>
            </label>
          </li>
        ))}
      </ul>

      <div className="admin-move">
        <label>
          <span>Move {everybody ? 'all of them' : `the ${String(chosen.size)} chosen`} to</span>
          <select
            value={toManagerId}
            disabled={moving}
            onChange={(event) => {
              setToManagerId(event.target.value);
            }}
          >
            <option value="">Choose a manager</option>
            {candidates.map((one) => (
              <option key={one.employeeId} value={one.employeeId}>
                {one.firstName} {one.lastName}
                {one.jobTitle === null ? '' : `, ${one.jobTitle}`}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="primary"
          disabled={moving || chosen.size === 0 || toManagerId === ''}
          onClick={move}
        >
          {moving ? 'Moving…' : 'Move reports'}
        </button>
      </div>

      {problem === undefined ? null : <Notice problem={problem} />}
    </section>
  );
}

/**
 * Whether the chart draws somebody's reports beside them, under their own manager.
 *
 * Saved as soon as it is ticked, as moving reports is, because it is not part of the record's
 * form: it changes the drawing and nothing else.
 */
function TeamLead({
  record,
  onChanged,
  onSignedOut,
}: {
  record: AdministrationRecord;
  onChanged: (record: AdministrationRecord) => void;
  onSignedOut: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);

  const change = (teamLead: boolean) => {
    setSaving(true);
    setProblem(undefined);

    setTeamLead(record.employeeId, teamLead)
      .then(onChanged)
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }

        setProblem(problemFrom(error));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <section className="admin-panel" aria-labelledby="record-team-lead">
      <h3 id="record-team-lead">On the organisation chart</h3>

      <label className="admin-team-lead">
        <input
          type="checkbox"
          checked={record.teamLead}
          disabled={saving}
          onChange={(event) => {
            change(event.target.checked);
          }}
        />
        <span>
          {record.firstName} is a team lead
          <small>
            {record.manager === null
              ? `Has no effect while ${record.firstName} reports to nobody.`
              : `Their reports are drawn beside them, under ${record.manager.firstName} ` +
                `${record.manager.lastName}, marked as led by ${record.firstName}.`}{' '}
            They still report to {record.firstName}, who still approves their leave.
          </small>
        </span>
      </label>

      {problem === undefined ? null : <Notice problem={problem} />}
    </section>
  );
}

/** Every change to the record: the old value, the new one, who and when. */
function History({ history }: { history: RecordChange[] }) {
  return (
    <section className="admin-panel" aria-labelledby="record-history">
      <h3 id="record-history">History</h3>

      {history.length === 0 ? (
        <p className="muted">No changes recorded.</p>
      ) : (
        <ol className="admin-history">
          {history.map((entry, index) => (
            <li key={`${entry.at}-${String(index)}`}>
              <p className="admin-history-who">
                <strong>{entry.by}</strong>{' '}
                {entry.action === 'CREATE' ? 'created the record' : 'changed'}
                <span className="muted"> · {moment(entry.at)}</span>
              </p>
              {entry.action === 'CREATE' ? null : (
                <ul>
                  {entry.changes.map((change) => (
                    <li key={change.field}>
                      {change.label}: <s>{shownValue(change.from)}</s> →{' '}
                      <span>{shownValue(change.to)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function shownValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return 'none';
  }

  if (typeof value === 'boolean') {
    return value ? 'yes' : 'no';
  }

  return typeof value === 'string' ? value : JSON.stringify(value);
}

function draftOf(record: AdministrationRecord): Draft {
  return {
    employeeNumber: record.employeeNumber,
    firstName: record.firstName,
    lastName: record.lastName,
    workEmail: record.workEmail,
    jobTitle: record.jobTitle ?? '',
    departmentId: record.department.id,
    managerId: record.manager?.employeeId ?? NOBODY,
    employmentType: record.employmentType,
    workPatternId: record.workPatternId,
    startDate: record.startDate,
    exitDate: record.exitDate ?? '',
    employmentStatus: record.employmentStatus,
    gender: record.gender ?? '',
  };
}

/** The draft as the server reads a record: blanks as null where a blank means none. */
function fieldsOf(draft: Draft, only?: readonly Field[]): RecordFields {
  const all: RecordFields = {
    employeeNumber: draft.employeeNumber.trim(),
    firstName: draft.firstName.trim(),
    lastName: draft.lastName.trim(),
    workEmail: draft.workEmail.trim(),
    jobTitle: draft.jobTitle.trim() === '' ? null : draft.jobTitle.trim(),
    departmentId: draft.departmentId,
    managerId: draft.managerId === NOBODY ? null : draft.managerId,
    employmentType: draft.employmentType,
    workPatternId: draft.workPatternId === '' ? null : draft.workPatternId,
    startDate: draft.startDate,
    exitDate: draft.exitDate === '' ? null : draft.exitDate,
    employmentStatus: draft.employmentStatus,
    gender: draft.gender === '' ? null : draft.gender,
  };

  if (only === undefined) {
    /* A new record has no exit date and starts active; the form does not offer either. */
    delete all.exitDate;
    delete all.employmentStatus;

    return all;
  }

  return Object.fromEntries(
    Object.entries(all).filter(([field]) => only.includes(field as Field)),
  ) as RecordFields;
}

/** Only what was changed, so nothing else on the record is touched or audited. */
function changesBetween(saved: Draft, draft: Draft): RecordFields {
  const changed = (Object.keys(draft) as Field[]).filter((field) => saved[field] !== draft[field]);

  return fieldsOf(draft, changed);
}

/** What is wrong with the form before it is sent, field by field. */
function mistakesIn(
  draft: Draft,
  record: AdministrationRecord | undefined,
): Partial<Record<Field, string>> {
  const mistakes: Partial<Record<Field, string>> = {};
  const required: [Field, string][] = [
    ['firstName', 'Enter their first name.'],
    ['lastName', 'Enter their last name.'],
    ['employeeNumber', 'Enter their employee number.'],
    ['workEmail', 'Enter their work email address.'],
    ['departmentId', 'Choose the department they are in.'],
    ['managerId', 'Choose who they report to.'],
    ['startDate', 'Enter the day they start.'],
  ];

  for (const [field, message] of required) {
    if (draft[field].trim() === '') {
      mistakes[field] = message;
    }
  }

  if (mistakes.workEmail === undefined && !/^[^\s@]+@[^\s@]+$/.test(draft.workEmail.trim())) {
    mistakes.workEmail = 'Enter a work email address, like kojo.antwi@rematholdings.com.';
  }

  if (draft.exitDate !== '' && draft.startDate !== '' && draft.exitDate < draft.startDate) {
    mistakes.exitDate = 'The exit date is before the start date.';
  }

  if (draft.employmentStatus === 'TERMINATED' && draft.exitDate === '') {
    mistakes.exitDate = 'Somebody who has left needs the date of their last day.';
  }

  /* The server's rule, said early: an exit date is not set on somebody with reports. */
  if (
    record !== undefined &&
    record.reportsStillHere.length > 0 &&
    draft.exitDate !== '' &&
    draft.exitDate !== (record.exitDate ?? '')
  ) {
    mistakes.exitDate =
      `${String(record.reportsStillHere.length)} ` +
      `${record.reportsStillHere.length === 1 ? 'person still reports' : 'people still report'} ` +
      `to ${record.firstName}. Move them below first.`;
  }

  return mistakes;
}
