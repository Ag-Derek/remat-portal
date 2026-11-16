/** Putting a photo on a record, taking it off, and showing it to colleagues. */

import type { Actor } from '../../core/auth/actor.js';
import type { Attribution } from '../../core/audit/audit.js';
import type { Guard } from '../../core/auth/policy.js';
import { type CalendarDate, currentDate } from '../../core/calendar/time.js';
import { EmployeeNotFound } from '../../core/organisation/employee/employee.js';
import type { EmployeeRepository } from '../../core/organisation/employee/employee.db.js';
import type { Storage, StoredObject } from '../../core/storage/index.js';
import { whyNotListed } from './directory.js';
import { directoryPolicy } from './policy.js';
import {
  cropFrom,
  type Photo,
  photoIdFrom,
  PhotoNotFound,
  type PhotoSize,
  photoSizeFrom,
  type StoredRendition,
  validatePhotoContent,
} from './photo.js';
import type { PhotoRepository } from './photo.db.js';
import { processPhoto, type Rendition } from './photo-image.js';

/** What arrives at the door. The content type sent is recorded and never believed. */
export interface UploadedPhoto {
  content: unknown;
  /** `left,top,side`, or nothing for the largest square in the middle. */
  crop: unknown;
  /** For the refusal's message alone. */
  claimedContentType?: string;
}

/** One size of one photo, with its bytes, for an image response. */
export interface PhotoContent {
  photo: Photo;
  rendition: StoredRendition;
  content: Buffer;
}

export class PhotoService {
  constructor(
    /** NFR SEC 02. */
    private readonly guard: Guard,
    private readonly photos: PhotoRepository,
    private readonly employees: EmployeeRepository,
    /** NFR SEC 04. The only thing that knows where bytes live. */
    private readonly storage: Storage,
    /** Today, in UTC, which is what decides who is current. NFR DAT 03. */
    private readonly today: () => CalendarDate = () => currentDate(),
  ) {}

  /**
   * Puts a photo on the reader's own record, replacing any already there.
   *
   * Whose record it is is decided first, on the id alone, as for the other self-service
   * fields. Then the bytes, then the crop, then the two sizes are made — and only once both
   * exist is anything stored. The old photo's files go once the new row is written, so a
   * failure anywhere before that leaves the old photo exactly where it was.
   */
  async upload(actor: Actor, employeeId: string, upload: UploadedPhoto): Promise<Photo> {
    this.guard.enforce(directoryPolicy.editProfile(actor, employeeId));

    const content = validatePhotoContent(upload.content);
    const crop = cropFrom(upload.crop);

    if ((await this.employees.findById(employeeId)) === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    const sizes = await processPhoto(content, crop, upload.claimedContentType);

    const thumbnail = await this.store(sizes.thumbnail);
    let profile: StoredRendition;

    try {
      profile = await this.store(sizes.profile);
    } catch (error) {
      await this.storage.delete(thumbnail.key);
      throw error;
    }

    let written: { photo: Photo; replaced: Photo | undefined };

    try {
      written = await this.photos.replace(attributionOf(actor), { employeeId, thumbnail, profile });
    } catch (error) {
      /* A row that was refused leaves bytes nothing names. Removed here, not left. */
      await Promise.all([this.storage.delete(thumbnail.key), this.storage.delete(profile.key)]);
      throw error;
    }

    if (written.replaced !== undefined) {
      await this.deleteFiles(written.replaced);
    }

    return written.photo;
  }

  /**
   * Takes the reader's own photo off, so they are shown by their initials again.
   *
   * Removing a photo that is not there succeeds, as a second click on Remove should: the
   * record ends up as it was asked to be.
   */
  async remove(actor: Actor, employeeId: string): Promise<void> {
    this.guard.enforce(directoryPolicy.editProfile(actor, employeeId));

    const removed = await this.photos.remove(employeeId);

    if (removed !== undefined) {
      await this.deleteFiles(removed);
    }
  }

  /**
   * One size of a photo, for somebody who may see the profile it is on.
   *
   * The profile's rule exactly: anybody current to anybody signed in, and anybody else to HR
   * alone. A photo id that is nobody's and a leaver's photo asked for by somebody who is not HR
   * get the same 404, so the address cannot be used to learn who has left.
   */
  async read(actor: Actor, photoId: unknown, size: unknown): Promise<PhotoContent> {
    const which: PhotoSize = photoSizeFrom(size);
    const photo = await this.photos.findById(photoIdFrom(photoId));

    if (photo === undefined) {
      this.guard.enforce(directoryPolicy.read(actor));
      throw new PhotoNotFound();
    }

    const employee = await this.employees.findById(photo.employeeId);

    if (employee === undefined) {
      /* Unreachable: a photo names an employee by foreign key and nothing deletes one. */
      throw new PhotoNotFound();
    }

    this.guard.enforce(
      directoryPolicy.readProfile(
        actor,
        employee.id,
        whyNotListed(employee, this.today()) === null,
      ),
    );

    const rendition = photo[which];

    return { photo, rendition, content: await this.storage.get(rendition.key) };
  }

  private async store(rendition: Rendition): Promise<StoredRendition> {
    const stored: StoredObject = await this.storage.put(rendition.content);

    return {
      key: stored.key,
      width: rendition.width,
      height: rendition.height,
      sizeBytes: stored.size,
      checksumSha256: stored.checksumSha256,
    };
  }

  private async deleteFiles(photo: Photo): Promise<void> {
    await Promise.all([
      this.storage.delete(photo.thumbnail.key),
      this.storage.delete(photo.profile.key),
    ]);
  }
}

function attributionOf(actor: Actor): Attribution {
  return { employeeId: actor.employeeId, description: actor.description };
}
