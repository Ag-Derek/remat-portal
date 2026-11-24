/**
 * The dashboard: the whole department's pipeline in figures (#289, Clients SRS CLI 102). Laid out
 * as the user's mockup has it: the weighted pipeline, where every open deal sits by stage, the
 * clients gone quiet, and the POCs by health.
 *
 * Worked out here from what the services read, with no database, so that every rule is tested on
 * its own. The sums are the company pipeline's (`totalsOf`), never one across currencies (CLI 75).
 */

import { type CalendarDate, calendarDaysBetween } from '../../core/calendar/time.js';
import { CURRENCIES, type Currency, type Money } from './opportunity.js';
import { type PipelineDeal, type PipelineTotals, totalsOf } from './pipeline.js';
import { POC_HEALTHS, type PocHealth, type PocView } from './poc.js';
import { type Stage, STAGES } from './stage.js';
import type { Standing } from './standing.js';
import type { Person } from './client.js';

/** Longer than this since anybody spoke to a client, and it has gone quiet (CLI 102). */
export const QUIET_AFTER_DAYS = 30;

/** An open deal is at any stage but Live, which is won and so never open. */
export const OPEN_STAGES: readonly Stage[] = STAGES.filter((stage) => stage !== 'LIVE');

/**
 * One stage's deals (CLI 102): how many, and their weighted value per currency (the user, 24
 * November 2026), with what that leaves out. Every open stage is listed, an empty one too.
 */
export interface StageFigures {
  stage: Stage;
  opportunities: number;
  weighted: Money[];
  noValue: number;
  noProbability: number;
}

/** A client nobody has spoken to in over {@link QUIET_AFTER_DAYS} days. */
export interface QuietClient {
  id: string;
  name: string;
  lastContact: CalendarDate;
  /** Whole days since, today being 0. */
  daysAgo: number;
}

/** From this share of its currency's figure, one deal is a warning (the user, 24 November 2026). */
export const LARGEST_WARNS_FROM = 50;

/**
 * The single deal that holds the most of one currency's weighted figure, and how much (CLI 78).
 */
export interface LargestShare {
  currency: Currency;
  deal: { id: string; client: { id: string; name: string }; productName: string };
  weighted: Money;
  /** A whole percentage of the currency's weighted figure, half up. */
  percent: number;
  /** How many deals that figure is made of; one, and this deal is all of it. */
  counted: number;
  /** At {@link LARGEST_WARNS_FROM} or over: one deal moving changes the whole number. */
  warns: boolean;
}

/** One deal or POC, as the reassignment list names it: "Ecobank · CreditStudio". */
export interface NamedItem {
  id: string;
  client: { id: string; name: string };
  productName: string;
}

/**
 * Somebody who can no longer look after what is theirs, and all of it (CLI 96): every client
 * they own, every open deal, and every running POC they lead. #289.
 */
export interface Reassignment {
  person: Person;
  standing: Standing;
  clients: { id: string; name: string }[];
  deals: NamedItem[];
  pocs: NamedItem[];
}

/** A client and its owner, as the clients list reads it. */
export interface OwnedClient {
  id: string;
  name: string;
  owner: Person;
}

export interface Dashboard {
  totals: PipelineTotals;
  /** By person's name; nobody where nothing needs it. */
  reassign: Reassignment[];
  /** One per currency with anything weighed in it, in the totals' order. */
  largest: LargestShare[];
  stages: StageFigures[];
  /**
   * Clients with an open deal gone quiet, the longest first (the user, 24 November 2026). Those
   * never spoken to at all are counted, not listed.
   */
  quiet: QuietClient[];
  neverContacted: number;
  pocs: {
    /** How many running POCs are at each health. */
    health: Record<PocHealth, number>;
    /**
     * The ones needing a look: At Risk or Stalled, or flagged whatever their health. Stalled
     * first, then At Risk, then flagged On Track; the soonest to be decided first within each.
     */
    attention: PocView[];
  };
}

/** Where a client stands on contact, as the repository reads it. */
export interface ClientContact {
  id: string;
  name: string;
  lastContact: CalendarDate | null;
}

export function dashboardOf(
  deals: readonly PipelineDeal[],
  pocs: readonly PocView[],
  contacts: readonly ClientContact[],
  today: CalendarDate,
  /** Every client, with its owner. */
  owned: readonly OwnedClient[] = [],
  /** The owners and CS leads who need replacing, and why. */
  standings: ReadonlyMap<string, Standing> = new Map(),
): Dashboard {
  return {
    totals: totalsOf(deals),
    reassign: reassignmentsOf(owned, deals, pocs, standings),
    largest: largestOf(deals),
    stages: OPEN_STAGES.map((stage) => {
      const { opportunities, weighted, noValue, noProbability } = totalsOf(
        deals.filter(({ deal }) => deal.stage === stage),
      );

      return { stage, opportunities, weighted, noValue, noProbability };
    }),
    ...quietOf(contacts, today),
    pocs: pocsOf(pocs),
  };
}

/**
 * Per currency, the deal weighed most, and its share of the currency's figure: worked out on the
 * exact sums, value times probability, so that rounding the total never moves the share. Where two
 * deals weigh the same, the first by client A to Z. A currency whose figure is nothing, every deal
 * in it at 0%, has no share to give and is left out.
 */
function largestOf(deals: readonly PipelineDeal[]): LargestShare[] {
  const shares: LargestShare[] = [];

  for (const currency of CURRENCIES) {
    const counted = deals.filter(
      ({ deal }) => deal.value?.currency === currency && deal.probability !== null,
    );
    const exact = ({ deal }: PipelineDeal) =>
      (deal.value?.amountMinor ?? 0) * (deal.probability ?? 0);

    const total = counted.reduce((sum, one) => sum + exact(one), 0);
    const largest = counted.reduce<PipelineDeal | undefined>(
      (most, one) => (most === undefined || exact(one) > exact(most) ? one : most),
      undefined,
    );
    if (largest === undefined || total === 0) {
      continue;
    }

    /* Half up in whole numbers, so that an exact half is never a float a hair below it. */
    const percent = Math.floor((exact(largest) * 200 + total) / (total * 2));
    shares.push({
      currency,
      deal: {
        id: largest.deal.id,
        client: largest.deal.client,
        productName: largest.deal.product.name,
      },
      weighted: { currency, amountMinor: Math.floor((exact(largest) + 50) / 100) },
      percent,
      counted: counted.length,
      warns: percent >= LARGEST_WARNS_FROM,
    });
  }

  return shares;
}

/**
 * Everybody whose things need a new owner or CS lead, each with all of them: clients by name, then
 * open deals and running POCs by client. Ended deals and POCs are history, and stay as they are.
 */
function reassignmentsOf(
  owned: readonly OwnedClient[],
  deals: readonly PipelineDeal[],
  pocs: readonly PocView[],
  standings: ReadonlyMap<string, Standing>,
): Reassignment[] {
  const people = new Map<string, Reassignment>();
  const of = (person: Person, standing: Standing): Reassignment => {
    const found = people.get(person.id);
    if (found !== undefined) return found;

    const made: Reassignment = { person, standing, clients: [], deals: [], pocs: [] };
    people.set(person.id, made);
    return made;
  };

  for (const client of owned) {
    const standing = standings.get(client.owner.id);
    if (standing !== undefined) {
      of(client.owner, standing).clients.push({ id: client.id, name: client.name });
    }
  }
  for (const { deal } of deals) {
    const standing = standings.get(deal.owner.id);
    if (standing !== undefined && deal.outcome === 'OPEN') {
      of(deal.owner, standing).deals.push({
        id: deal.id,
        client: deal.client,
        productName: deal.product.name,
      });
    }
  }
  for (const poc of pocs) {
    if (poc.csLeadStanding !== null && poc.deal.outcome === 'OPEN') {
      of(poc.csLead, poc.csLeadStanding).pocs.push({
        id: poc.id,
        client: { id: poc.client.id, name: poc.client.name },
        productName: poc.deal.productName,
      });
    }
  }

  const byClient = (one: NamedItem, other: NamedItem) =>
    one.client.name.localeCompare(other.client.name) ||
    one.productName.localeCompare(other.productName);

  return [...people.values()]
    .map((one) => ({
      ...one,
      clients: one.clients.sort((a, b) => a.name.localeCompare(b.name)),
      deals: one.deals.sort(byClient),
      pocs: one.pocs.sort(byClient),
    }))
    .sort((one, other) => one.person.name.localeCompare(other.person.name));
}

function quietOf(
  contacts: readonly ClientContact[],
  today: CalendarDate,
): Pick<Dashboard, 'quiet' | 'neverContacted'> {
  const quiet: QuietClient[] = [];
  let neverContacted = 0;

  for (const client of contacts) {
    if (client.lastContact === null) {
      neverContacted += 1;
      continue;
    }

    /* Inclusive of both days, so a contact today is one day, and 0 days ago. */
    const daysAgo = calendarDaysBetween(client.lastContact, today) - 1;
    if (daysAgo > QUIET_AFTER_DAYS) {
      quiet.push({ id: client.id, name: client.name, lastContact: client.lastContact, daysAgo });
    }
  }

  quiet.sort((one, other) => other.daysAgo - one.daysAgo || one.name.localeCompare(other.name));

  return { quiet, neverContacted };
}

/** Stalled before At Risk before On Track: the worst first. */
const HEALTH_ORDER: Record<PocHealth, number> = { STALLED: 0, AT_RISK: 1, ON_TRACK: 2 };

function pocsOf(pocs: readonly PocView[]): Dashboard['pocs'] {
  const running = pocs.filter((poc) => poc.deal.outcome === 'OPEN');
  const health = Object.fromEntries(
    POC_HEALTHS.map((one) => [one, running.filter((poc) => poc.health === one).length]),
  ) as Record<PocHealth, number>;

  const attention = running
    .filter((poc) => poc.health !== 'ON_TRACK' || poc.flags.length > 0)
    .sort(
      (one, other) =>
        HEALTH_ORDER[one.health] - HEALTH_ORDER[other.health] ||
        one.daysToDecision - other.daysToDecision,
    );

  return { health, attention };
}
