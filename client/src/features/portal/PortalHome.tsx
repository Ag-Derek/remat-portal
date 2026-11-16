import type { Me } from '../../api';

/** The portal's front page: where signing in lands, and the way into each app. */
export function PortalHome({
  me,
  initials,
  clients,
  onSignOut,
}: {
  me: Me;
  initials: string;
  /**
   * Whether the clients card is drawn: for whoever the server says may see it, and for nobody
   * else, who are never shown it is there (#274, CLI 93). Nobody in a build until it goes live.
   */
  clients: boolean;
  onSignOut: () => void;
}) {
  return (
    <div className="portal">
      <header className="portal-bar">
        <div className="portal-bar-inner">
          <a className="portal-name" href="#/">
            Remat Portal
          </a>

          <p className="whoami">
            <span className="whoami-name">
              {me.firstName} {me.lastName}
            </span>
            <span className="avatar" aria-hidden="true">
              {initials}
            </span>
          </p>

          <button type="button" className="linkish" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <main className="portal-page">
        <h1>Hello, {me.firstName}</h1>

        <ul className="portal-apps">
          <li>
            <a className="portal-app" href="#/balances">
              <RotaMark />
              Rota
            </a>
          </li>
          <li>
            <a className="portal-app" href="#/directory">
              <DirectoryMark />
              Directory
            </a>
          </li>
          {clients ? (
            <li>
              <a className="portal-app" href="#/clients">
                <ClientsMark />
                Clients
              </a>
            </li>
          ) : null}
        </ul>
      </main>
    </div>
  );
}

/* Two-tone marks, ink with one part in the accent. `aria-hidden`; the name is beside each. */

function RotaMark() {
  return (
    <svg className="portal-mark" viewBox="0 0 40 40" aria-hidden="true">
      <g fill="none" strokeWidth="5" transform="rotate(-90 20 20)">
        <circle
          cx="20"
          cy="20"
          r="14"
          stroke="var(--ink)"
          strokeDasharray="65 23"
          strokeDashoffset="-23"
        />
        <circle
          cx="20"
          cy="20"
          r="14"
          stroke="var(--accent)"
          strokeDasharray="13 75"
          strokeDashoffset="-6"
        />
      </g>
    </svg>
  );
}

function DirectoryMark() {
  return (
    <svg className="portal-mark" viewBox="0 0 40 40" aria-hidden="true">
      <path d="M20 12v8M11 27v-7h18v7" fill="none" stroke="var(--ink)" strokeWidth="3" />
      <circle cx="20" cy="8" r="4" fill="var(--accent)" />
      <circle cx="11" cy="31" r="4" fill="var(--ink)" />
      <circle cx="29" cy="31" r="4" fill="var(--ink)" />
    </svg>
  );
}

/** A pipeline narrowing to the deals that go live. */
function ClientsMark() {
  return (
    <svg className="portal-mark" viewBox="0 0 40 40" aria-hidden="true">
      <rect x="6" y="8" width="28" height="6" rx="3" fill="var(--ink)" />
      <rect x="11" y="17" width="18" height="6" rx="3" fill="var(--ink)" />
      <rect x="16" y="26" width="8" height="6" rx="3" fill="var(--accent)" />
    </svg>
  );
}
