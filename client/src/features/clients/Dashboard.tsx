import { useCallback, useEffect, useState } from 'react';
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
import { PipelineSummary } from './CompanyPipeline';
import { STAGE_NAME } from './Deals';
import { decisionInWords, Flags, HEALTH_NAME, HealthPill } from './PocsView';
import { Dialog, DialogFoot, Field, standingInWords, useSending } from './ui';

/**
 * The dashboard (CLI 102), as the user's mockup lays it out: the weighted pipeline, where every open
 * deal sits by stage, the clients gone quiet, and the POCs by health. The whole company, with no
 * filters. #289.
 *
 * The figures are the company pipeline's own card, read the same way (CLI 75 to 77). Each stage
 * shows how many deals and their weighted value per currency, its bar as long as its count (the
 * user, 24 November 2026). Each client and POC named opens its page. On a phone, the two panels
 * at the bottom stack (NFR CLI USA 02).
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

  return (
    <section className="clients-dashboard" aria-label="Dashboard">
      {problem === undefined ? null : <Notice problem={problem} onRetry={load} />}

      {dashboard === undefined ? null : (
        <>
          <PipelineSummary totals={dashboard.totals} />
          {dashboard.largest.length === 0 ? null : (
            <ul className="clients-shares">
              {dashboard.largest.map((share) => (
                <LargestShare key={share.currency} share={share} />
              ))}
            </ul>
          )}
          {dashboard.reassign.length === 0 ? null : (
            <NeedsReassignment
              reassign={dashboard.reassign}
              onMoved={load}
              onSignedOut={onSignedOut}
            />
          )}
          <Stages stages={dashboard.stages} />
          <div className="clients-dashboard-pair">
            <GoneQuiet quiet={dashboard.quiet} never={dashboard.neverContacted} />
            <PocsByHealth pocs={dashboard.pocs} />
          </div>
        </>
      )}
    </section>
  );
}

/** How each currency's figure is named in a sentence. */
const FIGURE_OF: Record<ClientsDashboard['largest'][number]['currency'], string> = {
  USD: 'dollar',
  GHS: 'cedi',
};

/**
 * One currency's largest deal and its share of that currency's weighted figure (CLI 78): in red,
 * with what that means, from half the figure up (the user, 24 November 2026); a plain line below.
 */
function LargestShare({ share }: { share: ClientsDashboard['largest'][number] }) {
  const figure = FIGURE_OF[share.currency];
  const deal = (
    <>
      <a href={`#/clients/client/${share.deal.client.id}`}>{share.deal.client.name}</a>’s{' '}
      {share.deal.productName}
    </>
  );

  return (
    <li className={share.warns ? 'clients-share is-warning' : 'clients-share'}>
      {share.counted === 1 ? (
        <>
          <strong>{deal}</strong> is the only deal in the {figure} figure.
        </>
      ) : share.warns ? (
        <>
          <strong>
            {deal} is {share.percent}% of the {figure} figure.
          </strong>
        </>
      ) : (
        <>
          The largest {figure} deal, {deal}, is {share.percent}% of the {figure} figure.
        </>
      )}
      {share.warns ? ' One deal moving changes the whole number.' : null}
    </li>
  );
}

/**
 * Everybody who can no longer look after what is theirs, and why, with each client, open deal and
 * running POC of theirs, each opening the page it is moved from (CLI 96, the user, 24 November
 * 2026). Drawn only where somebody needs it.
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
    <section className="clients-panel is-attention" aria-labelledby="clients-reassign-heading">
      <header className="clients-panel-head">
        <div>
          <h3 id="clients-reassign-heading">Needs reassignment</h3>
          <p className="muted">
            Their owner or CS lead has left, or no longer has a clients role. A BD manager moves
            them.
          </p>
        </div>
      </header>
      <ul className="clients-dashboard-body clients-reassign">
        {reassign.map((one) => (
          <li key={one.person.id}>
            <div className="clients-reassign-head">
              <p>
                <strong>{one.person.name}</strong>{' '}
                <span className="clients-gap">· {standingInWords(one.standing)}</span>
              </p>
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
            <dl>
              {one.clients.length === 0 ? null : (
                <div>
                  <dt>{one.clients.length === 1 ? 'Client' : 'Clients'}</dt>
                  <dd>
                    {one.clients.map((client, at) => (
                      <span key={client.id}>
                        {at === 0 ? null : ', '}
                        <a href={`#/clients/client/${client.id}`}>{client.name}</a>
                      </span>
                    ))}
                  </dd>
                </div>
              )}
              {one.deals.length === 0 ? null : (
                <div>
                  <dt>{one.deals.length === 1 ? 'Open deal' : 'Open deals'}</dt>
                  <dd>
                    {one.deals.map((deal, at) => (
                      <span key={deal.id}>
                        {at === 0 ? null : ', '}
                        <a href={`#/clients/client/${deal.client.id}`}>
                          {deal.client.name} · {deal.productName}
                        </a>
                      </span>
                    ))}
                  </dd>
                </div>
              )}
              {one.pocs.length === 0 ? null : (
                <div>
                  <dt>{one.pocs.length === 1 ? 'POC' : 'POCs'}</dt>
                  <dd>
                    {one.pocs.map((poc, at) => (
                      <span key={poc.id}>
                        {at === 0 ? null : ', '}
                        <a href={`#/clients/poc/${poc.id}`}>
                          {poc.client.name} · {poc.productName}
                        </a>
                      </span>
                    ))}
                  </dd>
                </div>
              )}
            </dl>
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
    </section>
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

/** Each open stage: a bar as long as its count, then the count and its weighted value. */
function Stages({ stages }: { stages: ClientsDashboard['stages'] }) {
  const most = Math.max(1, ...stages.map((one) => one.opportunities));

  return (
    <section className="clients-panel" aria-labelledby="clients-stages-heading">
      <header className="clients-panel-head">
        <div>
          <h3 id="clients-stages-heading">Where everything sits</h3>
          <p className="muted">Open deals by stage, with the weighted value each stage carries.</p>
        </div>
      </header>
      <ul className="clients-stage-bars">
        {stages.map((one) => (
          <li key={one.stage}>
            <span className="clients-stage-bar-name">{STAGE_NAME[one.stage]}</span>
            <span className="clients-stage-bar-track" aria-hidden="true">
              <span
                className={one.opportunities === 0 ? 'is-empty' : undefined}
                style={{ width: `${String((one.opportunities / most) * 100)}%` }}
              />
            </span>
            <span className="clients-stage-bar-figure">
              <StageFigure figures={one} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "3 · USD 36,100 | GHS 9,000", "14 · no value recorded", or "None". */
function StageFigure({ figures }: { figures: ClientsDashboard['stages'][number] }) {
  if (figures.opportunities === 0) {
    return <span className="muted">None</span>;
  }

  return (
    <>
      <strong>{figures.opportunities}</strong>
      {' · '}
      {figures.weighted.length > 0 ? (
        figures.weighted.map((amount) => money(amount)).join(' | ')
      ) : (
        <span className="clients-gap">
          {figures.noValue === figures.opportunities ? 'no value recorded' : 'nothing weighed'}
        </span>
      )}
    </>
  );
}

/** Clients with an open deal nobody has spoken to in over 30 days, and those never spoken to. */
function GoneQuiet({ quiet, never }: { quiet: ClientsDashboard['quiet']; never: number }) {
  return (
    <section className="clients-panel" aria-labelledby="clients-quiet-heading">
      <header className="clients-panel-head">
        <div>
          <h3 id="clients-quiet-heading">Gone quiet</h3>
          <p className="muted">Clients with an open deal nobody has spoken to in over 30 days.</p>
        </div>
      </header>
      <div className="clients-dashboard-body">
        {quiet.length === 0 ? (
          <p className="muted">
            {never === 0
              ? 'Every client with an open deal has been spoken to in the last 30 days.'
              : 'Nobody has gone quiet.'}
          </p>
        ) : (
          <ul className="clients-dashboard-list">
            {quiet.map((client) => (
              <li key={client.id}>
                <a href={`#/clients/client/${client.id}`}>{client.name}</a>
                <span className="clients-gap">{client.daysAgo} days</span>
              </li>
            ))}
          </ul>
        )}
        {never === 0 ? null : (
          <p className="clients-never">
            {`${quiet.length === 0 ? '' : 'A further '}${String(never)} ${
              never === 1 ? 'client with an open deal has' : 'clients with an open deal have'
            } never been contacted at all.`}
          </p>
        )}
      </div>
    </section>
  );
}

const HEALTHS: PocHealth[] = ['ON_TRACK', 'AT_RISK', 'STALLED'];

/** How many running POCs are at each health, then each one needing a look. */
function PocsByHealth({ pocs }: { pocs: ClientsDashboard['pocs'] }) {
  const running = HEALTHS.reduce((sum, health) => sum + pocs.health[health], 0);

  return (
    <section className="clients-panel" aria-labelledby="clients-poc-health-heading">
      <header className="clients-panel-head">
        <div>
          <h3 id="clients-poc-health-heading">POCs by health</h3>
          <p className="muted">Every POC running, and the ones that need a look.</p>
        </div>
      </header>
      <div className="clients-dashboard-body">
        {running === 0 ? (
          <p className="muted">No POC is running.</p>
        ) : (
          <>
            <dl className="clients-health-counts">
              {HEALTHS.map((health) => (
                <div key={health}>
                  <dt>{HEALTH_NAME[health]}</dt>
                  <dd className="clients-figure">{pocs.health[health]}</dd>
                </div>
              ))}
            </dl>
            {pocs.attention.length === 0 ? (
              <p className="muted">Every running POC is On Track, with nothing flagged.</p>
            ) : (
              <ul className="clients-dashboard-list is-pocs">
                {pocs.attention.map((poc) => (
                  <li key={poc.id}>
                    <div>
                      <a href={`#/clients/poc/${poc.id}`}>
                        {poc.client.name} · {poc.deal.productName}
                      </a>
                      <small className="muted">
                        Day {poc.day} · {decisionInWords(poc.daysToDecision)}
                      </small>
                      <Flags flags={poc.flags} />
                    </div>
                    <HealthPill health={poc.health} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}
