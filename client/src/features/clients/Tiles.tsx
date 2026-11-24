import type { ReactNode } from 'react';
import type { CompanyPipelineView, Money } from '../../api';
import { money } from '../../format';

/**
 * Numbers at a glance, for the company pipeline and the dashboard (#289): a row of tiles, each a
 * small label over a big figure. Sums of money are one line per currency, never one across them
 * (CLI 75). What a total leaves out is a small amber chip on it rather than a sentence (CLI 77),
 * with the reason on hover and to a screen reader (the user, 24 November 2026).
 */

type Totals = CompanyPipelineView['totals'];

/** A row of tiles that wraps on a narrow screen. */
export function Tiles({ children }: { children: ReactNode }) {
  return <dl className="clients-tiles">{children}</dl>;
}

/** One tile: what it is, then its figure, then anything small under it. */
export function Tile({
  label,
  children,
  under,
}: {
  label: string;
  children: ReactNode;
  under?: ReactNode;
}) {
  return (
    <div className="clients-tile">
      <dt>{label}</dt>
      <dd>
        {children}
        {under}
      </dd>
    </div>
  );
}

/** A count, as big as a tile shows it. */
export function Count({ of }: { of: number }) {
  return <span className="clients-tile-figure">{of.toLocaleString()}</span>;
}

/** Each currency's sum on its own line, or a dash where there is none. */
export function MoneyLines({ amounts }: { amounts: Money[] }) {
  if (amounts.length === 0) {
    return <span className="clients-tile-figure is-none">—</span>;
  }

  return (
    <span className="clients-tile-money">
      {amounts.map((amount) => (
        <span key={amount.currency}>{money(amount)}</span>
      ))}
    </span>
  );
}

/** "3 with no value": the open deals a recorded total cannot count (CLI 77). */
export function NoValue({ totals }: { totals: Totals }) {
  if (totals.noValue === 0) {
    return null;
  }

  return (
    <span
      className="clients-tile-chip"
      title={`${String(totals.noValue)} open ${totals.noValue === 1 ? 'deal has' : 'deals have'} no value, so the total leaves ${totals.noValue === 1 ? 'it' : 'them'} out`}
    >
      {totals.noValue} with no value
    </span>
  );
}

/** The company pipeline's three: the value recorded first, then deals and clients. */
export function PipelineTiles({ totals }: { totals: Totals }) {
  return (
    <Tiles>
      <Tile label="Recorded value" under={<NoValue totals={totals} />}>
        <MoneyLines amounts={totals.recorded} />
      </Tile>
      <Tile label="Deals">
        <Count of={totals.opportunities} />
      </Tile>
      <Tile label="Clients">
        <Count of={totals.clients} />
      </Tile>
    </Tiles>
  );
}
