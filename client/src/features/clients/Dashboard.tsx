import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  type ClientsDashboard,
  clientsDashboard,
  type ClientsHolder,
  clientsHolders,
  isNotSignedIn,
  moveEverything,
  type PocHealth,
} from '../../api';
import { money } from '../../format';
import { Notice, type Problem, problemFrom } from '../../problem';
import { STAGE_NAME } from './Deals';
import { FLAG_NAME, HEALTH_NAME, HealthPill } from './PocsView';
import { Count, MoneyLines, NoValue, Tile, Tiles } from './Tiles';
import { Dialog, DialogFoot, Field, standingInWords, useSending } from './ui';

/**
 * The dashboard (CLI 102): numbers first, then charts, with as few words as will do (the user, 24
 * November 2026). The whole company, unfiltered. #289.
 *
 * - Five tiles: the value recorded per currency, with a chip for deals with none; open deals;
 *   clients; POCs running; clients gone quiet, with those never contacted under it.
 * - Deals by stage: a bar per open stage as long as its count, the count at its tip and the
 *   value recorded beside it.
 * - POC health: one bar split On Track, At Risk, Stalled, with a legend of counts, and the POCs
 *   needing a look under it.
 * - Gone quiet: the quietest clients, a bar as long as the days since anybody spoke to them.
 * - Needs reassignment, where somebody does: each person, why, what they hold, and Move all.
 *
 * Each bar names its figures on hover, and every figure is printed too, so nothing is read from
 * colour alone. On a phone the panels stack (NFR CLI USA 02).
 */
export function Dashboard({ onSignedOut }: { onSignedOut: () => void }) {
  const [dashboard, setDashboard] = useState<ClientsDashboard | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);

  const load = useCallback(() => {
    clientsDashboard()
      .then((found) => {
        setDashboard(found);
        setProblem(undefined);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setProblem(problemFrom(error));
      });
  }, [onSignedOut]);

  useEffect(load, [load]);

  if (dashboard === undefined) {
    return problem === undefined ? null : <Notice problem={problem} onRetry={load} />;
  }

  const running = HEALTHS.reduce((sum, health) => sum + dashboard.pocs.health[health], 0);

  return (
    <section className="clients-dashboard" aria-label="Dashboard">
      {problem === undefined ? null : <Notice problem={problem} onRetry={load} />}

      <Tiles>
        <Tile label="Recorded value" under={<NoValue totals={dashboard.totals} />}>
          <MoneyLines amounts={dashboard.totals.recorded} />
        </Tile>
        <Tile label="Open deals">
          <Count of={dashboard.totals.opportunities} />
        </Tile>
        <Tile label="Clients">
          <Count of={dashboard.totals.clients} />
        </Tile>
        <Tile label="POCs running">
          <Count of={running} />
        </Tile>
        <Tile
          label="Gone quiet"
          under={
            dashboard.neverContacted === 0 ? null : (
              <small className="clients-tile-under">
                +{dashboard.neverContacted} never contacted
              </small>
            )
          }
        >
          <Count of={dashboard.quiet.length} />
        </Tile>
      </Tiles>

      <div className="clients-dashboard-pair">
        <Stages stages={dashboard.stages} />
        <PocHealthChart pocs={dashboard.pocs} running={running} />
      </div>

      <div className="clients-dashboard-pair">
        <GoneQuiet quiet={dashboard.quiet} />
        {dashboard.reassign.length === 0 ? null : (
          <NeedsReassignment
            reassign={dashboard.reassign}
            onMoved={load}
            onSignedOut={onSignedOut}
          />
        )}
      </div>
    </section>
  );
}

/** A panel with a short title and nothing else said about it. */
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="clients-panel clients-chart" aria-label={title}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** Each open stage: its name, a bar as long as its count, the count, and its value recorded. */
function Stages({ stages }: { stages: ClientsDashboard['stages'] }) {
  const most = Math.max(1, ...stages.map((one) => one.opportunities));

  return (
    <Panel title="Deals by stage">
      <ul className="clients-bars">
        {stages.map((one) => {
          const value = one.recorded.map((amount) => money(amount)).join(' · ');

          return (
            <li
              key={one.stage}
              title={`${STAGE_NAME[one.stage]}: ${String(one.opportunities)} ${
                one.opportunities === 1 ? 'deal' : 'deals'
              }${value === '' ? '' : `, ${value}`}`}
            >
              <span className="clients-bar-name">{STAGE_NAME[one.stage]}</span>
              <span className="clients-bar-track" aria-hidden="true">
                {one.opportunities === 0 ? null : (
                  <span style={{ width: `${String((one.opportunities / most) * 100)}%` }} />
                )}
              </span>
              <span className="clients-bar-figure">
                <strong className={one.opportunities === 0 ? 'muted' : undefined}>
                  {one.opportunities}
                </strong>
                {value === '' ? null : <small>{value}</small>}
              </span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

const HEALTHS: PocHealth[] = ['ON_TRACK', 'AT_RISK', 'STALLED'];

/** "is-on-track", for a segment and a legend swatch. */
function healthClass(health: PocHealth): string {
  return `is-${health.toLowerCase().replace('_', '-')}`;
}

/**
 * One bar split by health, each part as wide as its count, a legend of the counts under it, then
 * every POC At Risk, Stalled or flagged.
 */
function PocHealthChart({ pocs, running }: { pocs: ClientsDashboard['pocs']; running: number }) {
  return (
    <Panel title="POC health">
      {running === 0 ? (
        <p className="muted">No POCs running.</p>
      ) : (
        <>
          <div
            className="clients-segments"
            role="img"
            aria-label={HEALTHS.map(
              (health) => `${String(pocs.health[health])} ${HEALTH_NAME[health]}`,
            ).join(', ')}
          >
            {HEALTHS.filter((health) => pocs.health[health] > 0).map((health) => (
              <span
                key={health}
                className={healthClass(health)}
                style={{ flexGrow: pocs.health[health] }}
                title={`${HEALTH_NAME[health]}: ${String(pocs.health[health])}`}
              />
            ))}
          </div>
          <ul className="clients-legend">
            {HEALTHS.map((health) => (
              <li key={health}>
                <span className={`clients-swatch ${healthClass(health)}`} aria-hidden="true" />
                <strong>{pocs.health[health]}</strong> {HEALTH_NAME[health]}
              </li>
            ))}
          </ul>

          {pocs.attention.length === 0 ? null : (
            <ul className="clients-dash-rows">
              {pocs.attention.map((poc) => {
                const flags = poc.flags.map((flag) => FLAG_NAME[flag.kind]);

                return (
                  <li key={poc.id}>
                    <a href={`#/clients/poc/${poc.id}`}>
                      {poc.client.name} · {poc.deal.productName}
                    </a>
                    <span className="clients-dash-row-end">
                      {flags.length === 0 ? null : (
                        <span className="clients-tile-chip is-warn" title={flags.join('\n')}>
                          {flags.length} {flags.length === 1 ? 'flag' : 'flags'}
                          <span className="visually-hidden">: {flags.join('; ')}</span>
                        </span>
                      )}
                      <HealthPill health={poc.health} />
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Panel>
  );
}

/** How many quiet clients show before "+N more". */
const QUIET_SHOWN = 5;

/** The quietest clients first, a bar as long as the days since anybody spoke to them. */
function GoneQuiet({ quiet }: { quiet: ClientsDashboard['quiet'] }) {
  const [all, setAll] = useState(false);
  const longest = Math.max(1, ...quiet.map((client) => client.daysAgo));
  const shown = all ? quiet : quiet.slice(0, QUIET_SHOWN);

  return (
    <Panel title="Gone quiet">
      {quiet.length === 0 ? (
        <p className="muted">Nobody quiet over 30 days.</p>
      ) : (
        <>
          <ul className="clients-bars is-quiet">
            {shown.map((client) => (
              <li key={client.id} title={`Last contact ${client.lastContact}`}>
                <a className="clients-bar-name" href={`#/clients/client/${client.id}`}>
                  {client.name}
                </a>
                <span className="clients-bar-track" aria-hidden="true">
                  <span style={{ width: `${String((client.daysAgo / longest) * 100)}%` }} />
                </span>
                <span className="clients-bar-figure">
                  <strong>{client.daysAgo}d</strong>
                  <span className="visually-hidden"> since anybody spoke to them</span>
                </span>
              </li>
            ))}
          </ul>
          {quiet.length <= QUIET_SHOWN ? null : (
            <button
              type="button"
              className="clients-more"
              onClick={() => {
                setAll(!all);
              }}
            >
              {all ? 'Show fewer' : `+${String(quiet.length - QUIET_SHOWN)} more`}
            </button>
          )}
        </>
      )}
    </Panel>
  );
}

/**
 * Each person who can no longer look after what is theirs (CLI 96): why, how much, and Move all.
 * What they hold opens under the count, each item linking to its page.
 */
function NeedsReassignment({
  reassign,
  onMoved,
  onSignedOut,
}: {
  reassign: ClientsDashboard['reassign'];
  onMoved: () => void;
  onSignedOut: () => void;
}) {
  const [moving, setMoving] = useState<ClientsDashboard['reassign'][number] | undefined>(undefined);

  return (
    <Panel title="Needs reassignment">
      <ul className="clients-dash-rows is-people">
        {reassign.map((one) => (
          <li key={one.person.id}>
            <div className="clients-dash-person">
              <strong>{one.person.name}</strong>
              <span className="clients-tile-chip">{standingInWords(one.standing)}</span>
              {one.mayMoveAll ? (
                <button
                  type="button"
                  onClick={() => {
                    setMoving(one);
                  }}
                >
                  Move all to…
                </button>
              ) : null}
            </div>
            <details>
              <summary>{countedInWords(one)}</summary>
              <ul>
                {one.clients.map((client) => (
                  <li key={`c${client.id}`}>
                    <a href={`#/clients/client/${client.id}`}>{client.name}</a>{' '}
                    <small className="muted">client</small>
                  </li>
                ))}
                {one.deals.map((deal) => (
                  <li key={`d${deal.id}`}>
                    <a href={`#/clients/client/${deal.client.id}`}>
                      {deal.client.name} · {deal.productName}
                    </a>{' '}
                    <small className="muted">deal</small>
                  </li>
                ))}
                {one.pocs.map((poc) => (
                  <li key={`p${poc.id}`}>
                    <a href={`#/clients/poc/${poc.id}`}>
                      {poc.client.name} · {poc.productName}
                    </a>{' '}
                    <small className="muted">POC</small>
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>
      {moving === undefined ? null : (
        <MoveAllDialog
          one={moving}
          onClose={() => {
            setMoving(undefined);
          }}
          onMoved={() => {
            setMoving(undefined);
            onMoved();
          }}
          onSignedOut={onSignedOut}
        />
      )}
    </Panel>
  );
}

/** "1 client, 2 open deals and 1 POC". */
function countedInWords(one: ClientsDashboard['reassign'][number]): string {
  const parts = (
    [
      [one.clients.length, 'client', 'clients'],
      [one.deals.length, 'open deal', 'open deals'],
      [one.pocs.length, 'POC', 'POCs'],
    ] as const
  )
    .filter(([count]) => count !== 0)
    .map(([count, single, many]) => `${String(count)} ${count === 1 ? single : many}`);

  const last = parts.pop();
  return last === undefined
    ? 'Nothing'
    : parts.length === 0
      ? last
      : `${parts.join(', ')} and ${last}`;
}

/**
 * Moving every client, open deal and running POC of one person's to somebody who could take them
 * over, at once (#289). Each goes as it would on its own: a client with its own open steps, a deal
 * with the old owner's open steps on it and its POC, a POC with its review meetings.
 */
function MoveAllDialog({
  one,
  onClose,
  onMoved,
  onSignedOut,
}: {
  one: ClientsDashboard['reassign'][number];
  onClose: () => void;
  onMoved: () => void;
  onSignedOut: () => void;
}) {
  const [people, setPeople] = useState<ClientsHolder[] | undefined>(undefined);
  const [toId, setToId] = useState('');
  const sending = useSending(onMoved, onSignedOut);
  const other = sending.other(['toId']);

  useEffect(() => {
    clientsHolders()
      .then(setPeople)
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) onSignedOut();
      });
  }, [onSignedOut]);

  const able = (people ?? []).filter((person) => person.canTakeOver && person.id !== one.person.id);

  return (
    <Dialog
      title={`Move everything of ${one.person.name}’s`}
      intro={`${countedInWords(one)} ${
        one.clients.length + one.deals.length + one.pocs.length === 1 ? 'moves' : 'move'
      }, each with its open steps. A POC’s review meetings go to its new CS lead.`}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          sending.send(() => moveEverything(one.person.id, toId));
        }}
      >
        <Field label="Move to" error={sending.errorFor('toId')}>
          {({ id, describedBy }) => (
            <select
              id={id}
              value={toId}
              aria-describedby={describedBy}
              disabled={sending.busy || people === undefined}
              onChange={(event) => {
                setToId(event.target.value);
              }}
            >
              <option value="">Choose somebody</option>
              {able.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        {other === undefined ? null : <Notice problem={other} />}
        <DialogFoot
          busy={sending.busy}
          disabled={toId === ''}
          doing="Moving…"
          done="Move all"
          onCancel={onClose}
        />
      </form>
    </Dialog>
  );
}
