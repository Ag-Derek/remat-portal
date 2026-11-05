# The directory API

Every endpoint the staff directory answers, for somebody writing a client or a test. Who may
do what, and why, is in [Authorisation and audit](authorisation-and-audit.md).

The routes are in `server/src/apps/directory/routes.ts`.

---

## What every endpoint has in common

**A session.** All of them sit behind `identify()`, so a request without a valid session cookie
gets a `401` and nothing else happens.

**Refusals have one shape**, from `server/src/core/http/problems.ts`:

```json
{ "error": "InvalidProfile", "message": "Work mobile must be a phone number…", "field": "workMobile" }
```

`message` is written for a person. `field` appears where one input was at fault.

| Status | Meaning |
|---|---|
| `400` | What was sent is wrong; `field` says where |
| `401` | No valid session |
| `403` | Refused, with the rule named, by a policy that has nothing to hide |
| `404` | Not there, or not for you. The two are one answer, so an address cannot show who has left |
| `409` | Well formed, but the state of the record refuses it |
| `413` | A photo over the size limit |
| `429` | Over a [limit](#limits). Waiting is the fix |

Every `403`, every `404` from a policy and every `429` from a limit is written to the denial log.
NFR SEC 03.

**Dates** are ten characters, `2026-10-30`. **Ids** are strings. An id that is not a number is
nobody, and gets a `404`.

## Limits

Counted per signed-in person, per process, in a window that starts with their first request.

| Limit | Routes | Allowance |
|---|---|---|
| Lookups | `GET /directory`, `GET /directory/people/:id`, `GET /directory/admin/people` | 60 a minute, shared between them |
| Photo uploads | `PUT /people/:id/photo` | 20 an hour |
| Messages | `POST /people/:id/messages` | 10 an hour |

Past a limit the answer is a `429` with `Retry-After` in seconds, and an upload is refused before
its body is read. Searching does not count against anything: the search box filters what
`GET /directory` already answered. Reading a photo has no limit, because a list of faces is a
request each.

## Reading the directory

### `GET /api/directory`

Everybody at the company today, by surname, and the departments they are in. Any employee.

```json
{
  "today": "2026-10-30",
  "people": [ { "…": "an entry" } ],
  "departments": [ { "id": "3", "name": "Operations" } ],
  "may": { "administer": false, "seeLoginsToCreate": false }
}
```

`may` says which parts of the Administration tab to draw. The routes behind it ask again.

An entry:

| Field | |
|---|---|
| `employeeId`, `firstName`, `lastName`, `jobTitle`, `workEmail` | |
| `department` | `{ id, name }` |
| `backOn` | The working day they return, or `null` where they are in |
| `workMobile`, `description` | What they keep themselves, or `null` |
| `photo` | `{ thumbnail, profile }` paths, or `null` for their initials |
| `cover` | Who to contact while they are away, in brief, or `null` |

"In brief" is `{ employeeId, firstName, lastName, jobTitle, photo }`.

### `GET /api/directory/chart`

Who reports to whom, among everybody here today. Any employee.

```json
{ "today": "2026-10-30", "lines": [ { "standing": "…", "top": { "…": "a person" } } ], "total": 12 }
```

A person is `{ employeeId, firstName, lastName, jobTitle, photo, reports: [...] }`, nested down.

### `GET /api/directory/people/:employeeId`

One person: an entry, plus `manager` (in brief, or `null`), `reports` (in brief) and `notListed`.

Anybody current is every employee's to read. Anybody else is HR's, and `404` to everyone else.
`notListed` is `null` for somebody current, and otherwise
`{ reason, startDate, exitDate }`, where `reason` is `NOT_STARTED`, `LEFT` or `SUSPENDED`.

### `GET /api/me/profile`

The reader's own entry, plus `startDate`, `manager` and `covering`: whose leave they are covering,
as `[{ person, from, to, agreed }]`.

## Changing your own profile

Only the person whose record it is. Anybody else, HR included, gets a `403`.

### `PATCH /api/people/:employeeId/profile`

```json
{ "workMobile": "024 555 0197", "description": "Come to me about tender notices." }
```

Answers with the profile as `GET /api/me/profile` does. An absent field is left alone, and `null`
or an empty string clears it. Live at once, and audited.

| Field | Rule |
|---|---|
| `workMobile` | 10 digits starting with 0, or `+` and 8 to 15 digits. Spaces, hyphens and brackets allowed. At most 20 characters |
| `description` | At most 280 characters |

Any other field is refused with a `400` naming it.

### `PUT /api/people/:employeeId/photo`

The body is the image itself: JPEG, PNG or WebP, at most 8 MB, at least 128 pixels on its shorter
side. The type is read from the bytes rather than the `Content-Type` header.

`X-Photo-Crop: left,top,side` picks the square, in pixels of the image the right way up. Without
it, the largest square in the middle. Replaces any photo already there.

```json
{
  "photo": { "thumbnail": "/api/photos/9/thumbnail", "profile": "/api/photos/9/profile" },
  "contentType": "image/webp",
  "thumbnail": { "width": 128, "height": 128 },
  "profile": { "width": 512, "height": 512 },
  "uploadedAt": "2026-10-30T09:15:00.000Z"
}
```

Answers `201`. Refused with a `400` for the wrong type or a photo too small, and a `413` for one
too large.

### `DELETE /api/people/:employeeId/photo`

Takes it down, leaving the initials. `204`, including when there was none.

### `GET /api/photos/:photoId/:size`

`size` is `thumbnail` or `profile`. Served as WebP to anybody who may read the profile it is on,
otherwise `404`. Cached privately for a year, with its checksum as the `ETag`: a new photo is a new
id, so an address never comes to mean a different picture.

## Emails

### `GET /api/me/email-preferences`

```json
{ "emails": [ { "email": "NEW_COLLEAGUE", "label": "…", "description": "…", "optional": true, "receives": true } ] }
```

### `PUT /api/me/email-preferences/:email`

Body `{ "receives": false }`. Answers with the whole list. Turning off an email that is always
sent is a `409`, and an `:email` that is not one is a `404`.

### `POST /api/people/:employeeId/messages`

Writes to a colleague from their profile: `{ "subject": "…", "message": "…" }`, at most 150 and
5,000 characters. Answers `202` with `{ "queued": true }`, because it is queued rather than sent.
Anybody current, and never yourself.

## HR's Administration tab

`HR_OFFICER` and `HR_ADMIN`, except where it says otherwise. Anybody else gets a `403` whatever the
id, before anybody is looked up. There is no `DELETE`: a record is never removed. FR 06.

| Route | |
|---|---|
| `GET /api/directory/admin/people` | Every record, leavers included, with `today`, `departments`, `loginsToCreate` and `systemAdministrators` |
| `GET /api/directory/admin/choices` | What the forms offer: departments, managers, patterns, and the employment and gender values |
| `GET /api/directory/admin/logins-to-create` | New records waiting for a login. `SYS_ADMIN` as well |
| `POST /api/directory/admin/people` | Adds somebody. `201`, with the record |
| `GET /api/directory/admin/people/:employeeId` | One record, with its history |
| `PATCH /api/directory/admin/people/:employeeId` | Changes only the fields sent |
| `POST /api/directory/admin/people/:employeeId/reports` | Moves their reports |

A record's fields, each a string or `null`: `employeeNumber`, `firstName`, `lastName`, `workEmail`,
`jobTitle`, `departmentId`, `managerId`, `workPatternId`, `startDate`, `exitDate`, `employmentType`,
`employmentStatus`, `gender`. `workMobile`, `description` and `photo` are the person's own, and
sending one is a `400`.

Moving reports takes `{ "toManagerId": "12", "employeeIds": ["31", "32"] }`, with `employeeIds`
left out or `null` for all of them still here. It answers `{ moved, to }`.
