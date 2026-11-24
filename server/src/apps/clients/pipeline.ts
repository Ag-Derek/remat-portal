/**
 * My pipeline: somebody's open deals, each with its next step and when the client was last
 * contacted about it, soonest next step first. Clients SRS CLI 97, TDD 7.
 *
 * The screen everybody with a clients role opens first, so it is read in one query (TDD 7):
 * the deal as its page has it, its earliest open next step, and the last day anything but a
 * note was logged against it. Overdue is worked out against today, never stored (TDD 1,
 * principle 3).
 *
 * POCs somebody leads join it with the POC (#285), which is where a POC lead is recorded.
 */

import type { CalendarDate } from '../../core/calendar/time.js';
import type { Person } from './client.js';
import { CURRENCIES, type Money, type Opportunity } from './opportunity.js';
import { isAnId } from './product.js';
import { isStage, type Stage, STAGES } from './stage.js';
import type { Standing } from './standing.js';

/** The open step on a deal that falls due first, whoever's it is. */
export interface PipelineStep {
  id: string;
  description: string;
  dueOn: CalendarDate;
  owner: Person;
}

/** One deal on somebody's pipeline. */
export interface PipelineDeal {
  deal: Opportunity;
  /** The client's type as it is now, "Bank", which the pipeline shows under its name. */
  clientType: string;
  clientTypeId: string;
  /** Null where nothing is planned for it, which is itself worth seeing. */
  nextStep: PipelineStep | null;
  /**
   * The last day a call, meeting, demo, proposal or financials was logged against the deal. A
   * note is not contact with the client, so it is left out. Null where there has been none.
   */
  lastContact: CalendarDate | null;
}

/** As the person reading it sees it: whether its next step is late. */
export type PipelineEntry = PipelineDeal & { overdue: boolean };

/* ------------------------------------------------------------ the company pipeline, #289 */

/**
 * What the company pipeline is narrowed to (CLI 98): a line, which includes every product in it
 * (CLI 09), or one product; a stage; an owner; a client type. Null is every one.
 */
export interface PipelineFilters {
  lineId: string | null;
  productId: string | null;
  stage: Stage | null;
  ownerId: string | null;
  clientTypeId: string | null;
}

/** A filter that is not one of the choices: an id that is not an id, or no stage. */
export class InvalidPipelineFilter extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidPipelineFilter';
    this.field = field;
  }
}

/**
 * The filters, from `?line=&product=&stage=&owner=&clientType=`. Each left out, or empty, is every
 * one. An id that could be one but matches no deal is not refused: it finds nothing.
 */
export function readPipelineFilters(query: Record<string, unknown>): PipelineFilters {
  const idOrNull = (field: string, what: string): string | null => {
    const value = query[field];

    if (value === undefined || value === '') return null;
    if (typeof value !== 'string' || !isAnId(value)) {
      throw new InvalidPipelineFilter(field, `Choose ${what} from the list, or every one.`);
    }
    return value;
  };

  const stage = query.stage;
  if (stage !== undefined && stage !== '' && !isStage(stage)) {
    throw new InvalidPipelineFilter('stage', 'Choose a stage from the list, or every one.');
  }

  return {
    lineId: idOrNull('line', 'a line'),
    productId: idOrNull('product', 'a product'),
    stage: isStage(stage) ? stage : null,
    ownerId: idOrNull('owner', 'an owner'),
    clientTypeId: idOrNull('clientType', 'a type of client'),
  };
}

/** The deals the filters leave, in the order they came. */
export function filtered<T extends PipelineDeal>(
  deals: readonly T[],
  filters: PipelineFilters,
): T[] {
  return deals.filter(
    ({ deal, clientTypeId }) =>
      (filters.lineId === null || deal.product.lineId === filters.lineId) &&
      (filters.productId === null || deal.product.id === filters.productId) &&
      (filters.stage === null || deal.stage === filters.stage) &&
      (filters.ownerId === null || deal.owner.id === filters.ownerId) &&
      (filters.clientTypeId === null || clientTypeId === filters.clientTypeId),
  );
}

/**
 * What each filter offers: only what some open deal has, whatever else is filtered, so that no
 * choice finds nothing on its own. Lines, products, owners and types by name; stages up the ladder.
 */
export interface PipelineChoices {
  lines: { id: string; name: string; products: { id: string; name: string }[] }[];
  stages: Stage[];
  owners: Person[];
  clientTypes: { id: string; name: string }[];
}

export function choicesOf(deals: readonly PipelineDeal[]): PipelineChoices {
  const byName = <T extends { name: string }>(one: T, other: T) =>
    one.name.localeCompare(other.name);

  const lines = new Map<string, { id: string; name: string; products: Map<string, string> }>();
  for (const { deal } of deals) {
    const line = lines.get(deal.product.lineId) ?? {
      id: deal.product.lineId,
      name: deal.product.lineName,
      products: new Map<string, string>(),
    };
    line.products.set(deal.product.id, deal.product.name);
    lines.set(line.id, line);
  }

  return {
    lines: [...lines.values()]
      .map((line) => ({
        id: line.id,
        name: line.name,
        products: [...line.products].map(([id, name]) => ({ id, name })).sort(byName),
      }))
      .sort(byName),
    stages: STAGES.filter((stage) => deals.some(({ deal }) => deal.stage === stage)),
    owners: [...new Map(deals.map(({ deal }) => [deal.owner.id, deal.owner]))]
      .map(([, owner]) => owner)
      .sort(byName),
    clientTypes: [...new Map(deals.map((one) => [one.clientTypeId, one.clientType]))]
      .map(([id, name]) => ({ id, name }))
      .sort(byName),
  };
}

/**
 * A deal's weighted value: its value times its probability of closing (CLI 76), to the nearest
 * pesewa or cent, half up. Null where it has no value or no probability, which is not counted
 * rather than counted as nothing (CLI 06).
 */
export function weightedOf(deal: Pick<Opportunity, 'value' | 'probability'>): Money | null {
  if (deal.value === null || deal.probability === null) {
    return null;
  }

  return {
    amountMinor: hundredthsHalfUp(deal.value.amountMinor * deal.probability),
    currency: deal.value.currency,
  };
}

/**
 * The figures over a set of open deals (CLI 75, CLI 76, TDD 8). Each sum is per currency and
 * never across them; a currency that nothing is counted in is left out, not shown as nothing.
 * The weighted sum is of value times probability, rounded once on the total, not row by row.
 */
export interface PipelineTotals {
  /** Over deals with both a value and a probability. */
  weighted: Money[];
  /** Every value recorded, whether or not it has a probability. */
  recorded: Money[];
  opportunities: number;
  clients: number;
  /**
   * What the totals leave out, so that neither reads as complete when it is not (CLI 77): deals
   * with no value, which neither total counts and which are in no currency; and deals with a value
   * but no probability, which are recorded but not weighed. One count each, for every currency.
   */
  noValue: number;
  noProbability: number;
}

export function totalsOf(deals: readonly PipelineDeal[]): PipelineTotals {
  const weighted: Money[] = [];
  const recorded: Money[] = [];

  for (const currency of CURRENCIES) {
    const valued = deals.filter(({ deal }) => deal.value?.currency === currency);
    const counted = valued.filter(({ deal }) => deal.probability !== null);

    if (counted.length > 0) {
      weighted.push({
        currency,
        amountMinor: hundredthsHalfUp(
          counted.reduce(
            (sum, { deal }) => sum + (deal.value?.amountMinor ?? 0) * (deal.probability ?? 0),
            0,
          ),
        ),
      });
    }
    if (valued.length > 0) {
      recorded.push({
        currency,
        amountMinor: valued.reduce((sum, { deal }) => sum + (deal.value?.amountMinor ?? 0), 0),
      });
    }
  }

  return {
    weighted,
    recorded,
    opportunities: deals.length,
    clients: new Set(deals.map(({ deal }) => deal.client.id)).size,
    noValue: deals.filter(({ deal }) => deal.value === null).length,
    noProbability: deals.filter(({ deal }) => deal.value !== null && deal.probability === null)
      .length,
  };
}

/** A whole number of hundredths, to the nearest whole, half up. Amounts are never negative. */
function hundredthsHalfUp(hundredths: number): number {
  return Math.floor((hundredths + 50) / 100);
}

/** The company pipeline as the screen reads it: the deals filtered, their figures, the choices. */
export interface CompanyPipeline {
  deals: (PipelineEntry & {
    weighted: Money | null;
    /** Why its owner can no longer look after it, or null where they can (CLI 96). */
    ownerStanding: Standing | null;
  })[];
  totals: PipelineTotals;
  choices: PipelineChoices;
}
