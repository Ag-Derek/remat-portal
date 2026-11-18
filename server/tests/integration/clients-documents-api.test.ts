import type { Kysely } from 'kysely';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { PINNED_DATE } from '../setup/pinned-date.js';
import { seed } from '../../seeds/seed.mjs';
import { type Database, databaseFor } from '../../src/core/db/index.js';
import { ClientsRoleRepository } from '../../src/apps/clients/role.db.js';
import { type Asker, type ClientsApp, startClientsApp } from '../support/clients-app.js';
import { InMemoryStorage } from '../support/in-memory-storage.js';
import { recordingDenials } from '../support/recording-denials.js';
import {
  A_DOCX,
  A_JPEG,
  A_PDF,
  A_PLAIN_ZIP,
  A_PNG,
  A_PPTX,
  A_PROGRAM,
  AN_INFECTED_PDF,
  AN_XLSX,
} from '../support/sample-files.js';

/**
 * Documents on activities and deals, over HTTP against a real database. #281, Clients SRS CLI 67
 * to CLI 70, TDD 4.6.
 *
 * On a deal, open or ended, anybody with a role attaches; on an activity, whoever logged it, at any
 * time (the user, 18 November 2026).
 */

const testDatabaseUrl = await databaseForThisFile();

const denials = recordingDenials();

let db: Kysely<Database>;
let admin: Client;
let app: ClientsApp;
let people: Record<string, string>;
let products: Record<string, string>;

let bdManager: Asker;
let associate: Asker;
let colleague: Asker;
let nobody: Asker;

/** ADB, its CreditStudio deal (the associate's), and a call about it the associate logged. */
let adb: string;
let deal: string;
let call: string;

interface DocumentJson {
  id: string;
  clientId: string;
  activityId: string | null;
  opportunityId: string | null;
  filename: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  scanStatus: string;
  downloadable: boolean;
  uploadedBy: { id: string; name: string };
  uploadedAt: string;
}

interface ProblemJson {
  error: string;
  message: string;
  field?: string;
}

const YESTERDAY = (() => {
  const date = new Date(`${PINNED_DATE}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);

  return date.toISOString().slice(0, 10);
})();

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);
  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();
  app = await startClientsApp(db, denials);
});

beforeEach(async () => {
  people = (await seed(admin)) as Record<string, string>;
  app.storage.reset();

  const grants = new ClientsRoleRepository(db);
  await grants.grant(people.commercialDirector, 'BD_MANAGER', people.headOfHr, 'them');
  await grants.grant(people.officer, 'ASSOCIATE', people.headOfHr, 'them');
  await grants.grant(people.opsDirector, 'ASSOCIATE', people.headOfHr, 'them');

  bdManager = { employeeId: people.commercialDirector };
  associate = { employeeId: people.officer };
  colleague = { employeeId: people.opsDirector };
  nobody = { employeeId: people.engineer };

  await admin.query('UPDATE clients_product SET retired_on = NULL');
  await admin.query('UPDATE clients_product_line SET retired_on = NULL');
  const { rows } = await admin.query<{ id: string; name: string }>(
    'SELECT id, name FROM clients_product',
  );
  products = Object.fromEntries(rows.map((row) => [row.name, row.id]));

  adb = await aClient('ADB');
  deal = await aDeal(adb);
  call = await aCall(associate);

  denials.clear();
});

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await admin?.end();
});

async function aClient(name: string): Promise<string> {
  const response = await app.send('POST', '/api/clients/clients', bdManager, {
    name,
    typeId: (
      await admin.query<{ id: string }>(`SELECT id FROM clients_client_type WHERE name = 'Bank'`)
    ).rows[0].id,
  });
  expect(response.status).toBe(201);

  return ((await response.json()) as { id: string }).id;
}

async function aDeal(client: string): Promise<string> {
  const response = await app.send('POST', '/api/clients/opportunities', associate, {
    clientId: client,
    productId: products.CreditStudio,
  });
  expect(response.status).toBe(201);

  return ((await response.json()) as { id: string }).id;
}

async function aCall(as: Asker, client = adb): Promise<string> {
  const response = await app.send('POST', '/api/clients/activities', as, {
    clientId: client,
    kind: 'CALL',
    happenedOn: YESTERDAY,
  });
  expect(response.status).toBe(201);

  return ((await response.json()) as { activity: { id: string } }).activity.id;
}

function toDeal(
  id: string,
  as: Asker,
  file: { content: Buffer; filename?: string; contentType?: string } = { content: A_PDF },
): Promise<globalThis.Response> {
  return app.sendFile(`/api/clients/opportunities/${id}/documents`, as, file);
}

function toActivity(
  id: string,
  as: Asker,
  file: { content: Buffer; filename?: string; contentType?: string } = { content: A_PDF },
): Promise<globalThis.Response> {
  return app.sendFile(`/api/clients/activities/${id}/documents`, as, file);
}

async function attached(response: globalThis.Response): Promise<DocumentJson> {
  expect(response.status).toBe(201);

  return (await response.json()) as DocumentJson;
}

async function refused(response: globalThis.Response, status: number): Promise<ProblemJson> {
  expect(response.status).toBe(status);

  return (await response.json()) as ProblemJson;
}

async function documentCount(): Promise<number> {
  const { rows } = await admin.query<{ n: string }>('SELECT count(*) AS n FROM clients_document');

  return Number(rows[0].n);
}

/* ---------------------------------------------------------------------- on a deal */

describe('attaching a document to a deal', () => {
  /* CLI 67, CLI 68. */
  it('keeps the file, and says what it is, how big, and who attached it', async () => {
    const document = await attached(
      await toDeal(deal, associate, { content: A_PDF, filename: 'Proposal for ADB.pdf' }),
    );

    expect(document).toMatchObject({
      clientId: adb,
      opportunityId: deal,
      activityId: null,
      filename: 'Proposal for ADB.pdf',
      contentType: 'application/pdf',
      sizeBytes: A_PDF.byteLength,
      scanStatus: 'CLEAN',
      downloadable: true,
      uploadedBy: { id: people.officer },
    });
    expect(document.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(app.storage.size).toBe(1);
  });

  /* CLI 68: storage's handle is the server's alone. */
  it('never tells the browser where the file is kept', async () => {
    const response = await toDeal(deal, associate);
    const text = await response.text();
    const { rows } = await admin.query<{ storage_key: string }>(
      'SELECT storage_key FROM clients_document',
    );

    expect(text).not.toContain(rows[0].storage_key);
    expect(text).not.toMatch(/storageKey/);
  });

  it("is anybody's with a role, whosever the deal", async () => {
    for (const as of [associate, colleague, bdManager]) {
      expect((await toDeal(deal, as)).status).toBe(201);
    }
  });

  /* #281: a signed contract goes on a deal once it is won, which has ended it. */
  it('goes on a deal that has ended as well as an open one', async () => {
    const reason = await admin.query<{ id: string }>(
      `SELECT id FROM clients_reason WHERE applies_to = 'LOST' AND retired_on IS NULL LIMIT 1`,
    );
    const lost = await app.send('POST', `/api/clients/opportunities/${deal}/lose`, associate, {
      reasonId: reason.rows[0].id,
    });
    expect(lost.status).toBe(200);

    expect((await toDeal(deal, colleague)).status).toBe(201);
  });

  it('is not found for a deal that does not exist', async () => {
    expect(await refused(await toDeal('99999999', associate), 404)).toMatchObject({
      error: 'OpportunityNotFound',
    });
  });

  it('is refused silently to somebody with no role, for a real deal', async () => {
    expect((await toDeal(deal, nobody)).status).toBe(404);
    expect(await documentCount()).toBe(0);
    expect(app.storage.size).toBe(0);
  });
});

/* ------------------------------------------------------------------- on an activity */

describe('attaching a document to an activity', () => {
  it('keeps it on the activity, for whoever logged it', async () => {
    expect(await attached(await toActivity(call, associate))).toMatchObject({
      clientId: adb,
      activityId: call,
      opportunityId: null,
    });
  });

  /* #281: a file added is not a change to what was logged, so the 24 hours do not stop it. */
  it('is still theirs to do long after the activity was logged', async () => {
    await admin.query(
      `UPDATE clients_activity SET logged_at = now() - interval '30 days' WHERE id = $1`,
      [call],
    );

    expect((await toActivity(call, associate)).status).toBe(201);
  });

  it('is refused openly to anybody else with a role, a BD manager included, naming who logged it', async () => {
    for (const as of [colleague, bdManager]) {
      const problem = await refused(await toActivity(call, as), 403);

      expect(problem.error).toBe('NotAuthorised');
      expect(problem.message).toMatch(/can attach files to this activity/);
    }
    expect(await documentCount()).toBe(0);
    expect(app.storage.size).toBe(0);
  });

  it('is not found for an activity that does not exist, and silent to somebody with no role', async () => {
    expect((await toActivity('99999999', associate)).status).toBe(404);
    expect((await toActivity(call, nobody)).status).toBe(404);
  });
});

/* -------------------------------------------------------------- what may be attached */

describe('what may be attached', () => {
  /* The user, 18 November 2026: PDF and Word, and workbooks, decks and pictures. */
  it('is a PDF, a Word document, a workbook, a deck, a PNG or a JPG', async () => {
    for (const [content, type] of [
      [A_PDF, 'application/pdf'],
      [A_DOCX, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      [AN_XLSX, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      [A_PPTX, 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      [A_PNG, 'image/png'],
      [A_JPEG, 'image/jpeg'],
    ] as const) {
      expect(
        await attached(await toDeal(deal, associate, { content, filename: 'file' })),
      ).toMatchObject({ contentType: type });
    }
  });

  it('is nothing else, however it is named, with nothing kept', async () => {
    for (const content of [A_PLAIN_ZIP, A_PROGRAM, Buffer.from('just some text')]) {
      expect(
        await refused(await toDeal(deal, associate, { content, filename: 'proposal.pdf' }), 400),
      ).toMatchObject({ error: 'DocumentTypeNotAccepted' });
    }
    expect(await documentCount()).toBe(0);
    expect(app.storage.size).toBe(0);
  });

  /* CLI 69: the type comes from the file itself. Neither its name nor what the browser called it
     is read to decide it, in either direction. */
  it('is what its bytes say, whatever it is called and whatever the browser claims', async () => {
    expect(
      await attached(
        await toDeal(deal, associate, {
          content: A_DOCX,
          filename: 'proposal.pdf',
          contentType: 'application/pdf',
        }),
      ),
    ).toMatchObject({
      filename: 'proposal.pdf',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    expect(
      await attached(
        await toDeal(deal, associate, {
          content: A_PDF,
          filename: 'proposal.exe',
          contentType: 'application/x-msdownload',
        }),
      ),
    ).toMatchObject({ contentType: 'application/pdf' });

    expect(
      await refused(
        await toDeal(deal, associate, {
          content: A_PROGRAM,
          filename: 'proposal.pdf',
          contentType: 'application/pdf',
        }),
        400,
      ),
    ).toMatchObject({ error: 'DocumentTypeNotAccepted' });

    /* And what was read is what is kept, so what opening it says is the same. */
    const { rows } = await admin.query<{ content_type: string }>(
      `SELECT content_type FROM clients_document ORDER BY id`,
    );
    expect(rows.map((row) => row.content_type)).toEqual([
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/pdf',
    ]);
  });

  it('is up to 50 MB a file', async () => {
    const tooLarge = Buffer.concat([A_PDF, Buffer.alloc(50 * 1024 * 1024)]);

    expect(await refused(await toDeal(deal, associate, { content: tooLarge }), 413)).toMatchObject({
      error: 'DocumentTooLarge',
      message: expect.stringMatching(/50 MB/),
    });
    expect(await documentCount()).toBe(0);
  });

  it('is refused by the virus scanner where it is infected, with nothing kept', async () => {
    expect(
      await refused(await toDeal(deal, associate, { content: AN_INFECTED_PDF }), 409),
    ).toMatchObject({ error: 'DocumentIsInfected' });
    expect(await documentCount()).toBe(0);
    expect(app.storage.size).toBe(0);
  });

  it('is a file with something in it, and a name', async () => {
    expect(
      await refused(await toDeal(deal, associate, { content: Buffer.alloc(0) }), 400),
    ).toMatchObject({ field: 'file' });
    expect(
      await refused(await toDeal(deal, associate, { content: A_PDF, filename: '' }), 400),
    ).toMatchObject({ field: 'filename' });
  });

  it('keeps the name without the folders a browser may send with it', async () => {
    expect(
      await attached(
        await toDeal(deal, associate, { content: A_PDF, filename: 'C:\\fakepath\\Proposal.pdf' }),
      ),
    ).toMatchObject({ filename: 'Proposal.pdf' });
    expect(
      await attached(
        await toDeal(deal, associate, { content: A_PDF, filename: 'Cédi’s offer.pdf' }),
      ),
    ).toMatchObject({ filename: 'Cédi’s offer.pdf' });
  });
});

/* -------------------------------------------------------------- on the client page */

describe("a client's documents", () => {
  it('are every file on its deals and its activities, the latest first', async () => {
    const first = await attached(
      await toDeal(deal, associate, { content: A_PDF, filename: 'BRD.pdf' }),
    );
    const second = await attached(
      await toActivity(call, associate, { content: A_DOCX, filename: 'Proposal.docx' }),
    );

    const fidelity = await aClient('Fidelity');
    await attached(await toDeal(await aDeal(fidelity), associate));

    const response = await app.send('GET', `/api/clients/clients/${adb}/documents`, colleague);
    expect(response.status).toBe(200);
    const { documents } = (await response.json()) as { documents: DocumentJson[] };

    expect(documents.map((document) => document.id)).toEqual([second.id, first.id]);
    expect(documents[0]).not.toHaveProperty('storageKey');
  });

  it('each say what they are on: the deal by its product, or the activity and its day', async () => {
    await attached(await toDeal(deal, associate));
    await attached(await toActivity(call, associate));

    const response = await app.send('GET', `/api/clients/clients/${adb}/documents`, associate);
    const { documents } = (await response.json()) as {
      documents: (DocumentJson & { on: unknown })[];
    };

    expect(documents.map((document) => document.on)).toEqual([
      {
        kind: 'ACTIVITY',
        activityId: call,
        activityKind: 'CALL',
        happenedOn: YESTERDAY,
        productName: null,
      },
      { kind: 'DEAL', dealId: deal, productName: 'CreditStudio' },
    ]);
  });

  /* The screen offers "Attach a file" on an activity only where the server would allow it. */
  it("say on each activity whether the person reading may attach to it: its logger's alone", async () => {
    const mayAttach = async (as: Asker): Promise<boolean | undefined> => {
      const response = await app.send('GET', `/api/clients/clients/${adb}/activity`, as);
      const { activity } = (await response.json()) as {
        activity: { id?: string; may?: { attach: boolean } }[];
      };

      return activity.find((entry) => entry.id === call)?.may?.attach;
    };

    expect(await mayAttach(associate)).toBe(true);
    expect(await mayAttach(colleague)).toBe(false);
    expect(await mayAttach(bdManager)).toBe(false);
  });

  it('are refused silently to somebody with no role', async () => {
    expect((await app.send('GET', `/api/clients/clients/${adb}/documents`, nobody)).status).toBe(
      404,
    );
  });
});

/* ------------------------------------------------- never deleted, but taken off */

describe('taking a file off again', () => {
  interface RemovedJson extends DocumentJson {
    removed: { at: string; by: { id: string; name: string } } | null;
    may: { remove: boolean };
  }

  function remove(id: string, as: Asker): Promise<globalThis.Response> {
    return app.send('POST', `/api/clients/documents/${id}/remove`, as);
  }

  async function keyOf(id: string): Promise<string> {
    const { rows } = await admin.query<{ storage_key: string }>(
      'SELECT storage_key FROM clients_document WHERE id = $1',
      [id],
    );

    return rows[0].storage_key;
  }

  /** A file the associate attached `hours` ago, its bytes in storage, written as no service would. */
  async function attachedHoursAgo(hours: number): Promise<string> {
    const stored = await app.storage.put(A_PDF);
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO clients_document (client_id, opportunity_id, original_filename, storage_key,
                                     content_type, size_bytes, checksum_sha256, scan_status,
                                     scanned_by, scanned_at, uploaded_by, uploaded_at)
       VALUES ($1, $2, 'proposal.pdf', $3, 'application/pdf', $4, $5, 'CLEAN',
               'a scanner', now(), $6, now() - make_interval(hours => $7))
       RETURNING id`,
      [adb, deal, stored.key, stored.size, stored.checksumSha256, people.officer, hours],
    );

    return rows[0].id;
  }

  /* #281, option (b): the file goes, and the record of it stays, saying who took it off and when. */
  it('deletes the file and keeps the record, for whoever attached it, within the day', async () => {
    const document = await attached(await toDeal(deal, associate));
    const key = await keyOf(document.id);

    const response = await remove(document.id, associate);
    expect(response.status).toBe(200);
    expect((await response.json()) as RemovedJson).toMatchObject({
      id: document.id,
      filename: document.filename,
      downloadable: false,
      removed: { by: { id: people.officer } },
      may: { remove: false },
    });

    expect(app.storage.has(key)).toBe(false);
    expect(await documentCount()).toBe(1);
  });

  it('cannot be opened, or taken off again, once it has been', async () => {
    const document = await attached(await toDeal(deal, associate));
    await remove(document.id, associate);

    for (const response of [
      await app.send('GET', `/api/clients/documents/${document.id}/download`, colleague),
      await remove(document.id, associate),
    ]) {
      expect(await refused(response, 409)).toMatchObject({ error: 'DocumentRemoved' });
    }
  });

  it('is refused openly to anybody but whoever attached it, a BD manager included', async () => {
    const document = await attached(await toDeal(deal, associate));

    for (const as of [colleague, bdManager]) {
      const problem = await refused(await remove(document.id, as), 403);
      expect(problem.message).toMatch(/can remove this file/);
    }
    expect(app.storage.has(await keyOf(document.id))).toBe(true);
  });

  it('is refused silently to somebody with no role, and not found for no such file', async () => {
    const document = await attached(await toDeal(deal, associate));

    expect((await remove(document.id, nobody)).status).toBe(404);
    expect(await refused(await remove('99999999', associate), 404)).toMatchObject({
      error: 'DocumentNotFound',
    });
  });

  /* As an activity is fixed after its day, by the service and by the table alike. */
  it('is refused once the file has been on for more than a day, which keeps it', async () => {
    const old = await attachedHoursAgo(25);

    expect(await refused(await remove(old, associate), 409)).toMatchObject({
      error: 'DocumentFixed',
    });
    expect(app.storage.has(await keyOf(old))).toBe(true);

    await expect(
      admin.query(`UPDATE clients_document SET removed_at = now(), removed_by = $2 WHERE id = $1`, [
        old,
        people.officer,
      ]),
    ).rejects.toMatchObject({ constraint: 'clients_document_removable_for_a_day' });
  });

  it('is offered only to whoever attached it, while it is on and within its day', async () => {
    const fresh = await attached(await toDeal(deal, associate));
    const old = await attachedHoursAgo(25);

    const listedFor = async (as: Asker) => {
      const response = await app.send('GET', `/api/clients/clients/${adb}/documents`, as);
      const { documents } = (await response.json()) as { documents: RemovedJson[] };

      return Object.fromEntries(documents.map((document) => [document.id, document.may.remove]));
    };

    expect(await listedFor(associate)).toEqual({ [fresh.id]: true, [old]: false });
    expect(await listedFor(bdManager)).toEqual({ [fresh.id]: false, [old]: false });
  });

  /* CLI 57, CLI 70, NFR CLI REC 03: no row goes, by anything, and nothing deletes on a timer. */
  it('never deletes a document row, which the application cannot do at all', async () => {
    const { rows } = await admin.query<{ may: boolean }>(
      `SELECT has_table_privilege('lms_app', 'clients_document', 'DELETE') AS may`,
    );
    expect(rows[0].may).toBe(false);

    /* And a removal stands: nothing puts a file back on. */
    const document = await attached(await toDeal(deal, associate));
    await remove(document.id, associate);
    await expect(
      admin.query(
        `UPDATE clients_document SET removed_at = NULL, removed_by = NULL WHERE id = $1`,
        [document.id],
      ),
    ).rejects.toMatchObject({ constraint: 'clients_document_is_removed_once' });
  });
});

/* ------------------------------------------------------------------ opening one */

/** As Supabase is: an address it signs for a while, saved under the name it is given. */
class LinkingStorage extends InMemoryStorage {
  override linkTo(key: string, downloadAs?: string): Promise<string | undefined> {
    return Promise.resolve(
      `https://storage.example/signed/${key}?expires=300&download=${encodeURIComponent(downloadAs ?? '')}`,
    );
  }
}

describe('opening a document', () => {
  function download(
    id: string,
    as: Asker,
    through: ClientsApp = app,
  ): Promise<globalThis.Response> {
    return through.send('GET', `/api/clients/documents/${id}/download`, as);
  }

  /* CLI 90: anybody with a role reads every document. The local driver mints no address, so the
     bytes come from here, sent so no browser renders them from this origin. */
  it('hands anybody with a role the file, under its own name, kept nowhere on the way', async () => {
    const document = await attached(
      await toActivity(call, associate, { content: A_DOCX, filename: 'Proposal for ADB.docx' }),
    );

    for (const as of [associate, colleague, bdManager]) {
      const response = await download(document.id, as);

      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).equals(A_DOCX)).toBe(true);
      expect(response.headers.get('content-type')).toBe('application/octet-stream');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-document-content-type')).toBe(document.contentType);
      expect(response.headers.get('content-disposition')).toBe(
        `attachment; filename="Proposal for ADB.docx"; filename*=UTF-8''Proposal%20for%20ADB.docx`,
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });

  /* NFR CLI SEC 03: where storage signs an address, that is where the browser is sent. */
  describe('where storage signs short lived addresses', () => {
    let linking: ClientsApp;

    beforeAll(async () => {
      linking = await startClientsApp(db, denials, new LinkingStorage());
    });

    afterAll(async () => {
      await linking?.close();
    });

    it('sends the browser to one, for this file and this name, kept nowhere', async () => {
      const document = await attached(
        await linking.sendFile(`/api/clients/opportunities/${deal}/documents`, associate, {
          content: A_PDF,
          filename: 'Signed contract.pdf',
        }),
      );
      const { rows } = await admin.query<{ storage_key: string }>(
        'SELECT storage_key FROM clients_document WHERE id = $1',
        [document.id],
      );

      const response = await download(document.id, colleague, linking);

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(
        `https://storage.example/signed/${rows[0].storage_key}?expires=300&download=Signed%20contract.pdf`,
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    });
  });

  /* NFR CLI SEC 04, asked on every request: no address for somebody without a role. */
  it('is refused silently to somebody with no role, for a real document', async () => {
    const document = await attached(await toDeal(deal, associate));
    const response = await download(document.id, nobody);

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('%PDF');
  });

  it('is refused to somebody whose role has ended since the file was attached', async () => {
    const document = await attached(await toDeal(deal, colleague));
    await admin.query(
      `UPDATE clients_role SET ended_at = now(), ended_by = $2, ended_reason = 'REVOKED'
        WHERE employee_id = $1 AND ended_at IS NULL`,
      [people.opsDirector, people.headOfHr],
    );

    expect((await download(document.id, colleague)).status).toBe(404);
  });

  it('is not found where there is no such document', async () => {
    expect(await refused(await download('99999999', associate), 404)).toMatchObject({
      error: 'DocumentNotFound',
    });
  });

  /* As leave's: a file nothing has cleared is a file nobody may open. */
  it('is refused while the file is waiting for its virus check', async () => {
    /* As a scanner that could not be reached leaves one. */
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO clients_document (client_id, opportunity_id, original_filename, storage_key,
                                     content_type, size_bytes, checksum_sha256, scan_status,
                                     uploaded_by)
       VALUES ($1, $2, 'proposal.pdf', $3, 'application/pdf', 10, $4, 'PENDING', $5)
       RETURNING id`,
      [adb, deal, 'a'.repeat(64), 'b'.repeat(64), people.officer],
    );

    expect(await refused(await download(rows[0].id, associate), 409)).toMatchObject({
      error: 'DocumentNotScanned',
    });
  });
});

/* -------------------------------------------------- the database holds the same shape */

describe('a document, in the database', () => {
  /** Writes a document straight into the table, as no service would. */
  async function insert(columns: Record<string, unknown>): Promise<string | null> {
    const values = {
      client_id: adb,
      opportunity_id: deal,
      original_filename: 'proposal.pdf',
      storage_key: 'a'.repeat(64),
      content_type: 'application/pdf',
      size_bytes: 10,
      checksum_sha256: 'b'.repeat(64),
      scan_status: 'CLEAN',
      scanned_by: 'a scanner',
      scanned_at: new Date(),
      uploaded_by: people.officer,
      ...columns,
    };
    const names = Object.keys(values);

    return admin
      .query(
        `INSERT INTO clients_document (${names.join(', ')})
         VALUES (${names.map((_, at) => `$${String(at + 1)}`).join(', ')})`,
        Object.values(values),
      )
      .then(
        () => null,
        (error: unknown) => (error as { constraint?: string }).constraint ?? 'no constraint',
      );
  }

  it('is on one activity or one deal, of its own client', async () => {
    expect(await insert({})).toBeNull();
    expect(await insert({ storage_key: 'c'.repeat(64), activity_id: call })).toBe(
      'clients_document_on_one_thing',
    );
    expect(await insert({ storage_key: 'c'.repeat(64), opportunity_id: null })).toBe(
      'clients_document_on_one_thing',
    );
    expect(
      await insert({ storage_key: 'c'.repeat(64), client_id: await aClient('Fidelity') }),
    ).toBe('clients_document_deal_is_the_clients');
  });

  it('is one of the accepted types, within 50 MB', async () => {
    expect(await insert({ content_type: 'application/zip' })).toBe(
      'clients_document_content_type_accepted',
    );
    expect(await insert({ size_bytes: 50 * 1024 * 1024 + 1 })).toBe(
      'clients_document_size_within_the_cap',
    );
  });

  it('is the file it was, and only its verdict moves, once', async () => {
    await insert({ scan_status: 'PENDING', scanned_by: null, scanned_at: null });

    await expect(
      admin.query(`UPDATE clients_document SET original_filename = 'other.pdf'`),
    ).rejects.toMatchObject({ constraint: 'clients_document_is_the_file_it_was' });

    await admin.query(
      `UPDATE clients_document SET scan_status = 'CLEAN', scanned_by = 'x', scanned_at = now()`,
    );
    await expect(
      admin.query(`UPDATE clients_document SET scan_status = 'INFECTED'`),
    ).rejects.toMatchObject({ constraint: 'clients_document_is_scanned_once' });
  });
});
