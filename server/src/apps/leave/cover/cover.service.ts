/** Naming who covers for somebody while they are on leave. #226. */

import type { Actor } from '../../../core/auth/actor.js';
import type { Guard } from '../../../core/auth/policy.js';
import {
  type CalendarDate,
  currentDate,
  formatDay,
  isCalendarDate,
} from '../../../core/calendar/time.js';
import { isCurrentOn } from '../../../core/organisation/employee/current.js';
import { type Employee, EmployeeNotFound } from '../../../core/organisation/employee/employee.js';
import type { EmployeeRepository } from '../../../core/organisation/employee/employee.db.js';
import type { BalanceOwner } from '../balance/policy.js';
import {
  isSettled,
  type LeaveRequest,
  LeaveRequestNotFound,
} from '../leave-request/leave-request.js';
import type { LeaveRequestRepository } from '../leave-request/leave-request.db.js';
import {
  changesTo,
  type CoverClash,
  CoverCannotBeChanged,
  type CoverDuty,
  type CoverInForce,
  CoverNotAtTheCompany,
  type CoverPart,
  clashesBetween,
  insideTheLeave,
  InvalidCover,
  type NamedCover,
  validateCoverParts,
} from './cover.js';
import type { CoverRepository } from './cover.db.js';
import { coverPolicy } from './policy.js';

/** Somebody named as cover, to be told. The shape `DirectoryEmailService.tellCover` takes. */
export interface CoverNaming {
  absenteeId: string;
  coverId: string;
  from: CalendarDate;
  to: CalendarDate;
  /** The cover row's id, so the same naming is never sent twice. */
  reference: string;
}

/**
 * Who tells a colleague they have been named. The directory's emails, handed in by the
 * composition root; declared here so leave imports nothing of the directory.
 */
export interface CoverNotifier {
  tellCover(actor: Actor, naming: CoverNaming): Promise<void>;
}

/** A colleague, as the cover picker and the plan name them. */
export interface Colleague {
  employeeId: string;
  firstName: string;
  lastName: string;
  jobTitle: string | null;
}

/** One part of the cover, with who it is. */
export interface CoverPartNamed extends CoverPart {
  id: string;
  cover: Colleague;
}

/** The cover on one piece of leave, as the screen that changes it reads it. */
export interface CoverPlan {
  leaveRequestId: string;
  absenteeId: string;
  /** The leave's own dates, which every part is inside. */
  from: CalendarDate;
  to: CalendarDate;
  parts: CoverPartNamed[];
  /** Days somebody named is away themselves. */
  clashes: CoverClash[];
  /** Whether it can still be changed: the leave is live and not over. */
  mayChange: boolean;
}

/** Who may be named as somebody's cover, and who to suggest. */
export interface CoverChoices {
  /** Everybody at the company today but the person going away, by surname. */
  colleagues: Colleague[];
  /** Their manager, where they have one at the company today. */
  suggestedId: string | null;
}

const names = new Intl.Collator('en', { sensitivity: 'base' });

export class CoverService {
  constructor(
    /** NFR SEC 02. */
    private readonly guard: Guard,
    private readonly covers: CoverRepository,
    private readonly requests: LeaveRequestRepository,
    private readonly employees: EmployeeRepository,
    /** Absent, nobody is told: a test app, or a deployment where the directory is closed. */
    private readonly notifier?: CoverNotifier,
    /** Today, in UTC, the day every other "today" on the server is. NFR DAT 03. */
    private readonly today: () => CalendarDate = () => currentDate(),
  ) {}

  /** The cover on one request. The person, their manager, and HR. */
  async forRequest(actor: Actor, requestId: string): Promise<CoverPlan> {
    const { request, absentee } = await this.leaveAndWhose(requestId);

    this.guard.enforce(coverPolicy.read(actor, ownerOf(absentee)));

    return this.planFor(request, await this.covers.standingFor(request.id));
  }

  /**
   * Names the cover for one request, replacing whatever stood. #226.
   *
   * Parts already standing exactly as asked are kept; the rest end; anybody newly named is
   * told, once the cover is written. Sending no parts clears it.
   */
  async name(actor: Actor, requestId: string, body: unknown): Promise<CoverPlan> {
    const { request, absentee } = await this.leaveAndWhose(requestId);

    this.guard.enforce(coverPolicy.name(actor, ownerOf(absentee)));

    assertMayChange(request, this.today());

    const parts = validateCoverParts(body, request);

    await this.assertAtTheCompany(parts);

    const standing = await this.covers.standingFor(request.id);
    const { end, add } = changesTo(standing, parts);

    const named = await this.covers.rename(actor, request.id, {
      end: end.map((one) => one.id),
      add,
    });

    for (const one of named) {
      await this.tell(actor, absentee, one);
    }

    return this.planFor(request, await this.covers.standingFor(request.id));
  }

  /** Who could cover for this person: everybody at the company today but them. */
  async choices(actor: Actor, absenteeId: string): Promise<CoverChoices> {
    const absentee = await this.employeeFor(absenteeId);

    this.guard.enforce(coverPolicy.name(actor, ownerOf(absentee)));

    const today = this.today();
    const colleagues = (await this.employees.list())
      .filter((one) => one.id !== absentee.id && isCurrentOn(one, today))
      .sort(
        (a, b) =>
          names.compare(a.lastName, b.lastName) ||
          names.compare(a.firstName, b.firstName) ||
          a.id.localeCompare(b.id),
      );

    return {
      colleagues: colleagues.map(colleagueOf),
      suggestedId: colleagues.some((one) => one.id === absentee.managerId)
        ? absentee.managerId
        : null,
    };
  }

  /**
   * The days a colleague is away themselves, inside the days they would cover. Asked by the
   * form as cover is chosen, before there is a request to name it on.
   */
  async clashes(
    actor: Actor,
    query: { absenteeId: string; coverId: unknown; from: unknown; to: unknown },
  ): Promise<CoverClash[]> {
    const absentee = await this.employeeFor(query.absenteeId);

    this.guard.enforce(coverPolicy.name(actor, ownerOf(absentee)));

    const { coverId, from, to } = query;

    if (typeof coverId !== 'string' || coverId === '') {
      throw new InvalidCover('coverId', 'Choose who covers.');
    }

    if (!isCalendarDate(from) || !isCalendarDate(to) || to < from) {
      throw new InvalidCover('to', 'Cover runs from one date to a later one, as YYYY-MM-DD.');
    }

    const part = { coverId, from, to };

    return clashesBetween([part], await this.requests.liveOverlapping([coverId], part));
  }

  /**
   * Who is covering for whom today. What the directory's `WhoIsCovering` port is filled with,
   * unguarded as `AwayTodayService.awayOn` is: it names nobody the directory does not.
   */
  async coversOn(day: CalendarDate): Promise<CoverInForce[]> {
    return this.covers.inForceOn(day);
  }

  /** What somebody has been named to cover from this day on, soonest first. The same port. */
  async coveringFrom(employeeId: string, day: CalendarDate): Promise<CoverDuty[]> {
    return (await this.covers.namedFor(employeeId, day)).flatMap((one) => {
      const inside = insideTheLeave(one, one.leave);

      return inside === null || inside.to < day
        ? []
        : [{ absenteeId: one.absenteeId, from: inside.from, to: inside.to, agreed: one.agreed }];
    });
  }

  /** The request and whose it is, or the vague 404 a request id that is nobody gets. */
  private async leaveAndWhose(
    requestId: string,
  ): Promise<{ request: LeaveRequest; absentee: Employee }> {
    const request = await this.requests.findById(requestId);

    if (request === undefined) {
      throw new LeaveRequestNotFound(requestId);
    }

    return { request, absentee: await this.employeeFor(request.employeeId) };
  }

  private async employeeFor(employeeId: string): Promise<Employee> {
    const employee = await this.employees.findById(employeeId);

    if (employee === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    return employee;
  }

  /**
   * Everybody named is at the company today and still here on their last day of cover. The
   * picker offers only current staff; this is the same rule for anything else that asks.
   */
  private async assertAtTheCompany(parts: readonly CoverPart[]): Promise<void> {
    const ids = [...new Set(parts.map((part) => part.coverId))];
    const found = new Map((await this.employees.findAllById(ids)).map((one) => [one.id, one]));
    const today = this.today();

    for (const part of parts) {
      const cover = found.get(part.coverId);

      if (cover === undefined) {
        throw new InvalidCover('coverId', 'Choose who covers from the list of colleagues.');
      }

      const name = `${cover.firstName} ${cover.lastName}`;

      if (!isCurrentOn(cover, today)) {
        throw new CoverNotAtTheCompany(name, 'is not at the company today');
      }

      if (cover.exitDate !== null && cover.exitDate < part.to) {
        throw new CoverNotAtTheCompany(
          name,
          `leaves the company on ${formatDay(cover.exitDate)}, before the cover ends on ` +
            formatDay(part.to),
        );
      }
    }
  }

  /**
   * The cover as it stands, each part cut to the leave's current dates and with who it is.
   * A part outside them is not shown.
   */
  private async planFor(
    request: LeaveRequest,
    standing: readonly NamedCover[],
  ): Promise<CoverPlan> {
    const parts = standing
      .map((one) => insideTheLeave(one, request))
      .filter((one): one is NamedCover => one !== null);

    const coverIds = [...new Set(parts.map((one) => one.coverId))];

    const [people, theirLeave] = await Promise.all([
      this.employees.findAllById(coverIds),
      this.requests.liveOverlapping(coverIds, request),
    ]);

    const byId = new Map(people.map((one) => [one.id, one]));

    return {
      leaveRequestId: request.id,
      absenteeId: request.employeeId,
      from: request.from,
      to: request.to,
      parts: parts.flatMap((one) => {
        const cover = byId.get(one.coverId);

        return cover === undefined
          ? []
          : [
              {
                id: one.id,
                coverId: one.coverId,
                from: one.from,
                to: one.to,
                cover: colleagueOf(cover),
              },
            ];
      }),
      clashes: clashesBetween(parts, theirLeave),
      mayChange: mayChange(request, this.today()),
    };
  }

  /**
   * Tells somebody they have been named. Never thrown out of: the cover is already saved, and
   * an email that could not be queued is not a reason to say naming it failed.
   */
  private async tell(actor: Actor, absentee: Employee, cover: NamedCover): Promise<void> {
    if (this.notifier === undefined) {
      return;
    }

    try {
      await this.notifier.tellCover(actor, {
        absenteeId: absentee.id,
        coverId: cover.coverId,
        from: cover.from,
        to: cover.to,
        reference: cover.id,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'cover.notify.failed',
          at: new Date().toISOString(),
          coverId: cover.id,
          because: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

/** Live, and not over: cover for days already gone covers nobody. */
function mayChange(request: LeaveRequest, today: CalendarDate): boolean {
  return !isSettled(request.status) && request.to >= today;
}

function assertMayChange(request: LeaveRequest, today: CalendarDate): void {
  if (isSettled(request.status)) {
    throw new CoverCannotBeChanged('ENDED');
  }

  if (request.to < today) {
    throw new CoverCannotBeChanged('OVER');
  }
}

function ownerOf(employee: Employee): BalanceOwner {
  return { employeeId: employee.id, managerId: employee.managerId };
}

function colleagueOf(employee: Employee): Colleague {
  return {
    employeeId: employee.id,
    firstName: employee.firstName,
    lastName: employee.lastName,
    jobTitle: employee.jobTitle,
  };
}
