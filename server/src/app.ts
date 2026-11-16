/** The application, assembled. */

import express, { type Express, type Request, type Response } from 'express';
import type { Guard } from './core/auth/policy.js';
import { ApproverQueueService } from './apps/leave/leave-request/approver-queue.service.js';
import { desksStaffedBy } from './apps/leave/leave-request/policy.js';
import { BalanceStatementService } from './apps/leave/balance/balance-statement.service.js';
import { EntitlementRuleService } from './apps/leave/entitlement/entitlement-rule.service.js';
import { LeaveTypeService } from './apps/leave/leave-type/leave-type.service.js';
import { RequestFormService } from './apps/leave/leave-request/request-form.service.js';
import { RequestHistoryService } from './apps/leave/leave-request/request-history.service.js';
import type { SignInService } from './core/identity/sign-in/sign-in.service.js';
import type { BalanceRepository } from './apps/leave/balance/balance.db.js';
import type { DepartmentRepository } from './core/organisation/department/department.db.js';
import type { EmployeeRepository } from './core/organisation/employee/employee.db.js';
import { LeaveRequestDraftService } from './apps/leave/leave-request/draft.service.js';
import type { LeaveRequestDraftRepository } from './apps/leave/leave-request/draft.db.js';
import type { LeaveDecisionRepository } from './apps/leave/leave-request/leave-decision.db.js';
import type { LeaveRoutingRepository } from './apps/leave/leave-request/routing.db.js';
import type { WithdrawalRepository } from './apps/leave/leave-request/withdrawal.db.js';
import type { ReversalRepository } from './apps/leave/leave-request/reversal.db.js';
import type { LeaveRequestRepository } from './apps/leave/leave-request/leave-request.db.js';
import type { LeaveRequestService } from './apps/leave/leave-request/leave-request.service.js';
import type { LeaveTypeRepository } from './apps/leave/leave-type/leave-type.db.js';
import type { LeaveYearRepository } from './apps/leave/leave-year/leave-year.db.js';
import type { OrganisationRepository } from './core/organisation/settings/organisation.db.js';
import type { ApprovalDelegationService } from './apps/leave/leave-request/delegation.service.js';
import type { RoleRepository } from './core/identity/role/role.db.js';
import type { SignInAccountRepository } from './core/identity/sign-in/sign-in-account.db.js';
import type { AttachmentRepository } from './apps/leave/leave-request/attachment.db.js';
import type { AttachmentLinkRepository } from './apps/leave/leave-request/attachment-link.db.js';
import { AttachmentService } from './apps/leave/leave-request/attachment.service.js';
import { attachmentRoutes } from './apps/leave/leave-request/attachment.routes.js';
import type { Scanner } from './core/scanning/index.js';
import type { Storage } from './core/storage/index.js';
import type { EntitlementRuleRepository } from './apps/leave/entitlement/entitlement-rule.db.js';
import type { HolidayRepository } from './apps/leave/holiday/holiday.db.js';
import { HolidayService } from './apps/leave/holiday/holiday.service.js';
import type { HolidayRecalculationService } from './apps/leave/holiday/recalculation.service.js';
import { earliestOpenDayFrom } from './apps/leave/leave-year/leave-year.service.js';
import { balanceRoutes } from './apps/leave/balance/routes.js';
import { BalanceAdjustmentService } from './apps/leave/balance/adjustment.service.js';
import { balanceAdjustmentRoutes } from './apps/leave/balance/adjustment.routes.js';
import type { LeaveEventRepository } from './apps/leave/leave-event/leave-event.db.js';
import { LeaveEventService } from './apps/leave/leave-event/leave-event.service.js';
import { leaveEventRoutes } from './apps/leave/leave-event/leave-event.routes.js';
import { theSystem } from './core/auth/actor.js';
import { LeaverStatementService } from './apps/leave/balance/leaver-statement.service.js';
import { leaverRoutes } from './apps/leave/balance/leaver-statement.routes.js';
import type { AuditRepository } from './core/audit/audit.db.js';
import { AuditService } from './core/audit/audit.service.js';
import { auditRoutes } from './core/audit/routes.js';
import { ReportService } from './apps/leave/report/report.service.js';
import { reportRoutes } from './apps/leave/report/routes.js';
import { LedgerService } from './apps/leave/balance/ledger.service.js';
import type { LedgerRepository } from './apps/leave/balance/ledger.db.js';
import type { BalanceService } from './apps/leave/balance/balance.service.js';
import { entitlementRuleRoutes } from './apps/leave/entitlement/routes.js';
import { holidayRoutes } from './apps/leave/holiday/routes.js';
import { leaveTypeRoutes } from './apps/leave/leave-type/routes.js';
import { organisationRoutes } from './apps/leave/settings/routes.js';
import { OrganisationService } from './core/organisation/settings/organisation.service.js';
import type { EmailWordingRepository } from './apps/leave/notification/wording.db.js';
import { EmailWordingService } from './apps/leave/notification/wording.service.js';
import { emailWordingRoutes } from './apps/leave/notification/wording.routes.js';
import { teamRoutes } from './apps/leave/team/routes.js';
import { TeamService } from './apps/leave/team/team.service.js';
import { teamCalendarRoutes } from './apps/leave/team/team-calendar.routes.js';
import type { LeaveCalculatorService } from './apps/leave/leave-calculator/leave-calculator.service.js';
import type { LeavePlanRepository } from './apps/leave/plan/plan.db.js';
import { LeavePlanService } from './apps/leave/plan/plan.service.js';
import { planRoutes } from './apps/leave/plan/routes.js';
import { TeamCalendarService } from './apps/leave/team/team-calendar.service.js';
import { AwayTodayService } from './apps/leave/team/away-today.service.js';
import type { CoverRepository } from './apps/leave/cover/cover.db.js';
import { CoverService } from './apps/leave/cover/cover.service.js';
import { coverRoutes } from './apps/leave/cover/routes.js';
import { DirectoryService } from './apps/directory/directory.service.js';
import { type DirectoryLimits, directoryRoutes } from './apps/directory/routes.js';
import { clientsRoutes } from './apps/clients/routes.js';
import type { ClientsRoleRepository } from './apps/clients/role.db.js';
import type { ClientsClientRepository } from './apps/clients/client.db.js';
import { ClientService } from './apps/clients/client.service.js';
import type { ClientsContactRepository } from './apps/clients/contact.db.js';
import type { ClientsProductInUseRepository } from './apps/clients/product-in-use.db.js';
import type { ClientsOpportunityRepository } from './apps/clients/opportunity.db.js';
import { OpportunityService } from './apps/clients/opportunity.service.js';
import type { ClientsProductRepository } from './apps/clients/product.db.js';
import { SetupService } from './apps/clients/setup.service.js';
import { RoleService } from './apps/clients/role.service.js';
import { clientsVisibility } from './apps/clients/visibility.js';
import { clientsDoor } from './apps/clients/door.js';
import { portalRoutes } from './core/portal/routes.js';
import type { PhotoRepository } from './apps/directory/photo.db.js';
import type { DirectoryEmailService } from './apps/directory/email.service.js';
import type { EmailOutbox } from './core/notification/outbox.service.js';
import { emailLogRoutes } from './core/notification/routes.js';
import { PhotoService } from './apps/directory/photo.service.js';
import { AdministrationService } from './apps/directory/administration.service.js';
import type { EmployeeService } from './core/organisation/employee/employee.service.js';
import type { WorkPatternRepository } from './core/calendar/work-pattern/work-pattern.db.js';
import { identify, insistOnANewPassword } from './core/http/identify.js';
import { answerProblems, type FailureLog, NO_SUCH_ROUTE } from './core/http/problems.js';
import { requestRoutes } from './apps/leave/leave-request/routes.js';
import { publicSessionRoutes, signedInSessionRoutes } from './apps/leave/session/session.routes.js';
import { sessionSecretFrom } from './core/identity/sign-in/session-cookie.routes.js';

/** What the application is built out of. */
export interface Application {
  guard: Guard;
  signIn: SignInService;
  balances: BalanceRepository;
  /** FR 27. The movements a cached balance is made of. */
  ledger: LedgerRepository;
  /**
   * FR 37. The one door a balance moves through, handed in whole as `leaveRequests` is.
   *
   * The same instance the write door below holds, so an adjustment and a request movement
   * cannot disagree about what a movement does to a cached figure.
   */
  adjustments: BalanceService;
  /** FR 32g. Optional, so a test app without them has no event routes. */
  events?: LeaveEventRepository;
  employees: EmployeeRepository;
  /**
   * FR 01, FR 06. The door HR's changes to a record go through, handed in whole as
   * `leaveRequests` is: it carries the company's email domains and the leave that follows a
   * moved manager, neither of which this file should choose. Optional, so a test app without
   * it has no Administration routes.
   */
  employeeRecords?: EmployeeService;
  /** FR 57. What the away calendar is scoped to, and what HR filters it by. */
  departments: DepartmentRepository;
  types: LeaveTypeRepository;
  years: LeaveYearRepository;
  /** FR 31. What a leave type is worth, and from when. */
  entitlementRules: EntitlementRuleRepository;
  /** FR 22. The gazetted days the office is closed. */
  holidays: HolidayRepository;
  /**
   * FR 23. Which days each person works, so the directory can say when somebody is back.
   * Optional, so a test app without it marks nobody away in the directory.
   */
  patterns?: WorkPatternRepository;
  /**
   * FR 25, §8.8. Crediting a late-declared holiday back into leave people had.
   *
   * A service rather than a repository, and passed in whole for the reason `leaveRequests`
   * is: a credit moves a balance and tells somebody about it, so it needs a transaction and
   * a mailer. Building it here would put a mailer within reach of a balance screen, which
   * is the property `RequestFormService` was separated out to keep.
   */
  holidayRecalculations: HolidayRecalculationService;
  /** FR 54. */
  requests: LeaveRequestRepository;
  /**
   * The one door that prices and writes a request.
   *
   * A service where every other part here is a repository, and it is the only one that could
   * be. Submitting holds days, which means a transaction, a balance service and a notifier;
   * `LeaveRequestService` is where those are already assembled and where the rule that a
   * quote and a submission count the same way lives. Building a second one here would be a
   * second answer to what a fortnight costs.
   */
  leaveRequests: LeaveRequestService;
  /** FR 39, FR 52. */
  decisions: LeaveDecisionRepository;
  /** FR 48b. The stages a request's routing skipped. */
  routing: LeaveRoutingRepository;
  /** FR 47. The asks to take agreed leave off the books. */
  withdrawals: WithdrawalRepository;
  /** The Chief Executive's reversals. Optional, so a test app without them shows none. */
  reversals?: ReversalRepository;
  /** FR 19. Requests started and not finished. */
  drafts: LeaveRequestDraftRepository;
  /** Leave people are planning. Optional, so a test app without it shows no plans. */
  planning?: { plans: LeavePlanRepository; calculator: LeaveCalculatorService };
  /** FR 12. Certificates and supporting documents. */
  attachments: AttachmentRepository;
  /** NFR SEC 04. The short-lived links they are fetched through, and who fetched them. */
  attachmentLinks: AttachmentLinkRepository;
  /** NFR SEC 04. Where attachment bytes live, behind one interface. */
  storage: Storage;
  /**
   * People's photos. Optional, so a test app without them has no photo routes and the
   * directory shows everybody's initials. The bytes go to `storage`, as attachments do.
   */
  photos?: PhotoRepository;
  /** NFR SEC 07. */
  scanner: Scanner;
  accounts: SignInAccountRepository;
  roles: RoleRepository;
  /** FR 49. Who is covering for an approver who is away. */
  delegations: ApprovalDelegationService;
  /** FR 48c. Who the `CEO` desk resolves to. */
  organisation: OrganisationRepository;
  /** FR 61. HR's wording of the emails. */
  emailWording: EmailWordingRepository;
  /** NFR AUD 01. */
  audit: AuditRepository;
  /**
   * The email queue, for the log of what was sent. Optional, so a test app without it has no
   * email log route. Built in main.ts, where the job that drains it is.
   */
  outbox?: EmailOutbox;
  /**
   * The directory's emails, for the screen where people choose theirs. A service rather than
   * repositories for the reason `leaveRequests` is: it queues mail.
   */
  directoryEmails?: DirectoryEmailService;
  /**
   * #226. Who covers for somebody on leave. Optional, so a test app without it has no cover
   * routes and the directory names nobody to contact instead.
   */
  covers?: CoverRepository;
  /** How much one person may ask of the directory. `DIRECTORY_LIMITS` when not given. */
  directoryLimits?: DirectoryLimits;
  /**
   * #274. Who holds a clients role. Optional, so a test app without it has no clients routes.
   * Mounted outside production only, while clients is being built.
   */
  clientsRoles?: ClientsRoleRepository;
  /** #293. Product lines and products. Optional, so a test app without them has no setup routes. */
  clientsProducts?: ClientsProductRepository;
  /** #276. Clients themselves. Optional, so a test app without them has no client routes. */
  clientsClients?: ClientsClientRepository;
  /** #276. Their contacts, which go with them: no client routes without both. */
  clientsContacts?: ClientsContactRepository;
  /** #276. The products they use, which go with them too. */
  clientsProductsInUse?: ClientsProductInUseRepository;
  /** #277. Their deals, which go with them as well. */
  clientsOpportunities?: ClientsOpportunityRepository;
  /** Where a 500 is written down. */
  failures?: FailureLog;
  /** Read from `SESSION_SECRET` when not given. */
  secret?: string;
}

export function buildApp(parts: Application): Express {
  const app = express();

  app.use(express.json({ limit: '64kb' }));

  app.disable('x-powered-by');

  const secret = parts.secret ?? sessionSecretFrom();

  /** For a load balancer and for a developer who wants to know the process is up. */
  app.get('/api/health', (_request: Request, response: Response) => {
    response.json({ status: 'ok' });
  });

  app.use('/api', publicSessionRoutes({ signIn: parts.signIn, secret }));

  app.use(
    '/api',
    identify({
      employees: parts.employees,
      accounts: parts.accounts,
      roles: parts.roles,
      organisation: parts.organisation,
      secret,
    }),
  );

  /* NFR SEC 01. Nothing but changing it, while the password is still somebody else's. Behind
     identify and in front of every route that needs one, so forgetting is not possible. */
  app.use('/api', insistOnANewPassword());

  app.use(
    '/api',
    signedInSessionRoutes({
      guard: parts.guard,
      signIn: parts.signIn,
      /* FR 40, FR 49. The same two reads the queue makes, so the rail and the screen
         cannot disagree about whether somebody staffs a desk. */
      desksFor: async (actor) =>
        desksStaffedBy(
          actor,
          await parts.organisation.chiefExecutiveId(),
          await parts.delegations.standingInFor(actor.employeeId),
        ),
    }),
  );

  app.use(
    '/api',
    balanceRoutes({
      statements: new BalanceStatementService(
        parts.balances,
        parts.guard,
        parts.employees,
        parts.types,
        parts.years,
      ),
    }),
  );

  /* FR 37, FR 27. Putting a balance right by hand, with a reason that stays on it.
     Reading a ledger is the person's own, their manager's and HR's, and posting an adjustment
     is an HR Administrator's — `ledgerPolicy` decides both rather than the mounting. The write
     door is handed in rather than built, so this is the same `BalanceService` a request
     movement goes through. */
  app.use(
    '/api',
    balanceAdjustmentRoutes({
      adjustments: new BalanceAdjustmentService(
        new BalanceStatementService(
          parts.balances,
          parts.guard,
          parts.employees,
          parts.types,
          parts.years,
        ),
        new LedgerService(parts.ledger, parts.guard, parts.employees),
        parts.guard,
        parts.employees,
        parts.types,
      ),
      balances: parts.adjustments,
    }),
  );

  /* FR 32g. Recording a birth, a bereavement and the like grants that type's days.
     Posting is either HR desk's; `ledgerPolicy.grantForAnEvent` decides. */
  if (parts.events !== undefined) {
    const rules = new EntitlementRuleService(
      parts.entitlementRules,
      parts.guard,
      earliestOpenDayFrom(parts.years),
    );
    const lookup = theSystem('the figure an event grants');

    app.use(
      '/api',
      leaveEventRoutes({
        events: new LeaveEventService(
          parts.adjustments,
          parts.guard,
          parts.employees,
          parts.types,
          parts.years,
          parts.events,
          async (employee, leaveTypeId, on) =>
            (await rules.entitlementOn(lookup, employee, leaveTypeId, on))?.entitlementDays,
        ),
        guard: parts.guard,
        employees: parts.employees,
        types: parts.types,
      }),
    );
  }

  /* FR 37a, §8.6d, §8.7. What a leaver is owed on their last day, with its working.
     A read service built from repositories: the figure writes nothing, so it needs no
     transaction and no mailer. The read rule is the balance's — theirs, their manager's and
     HR's — and the picker is the directory's, which `ledgerPolicy` and `employeePolicy`
     decide rather than the mounting does. */
  app.use(
    '/api',
    leaverRoutes({
      leavers: new LeaverStatementService(
        parts.balances,
        parts.guard,
        parts.employees,
        parts.types,
        parts.years,
        new EntitlementRuleService(
          parts.entitlementRules,
          parts.guard,
          earliestOpenDayFrom(parts.years),
        ),
      ),
    }),
  );

  /* FR 63. HR's reports. Read only, built from repositories. */
  app.use(
    '/api',
    reportRoutes({
      reports: new ReportService(
        parts.guard,
        parts.employees,
        parts.departments,
        parts.types,
        parts.years,
        parts.balances,
        parts.requests,
      ),
    }),
  );

  /* NFR AUD 01. The audit log, searched. Read only. */
  app.use(
    '/api',
    auditRoutes({
      audit: new AuditService(parts.audit, parts.employees, parts.accounts, parts.guard),
    }),
  );

  /* FR 31, FR 32. Reading a type is anybody's — the person who most needs to know a
     notice window is the one about to miss it — and writing one is an HR Administrator's,
     which `leaveTypePolicy` decides rather than the mounting does. */
  app.use('/api', leaveTypeRoutes({ types: new LeaveTypeService(parts.types, parts.guard) }));

  /* FR 31. The figures behind those types, effective dated. The boundary a closed
     year sets is read from the leave year table rather than passed in, so the refusal that
     protects last year's figures cannot be configured away. */
  app.use(
    '/api',
    entitlementRuleRoutes({
      rules: new EntitlementRuleService(
        parts.entitlementRules,
        parts.guard,
        earliestOpenDayFrom(parts.years),
      ),
      types: new LeaveTypeService(parts.types, parts.guard),
      employees: parts.employees,
      departments: parts.departments,
      years: parts.years,
    }),
  );

  /* FR 22. The days the office is closed, kept by HR the day the gazette says so.
     Reading the calendar is anybody's — it is what a leave quote is priced against — and
     `holidayPolicy` decides the writes rather than the mounting. The closed-year boundary is
     read from the leave year table, so the trigger and the refusal cannot disagree. */
  app.use(
    '/api',
    holidayRoutes({
      holidays: new HolidayService(
        parts.holidays,
        parts.guard,
        earliestOpenDayFrom(parts.years),
        parts.years,
      ),
      years: parts.years,
      /* FR 25, §8.8. Crediting a late-declared day back is the same desk's act as
         declaring it, so it hangs off the calendar's own router. */
      recalculations: parts.holidayRecalculations,
    }),
  );

  /* FR 44, FR 48c, NFR SEC 06. The settings that are about the company rather than
     about a type, a year or a person. Reading them is everybody's, because the request form
     already says unpaid leave goes to the Chief Executive, and `organisationPolicy` decides
     the writes rather than the mounting. The notice and back-dating windows are read here
     and written through `leaveTypeRoutes` above, which stays the one door onto a type. */
  app.use(
    '/api',
    organisationRoutes({
      organisation: new OrganisationService(parts.organisation, parts.guard, parts.employees),
      types: new LeaveTypeService(parts.types, parts.guard),
    }),
  );

  /* FR 61. The wording of the emails. Reading is HR's, changing it an HR Officer's. */
  app.use(
    '/api',
    emailWordingRoutes({ wording: new EmailWordingService(parts.emailWording, parts.guard) }),
  );

  /* FR 55, FR 56. A read service built from repositories, as the two above are:
     nothing a manager reads about their reports needs a transaction or a mailer. */
  app.use(
    '/api',
    teamRoutes({
      team: new TeamService(
        parts.guard,
        parts.employees,
        parts.balances,
        parts.requests,
        parts.types,
        parts.years,
      ),
    }),
  );

  /* FR 57. Everybody's screen, scoped to a department, and it is handed no
     leave type repository: a type name cannot be sent by a service that never reads the
     table. */
  app.use(
    '/api',
    teamCalendarRoutes({
      calendar: new TeamCalendarService(
        parts.guard,
        parts.employees,
        parts.requests,
        parts.years,
        parts.departments,
        /* Plans are drawn beside the leave, and like it carry dates and nothing else. */
        parts.planning?.plans,
      ),
    }),
  );

  /* The staff directory, every employee's. Who is away comes from leave through the
     directory's own port, so neither app imports the other; only a return date crosses.

     #226. Cover is named on leave and shown in the directory, and the colleague named is
     told by the directory's emails, so it is built with the directory. Same port arrangement as
     who is away: the directory is handed the service, and neither imports the other. */
  const cover =
    parts.covers === undefined
      ? undefined
      : new CoverService(
          parts.guard,
          parts.covers,
          parts.requests,
          parts.employees,
          parts.directoryEmails,
        );

  if (cover !== undefined) {
    app.use('/api', coverRoutes({ cover }));
  }

  app.use(
    '/api',
    directoryRoutes({
      guard: parts.guard,
      limits: parts.directoryLimits,
      directory: new DirectoryService(
        parts.guard,
        parts.employees,
        parts.departments,
        parts.photos ?? { photosOf: () => Promise.resolve([]) },
        parts.patterns === undefined
          ? undefined
          : new AwayTodayService(parts.requests, parts.employees, parts.patterns, parts.holidays),
        undefined,
        cover,
      ),
      photos:
        parts.photos === undefined
          ? undefined
          : new PhotoService(parts.guard, parts.photos, parts.employees, parts.storage),
      emails: parts.directoryEmails,
      /* HR's Administration tab. Every route asks `directoryPolicy.administer` itself. */
      administration:
        parts.employeeRecords === undefined || parts.patterns === undefined
          ? undefined
          : new AdministrationService(
              parts.guard,
              parts.employees,
              parts.employeeRecords,
              parts.departments,
              parts.patterns,
              parts.accounts,
              parts.roles,
              parts.audit,
            ),
    }),
  );

  /* Clients, the business development pipeline. #274.

     Still being built, so not mounted in production: `/api/clients` answers 404 there until it
     goes live, as the directory's did. The client hides the screen on the same terms. */
  const clientsRoles = process.env.NODE_ENV === 'production' ? undefined : parts.clientsRoles;

  if (clientsRoles !== undefined) {
    /* A client's page lists its deals, so there are client routes only with both. */
    const clientParts =
      parts.clientsClients === undefined ||
      parts.clientsContacts === undefined ||
      parts.clientsProductsInUse === undefined ||
      parts.clientsOpportunities === undefined
        ? undefined
        : {
            clients: parts.clientsClients,
            contacts: parts.clientsContacts,
            productsInUse: parts.clientsProductsInUse,
            opportunities: parts.clientsOpportunities,
          };

    app.use(
      '/api',
      clientsRoutes({
        door: clientsDoor(parts.guard, clientsRoles),
        grants: clientsRoles,
        roles: new RoleService(parts.guard, clientsRoles, parts.employees),
        setup:
          parts.clientsProducts === undefined || parts.clientsClients === undefined
            ? undefined
            : new SetupService(
                parts.guard,
                clientsRoles,
                parts.clientsProducts,
                parts.clientsClients,
              ),
        clients:
          clientParts === undefined
            ? undefined
            : new ClientService(
                parts.guard,
                clientsRoles,
                clientParts.clients,
                clientParts.contacts,
                clientParts.productsInUse,
                clientParts.opportunities,
              ),
        opportunities:
          clientParts === undefined
            ? undefined
            : new OpportunityService(
                parts.guard,
                clientsRoles,
                clientParts.clients,
                clientParts.productsInUse,
                clientParts.opportunities,
              ),
      }),
    );
  }

  /* #274. Which tiles are only some people's, and whether this person has them. Clients is the
     only one, and is registered on the same terms as its routes: where they are not mounted, its
     tile is nobody's. */
  app.use(
    '/api',
    portalRoutes({
      apps: clientsRoles === undefined ? [] : [clientsVisibility(parts.guard, clientsRoles)],
    }),
  );

  /* Who was sent which email and what became of it. An HR Administrator's and a System
     Administrator's, which `outboxPolicy` decides rather than the mounting. */
  if (parts.outbox !== undefined) {
    app.use('/api', emailLogRoutes({ outbox: parts.outbox }));
  }

  if (parts.planning !== undefined) {
    app.use(
      '/api',
      planRoutes({
        plans: new LeavePlanService(
          parts.guard,
          parts.planning.plans,
          parts.employees,
          parts.types,
          parts.years,
          parts.balances,
          parts.planning.calculator,
        ),
      }),
    );
  }

  /** FR 54, and the request form, quote and submission. */
  app.use(
    '/api',
    requestRoutes({
      history: new RequestHistoryService(
        parts.requests,
        parts.decisions,
        parts.guard,
        parts.employees,
        parts.types,
        parts.years,
        parts.routing,
        parts.withdrawals,
        parts.reversals ?? null,
      ),
      /** What each kind of leave asks of somebody, before any dates. */
      form: new RequestFormService(
        new LeaveTypeService(parts.types, parts.guard),
        parts.guard,
        parts.employees,
      ),
      /* The write door, handed in whole rather than built here, because
         it is the one place a request is priced and the one place a request is written and
         those two have to be the same object — see `LeaveRequestService.quote`, which is
         emphatic that a quote and a submission ask the same questions of the same facts. */
      requests: parts.leaveRequests,
      /* A read service built from repositories, like the two above and unlike the
         write door: nothing an approver queue shows needs a transaction or a mailer. */
      queue: new ApproverQueueService(
        parts.requests,
        parts.decisions,
        parts.guard,
        parts.employees,
        parts.organisation,
        parts.balances,
        parts.types,
        parts.years,
        /** FR 49. */
        parts.delegations,
      ),
      /** FR 49. */
      delegations: parts.delegations,
      /* FR 19. A draft holds nothing, so this needs no transaction and no
         balance — but finishing one is an ordinary submission, so it is handed the same
         write door rather than a second way into `leave_request`. */
      drafts: new LeaveRequestDraftService(
        parts.guard,
        parts.drafts,
        parts.employees,
        parts.leaveRequests,
      ),
      /* FR 51. A batch reports each row's refusal rather than throwing, so a fault
         among them reaches the same log `answerProblems` writes to and not neither. */
      failures: parts.failures,
    }),
  );

  /* FR 12. Its own router because the upload takes a raw body, which is
     route-level middleware rather than anything the JSON routes above want. */
  app.use(
    '/api',
    attachmentRoutes({
      attachments: new AttachmentService(
        parts.guard,
        parts.attachments,
        parts.attachmentLinks,
        parts.requests,
        parts.employees,
        parts.types,
        parts.organisation,
        parts.delegations,
        parts.storage,
        parts.scanner,
      ),
    }),
  );

  app.use('/api', (_request: Request, response: Response) => {
    response.status(404).json(NO_SUCH_ROUTE);
  });

  app.use(answerProblems(parts.failures));

  return app;
}
