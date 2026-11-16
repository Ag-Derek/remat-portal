import { useEffect, useRef, useState } from 'react';
import {
  type CoverChoices,
  type CoverClash,
  type CoverColleague,
  type CoverPart,
  coverChoices,
  coverClashes,
  isNotSignedIn,
} from '../../api';
import { RemoveButton } from '../../ActionButtons';
import { dayAfter, period } from '../../format';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';

/** The most parts the server takes. */
const MOST_PARTS = 10;

/** Whether cover can still be named on leave: live, and not over. The server asks again. */
export function mayNameCover(live: boolean, to: string): boolean {
  const now = new Date();
  const today =
    `${String(now.getFullYear()).padStart(4, '0')}-` +
    `${String(now.getMonth() + 1).padStart(2, '0')}-` +
    `${String(now.getDate()).padStart(2, '0')}`;

  return live && to >= today;
}

/**
 * Who covers, as it is being chosen. One row for the whole leave, or several rows each with
 * its own dates. Kept apart from the leave's dates, so moving them carries a single cover along.
 */
export interface CoverDraft {
  split: boolean;
  rows: CoverPart[];
}

export const NO_COVER: CoverDraft = { split: false, rows: [] };

/** The draft as the server takes it: the whole leave, or each part as chosen. */
export function partsOf(draft: CoverDraft, from: string, to: string): CoverPart[] {
  if (!draft.split) {
    const coverId = draft.rows[0]?.coverId ?? '';

    return coverId === '' || from === '' || to === '' ? [] : [{ coverId, from, to }];
  }

  return draft.rows.filter((row) => row.coverId !== '' && row.from !== '' && row.to !== '');
}

/** The draft for cover already named on leave from `from` to `to`. */
export function draftOf(parts: CoverPart[], from: string, to: string): CoverDraft {
  const whole = parts.length === 1 && parts[0].from === from && parts[0].to === to;

  return { split: parts.length > 1 || (parts.length === 1 && !whole), rows: parts };
}

/**
 * Choosing who covers while somebody is away. #226.
 *
 * The picker offers the colleagues the server lists, which is everybody at the company today
 * but the person going: a leaver, or yourself, is never offered. Their manager is suggested,
 * as a button rather than chosen for them, because naming somebody emails them.
 *
 * Each colleague chosen is checked against their own leave as they are chosen, and any day
 * they are away too is said beside them. A warning only: it is still theirs to name.
 */
export function CoverFields({
  employeeId,
  from,
  to,
  draft,
  onChange,
  disabled = false,
  onSignedOut,
}: {
  /** Whose leave. Left out for the reader's own. */
  employeeId?: string;
  /** The leave's dates, empty until chosen. */
  from: string;
  to: string;
  draft: CoverDraft;
  onChange: (draft: CoverDraft) => void;
  disabled?: boolean;
  onSignedOut: () => void;
}) {
  const [choices, setChoices] = useState<CoverChoices | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const clashes = useClashes(employeeId, partsOf(draft, from, to), onSignedOut);

  useEffect(() => {
    coverChoices(employeeId)
      .then((next) => {
        setChoices(next);
        setProblem(undefined);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }

        setProblem(problemFrom(error));
      });
  }, [employeeId, onSignedOut]);

  if (problem !== undefined) {
    return <Notice problem={problem} />;
  }

  if (choices === undefined) {
    return <p className="muted">Loading colleagues…</p>;
  }

  const colleagues = choices.colleagues;
  const suggested = colleagues.find((one) => one.employeeId === choices.suggestedId);
  const rows = draft.rows.length === 0 ? [{ coverId: '', from, to }] : draft.rows;
  const datesChosen = from !== '' && to !== '';

  const setRow = (at: number, row: CoverPart) => {
    onChange({ ...draft, rows: rows.map((one, index) => (index === at ? row : one)) });
  };

  const split = () => {
    onChange({ split: true, rows: rows.map((one) => ({ ...one, from, to })) });
  };

  const whole = () => {
    onChange({ split: false, rows: rows.slice(0, 1) });
  };

  const addPart = () => {
    const last = rows[rows.length - 1];
    /* Picking up the day after the last part, which is what a split nearly always is. */
    const start = last.to !== '' && last.to < to ? dayAfter(last.to) : from;

    onChange({ ...draft, rows: [...rows, { coverId: '', from: start, to }] });
  };

  const removePart = (at: number) => {
    const left = rows.filter((_one, index) => index !== at);

    onChange(left.length === 0 ? NO_COVER : { ...draft, rows: left });
  };

  return (
    <div className="cover-fields">
      {draft.split ? (
        <ol className="cover-parts">
          {rows.map((row, at) => (
            <li key={at} className="cover-part">
              <Picker
                label={`Who covers part ${String(at + 1)}`}
                value={row.coverId}
                colleagues={colleagues}
                disabled={disabled}
                onPick={(coverId) => {
                  setRow(at, { ...row, coverId });
                }}
              />
              <div className="dates">
                <label>
                  From
                  <input
                    type="date"
                    value={row.from}
                    min={from || undefined}
                    max={to || undefined}
                    disabled={disabled}
                    onChange={(event) => {
                      setRow(at, { ...row, from: event.target.value });
                    }}
                  />
                </label>
                <label>
                  To
                  <input
                    type="date"
                    value={row.to}
                    min={row.from || from || undefined}
                    max={to || undefined}
                    disabled={disabled}
                    onChange={(event) => {
                      setRow(at, { ...row, to: event.target.value });
                    }}
                  />
                </label>
              </div>
              <RemoveButton
                label={`Remove part ${String(at + 1)} of the cover`}
                disabled={disabled}
                onClick={() => {
                  removePart(at);
                }}
              />
              <Clashes clashes={clashes} coverId={row.coverId} colleagues={colleagues} />
            </li>
          ))}
        </ol>
      ) : (
        <>
          <Picker
            label="Who covers"
            value={rows[0].coverId}
            colleagues={colleagues}
            disabled={disabled}
            onPick={(coverId) => {
              onChange({ split: false, rows: coverId === '' ? [] : [{ coverId, from, to }] });
            }}
          />
          <Clashes clashes={clashes} coverId={rows[0].coverId} colleagues={colleagues} />
        </>
      )}

      <div className="cover-actions">
        {/* The manager, offered rather than chosen: naming somebody tells them. */}
        {!draft.split && rows[0].coverId === '' && suggested !== undefined ? (
          <button
            type="button"
            className="linkish"
            disabled={disabled}
            onClick={() => {
              onChange({ split: false, rows: [{ coverId: suggested.employeeId, from, to }] });
            }}
          >
            Use {nameOf(suggested)}, {employeeId === undefined ? 'your' : 'their'} manager
          </button>
        ) : null}

        {draft.split ? (
          <>
            {rows.length < MOST_PARTS ? (
              <button type="button" className="linkish" disabled={disabled} onClick={addPart}>
                <Icon name="plus" />
                Add another part
              </button>
            ) : null}
            <button type="button" className="linkish" disabled={disabled} onClick={whole}>
              One person for the whole leave
            </button>
          </>
        ) : (
          <button
            type="button"
            className="linkish"
            disabled={disabled || !datesChosen}
            onClick={split}
          >
            Different cover for different days
          </button>
        )}
      </div>
    </div>
  );
}

/** One colleague, chosen from current staff. */
function Picker({
  label,
  value,
  colleagues,
  disabled,
  onPick,
}: {
  label: string;
  value: string;
  colleagues: CoverColleague[];
  disabled: boolean;
  onPick: (coverId: string) => void;
}) {
  return (
    <label>
      {label}
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onPick(event.target.value);
        }}
      >
        <option value="">Nobody named</option>
        {colleagues.map((one) => (
          <option key={one.employeeId} value={one.employeeId}>
            {nameOf(one)}
            {one.jobTitle === null ? '' : ` (${one.jobTitle})`}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The days the colleague chosen is away themselves. */
function Clashes({
  clashes,
  coverId,
  colleagues,
}: {
  clashes: CoverClash[];
  coverId: string;
  colleagues: CoverColleague[];
}) {
  const theirs = clashes.filter((one) => one.coverId === coverId);
  const who = colleagues.find((one) => one.employeeId === coverId);

  if (theirs.length === 0 || who === undefined) {
    return null;
  }

  return (
    <p className="notice warning" role="status">
      {nameOf(who)} is on leave too: {theirs.map((one) => period(one.from, one.to)).join(', ')}. You
      can still name them, but colleagues may not reach them then.
    </p>
  );
}

/**
 * The days each colleague chosen is away themselves, asked again whenever the cover changes.
 * An older answer landing late is dropped, as the quote's is.
 */
function useClashes(
  employeeId: string | undefined,
  parts: CoverPart[],
  onSignedOut: () => void,
): CoverClash[] {
  const [clashes, setClashes] = useState<CoverClash[]>([]);
  const asked = useRef(0);
  const key = JSON.stringify(parts);

  useEffect(() => {
    const wanted = JSON.parse(key) as CoverPart[];

    asked.current += 1;
    const mine = asked.current;

    if (wanted.length === 0) {
      setClashes([]);
      return;
    }

    const waiting = setTimeout(() => {
      Promise.all(wanted.map((part) => coverClashes({ employeeId, ...part })))
        .then((found) => {
          if (mine === asked.current) {
            setClashes(found.flat());
          }
        })
        .catch((error: unknown) => {
          if (isNotSignedIn(error)) {
            onSignedOut();
            return;
          }

          /* A warning that could not be fetched is not a reason to stop anybody. */
          if (mine === asked.current) {
            setClashes([]);
          }
        });
    }, 300);

    return () => {
      clearTimeout(waiting);
    };
  }, [employeeId, key, onSignedOut]);

  return clashes;
}

function nameOf(person: Pick<CoverColleague, 'firstName' | 'lastName'>): string {
  return `${person.firstName} ${person.lastName}`;
}
