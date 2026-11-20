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
import type { Opportunity } from './opportunity.js';

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
