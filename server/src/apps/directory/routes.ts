/** The staff directory, over HTTP. NFR DAT 03. */

import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from 'express';
import type { Guard } from '../../core/auth/policy.js';
import { actorOf } from '../../core/http/identify.js';
import { type RateLimit, rateLimit } from '../../core/http/rate-limit.js';
import type {
  ChartPerson,
  DepartmentInTheDirectory,
  DirectoryEntry,
  DirectoryForReader,
  DirectoryProfile,
  MyProfile,
  PersonInBrief,
  StaffChart,
} from './directory.js';
import type { DirectoryService } from './directory.service.js';
import { MAX_PHOTO_BYTES, type Photo, type PhotoSize, PhotoTooLarge } from './photo.js';
import { readDirectoryEmail, readReceives } from './email.js';
import type { DirectoryEmailService, EmailChoice } from './email.service.js';
import type { PhotoService } from './photo.service.js';
import type { LoginToCreate, PersonNamed, RecordChange, StaffRecord } from './administration.js';
import type {
  AdministrationChoices,
  AdministrationList,
  AdministrationRecord,
  AdministrationService,
} from './administration.service.js';

export interface DirectoryRoutes {
  /** NFR SEC 03. Where a request over a limit is written down. */
  guard: Guard;
  directory: DirectoryService;
  /** Optional, so a test app without photos has no photo routes and shows everybody's initials. */
  photos?: PhotoService;
  /** Optional, so a test app without email has no email preference routes. */
  emails?: DirectoryEmailService;
  /** HR's Administration tab. Optional, so an app built without one has no such routes. */
  administration?: AdministrationService;
  /** {@link DIRECTORY_LIMITS}, unless a test needs to reach one sooner or never. */
  limits?: DirectoryLimits;
}

/** How much one person may ask of the routes that have a limit. */
export interface DirectoryLimits {
  /** Between them, every route that finds people. One count, so moving between them saves nothing. */
  lookups: RateLimit;
  photoUploads: RateLimit;
}

/**
 * The directory's limits.
 *
 * The search box filters what `GET /directory` already answered, so a lookup is a screen opened
 * and never a keystroke: sixty a minute is nobody working normally, and is somebody walking the
 * id sequence. Twenty photos an hour leaves room to try again, and each one costs a resize.
 * Reading a photo has no limit: a list of a few hundred faces is a few hundred requests.
 */
export const DIRECTORY_LIMITS: DirectoryLimits = {
  lookups: { max: 60, windowSeconds: 60 },
  photoUploads: { max: 20, windowSeconds: 60 * 60 },
};

/**
 * How long a browser may keep an image without asking again: a year, the longest any of them
 * honours. Safe because the photo's id is in its address and a new photo is a new id, so an
 * address never comes to mean a different picture.
 */
const PHOTO_CACHE_SECONDS = 365 * 24 * 60 * 60;

/** The raw body parser for an upload, capped at the photo limit. */
const photoBytes = express.raw({ type: () => true, limit: MAX_PHOTO_BYTES });

/**
 * The upload body, with a photo over the cap refused in a photo's own words.
 *
 * The parser refuses it before any route runs, in its own shape, and the error handler would
 * otherwise answer it with an attachment's limit.
 */
function photoBody(request: Request, response: Response, next: NextFunction): void {
  photoBytes(request, response, (error?: unknown) => {
    if ((error as { type?: unknown } | undefined)?.type === 'entity.too.large') {
      next(new PhotoTooLarge(Number((error as { length?: unknown }).length) || 0));
      return;
    }

    next(error);
  });
}

export function directoryRoutes({
  guard,
  directory,
  photos,
  emails,
  administration,
  limits = DIRECTORY_LIMITS,
}: DirectoryRoutes): Router {
  const routes = Router();

  const lookups = rateLimit(
    guard,
    'lookUpPeople',
    limits.lookups,
    'That is a lot of lookups in a short time. Wait a moment, then try again.',
  );
  const uploads = rateLimit(
    guard,
    'uploadPhoto',
    limits.photoUploads,
    'That is a lot of photos in a short time. Wait a while, then try again.',
  );

  /* Before `/directory/people/:employeeId`, though no path here can be mistaken for one. */
  if (administration !== undefined) {
    administrationRoutes(routes, administration, lookups);
  }

  /** Everybody at the company today. Behind identify, so a session is needed to ask. */
  routes.get('/directory', lookups, (_request: Request, response: Response, next) => {
    void directory
      .read(actorOf(response))
      .then((found) => {
        response.json(directoryAsJson(found));
      })
      .catch(next);
  });

  /** Who reports to whom, among everybody at the company today. */
  routes.get('/directory/chart', (_request: Request, response: Response, next) => {
    void directory
      .chart(actorOf(response))
      .then((chart) => {
        response.json(chartAsJson(chart));
      })
      .catch(next);
  });

  /** One person: anybody current to anybody, and a leaver to HR alone. Otherwise 404. */
  routes.get(
    '/directory/people/:employeeId',
    lookups,
    (request: Request<{ employeeId: string }>, response: Response, next) => {
      void directory
        .person(actorOf(response), request.params.employeeId)
        .then((person) => {
          response.json(personProfileAsJson(person));
        })
        .catch(next);
    },
  );

  /** My own profile, with the HR-kept facts only I am shown. `/me` names the reader. */
  routes.get('/me/profile', (_request: Request, response: Response, next) => {
    void directory
      .mine(actorOf(response))
      .then((mine) => {
        response.json(profileAsJson(mine));
      })
      .catch(next);
  });

  /**
   * Changing the self-service fields on a record. Only its owner may, and anybody else is
   * answered 403 and logged; the id is in the path so that the refusal has something to
   * refuse. The body is passed on whole for the service to check, so a field HR keeps is
   * named in the refusal rather than dropped on the floor here.
   */
  routes.patch(
    '/people/:employeeId/profile',
    (request: Request<{ employeeId: string }>, response: Response, next) => {
      void directory
        .editProfile(actorOf(response), request.params.employeeId, request.body)
        .then((mine) => {
          response.json(profileAsJson(mine));
        })
        .catch(next);
    },
  );

  if (photos !== undefined) {
    photoRoutes(routes, photos, uploads);
  }

  if (emails !== undefined) {
    emailRoutes(routes, emails);
    messageRoutes(routes, emails);
  }

  return routes;
}

/**
 * HR's Administration tab, under `/directory/admin`. Every one asks `directoryPolicy.administer`
 * before anything else, so anybody who is not HR is answered 403 whatever the id.
 *
 * No DELETE: a record is never removed. FR 06.
 */
function administrationRoutes(
  routes: Router,
  administration: AdministrationService,
  lookups: RequestHandler,
): void {
  /** Everybody with a record, leavers included. Searching and filtering are the screen's. */
  routes.get('/directory/admin/people', lookups, (_request: Request, response: Response, next) => {
    void administration
      .list(actorOf(response))
      .then((list) => {
        response.json(administrationListAsJson(list));
      })
      .catch(next);
  });

  /** What the add and edit forms offer: open departments, current staff, working patterns. */
  routes.get('/directory/admin/choices', (_request: Request, response: Response, next) => {
    void administration
      .choices(actorOf(response))
      .then((choices) => {
        response.json(choicesAsJson(choices));
      })
      .catch(next);
  });

  /** New records waiting for a login. HR's and whoever creates logins. */
  routes.get('/directory/admin/logins-to-create', (_request: Request, response: Response, next) => {
    void administration
      .loginsToCreate(actorOf(response))
      .then((waiting) => {
        response.json({ loginsToCreate: waiting.map(loginToCreateAsJson) });
      })
      .catch(next);
  });

  /** Adds somebody. 201, with the record as it now stands. */
  routes.post('/directory/admin/people', (request: Request, response: Response, next) => {
    void administration
      .add(actorOf(response), request.body)
      .then((record) => {
        response.status(201).json(administrationRecordAsJson(record));
      })
      .catch(next);
  });

  routes.get(
    '/directory/admin/people/:employeeId',
    (request: Request<{ employeeId: string }>, response: Response, next) => {
      void administration
        .record(actorOf(response), request.params.employeeId)
        .then((record) => {
          response.json(administrationRecordAsJson(record));
        })
        .catch(next);
    },
  );

  /** Changes the fields HR keeps. Only the fields sent are changed. */
  routes.patch(
    '/directory/admin/people/:employeeId',
    (request: Request<{ employeeId: string }>, response: Response, next) => {
      void administration
        .edit(actorOf(response), request.params.employeeId, request.body)
        .then((record) => {
          response.json(administrationRecordAsJson(record));
        })
        .catch(next);
    },
  );

  /** Moves some or all of somebody's reports to another manager. */
  routes.post(
    '/directory/admin/people/:employeeId/reports',
    (request: Request<{ employeeId: string }>, response: Response, next) => {
      void administration
        .reassignReports(actorOf(response), request.params.employeeId, request.body)
        .then(({ moved, to }) => {
          response.json({ moved: moved.map(namedAsJson), to: namedAsJson(to) });
        })
        .catch(next);
    },
  );

  /** `{ "teamLead": true }`: their reports are drawn beside them on the chart. Nothing else. */
  routes.put(
    '/directory/admin/people/:employeeId/team-lead',
    (request: Request<{ employeeId: string }>, response: Response, next) => {
      void administration
        .setTeamLead(actorOf(response), request.params.employeeId, request.body)
        .then((record) => {
          response.json(administrationRecordAsJson(record));
        })
        .catch(next);
    },
  );
}

function namedAsJson(person: PersonNamed): unknown {
  return {
    employeeId: person.employeeId,
    firstName: person.firstName,
    lastName: person.lastName,
    jobTitle: person.jobTitle,
  };
}

/** One row of HR's list. Ten-character dates throughout. NFR DAT 03. */
function staffRecordAsJson(record: StaffRecord): unknown {
  const { employee } = record;

  return {
    employeeId: employee.id,
    employeeNumber: employee.employeeNumber,
    firstName: employee.firstName,
    lastName: employee.lastName,
    workEmail: employee.workEmail,
    jobTitle: employee.jobTitle,
    department: { id: employee.departmentId, name: record.departmentName },
    manager: record.manager === null ? null : namedAsJson(record.manager),
    workPatternId: employee.workPatternId,
    startDate: employee.startDate,
    exitDate: employee.exitDate,
    employmentType: employee.employmentType,
    employmentStatus: employee.employmentStatus,
    gender: employee.gender,
    standing: record.standing,
    login: record.login,
    reports: record.reports,
  };
}

function administrationListAsJson(list: AdministrationList): unknown {
  return {
    today: list.today,
    records: list.records.map(staffRecordAsJson),
    departments: list.departments.map(departmentAsJson),
    loginsToCreate: list.loginsToCreate.map(loginToCreateAsJson),
    systemAdministrators: list.systemAdministrators.map(namedAsJson),
  };
}

function administrationRecordAsJson(record: AdministrationRecord): unknown {
  return {
    ...(staffRecordAsJson(record) as object),
    today: record.today,
    workPatternName: record.workPatternName,
    reportsStillHere: record.reportsStillHere.map(namedAsJson),
    teamLead: record.teamLead,
    history: record.history.map(changeAsJson),
  };
}

function changeAsJson(change: RecordChange): unknown {
  return {
    at: change.at.toISOString(),
    action: change.action,
    by: change.by,
    changes: change.changes.map((one) => ({
      field: one.field,
      label: one.label,
      from: one.from,
      to: one.to,
    })),
  };
}

function loginToCreateAsJson(waiting: LoginToCreate): unknown {
  return {
    person: namedAsJson(waiting.person),
    workEmail: waiting.workEmail,
    startDate: waiting.startDate,
    soon: waiting.soon,
  };
}

function choicesAsJson(choices: AdministrationChoices): unknown {
  return {
    today: choices.today,
    departments: choices.departments.map(departmentAsJson),
    managers: choices.managers.map(namedAsJson),
    patterns: choices.patterns.map((one) => ({
      id: one.id,
      name: one.name,
      isDefault: one.isDefault,
    })),
    employmentTypes: choices.employmentTypes,
    employmentStatuses: choices.employmentStatuses,
    genders: choices.genders,
  };
}

function emailRoutes(routes: Router, emails: DirectoryEmailService): void {
  /** The emails I can be sent, and which come to me. `/me` names the reader. */
  routes.get('/me/email-preferences', (_request: Request, response: Response, next) => {
    void emails
      .choices(actorOf(response))
      .then((choices) => {
        response.json({ emails: choices.map(choiceAsJson) });
      })
      .catch(next);
  });

  /**
   * Turns one on or off: `{ "receives": false }`. Turning off one that is always sent is
   * refused with a 409 that says why. Answered with the whole list, as it now stands.
   */
  routes.put(
    '/me/email-preferences/:email',
    (request: Request<{ email: string }>, response: Response, next) => {
      void Promise.resolve()
        .then(() =>
          emails.choose(
            actorOf(response),
            readDirectoryEmail(request.params.email),
            readReceives(request.body),
          ),
        )
        .then((choices) => {
          response.json({ emails: choices.map(choiceAsJson) });
        })
        .catch(next);
    },
  );
}

/**
 * Writing to a colleague from their profile: `{ "subject": "...", "message": "..." }`. Answered
 * 202, because it is queued rather than sent; the writer gets a copy in their inbox.
 */
function messageRoutes(routes: Router, emails: DirectoryEmailService): void {
  routes.post(
    '/people/:employeeId/messages',
    (request: Request<{ employeeId: string }>, response: Response, next) => {
      void emails
        .sendMessage(actorOf(response), request.params.employeeId, request.body)
        .then(() => {
          response.status(202).json({ queued: true });
        })
        .catch(next);
    },
  );
}

function choiceAsJson(choice: EmailChoice): unknown {
  return {
    email: choice.email,
    label: choice.label,
    description: choice.description,
    optional: choice.optional,
    receives: choice.receives,
  };
}

function photoRoutes(routes: Router, photos: PhotoService, uploads: RequestHandler): void {
  /**
   * Puts up a photo, replacing any already there. Only its owner may.
   *
   * **The body is the image**, as with attachments: one file, no multipart form. What it is
   * is read from the bytes. The square to cut is `X-Photo-Crop: left,top,side`, in pixels of
   * the image the right way up; without it, the largest square in the middle.
   *
   * The limit comes first, so a refused upload is not read off the wire.
   */
  routes.put(
    '/people/:employeeId/photo',
    uploads,
    photoBody,
    (request: Request<{ employeeId: string }>, response: Response, next) => {
      void photos
        .upload(actorOf(response), request.params.employeeId, {
          content: request.body,
          crop: request.get('x-photo-crop'),
          claimedContentType: request.get('content-type') ?? '',
        })
        .then((photo) => {
          response.status(201).json(uploadedAsJson(photo));
        })
        .catch(next);
    },
  );

  /**
   * Takes the photo down, leaving the initials. Only its owner may.
   *
   * `:id` rather than `:employeeId`, so that the check for a route deleting an employee
   * (tests/unit/employee-never-deleted.test.ts) has nothing here to mistake for one.
   */
  routes.delete(
    '/people/:id/photo',
    (request: Request<{ id: string }>, response: Response, next) => {
      void photos
        .remove(actorOf(response), request.params.id)
        .then(() => {
          response.status(204).end();
        })
        .catch(next);
    },
  );

  /**
   * One size of one photo. Behind identify, so only somebody signed in gets an image, and
   * only of somebody whose profile they may see.
   *
   * `private` so that no shared cache between here and the browser keeps a copy, and
   * `immutable` because the address names the photo rather than the person. The checksum is
   * the ETag, so a browser that does ask again is answered 304 with no body.
   */
  routes.get(
    '/photos/:photoId/:size',
    (request: Request<{ photoId: string; size: string }>, response: Response, next) => {
      void photos
        .read(actorOf(response), request.params.photoId, request.params.size)
        .then(({ photo, rendition, content }) => {
          response
            .status(200)
            .set('Content-Type', photo.contentType)
            .set('X-Content-Type-Options', 'nosniff')
            .set('Cache-Control', `private, max-age=${String(PHOTO_CACHE_SECONDS)}, immutable`)
            .set('ETag', `"${rendition.checksumSha256}"`)
            .set('Content-Disposition', 'inline')
            .send(content);
        })
        .catch(next);
    },
  );
}

/**
 * Where somebody's photo is, at each size, or null for their initials.
 *
 * Paths rather than absolute addresses, as for attachment links, so nothing here decides what
 * host the application answers on.
 */
function photoAsJson(photoId: string | null): unknown {
  if (photoId === null) {
    return null;
  }

  const at = (size: PhotoSize) => `/api/photos/${encodeURIComponent(photoId)}/${size}`;

  return { thumbnail: at('thumbnail'), profile: at('profile') };
}

/** A photo just put up: where it is, and what was made. The storage keys stay here. */
function uploadedAsJson(photo: Photo): unknown {
  return {
    photo: photoAsJson(photo.id),
    contentType: photo.contentType,
    thumbnail: { width: photo.thumbnail.width, height: photo.thumbnail.height },
    profile: { width: photo.profile.width, height: photo.profile.height },
    uploadedAt: photo.uploadedAt.toISOString(),
  };
}

/** Somebody's own profile. Only ever sent to the person it is. */
function profileAsJson(mine: MyProfile): unknown {
  return {
    ...(entryAsJson(mine) as object),
    /** Ten characters. NFR DAT 03. */
    startDate: mine.startDate,
    manager: mine.manager === null ? null : briefAsJson(mine.manager),
    /** Whose leave they are covering. Ten characters each. NFR DAT 03. */
    covering: mine.covering.map((one) => ({
      person: briefAsJson(one.person),
      from: one.from,
      to: one.to,
      agreed: one.agreed,
    })),
  };
}

function briefAsJson(person: PersonInBrief): unknown {
  return {
    employeeId: person.employeeId,
    firstName: person.firstName,
    lastName: person.lastName,
    jobTitle: person.jobTitle,
    photo: photoAsJson(person.photoId),
  };
}

/**
 * The whole answer, field by field.
 *
 * Written out rather than sent whole, so that a field added to the domain reaches every
 * employee only when somebody edits this file.
 */
function directoryAsJson(directory: DirectoryForReader): unknown {
  return {
    today: directory.today,
    people: directory.people.map(entryAsJson),
    departments: directory.departments.map(departmentAsJson),
    /** Which parts of the Administration tab to draw. The routes behind it ask again. */
    may: {
      administer: directory.may.administer,
      seeLoginsToCreate: directory.may.seeLoginsToCreate,
    },
  };
}

function entryAsJson(entry: DirectoryEntry): unknown {
  return {
    employeeId: entry.employeeId,
    firstName: entry.firstName,
    lastName: entry.lastName,
    jobTitle: entry.jobTitle,
    department: departmentAsJson(entry.department),
    workEmail: entry.workEmail,
    /** Ten characters, or null where they are in. NFR DAT 03. */
    backOn: entry.backOn,
    /** What they keep themselves. Null where they have said nothing. */
    workMobile: entry.workMobile,
    description: entry.description,
    /** Null where they have none, and the screen draws their initials. */
    photo: photoAsJson(entry.photoId),
    /** Who to contact instead while they are away. Null when they are in or named nobody. */
    cover: entry.cover === null ? null : briefAsJson(entry.cover),
  };
}

/**
 * One person's profile. `notListed` is only ever non null for HR. No start date for anybody
 * current: that is on their own profile only.
 */
function personProfileAsJson(person: DirectoryProfile): unknown {
  return {
    ...(entryAsJson(person) as object),
    manager: person.manager === null ? null : briefAsJson(person.manager),
    reports: person.reports.map(briefAsJson),
    notListed:
      person.notListed === null
        ? null
        : {
            reason: person.notListed.reason,
            /** Ten characters each. NFR DAT 03. */
            startDate: person.notListed.startDate,
            exitDate: person.notListed.exitDate,
          },
  };
}

/** The chart, field by field, for the reason the directory is. */
function chartAsJson(chart: StaffChart): unknown {
  return {
    today: chart.today,
    lines: chart.lines.map((line) => ({ standing: line.standing, top: personAsJson(line.top) })),
    total: chart.total,
  };
}

/**
 * One person and everybody under them.
 *
 * Recursive where the builder is not: the builder is handed whatever the table holds and has
 * to survive a loop, which is infinitely deep until something bounds it. By here every loop is
 * broken, and the depth is the organisation's.
 */
function personAsJson(person: ChartPerson): unknown {
  return {
    employeeId: person.employeeId,
    firstName: person.firstName,
    lastName: person.lastName,
    jobTitle: person.jobTitle,
    photo: photoAsJson(person.photoId),
    department: departmentAsJson(person.department),
    /** The team lead they report to, where they are drawn beside that lead. */
    ledBy: person.ledBy,
    reports: person.reports.map(personAsJson),
  };
}

function departmentAsJson(department: DepartmentInTheDirectory): unknown {
  return { id: department.id, name: department.name };
}
