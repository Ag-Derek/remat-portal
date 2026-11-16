/** The server entry point. */

import { config as loadEnv } from 'dotenv';
import { Guard } from './core/auth/policy.js';
import { createDatabase } from './core/db/index.js';
import { createMailer } from './core/notification/mailer.js';
import { AuditRepository } from './core/audit/audit.db.js';
import { BalanceRepository } from './apps/leave/balance/balance.db.js';
import { DepartmentRepository } from './core/organisation/department/department.db.js';
import { EmployeeRepository } from './core/organisation/employee/employee.db.js';
import { EntitlementRuleRepository } from './apps/leave/entitlement/entitlement-rule.db.js';
import { HolidayRepository } from './apps/leave/holiday/holiday.db.js';
import { HolidayRecalculationRepository } from './apps/leave/holiday/recalculation.db.js';
import { ApprovalDelegationRepository } from './apps/leave/leave-request/delegation.db.js';
import { AttachmentRepository } from './apps/leave/leave-request/attachment.db.js';
import { CoverRepository } from './apps/leave/cover/cover.db.js';
import { PhotoRepository } from './apps/directory/photo.db.js';
import { ClientsRoleRepository } from './apps/clients/role.db.js';
import { ClientsClientRepository } from './apps/clients/client.db.js';
import { ClientsContactRepository } from './apps/clients/contact.db.js';
import { ClientsProductInUseRepository } from './apps/clients/product-in-use.db.js';
import { ClientsOpportunityRepository } from './apps/clients/opportunity.db.js';
import { ClientsProductRepository } from './apps/clients/product.db.js';
import { ClientsLeavers, summaryOfLeaversSwept } from './apps/clients/leavers.js';
import { AttachmentLinkRepository } from './apps/leave/leave-request/attachment-link.db.js';
import { LeaveDecisionRepository } from './apps/leave/leave-request/leave-decision.db.js';
import { LeaveRequestDraftRepository } from './apps/leave/leave-request/draft.db.js';
import { LeavePlanRepository } from './apps/leave/plan/plan.db.js';
import { LeaveRoutingRepository } from './apps/leave/leave-request/routing.db.js';
import { ReclassificationRepository } from './apps/leave/leave-request/reclassification.db.js';
import { WithdrawalRepository } from './apps/leave/leave-request/withdrawal.db.js';
import { ReversalRepository } from './apps/leave/leave-request/reversal.db.js';
import { LeaveRequestRepository } from './apps/leave/leave-request/leave-request.db.js';
import { LeaveTypeRepository } from './apps/leave/leave-type/leave-type.db.js';
import { LeaveYearRepository } from './apps/leave/leave-year/leave-year.db.js';
import { LedgerRepository } from './apps/leave/balance/ledger.db.js';
import { NotificationRepository } from './apps/leave/notification/notification.db.js';
import { EmailWordingRepository } from './apps/leave/notification/wording.db.js';
import { OrganisationRepository } from './core/organisation/settings/organisation.db.js';
import { RoleRepository } from './core/identity/role/role.db.js';
import { SignInAccountRepository } from './core/identity/sign-in/sign-in-account.db.js';
import { Transactions } from './core/db/transaction.js';
import { WorkPatternRepository } from './core/calendar/work-pattern/work-pattern.db.js';
import { buildApp } from './app.js';
import { createScanner } from './core/scanning/index.js';
import { createStorage } from './core/storage/index.js';
import { sessionSecretFrom } from './core/identity/sign-in/session-cookie.routes.js';
import { BalanceService } from './apps/leave/balance/balance.service.js';
import { HolidayRecalculationService } from './apps/leave/holiday/recalculation.service.js';
import { LeaveCalculatorService } from './apps/leave/leave-calculator/leave-calculator.service.js';
import { earliestOpenDayFrom } from './apps/leave/leave-year/leave-year.service.js';
import { ApprovalDelegationService } from './apps/leave/leave-request/delegation.service.js';
import { LeaveRequestService } from './apps/leave/leave-request/leave-request.service.js';
import { NotificationService } from './apps/leave/notification/notification.service.js';
import { SignInService } from './core/identity/sign-in/sign-in.service.js';
import { LeaveEventRepository } from './apps/leave/leave-event/leave-event.db.js';
import {
  EntitlementExpiry,
  summaryOf as summaryOfEntitlementExpiry,
} from './apps/leave/entitlement/entitlement-expiry.job.js';
import { theSystem } from './core/auth/actor.js';
import { EntitlementRuleService } from './apps/leave/entitlement/entitlement-rule.service.js';
import { currentDate } from './core/calendar/time.js';
import { LeaveYearService } from './apps/leave/leave-year/leave-year.service.js';
import { AnnualGrant } from './apps/leave/entitlement/annual-grant.job.js';
import { summaryOf as summaryOfGrant } from './apps/leave/entitlement/annual-grant.js';
import { YearRollover } from './apps/leave/leave-year/year-rollover.job.js';
import { summaryOf as summaryOfRollover } from './apps/leave/leave-year/year-rollover.js';
import { CarryoverExpiry } from './apps/leave/leave-year/carryover-expiry.job.js';
import { summaryOf as summaryOfCarryoverExpiry } from './apps/leave/leave-year/carryover-expiry.js';
import { AttachmentPurge } from './apps/leave/leave-request/attachment-purge.job.js';
import { BalanceReconciliation } from './apps/leave/balance/balance-reconciliation.job.js';
import { ReconciliationRepository } from './apps/leave/balance/reconciliation.db.js';
import { reportOf } from './apps/leave/balance/reconciliation.js';
import {
  DailyApproverReminders,
  summaryOf as summaryOfReminders,
} from './apps/leave/notification/reminder.job.js';
import { UndeliveredNotices } from './apps/leave/notification/delivery.job.js';
import { summaryOf as summaryOfDelivery } from './apps/leave/notification/delivery.js';
import { EmployeeService } from './core/organisation/employee/employee.service.js';
import { EmailOutboxRepository } from './core/notification/outbox.db.js';
import { EmailOutbox } from './core/notification/outbox.service.js';
import { summaryOf as summaryOfOutbox } from './core/notification/outbox.js';
import { EmailPreferenceRepository } from './apps/directory/email.db.js';
import { DirectoryEmailService } from './apps/directory/email.service.js';
import { portalLinks } from './apps/directory/email.js';
import { DailyDirectoryEmails, summaryOfDailyEmails } from './apps/directory/email.job.js';
import {
  LeaverReports,
  summaryOfLeaverReports,
} from './core/organisation/employee/leaver-reports.job.js';

loadEnv();

/** The port, checked rather than coerced. */
function portFrom(env: NodeJS.ProcessEnv): number {
  const port = Number(env.PORT ?? '3000');

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `PORT is ${String(env.PORT)}, which is not a port. Set it to a whole number between ` +
        '1 and 65535, or leave it unset for 3000. See .env.example.',
    );
  }

  return port;
}

/**
 * The address email links point at. Development's default is Vite's; production must say,
 * because a link to localhost in somebody's inbox opens nothing. See .env.example.
 */
function appUrlFrom(env: NodeJS.ProcessEnv): string {
  const url = env.APP_URL?.trim();

  if (url) {
    return url;
  }

  if (env.NODE_ENV === 'production') {
    throw new Error(
      'APP_URL is not set. Email links need the address people open the portal at. See .env.example.',
    );
  }

  return 'http://localhost:5173';
}

const db = createDatabase();
const guard = new Guard();

const employees = new EmployeeRepository(db);
/** FR 57. */
const departments = new DepartmentRepository(db);
const accounts = new SignInAccountRepository(db);
const roles = new RoleRepository(db);
const types = new LeaveTypeRepository(db);
const years = new LeaveYearRepository(db);
/** FR 31. */
const entitlementRules = new EntitlementRuleRepository(db);
/** FR 22. */
const holidays = new HolidayRepository(db);
const requests = new LeaveRequestRepository(db);
const decisions = new LeaveDecisionRepository(db);
/** FR 48b. */
const routing = new LeaveRoutingRepository(db);
/** FR 47. */
const withdrawals = new WithdrawalRepository(db);
const reversals = new ReversalRepository(db);
/** FR 32c. */
const reclassifications = new ReclassificationRepository(db);
/** FR 25. The holidays declared late and credited back. */
const recalculations = new HolidayRecalculationRepository(db);
/** FR 19. Requests started and not finished. */
const drafts = new LeaveRequestDraftRepository(db);
/** FR 12. */
const attachments = new AttachmentRepository(db);
/** NFR SEC 04. */
const attachmentLinks = new AttachmentLinkRepository(db);
const balances = new BalanceRepository(db);
/** FR 48c. Who the `CEO` desk resolves to. */
const organisation = new OrganisationRepository(db);
/** FR 49. */
const delegations = new ApprovalDelegationService(
  new ApprovalDelegationRepository(db),
  guard,
  employees,
  roles,
);

/** FR 23. Which days each person works. */
const patterns = new WorkPatternRepository(db);

const mailer = createMailer();

/**
 * The email queue. Built once, as the mailer is: every message is a row here, sent by the
 * job below, so nothing that decides an email waits on the mail server. Each one queued
 * nudges that job, so it goes within seconds rather than at the next minute.
 */
const outbox = new EmailOutbox(new EmailOutboxRepository(db), mailer, guard, undefined, () => {
  setImmediate(() => {
    void drainOutbox();
  });
});

/**
 * The one place a balance moves. §5.7, FR 37.
 *
 * Built once and handed to both doors below it, so an adjustment posted from the HR screen
 * and a day held by a leave request are the same act against the same cache.
 */
const movements = new BalanceService(balances, guard, employees, new Transactions(db));

/** FR 27. The movements behind a balance, which the adjustment screen reads. */
const ledger = new LedgerRepository(db);

/**
 * FR 59. Built once here, as the mailer is, and handed to both doors that write news.
 *
 * A recalculation is the second caller: a holiday credited back is told in the same words and
 * through the same retry as an approval, and a second instance would be a second backoff.
 */
const notifications = new NotificationService(new NotificationRepository(db), mailer, guard);

/** FR 31. The entitlement rules, asked what per-occasion leave is worth. */
const entitlementLookup = new EntitlementRuleService(
  entitlementRules,
  guard,
  earliestOpenDayFrom(years),
);

/**
 * The write door, built once here.
 *
 * Everything below it is what asking for leave actually needs: a balance service to hold the
 * days, a calculator to count them against the working pattern and the holiday calendar, and
 * a notifier to say what happened once the transaction has committed. The read services in
 * `buildApp` construct themselves out of repositories precisely so that none of this has to
 * exist for a balance screen to render — see `RequestFormService`, which argues it.
 */
const leaveRequests = new LeaveRequestService(
  movements,
  guard,
  employees,
  types,
  years,
  requests,
  decisions,
  routing,
  withdrawals,
  reclassifications,
  attachments,
  roles,
  delegations,
  organisation,
  new LeaveCalculatorService(patterns, holidays, guard),
  notifications,
  /* FR 32g. What per-occasion leave is worth, so it is capped when asked for and granted
     when approved. */
  async (employee, leaveTypeId, on) =>
    (
      await entitlementLookup.entitlementOn(
        theSystem('the figure an occasion grants'),
        employee,
        leaveTypeId,
        on,
      )
    )?.entitlementDays,
);

/**
 * FR 25, §8.8. The second write door, built here for the same reason the first is.
 *
 * Crediting a holiday back moves a balance and tells everybody it moved, so it needs the
 * transaction door and the notifier — and `buildApp` is deliberately not a place either is
 * reachable from.
 */
const holidayRecalculations = new HolidayRecalculationService(
  holidays,
  recalculations,
  requests,
  employees,
  types,
  patterns,
  movements,
  notifications,
  guard,
  earliestOpenDayFrom(years),
);

/** FR 32g, FR 32e. Births, bereavements and the like, and the grants they caused. */
const events = new LeaveEventRepository(db);

/** NFR SEC 04. Shared by the attachment routes and the certificate purge. */
const storage = createStorage();

/** The directory's emails: welcomes, introductions, leaver warnings, record changes, cover. */
const directoryEmails = new DirectoryEmailService(
  guard,
  employees,
  departments,
  roles,
  new EmailPreferenceRepository(db),
  outbox,
  portalLinks(appUrlFrom(process.env)),
);

/**
 * The door every change to a record goes through, built once and shared by the Administration
 * tab and the job that moves a leaver's reports, so every one of them tells the directory's emails.
 * The leave service is what a moved report's pending requests follow. FR 07.
 */
/**
 * #274. Clients, which is still being built and so is nowhere in production: neither its routes
 * (see app.ts), nor its part in a leaver's exit, nor its hourly sweep. One repository, shared by
 * all three, so the grants a leaver loses are the grants the routes read.
 */
const CLIENTS_IS_OPEN = process.env.NODE_ENV !== 'production';
const clientsRoles = new ClientsRoleRepository(db);
const clientsLeavers = new ClientsLeavers(guard, clientsRoles, employees);

const employeeRecords = new EmployeeService(
  employees,
  departments,
  patterns,
  guard,
  leaveRequests,
  {
    /* CLI 95: a leaver's clients grants end with the change that says they have left. */
    subscribers: CLIENTS_IS_OPEN ? [directoryEmails, clientsLeavers] : [directoryEmails],
  },
);

const app = buildApp({
  guard,
  signIn: new SignInService(accounts, employees, roles, mailer, guard),
  /** Plans, and the calculator that prices them as a request would be. */
  planning: {
    plans: new LeavePlanRepository(db),
    calculator: new LeaveCalculatorService(patterns, holidays, guard),
  },
  balances,
  /** FR 27, FR 37. */
  ledger,
  adjustments: movements,
  /** FR 32g. */
  events,
  employees,
  employeeRecords,
  departments,
  types,
  years,
  entitlementRules,
  holidays,
  /** FR 23. When somebody away is back, in the directory. */
  patterns,
  /** FR 25, §8.8. */
  holidayRecalculations,
  requests,
  leaveRequests,
  decisions,
  routing,
  withdrawals,
  reversals,
  drafts,
  attachments,
  attachmentLinks,
  /* Both built once here, as the mailer is: the driver each resolves to is a deployment's
     decision, and nothing above them may know which one it got. NFR SEC 04, NFR SEC 07. */
  storage,
  /** People's photos, whose bytes go to the same storage. */
  photos: new PhotoRepository(db),
  scanner: createScanner(),
  accounts,
  roles,
  delegations,
  organisation,
  /** FR 61. */
  emailWording: new EmailWordingRepository(db),
  /** NFR AUD 01. */
  audit: new AuditRepository(db),
  /** The log of every email sent. */
  outbox,
  directoryEmails,
  /** #226. Who covers for somebody on leave. */
  covers: new CoverRepository(db),
  /** #274. Who holds a clients role. Its routes are mounted outside production only. */
  clientsRoles,
  /** #293. */
  clientsProducts: new ClientsProductRepository(db),
  /** #276. */
  clientsClients: new ClientsClientRepository(db),
  clientsContacts: new ClientsContactRepository(db),
  clientsProductsInUse: new ClientsProductInUseRepository(db),
  /** #277. */
  clientsOpportunities: new ClientsOpportunityRepository(db),
  /* Resolved here as well as inside buildApp, so that a missing secret stops the process
     before a socket is opened rather than while the first request is being served. */
  secret: sessionSecretFrom(),
});

const port = portFrom(process.env);

const server = app.listen(port, () => {
  console.log(
    JSON.stringify({
      event: 'http.listening',
      at: new Date().toISOString(),
      port,
      environment: process.env.NODE_ENV ?? 'development',
    }),
  );
});

/*
 * The scheduled jobs. In process rather than a cron: every job is safe to rerun, so a restart
 * or a sleeping instance only means it runs again when the process wakes.
 */
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** FR 50. Not before the working day starts. */
const REMIND_FROM_HOUR_UTC = 8;

const yearService = new LeaveYearService(years, guard);
const annualGrant = new AnnualGrant(movements, yearService, entitlementLookup, employees, types);
const rollover = new YearRollover(
  movements,
  yearService,
  entitlementLookup,
  annualGrant,
  employees,
  types,
);
const carryoverExpiry = new CarryoverExpiry(
  movements,
  balances,
  entitlementLookup,
  years,
  employees,
  types,
);
const entitlementExpiry = new EntitlementExpiry(movements, events, types, years);
const attachmentPurge = new AttachmentPurge(attachments, organisation, storage);
const reconciliation = new BalanceReconciliation(
  new ReconciliationRepository(db),
  guard,
  roles,
  employees,
  mailer,
);
const reminders = new DailyApproverReminders(leaveRequests, notifications);
const undelivered = new UndeliveredNotices(notifications);
/* The same door HR's changes go through. FR 07. */
const leaverReports = new LeaverReports(employeeRecords);
const dailyDirectoryEmails = new DailyDirectoryEmails(directoryEmails);

/** Runs one job and logs its summary, or its failure. Undefined means nothing worth logging. */
async function runJob(job: string, work: () => Promise<string | undefined>): Promise<void> {
  try {
    const summary = await work();

    if (summary !== undefined) {
      console.log(JSON.stringify({ event: `job.${job}`, at: new Date().toISOString() }));
      console.log(summary);
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: `job.${job}.failed`,
        at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** Runs now and then every interval, skipping a tick while the last one is still going. */
function every(intervalMs: number, work: () => Promise<void>): NodeJS.Timeout {
  let running = false;

  const tick = (): void => {
    if (running) {
      return;
    }
    running = true;
    void work().finally(() => {
      running = false;
    });
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();

  return timer;
}

/** FR 36, §11. Every open year that has ended, oldest first, closed from the day after. */
async function rollOverFinishedYears(): Promise<string | undefined> {
  const actor = theSystem('the year rollover');
  const today = currentDate();
  const finished = (await years.list({ openOnly: true })).filter((year) => year.endDate < today);
  const summaries: string[] = [];

  for (const year of finished) {
    summaries.push(summaryOfRollover(await rollover.run(actor, year.id)));
  }

  return summaries.length === 0 ? undefined : summaries.join('\n\n');
}

/** FR 30. The current year, which also reaches anyone who joined since the last run. */
async function grantTheCurrentYear(): Promise<string | undefined> {
  const actor = theSystem('the annual grant');
  const year = await yearService.current(actor);

  if (year === undefined) {
    return undefined;
  }

  const run = await annualGrant.run(actor, year.id);

  return run.granted.length === 0 ? undefined : summaryOfGrant(run);
}

/* Daily, in sequence: the balance moves first, and the reconciliation checks what they left. */
const dailyTimer = every(DAY_MS, async () => {
  await runJob('year-rollover', rollOverFinishedYears);
  await runJob('annual-grant', grantTheCurrentYear);
  await runJob('carryover-expiry', async () =>
    summaryOfCarryoverExpiry(await carryoverExpiry.run(theSystem('the carryover expiry'))),
  );
  await runJob('entitlement-expiry', async () =>
    summaryOfEntitlementExpiry(await entitlementExpiry.run(theSystem('the entitlement expiry'))),
  );
  await runJob('attachment-purge', async () => {
    const run = await attachmentPurge.run();

    return `Certificate purge as at ${run.asAt}: ${String(run.deleted.length)} stored files deleted.`;
  });
  await runJob('balance-reconciliation', async () =>
    reportOf(await reconciliation.run(theSystem('the balance reconciliation'))),
  );
});

/* FR 50, FR 60. Hourly so a restart cannot skip a day; the job reminds nobody twice in one. */
const reminderTimer = every(HOUR_MS, () =>
  runJob('approver-reminders', async () => {
    if (new Date().getUTCHours() < REMIND_FROM_HOUR_UTC) {
      return undefined;
    }

    const run = await reminders.run(theSystem('the daily approver reminders'));

    return run.reminded.length === 0 ? undefined : summaryOfReminders(run);
  }),
);

/* FR 06, FR 07. Hourly, so a leaver's reports move within the hour after their last day
   rather than whenever a daily tick next falls. */
const leaverTimer = every(HOUR_MS, () =>
  runJob('leaver-reports', async () =>
    summaryOfLeaverReports(await leaverReports.run(theSystem("the leavers' reports"))),
  ),
);

/* #274, CLI 95. Hourly, with the leavers' reports: an exit recorded ahead of time ends nothing
   when it is recorded, so a leaver's clients grants end within the hour after their last day. */
const clientsLeaversTimer = every(HOUR_MS, () =>
  runJob('clients-leavers', async () =>
    CLIENTS_IS_OPEN
      ? summaryOfLeaversSwept(
          await clientsLeavers.sweep(theSystem("ending leavers' clients roles")),
        )
      : undefined,
  ),
);

/* FR 59. Every minute, the shortest backoff. */
const deliveryTimer = every(MINUTE_MS, () =>
  runJob('notification-retry', async () => {
    const run = await undelivered.run(theSystem('the notification retry'));

    return run.due === 0 ? undefined : summaryOfDelivery(run);
  }),
);

/* Welcomes on a start date and warnings as an exit date nears. Hourly so a restart cannot
   skip a day, and not before the working day starts; nobody is sent the same one twice. */
const directoryEmailTimer = every(HOUR_MS, () =>
  runJob('directory-emails', async () => {
    if (new Date().getUTCHours() < REMIND_FROM_HOUR_UTC) {
      return undefined;
    }

    return summaryOfDailyEmails(
      await dailyDirectoryEmails.run(theSystem('the directory daily emails')),
    );
  }),
);

/** Whether the outbox is being drained, and whether something was queued while it was. */
let draining = false;
let drainAgain = false;

/**
 * Sends what the outbox has due. Every minute for the retries, and straight after anything is
 * queued. One drain at a time; something queued during one is picked up by a second pass.
 */
async function drainOutbox(): Promise<void> {
  if (draining) {
    drainAgain = true;
    return;
  }

  draining = true;

  try {
    do {
      drainAgain = false;
      await runJob('email-outbox', async () =>
        summaryOfOutbox(await outbox.drain(theSystem('the email outbox'))),
      );
    } while (drainAgain);
  } finally {
    draining = false;
  }
}

const outboxTimer = every(MINUTE_MS, drainOutbox);

/**
 * Stop taking new connections, finish the ones in flight, then close the pool.
 *
 * In that order, and the order is the point: closing the pool first would fail every
 * request that was halfway through a query, which for this application means somebody's
 * leave request landing in neither state. `Transactions.allOrNothing` would roll those
 * back correctly — nothing is corrupted either way — but a deploy that answers five
 * hundreds it did not have to is a deploy people learn to fear.
 */
function shutDown(signal: string): void {
  console.log(JSON.stringify({ event: 'http.closing', at: new Date().toISOString(), signal }));

  clearInterval(dailyTimer);
  clearInterval(reminderTimer);
  clearInterval(leaverTimer);
  clearInterval(clientsLeaversTimer);
  clearInterval(deliveryTimer);
  clearInterval(directoryEmailTimer);
  clearInterval(outboxTimer);

  server.close(() => {
    void db.destroy().then(() => {
      process.exit(0);
    });
  });
}

process.on('SIGTERM', () => {
  shutDown('SIGTERM');
});
process.on('SIGINT', () => {
  shutDown('SIGINT');
});
