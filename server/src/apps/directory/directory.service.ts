/** The staff directory, assembled. */

import type { Actor } from '../../core/auth/actor.js';
import type { Guard } from '../../core/auth/policy.js';
import { type CalendarDate, currentDate } from '../../core/calendar/time.js';
import type { DepartmentRepository } from '../../core/organisation/department/department.db.js';
import { EmployeeNotFound } from '../../core/organisation/employee/employee.js';
import type { EmployeeRepository } from '../../core/organisation/employee/employee.db.js';
import {
  coverOf,
  coveringFor,
  directoryFor,
  type DirectoryForReader,
  type DirectoryProfile,
  entryFor,
  inBrief,
  isCurrentOn,
  type MyProfile,
  photoIdsOf,
  type PhotoLookup,
  reportingLineOf,
  type StaffChart,
  staffChartFor,
  type WhoIsAway,
  type WhoIsCovering,
  whyNotListed,
} from './directory.js';
import { directoryPolicy } from './policy.js';
import { validateProfileEdit } from './profile.js';

export class DirectoryService {
  constructor(
    /** NFR SEC 02. */
    private readonly guard: Guard,
    private readonly employees: EmployeeRepository,
    /** The name each person's department goes by. */
    private readonly departments: DepartmentRepository,
    /** Who has a photo up, so the screen knows whose to fetch and whose initials to draw. */
    private readonly photos: PhotoLookup,
    /** Who is on agreed leave. Absent, nobody is marked away. */
    private readonly away?: WhoIsAway,
    /** Today, in UTC, which is the day the database's `current_date` is having. NFR DAT 03. */
    private readonly today: () => CalendarDate = () => currentDate(),
    /** Who covers for whom, from leave. Absent, nobody names cover. #226. */
    private readonly covering?: WhoIsCovering,
  ) {}

  /**
   * Everybody at the company today, with whoever is away marked.
   *
   * The whole list in one answer, and the searching is the screen's: a company this size is a
   * few hundred rows, and a search that asked the server on every keystroke would be slower
   * to answer the question it was asked than reading the list once.
   */
  async read(actor: Actor): Promise<DirectoryForReader> {
    this.guard.enforce(directoryPolicy.read(actor));

    const today = this.today();

    /* Everybody, not `activeOnly`: a leaver already marked TERMINATED is still listed until
       their exit date passes, and `isCurrentOn` is what decides that. */
    const [everybody, departments, away, covers] = await Promise.all([
      this.employees.list(),
      this.departments.list(),
      this.away === undefined ? [] : this.away.awayOn(today),
      this.covering === undefined ? [] : this.covering.coversOn(today),
    ]);

    const employees = everybody.filter((one) => isCurrentOn(one, today));
    const ids = employees.map((one) => one.id);
    const [profiles, photos] = await Promise.all([
      this.employees.profilesOf(ids),
      this.photos.photosOf(ids),
    ]);

    return {
      ...directoryFor({ employees, departments, away, profiles, photos, covers, today }),
      may: {
        administer: this.guard.permits(directoryPolicy.administer(actor)),
        seeLoginsToCreate: this.guard.permits(directoryPolicy.loginsToCreate(actor)),
      },
    };
  }

  /**
   * Who reports to whom, among the people at the company today.
   *
   * Built afresh on every read from the manager on each record, which is the field leave
   * requests are routed by, so the chart cannot disagree with where a request goes. A team
   * lead's reports are drawn beside them, and say whom they report to.
   */
  async chart(actor: Actor): Promise<StaffChart> {
    this.guard.enforce(directoryPolicy.chart(actor));

    const today = this.today();
    const [employees, teamLeads, departments] = await Promise.all([
      this.employees.list(),
      this.employees.teamLeadIds(),
      this.departments.list(),
    ]);
    const photos = await this.photos.photosOf(
      employees.filter((one) => isCurrentOn(one, today)).map((one) => one.id),
    );

    return staffChartFor(employees, today, photos, teamLeads, departments);
  }

  /**
   * One person's profile, with their reporting line: anybody current to anybody, and anybody
   * else to HR alone.
   *
   * An id that is nobody and a leaver asked for by somebody who is not HR get the same 404,
   * so the address cannot be used to learn who has left. Found in the list rather than by id,
   * which also finds their manager and reports, and means an id that is not a number, or is
   * too large for one, is nobody rather than a query that fails.
   */
  async person(actor: Actor, employeeId: string): Promise<DirectoryProfile> {
    const today = this.today();
    const everybody = await this.employees.list();
    const employee = everybody.find((one) => one.id === employeeId);

    if (employee === undefined) {
      this.guard.enforce(directoryPolicy.read(actor));
      throw new EmployeeNotFound(employeeId);
    }

    const reason = whyNotListed(employee, today);

    this.guard.enforce(directoryPolicy.readProfile(actor, employee.id, reason === null));

    /* Nobody who is not here is away, or covered for. */
    const [department, away, covers, profiles] = await Promise.all([
      this.departments.findById(employee.departmentId),
      this.away === undefined || reason !== null ? [] : this.away.awayOn(today),
      this.covering === undefined || reason !== null ? [] : this.covering.coversOn(today),
      this.employees.profilesOf([employee.id]),
    ]);

    const coverId = covers.find((one) => one.employeeId === employee.id)?.coverId;

    /* Their own photo, and the photos of whoever is on their reporting line or covering. */
    const photos = await this.photos
      .photosOf(
        everybody
          .filter(
            (one) =>
              one.id === employee.id ||
              one.id === employee.managerId ||
              one.managerId === employee.id ||
              one.id === coverId,
          )
          .map((one) => one.id),
      )
      .then(photoIdsOf);

    return {
      ...entryFor(
        employee,
        department,
        away.find((one) => one.employeeId === employee.id)?.backOn,
        profiles[0],
        photos.get(employee.id),
        coverOf(employee.id, covers, everybody, today, photos),
      ),
      ...reportingLineOf(employee, everybody, today, photos),
      notListed:
        reason === null
          ? null
          : { reason, startDate: employee.startDate, exitDate: employee.exitDate },
    };
  }

  /**
   * The reader's own profile, with what only they are shown of it: when they started.
   */
  async mine(actor: Actor): Promise<MyProfile> {
    this.guard.enforce(directoryPolicy.read(actor));

    /* Not null: the policy above refuses an actor with nobody behind it. */
    const employeeId = actor.employeeId ?? '';
    const employee = await this.employees.findById(employeeId);

    if (employee === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    const today = this.today();

    const [department, away, covers, duties, profiles] = await Promise.all([
      this.departments.findById(employee.departmentId),
      this.away === undefined ? [] : this.away.awayOn(today),
      this.covering === undefined ? [] : this.covering.coversOn(today),
      this.covering === undefined ? [] : this.covering.coveringFrom(employee.id, today),
      this.employees.profilesOf([employee.id]),
    ]);

    /* Their manager, whoever covers for them today, and whoever they are covering for. */
    const coverId = covers.find((one) => one.employeeId === employee.id)?.coverId;
    const named = [
      ...new Set(
        [employee.managerId, coverId, ...duties.map((one) => one.absenteeId)].filter(
          (id): id is string => id !== null && id !== undefined,
        ),
      ),
    ];

    const [others, photos] = await Promise.all([
      this.employees.findAllById(named),
      this.photos.photosOf([employee.id, ...named]).then(photoIdsOf),
    ]);

    const manager = others.find((one) => one.id === employee.managerId);

    return {
      ...entryFor(
        employee,
        department,
        away.find((one) => one.employeeId === employee.id)?.backOn,
        profiles[0],
        photos.get(employee.id),
        coverOf(employee.id, covers, others, today, photos),
      ),
      startDate: employee.startDate,
      manager: manager === undefined ? null : inBrief(manager, photos),
      covering: coveringFor(duties, others, today, photos),
    };
  }

  /**
   * Changes the reader's own work mobile and description. Live at once, with nobody to ask.
   *
   * Whose record it is is decided first, on the id alone, and a refusal is logged by the
   * guard before anything is read. Then the body is checked, and only then is anything
   * written. The audit trigger on `employee` records the change: before, after, who and when.
   */
  async editProfile(actor: Actor, employeeId: string, body: unknown): Promise<MyProfile> {
    this.guard.enforce(directoryPolicy.editProfile(actor, employeeId));

    const edit = validateProfileEdit(body);

    if ((await this.employees.updateProfile(actor, employeeId, edit)) === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    return this.mine(actor);
  }
}
