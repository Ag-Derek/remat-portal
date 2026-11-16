/** The marks in the rail, on the cards and in the buttons. */

/**
 * One glyph per name, inline rather than an icon package.
 *
 * `aria-hidden` always — each sits beside its own label. NFR USA 03.
 */
export type IconName =
  /* The rail. */
  | 'balances'
  | 'ask'
  | 'requests'
  | 'calendar'
  | 'approvals'
  | 'settings'
  | 'holiday'
  /* Kinds of leave, matched on the name by `iconForLeaveType`. */
  | 'annual'
  | 'sick'
  | 'compassionate'
  | 'maternity'
  | 'paternity'
  | 'study'
  | 'unpaid'
  /* On the cards and in the controls. */
  | 'info'
  | 'people'
  | 'lead'
  | 'stage'
  | 'tick'
  | 'cross'
  | 'send'
  | 'clip'
  | 'upload'
  | 'again'
  | 'plus'
  | 'pencil'
  | 'up'
  | 'down'
  | 'report'
  | 'download'
  | 'history'
  | 'search'
  | 'mail'
  | 'list'
  | 'bin'
  /* Showing and hiding a password as it is typed. */
  | 'eye'
  | 'eye-off'
  /* Back to where a screen was opened from. */
  | 'back'
  /* Putting up a photo. */
  | 'camera'
  /* Copying something to the clipboard. */
  | 'copy'
  /* Clients setup's sections. */
  | 'checklist'
  | 'exit-reasons';

const PATHS: Record<IconName, string> = {
  /** What you have: a calendar with days counted on it. */
  balances: 'M4 5h16v15H4zM4 10h16M8 3v4M16 3v4',
  /** Asking: something sent. */
  ask: 'M21 3 10.5 13.5M21 3l-6.5 18-4-8-8-4z',
  /** What you asked for: a page with lines on it. */
  requests: 'M6 3h12v18H6zM9.5 8h5M9.5 12h5M9.5 16h3',
  /** Who is away: people. */
  calendar:
    'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20a7 7 0 0 1 14 0M17 4.5a3.5 3.5 0 0 1 0 7M18 20a6.5 6.5 0 0 0-2-4.7',
  /** Waiting on you: a clock, because what it is about is how long it has been sitting there. */
  approvals: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2',
  /** Setting the rules up: sliders, because each one is a value being set. */
  settings: 'M4 7h10M18 7h2M4 17h2M10 17h10M16 4.5v5M8 14.5v5',
  /** The calendar of `balances`, with one day ringed on it. */
  holiday:
    'M4 5h16v15H4zM4 10h16M8 3v4M16 3v4M12 17.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5z',

  annual: 'M4 5h16v15H4zM4 10h16M8 3v4M16 3v4',
  sick: 'M12 6.5h5M14.5 4v5M4.5 4.5h4v5.5a3 3 0 0 0 6 0M8.5 10v3a5 5 0 0 0 10 0v-1',
  compassionate: 'M12 20s-7-4.4-7-9.2A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.8C19 15.6 12 20 12 20z',
  maternity:
    'M12 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM12 9c-2.5 0-4 2-4 4.5S9 21 12 21s4-4 4-7.5S14.5 9 12 9zM12 13v4',
  paternity:
    'M12 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM9 21v-5H7.5V12a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v4H15v5z',
  study: 'M12 4 2.5 8.5 12 13l9.5-4.5zM6.5 11v5c0 1.5 2.5 3 5.5 3s5.5-1.5 5.5-3v-5',
  unpaid: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12h8',

  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.75v.5',
  people:
    'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20a7 7 0 0 1 14 0M17 4.5a3.5 3.5 0 0 1 0 7M18 20a6.5 6.5 0 0 0-2-4.7',
  /** A team lead on the organisation chart, filled on the lead and outlined on their team. */
  lead: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
  /** The chain a request walks up. FR 38a. */
  stage:
    'M12 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM12 8v3M12 11H7a2 2 0 0 0-2 2v2M12 11h5a2 2 0 0 1 2 2v2M5 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM19 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  tick: 'M4.5 12.5 9.5 17.5 19.5 6.5',
  cross: 'M6 6l12 12M18 6 6 18',
  send: 'M21 3 10.5 13.5M21 3l-6.5 18-4-8-8-4z',
  clip: 'M20 11.5 12 19.5a5 5 0 0 1-7-7l8.5-8.5a3.4 3.4 0 0 1 5 5L10 17.5a1.8 1.8 0 0 1-2.5-2.5l8-8',
  upload: 'M12 16V4m0 0L8 8m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  /** A photo of you: a camera body with its lens. */
  camera: 'M4 8h3l1.5-2.5h7L17 8h3v11H4zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  /** Trying the same thing again. */
  again: 'M20 12a8 8 0 1 1-2.6-5.9M20 3.5V8h-4.5',
  /** Adding one. */
  plus: 'M12 5v14M5 12h14',
  /** Changing one: a pencil over the line it is writing on. */
  pencil: 'M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16zM14 6l4 4',
  /** A step moving up or down an approval chain. */
  up: 'M6 15l6-6 6 6',
  /** Back: `up` turned to face left. */
  back: 'M15 18l-6-6 6-6',
  down: 'M6 9l6 6 6-6',
  /** HR's reports: a bar chart. */
  report: 'M4 20h16M7 16v-5M12 16V6M17 16v-8',
  /** Saving a file: `upload` the other way. */
  download: 'M12 4v12m0 0-4-4m4 4 4-4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  /** The audit log: a clock turning back. */
  history: 'M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 3.5V8H8M12 7.5V12l3 2',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  /** An email: an envelope. */
  mail: 'M3 6h18v12H3zM3 7l9 6.5L21 7',
  /** Copying: one page over another. */
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  /** A bulleted list. */
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  /** Removing one: a bin with its lid. */
  bin: 'M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5',
  /** Clients checklists: a clipboard, its clip on top, one item ticked and one still to do. */
  checklist:
    'M8.5 5H6.5A1.5 1.5 0 0 0 5 6.5v13A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 17.5 5h-2M9.5 3h5a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-.5.5h-5a.5.5 0 0 1-.5-.5v-2a.5.5 0 0 1 .5-.5zM8 11.5l1.5 1.5 2.5-2.75M14 11.75h2.5M8.25 15.5h2.5V18h-2.5zM14 16.75h2.5',
  /** Clients lost and exit reasons: a list of reasons, open on one side, and the way out of it. */
  'exit-reasons':
    'M15 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19H15M8 9h4.5M8 12h3.5M8 15h4.5M14.5 12H21M18.5 9.5 21 12l-2.5 2.5',
  /** The password is hidden; pressing shows it. */
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  /** The password is showing; pressing hides it again. */
  'eye-off':
    'M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.8 9.8 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d={PATHS[name]}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Which glyph a kind of leave gets.
 *
 * Matched on the name the server sent rather than on a list of codes this file keeps: HR
 * creates leave types, so an unrecognised one is the ordinary case and gets the calendar.
 */
export function iconForLeaveType(name: string): IconName {
  const said = name.toLowerCase();

  if (said.includes('sick')) return 'sick';
  if (said.includes('compassionate') || said.includes('bereave')) return 'compassionate';
  if (said.includes('matern')) return 'maternity';
  if (said.includes('patern')) return 'paternity';
  if (said.includes('study') || said.includes('exam')) return 'study';
  if (said.includes('unpaid')) return 'unpaid';

  return 'annual';
}
