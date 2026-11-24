/**
 * The emails Clients sends. #290.
 *
 * Built here and queued through core's outbox, which sends them and tries again where the mail
 * server refuses. Each carries a dedupe key, so the morning's job queueing one twice queues it
 * once.
 */

import { createHash } from 'node:crypto';
import { type CalendarDate, formatDay } from '../../core/calendar/time.js';
import { BRAND_NAME, oneLine, renderEmail } from '../../core/notification/layout.js';
import type { NewOutboxEmail } from '../../core/notification/outbox.js';
import type { Poc, PocFlag } from './poc.js';
import { flagsIn, type PocAlert, toldKeyOf } from './poc-alerts.js';
import type { OwnersSteps, StepToRemind } from './reminders.js';

/** Somebody an email goes to. */
export interface Recipient {
  id: string;
  firstName: string;
  workEmail: string;
}

/** Where the emails link to. Built from `APP_URL`. */
export interface ClientsLinks {
  /** My pipeline, where somebody's own next steps are. */
  myPipeline(): string;
  /** The POCs tab, every running POC. */
  pocs(): string;
  /** One POC's page. */
  poc(id: string): string;
}

/** Links into Clients at this address. */
export function clientsLinks(appUrl: string): ClientsLinks {
  const base = appUrl.replace(/\/+$/, '');

  return {
    myPipeline: () => `${base}/#/clients`,
    pocs: () => `${base}/#/clients/pocs`,
    poc: (id) => `${base}/#/clients/poc/${encodeURIComponent(id)}`,
  };
}

/** The morning's next steps email's name in the outbox. */
export const NEXT_STEPS_EMAIL = 'CLIENTS_NEXT_STEPS';

/**
 * An owner's next steps on the morning of `day`: what is due, then what has just become overdue
 * (#290). One a morning per owner, which its dedupe key holds.
 */
export function nextStepsEmail(facts: {
  owner: Recipient;
  day: CalendarDate;
  steps: OwnersSteps;
  links: ClientsLinks;
}): NewOutboxEmail {
  const { owner, day, steps } = facts;
  const counts = [
    ...(steps.due.length === 0 ? [] : [`${String(steps.due.length)} due`]),
    ...(steps.overdue.length === 0 ? [] : [`${String(steps.overdue.length)} overdue`]),
  ].join(', ');

  const { text, html } = renderEmail({
    preview: [...steps.due, ...steps.overdue].map((step) => step.description).join(' · '),
    greeting: `Hello ${owner.firstName},`,
    paragraphs: [`Your next steps in Clients this morning: ${counts}.`],
    facts: [
      ...steps.due.map((step) => ({ label: dueLabel(step, day), value: whatOf(step) })),
      ...steps.overdue.map((step) => ({
        label: `Overdue, was due ${formatDay(step.dueOn)}`,
        value: whatOf(step),
      })),
    ],
    action: { label: 'Open My pipeline', href: facts.links.myPipeline() },
    afterAction: ['Close a step on My pipeline once it is done.'],
    signOff: BRAND_NAME,
    footer: [
      'You get this because these next steps are yours in Clients. It comes on a working ' +
        'morning when one of yours is due, and once when one becomes overdue.',
    ],
  });

  return {
    kind: NEXT_STEPS_EMAIL,
    recipientEmployeeId: owner.id,
    to: owner.workEmail,
    fromName: BRAND_NAME,
    replyTo: null,
    senderEmployeeId: null,
    subject: oneLine(`Your next steps: ${counts}`),
    text,
    html,
    dedupeKey: `${NEXT_STEPS_EMAIL}:${owner.id}:${day}`,
  };
}

/** The morning's POC alerts email's name in the outbox. */
export const POC_ALERTS_EMAIL = 'CLIENTS_POC_ALERTS';

/**
 * Somebody's POC alerts on the morning of `day`: every POC newly flagged that they lead, or whose
 * lead reports to them as a BD manager (#290, CLI 72).
 *
 * Its dedupe key is the person, the day and a fingerprint of the flags it tells (task 4). The same
 * flags queued twice are queued once; a flag raised between a stopped run and its rerun makes a
 * different email, carrying only what is new, since what was queued is recorded with it.
 */
export function pocAlertsEmail(facts: {
  recipient: Recipient;
  day: CalendarDate;
  alerts: readonly PocAlert[];
  links: ClientsLinks;
}): NewOutboxEmail {
  const { recipient, day, alerts, links } = facts;
  const [only] = alerts;
  const subject =
    alerts.length === 1
      ? `POC alert: ${nameOfPoc(only.poc)} needs attention`
      : `POC alerts: ${String(alerts.length)} POCs need attention`;

  const { text, html } = renderEmail({
    preview: alerts.map((alert) => nameOfPoc(alert.poc)).join(' · '),
    greeting: `Hello ${recipient.firstName},`,
    paragraphs: [
      alerts.length === 1
        ? 'A POC has a new flag.'
        : `${String(alerts.length)} POCs have new flags.`,
    ],
    facts: alerts.map((alert) => ({
      label: nameOfPoc(alert.poc),
      value:
        alert.flags.map((flag) => FLAG_SAYS[flag.kind](alert.poc)).join('. ') +
        `. CS lead: ${alert.poc.csLead.name}.`,
    })),
    action:
      alerts.length === 1
        ? { label: 'Open the POC', href: links.poc(only.poc.id) }
        : { label: 'Open POCs', href: links.pocs() },
    signOff: BRAND_NAME,
    footer: [
      'You get this because you lead these POCs in Clients, or their CS lead reports to you. ' +
        'Each flag is sent once, on the first working morning after it is raised.',
    ],
  });

  return {
    kind: POC_ALERTS_EMAIL,
    recipientEmployeeId: recipient.id,
    to: recipient.workEmail,
    fromName: BRAND_NAME,
    replyTo: null,
    senderEmployeeId: null,
    subject: oneLine(subject),
    text,
    html,
    dedupeKey: `${POC_ALERTS_EMAIL}:${recipient.id}:${day}:${fingerprintOf(alerts)}`,
  };
}

/** Twelve hex characters standing for exactly these flags, whatever order they came in. */
function fingerprintOf(alerts: readonly PocAlert[]): string {
  const keys = flagsIn(alerts).map(toldKeyOf).sort();

  return createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 12);
}

/** "ADB · Federation": the client and its deal's product. */
function nameOfPoc(poc: Poc): string {
  return `${poc.client.name} · ${poc.deal.productName}`;
}

/** What each flag says, in the words the POCs screen uses (PocsView.tsx). */
const FLAG_SAYS: Record<PocFlag['kind'], (poc: Poc) => string> = {
  NO_CORRECTIVE_ACTION: () => 'No corrective action 48 hours after At Risk',
  EXIT_DECISION: () => 'Stalled seven days with no reset: decide whether to exit',
  LOW_USAGE: (poc) =>
    `Below 50% usage at Day 63${poc.usage === null ? '' : ` (${String(poc.usage.percent)}%)`}: ` +
    'unlikely to convert',
  NO_USAGE: () => 'No usage recorded by Day 63',
  PAST_DECISION: (poc) => `Past its decision date, ${formatDay(poc.decisionOn)}`,
};

/** "Due today", or the day where it falls on one the company does not work. */
function dueLabel(step: StepToRemind, day: CalendarDate): string {
  return step.dueOn === day ? 'Due today' : `Due ${formatDay(step.dueOn)}`;
}

/** "Testbank · CreditStudio: Send the revised proposal". */
function whatOf(step: StepToRemind): string {
  const about =
    step.productName === null ? step.client.name : `${step.client.name} · ${step.productName}`;

  return `${about}: ${step.description}`;
}
