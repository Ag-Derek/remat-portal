import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type ChartLine,
  type ChartPerson,
  isNotSignedIn,
  type StaffChart,
  staffChart,
} from '../../api';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';
import { Avatar, fold, profileAddress } from './person';

/** How far the chart can be zoomed out and in, and how far one press of − or + goes. */
const ZOOM_LEAST = 0.4;
const ZOOM_MOST = 1.5;
const ZOOM_STEP = 0.1;

/**
 * A chart of more people than this opens with the top two levels drawn and the rest folded,
 * so the first sight of a large organisation is its shape rather than a wall of cards.
 */
const OPEN_IN_FULL = 40;
const LEVELS_OPEN = 2;

/** How far a pressed pointer moves before the press is a drag rather than a click. */
const DRAG_FROM = 4;

/** How many names the search offers at once. */
const MATCHES_SHOWN = 8;

/**
 * The organisation chart, at `#/directory/chart`, and centred on somebody at
 * `#/directory/chart/<id>`.
 *
 * Fetched every time it is opened rather than kept, so it is always the reporting lines as the
 * records hold them now.
 */
export function OrgChart({
  focusId,
  onSignedOut,
}: {
  /** Somebody to centre on, from the address. */
  focusId: string | undefined;
  onSignedOut: () => void;
}) {
  const [chart, setChart] = useState<StaffChart | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);

    staffChart()
      .then((found) => {
        setChart(found);
        setProblem(undefined);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }

        setProblem(problemFrom(error));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [onSignedOut]);

  useEffect(load, [load]);

  return (
    <>
      <p className="muted org-intro">
        Drawn from the reporting line every time it is opened, so it cannot go out of date. Click
        anybody to open their profile.
      </p>

      {problem === undefined ? null : (
        <Notice problem={problem} retrying={loading} onRetry={load} />
      )}

      {chart === undefined ? (
        problem === undefined ? (
          <div className="org-viewport skeleton" aria-busy="true">
            <span className="visually-hidden">Loading the organisation chart</span>
          </div>
        ) : null
      ) : chart.lines.length === 0 ? (
        <p className="notice plain">Nobody is on the organisation chart yet.</p>
      ) : (
        <Chart chart={chart} focusId={focusId} />
      )}

      <p className="muted org-footnote">
        Current staff only. A chart that looks wrong is worth reporting quickly, because the same
        field decides where leave requests go.
      </p>
    </>
  );
}

/** Everybody on the chart, once, with who they report to on it. */
interface Index {
  /** By surname, for the search. */
  people: { person: ChartPerson; depth: number; text: string }[];
  /** The person above each person on the chart; null at the top of a line. */
  above: Map<string, string | null>;
}

function Chart({ chart, focusId }: { chart: StaffChart; focusId: string | undefined }) {
  const index = useMemo(() => indexOf(chart), [chart]);

  /* The team leads with a team drawn beside them, which is whoever somebody is led by. */
  const leads = useMemo(
    () =>
      new Set(
        index.people.flatMap(({ person }) =>
          person.ledBy === null ? [] : [person.ledBy.employeeId],
        ),
      ),
    [index],
  );

  /* Those whose reports are folded away. Everybody else's are drawn. */
  const [folded, setFolded] = useState<ReadonlySet<string>>(() =>
    openTo(firstFolded(index, chart.total), index, focusId),
  );
  const [zoom, setZoom] = useState(1);
  const [found, setFound] = useState<string | undefined>(focusId);
  const [search, setSearch] = useState('');

  const viewport = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);

  /* Who to bring into view once the cards are where they are going to be. */
  const centreOn = useRef<string | undefined>(focusId ?? chart.lines[0].top.employeeId);
  /* The point under the pointer, or the middle, that a change of zoom keeps where it is. */
  const anchor = useRef<{ x: number; y: number; atX: number; atY: number } | undefined>(undefined);
  /* The zoom a wheel event reads, which is not the one its closure was made with. Set by
     `zoomTo`, the only thing that changes it. */
  const zoomNow = useRef(zoom);

  /* Somebody new in the address while the chart is open: back and forward between two people. */
  useEffect(() => {
    if (focusId !== undefined && index.above.has(focusId)) {
      setFolded((was) => openTo(was, index, focusId));
      setFound(focusId);
      centreOn.current = focusId;
    }
  }, [focusId, index]);

  /* After every redraw: keep the anchor still through a zoom, then centre whoever was asked for. */
  useLayoutEffect(() => {
    const port = viewport.current;

    if (port === null) {
      return;
    }

    if (anchor.current !== undefined) {
      port.scrollLeft = anchor.current.x * zoom - anchor.current.atX;
      port.scrollTop = anchor.current.y * zoom - anchor.current.atY;
      anchor.current = undefined;
    }

    const wanted = centreOn.current;
    centreOn.current = undefined;

    const card =
      wanted === undefined
        ? null
        : port.querySelector<HTMLElement>(`[data-employee-id="${CSS.escape(wanted)}"]`);

    if (card !== null) {
      centre(port, card);

      /* Only when somebody was asked for: opening the chart should not take the focus. */
      if (wanted === found) {
        card.focus({ preventScroll: true });
      }
    }
  }, [zoom, folded, found]);

  const zoomTo = useCallback((next: number, at?: { x: number; y: number }) => {
    const port = viewport.current;
    const from = zoomNow.current;
    const to = Math.round(Math.min(ZOOM_MOST, Math.max(ZOOM_LEAST, next)) * 100) / 100;

    if (port === null || to === from) {
      return false;
    }

    const atX = at?.x ?? port.clientWidth / 2;
    const atY = at?.y ?? port.clientHeight / 2;

    anchor.current = {
      x: (port.scrollLeft + atX) / from,
      y: (port.scrollTop + atY) / from,
      atX,
      atY,
    };
    zoomNow.current = to;
    setZoom(to);

    return true;
  }, []);

  /* Ctrl and the wheel, or a pinch on a trackpad, which arrives as the same thing. Not
     passive, or the browser would zoom the whole page as well. */
  useEffect(() => {
    const port = viewport.current;

    if (port === null) {
      return;
    }

    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }

      event.preventDefault();

      const box = port.getBoundingClientRect();

      zoomTo(zoomNow.current * (event.deltaY < 0 ? 1.1 : 1 / 1.1), {
        x: event.clientX - box.left,
        y: event.clientY - box.top,
      });
    };

    port.addEventListener('wheel', wheel, { passive: false });

    return () => {
      port.removeEventListener('wheel', wheel);
    };
  }, [zoomTo]);

  /** Shrinks the chart until all of it is in view, and no larger than as drawn. */
  const fit = () => {
    const port = viewport.current;
    const canvas = port?.firstElementChild;

    if (port === null || !(canvas instanceof HTMLElement)) {
      return;
    }

    const width = canvas.scrollWidth / zoomNow.current;
    const height = canvas.scrollHeight / zoomNow.current;
    const head = chart.lines[0].top.employeeId;

    if (zoomTo(Math.min(1, port.clientWidth / width, port.clientHeight / height))) {
      centreOn.current = head;
    } else {
      const card = port.querySelector<HTMLElement>(`[data-employee-id="${CSS.escape(head)}"]`);

      if (card !== null) {
        centre(port, card);
      }
    }
  };

  const jumpTo = (employeeId: string) => {
    setFolded((was) => openTo(was, index, employeeId));
    setFound(employeeId);
    setSearch('');
    centreOn.current = employeeId;
  };

  const toggle = (employeeId: string) => {
    setFolded((was) => {
      const now = new Set(was);

      if (!now.delete(employeeId)) {
        now.add(employeeId);
      }

      return now;
    });
  };

  const foldEverything = () => {
    /* All but the top of each line, so there is still a shape to open. */
    setFolded(
      new Set(
        index.people
          .filter((one) => one.depth > 1 && one.person.reports.length > 0)
          .map((one) => one.person.employeeId),
      ),
    );
    centreOn.current = chart.lines[0].top.employeeId;
  };

  const openEverything = () => {
    setFolded(new Set());
  };

  const pan = usePanning(viewport);

  /* The search, over names and job titles. */
  const terms = fold(search).split(/\s+/).filter(Boolean);
  const matches =
    terms.length === 0
      ? []
      : index.people.filter((one) => terms.every((term) => one.text.includes(term)));

  const searchKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && matches.length > 0) {
      event.preventDefault();
      jumpTo(matches[0].person.employeeId);
    } else if (event.key === 'ArrowDown' && matches.length > 0) {
      event.preventDefault();
      event.currentTarget
        .closest('.org-search')
        ?.querySelector<HTMLButtonElement>('.org-matches button')
        ?.focus();
    } else if (event.key === 'Escape') {
      setSearch('');
    }
  };

  return (
    <>
      <div className="org-controls">
        <div className="org-search">
          <label className="filter-search">
            <span className="visually-hidden">Find somebody on the chart</span>
            <Icon name="search" />
            <input
              ref={searchBox}
              type="search"
              value={search}
              placeholder="Find somebody by name"
              autoComplete="off"
              onChange={(event) => {
                setSearch(event.target.value);
              }}
              onKeyDown={searchKeys}
            />
          </label>

          {terms.length === 0 ? null : (
            <ul className="org-matches">
              {matches.length === 0 ? (
                <li className="muted">Nobody on the chart matches "{search.trim()}".</li>
              ) : (
                matches.slice(0, MATCHES_SHOWN).map(({ person }) => (
                  <li key={person.employeeId}>
                    <button
                      type="button"
                      onClick={() => {
                        jumpTo(person.employeeId);
                      }}
                      onKeyDown={(event) => {
                        const item = event.currentTarget.parentElement;
                        const next =
                          event.key === 'ArrowDown'
                            ? item?.nextElementSibling
                            : event.key === 'ArrowUp'
                              ? item?.previousElementSibling
                              : undefined;

                        if (event.key === 'Escape') {
                          setSearch('');
                          searchBox.current?.focus();
                        } else if (next !== undefined) {
                          event.preventDefault();
                          if (next === null && event.key === 'ArrowUp') {
                            searchBox.current?.focus();
                          } else {
                            next?.querySelector('button')?.focus();
                          }
                        }
                      }}
                    >
                      <Avatar person={person} />
                      <span>
                        <strong>
                          {person.firstName} {person.lastName}
                        </strong>
                        {person.jobTitle === null ? null : <small>{person.jobTitle}</small>}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}

          <p className="visually-hidden" aria-live="polite">
            {terms.length === 0 ? '' : `${String(matches.length)} found`}
          </p>
        </div>

        <div className="org-buttons">
          <div className="org-zoom" role="group" aria-label="Zoom">
            <button
              type="button"
              aria-label="Zoom out"
              disabled={zoom <= ZOOM_LEAST}
              onClick={() => {
                zoomTo(zoom - ZOOM_STEP);
              }}
            >
              −
            </button>
            <button
              type="button"
              className="org-zoom-level"
              aria-label={`Zoom ${String(Math.round(zoom * 100))}%. Reset to 100%`}
              onClick={() => {
                zoomTo(1);
              }}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              aria-label="Zoom in"
              disabled={zoom >= ZOOM_MOST}
              onClick={() => {
                zoomTo(zoom + ZOOM_STEP);
              }}
            >
              +
            </button>
            <button type="button" onClick={fit}>
              Fit
            </button>
          </div>

          <button type="button" onClick={openEverything} disabled={folded.size === 0}>
            Expand all
          </button>
          <button type="button" onClick={foldEverything}>
            Collapse all
          </button>
        </div>
      </div>

      {/* Focusable, so the arrow keys scroll it for somebody without a mouse. */}
      <div
        ref={viewport}
        className="org-viewport"
        role="region"
        aria-label="Organisation chart"
        tabIndex={0}
        {...pan}
      >
        <div className="org-canvas" style={{ zoom }}>
          {chart.lines.map((line) => (
            <section className="org-line" key={line.top.employeeId}>
              {line.standing === 'HEAD_OF_THE_ORGANISATION' ? null : (
                <p className="notice org-flag">{flagFor(line)}</p>
              )}
              <ul className="org-tree">
                <Branch
                  person={line.top}
                  leads={leads}
                  folded={folded}
                  found={found}
                  onToggle={toggle}
                />
              </ul>
            </section>
          ))}
        </div>
      </div>

      {/* Under the chart, and only while there is a team lead on it to explain. */}
      {leads.size === 0 ? null : (
        <ul className="org-legend" aria-label="What the stars mean">
          <li>
            <span className="org-star is-lead" aria-hidden="true">
              <Icon name="lead" />
            </span>
            Team lead
          </li>
          <li>
            <span className="org-star is-led" aria-hidden="true">
              <Icon name="lead" />
            </span>
            Team member
          </li>
        </ul>
      )}
    </>
  );
}

/** One person, and under them everybody whose reports are not folded away. */
function Branch({
  person,
  leads,
  folded,
  found,
  onToggle,
}: {
  person: ChartPerson;
  /** Team leads with a team drawn beside them, who get the filled mark. */
  leads: ReadonlySet<string>;
  folded: ReadonlySet<string>;
  found: string | undefined;
  onToggle: (employeeId: string) => void;
}) {
  const name = `${person.firstName} ${person.lastName}`;
  const count = person.reports.length;
  const open = count > 0 && !folded.has(person.employeeId);
  /* The star in the corner, and what it says when pointed at: the lead's department, or the
     lead somebody is drawn beside. Also read out, since a screen reader cannot point. */
  const star = leads.has(person.employeeId)
    ? { kind: 'is-lead', says: `${person.department.name} team lead` }
    : person.ledBy === null
      ? undefined
      : { kind: 'is-led', says: `Led by ${person.ledBy.firstName} ${person.ledBy.lastName}` };

  return (
    <li>
      <div className="org-node">
        <a
          className={`org-card${found === person.employeeId ? ' is-found' : ''}${
            star === undefined ? '' : ` ${star.kind}`
          }`}
          href={profileAddress(person)}
          data-employee-id={person.employeeId}
          draggable={false}
        >
          <Avatar person={person} />
          <span>
            <strong>{name}</strong>
            {person.jobTitle === null ? null : <small>{person.jobTitle}</small>}
            {star === undefined ? null : <span className="visually-hidden">{star.says}</span>}
          </span>
          {star === undefined ? null : (
            <span className={`org-star ${star.kind}`} data-says={star.says} aria-hidden="true">
              <Icon name="lead" />
            </span>
          )}
        </a>

        {count === 0 ? null : (
          <button
            type="button"
            className="org-toggle"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} the ${String(count)} ${
              count === 1 ? 'person' : 'people'
            } reporting to ${name}`}
            onClick={() => {
              onToggle(person.employeeId);
            }}
          >
            {open ? <Icon name="up" /> : `+${String(count)}`}
          </button>
        )}
      </div>

      {open ? (
        <ul>
          {person.reports.map((report) => (
            <Branch
              key={report.employeeId}
              person={report}
              leads={leads}
              folded={folded}
              found={found}
              onToggle={onToggle}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** What is wrong with a line that is not the head's, in words anybody can pass on to HR. */
function flagFor(line: ChartLine): string {
  const name = `${line.top.firstName} ${line.top.lastName}`;

  switch (line.standing) {
    case 'SECOND_HEAD':
      return `${name} has no manager on their record, and only the head of the organisation should have none. Worth telling HR: leave requests follow this line.`;
    case 'MANAGER_NOT_ON_THE_CHART':
      return `${name} reports to somebody who is not on the chart, usually because they have left. Worth telling HR: leave requests follow this line.`;
    case 'REPORTING_LINE_LOOPS':
      return `The reporting line above ${name} goes round in a circle and never reaches the top. Worth telling HR: leave requests follow this line.`;
    default:
      return '';
  }
}

/* ------------------------------------------------------------------ the shape */

/** Everybody, walked once. An explicit stack, as the server builds it. */
function indexOf(chart: StaffChart): Index {
  const people: Index['people'] = [];
  const above = new Map<string, string | null>();
  const pending = chart.lines.map((line) => ({
    person: line.top,
    parent: null as string | null,
    depth: 1,
  }));

  while (pending.length > 0) {
    const { person, parent, depth } = pending.pop() as (typeof pending)[number];

    above.set(person.employeeId, parent);
    people.push({
      person,
      depth,
      text: fold(`${person.firstName} ${person.lastName} ${person.jobTitle ?? ''}`),
    });

    for (const report of person.reports) {
      pending.push({ person: report, parent: person.employeeId, depth: depth + 1 });
    }
  }

  people.sort(
    (a, b) =>
      names.compare(a.person.lastName, b.person.lastName) ||
      names.compare(a.person.firstName, b.person.firstName),
  );

  return { people, above };
}

const names = new Intl.Collator('en', { sensitivity: 'base' });

/** Who starts folded: nobody in a small organisation, everybody below the top two in a large one. */
function firstFolded(index: Index, total: number): ReadonlySet<string> {
  if (total <= OPEN_IN_FULL) {
    return new Set();
  }

  return new Set(
    index.people
      .filter((one) => one.depth >= LEVELS_OPEN && one.person.reports.length > 0)
      .map((one) => one.person.employeeId),
  );
}

/** The same, with every manager above somebody unfolded so that they are drawn. */
function openTo(
  folded: ReadonlySet<string>,
  index: Index,
  employeeId: string | undefined,
): ReadonlySet<string> {
  const now = new Set(folded);
  let at = employeeId === undefined ? null : (index.above.get(employeeId) ?? null);

  while (at !== null) {
    now.delete(at);
    at = index.above.get(at) ?? null;
  }

  return now;
}

/** Scrolls the chart so a card is in the middle of it, and the page so the card is in view. */
function centre(port: HTMLElement, card: HTMLElement): void {
  const box = card.getBoundingClientRect();
  const view = port.getBoundingClientRect();

  port.scrollLeft += box.left + box.width / 2 - (view.left + view.width / 2);
  port.scrollTop += box.top + box.height / 2 - (view.top + view.height / 2);

  /* On a phone the chart is as tall as it needs to be and the page is what scrolls. */
  card.scrollIntoView({
    block: port.scrollHeight > port.clientHeight ? 'nearest' : 'center',
    inline: 'nearest',
  });
}

/**
 * Dragging the chart about with the mouse.
 *
 * A touch screen scrolls it already, and a pen is left to do what a pen does. A press that
 * moves is a drag and not a click, so letting go over somebody's card does not open their
 * profile.
 */
function usePanning(viewport: RefObject<HTMLDivElement | null>) {
  const drag = useRef<
    { x: number; y: number; left: number; top: number; moved: boolean } | undefined
  >(undefined);
  const swallowClick = useRef(false);

  return {
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      const port = viewport.current;

      if (
        port === null ||
        event.pointerType !== 'mouse' ||
        event.button !== 0 ||
        (event.target as HTMLElement).closest('button, input') !== null
      ) {
        return;
      }

      drag.current = {
        x: event.clientX,
        y: event.clientY,
        left: port.scrollLeft,
        top: port.scrollTop,
        moved: false,
      };
    },

    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      const port = viewport.current;
      const from = drag.current;

      if (port === null || from === undefined) {
        return;
      }

      const dx = event.clientX - from.x;
      const dy = event.clientY - from.y;

      if (!from.moved) {
        if (Math.hypot(dx, dy) < DRAG_FROM) {
          return;
        }

        from.moved = true;
        port.setPointerCapture(event.pointerId);
        port.classList.add('is-panning');
      }

      port.scrollLeft = from.left - dx;
      port.scrollTop = from.top - dy;
    },

    onPointerUp() {
      const port = viewport.current;

      swallowClick.current = drag.current?.moved === true;
      drag.current = undefined;
      port?.classList.remove('is-panning');
    },

    onPointerCancel() {
      drag.current = undefined;
      viewport.current?.classList.remove('is-panning');
    },

    onClickCapture(event: MouseEvent<HTMLDivElement>) {
      if (swallowClick.current) {
        swallowClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
}
