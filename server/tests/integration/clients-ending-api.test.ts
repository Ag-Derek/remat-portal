import type { Kysely } from 'kysely';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { PINNED_DATE } from '../setup/pinned-date.js';
import { seed } from '../../seeds/seed.mjs';
import { type Database, databaseFor } from '../../src/core/db/index.js';
import { signedInAs } from '../../src/core/auth/actor.js';
import { CompanyCalendar } from '../../src/core/calendar/company-calendar.js';
import { EmployeeRepository } from '../../src/core/organisation/employee/employee.db.js';
import { ClientsOpportunityRepository } from '../../src/apps/clients/opportunity.db.js';
import { ClientsReasonRepository } from '../../src/apps/clients/reason.db.js';
import { ClientsRoleRepository } from '../../src/apps/clients/role.db.js';
import { StageForPoc } from '../../src/apps/clients/stage-for-poc.js';
import { type Asker, type ClientsApp, startClientsApp } from '../support/clients-app.js';
import { intoItsPoc as intoAPoc } from '../support/clients-poc.js';
import { recordingDenials } from '../support/recording-denials.js';

/**
 * Ending a deal without winning it, over HTTP against a real database. #279, Clients SRS CLI 51
 * to CLI 56, TDD 5, TDD 11.
 *
 * A deal in its POC ends only by the POC converting or exiting, which the POC service will ask
 * for (#287). Until it exists, those are asked of {@link StageForPoc} directly.
 */

const testDatabaseUrl = await databaseForThisFile();

const denials = recordingDenials();

let db: Kysely<Database>;
let admin: Client;
let app: ClientsApp;
let people: Record<string, string>;
let products: Record<string, string>;
/** The reasons the migration seeded, which every test starts from. */
let starterReasons: string[];
/** The current reasons, by list and label. */
let lostFor: Record<string, string>;
let exitedFor: Record<string, string>;

let bdManager: Asker;
let associate: Asker;
let colleague: Asker;
let nobody: Asker;

/** ADB, owned by the BD manager. */
let adb: string;

interface DealJson {
  id: string;
  stage: string;
  outcome: string;
  endedOn: string | null;
  ending: { reason: { id: string; label: string }; note: string | null } | null;
  may: { change: boolean; move: boolean; decidePoc: boolean; lose: boolean };
}

interface ProblemJson {
  error: string;
  message: string;
  field?: string;
}

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);
  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();
  app = await startClientsApp(db, denials);
  starterReasons = (await admin.query<{ id: string }>('SELECT id FROM clients_reason')).rows.map(
    (row) => row.id,
  );
});

beforeEach(async () => {
  people = (await seed(admin)) as Record<string, string>;

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
  /* The starter set as migrated, and no reason a test added: the seed clears the deals that
     name them, but not the lists, which reference no employee. */
  await admin.query('DELETE FROM clients_reason WHERE NOT (id = ANY($1))', [starterReasons]);
  await admin.query('UPDATE clients_reason SET retired_on = NULL');
  const { rows } = await admin.query<{ id: string; name: string }>(
    'SELECT id, name FROM clients_product',
  );
  products = Object.fromEntries(rows.map((row) => [row.name, row.id]));

  const reasons = await admin.query<{ id: string; applies_to: string; label: string }>(
    'SELECT id, applies_to, label FROM clients_reason',
  );
  lostFor = Object.fromEntries(
    reasons.rows.filter((row) => row.applies_to === 'LOST').map((row) => [row.label, row.id]),
  );
  exitedFor = Object.fromEntries(
    reasons.rows.filter((row) => row.applies_to === 'EXITED').map((row) => [row.label, row.id]),
  );

  const client = await app.send('POST', '/api/clients/clients', bdManager, {
    name: 'ADB',
    typeId: (
      await admin.query<{ id: string }>(`SELECT id FROM clients_client_type WHERE name = 'Bank'`)
    ).rows[0].id,
  });
  adb = ((await client.json()) as { id: string }).id;

  denials.clear();
});

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await admin?.end();
});

/** A deal at ADB for CreditStudio, opened by `as`, who owns it. */
async function aDeal(as: Asker = associate, product = 'CreditStudio'): Promise<DealJson> {
  const response = await app.send('POST', '/api/clients/opportunities', as, {
    clientId: adb,
    productId: products[product],
  });
  expect(response.status).toBe(201);

  return (await response.json()) as DealJson;
}

function lose(as: Asker, id: string, body: unknown): Promise<globalThis.Response> {
  return app.send('POST', `/api/clients/opportunities/${id}/lose`, as, body);
}

async function lost(as: Asker, id: string, body: unknown): Promise<DealJson> {
  const response = await lose(as, id, body);
  expect(response.status).toBe(200);

  return (await response.json()) as DealJson;
}

async function moved(id: string, toStage: string): Promise<void> {
  const response = await app.send('POST', `/api/clients/opportunities/${id}/stage`, associate, {
    toStage,
  });
  expect(response.status).toBe(200);
}

async function refused(response: globalThis.Response, status: number): Promise<ProblemJson> {
  expect(response.status).toBe(status);

  return (await response.json()) as ProblemJson;
}

async function find(id: string, as: Asker = associate): Promise<DealJson> {
  return (await (await app.send('GET', `/api/clients/opportunities/${id}`, as)).json()) as DealJson;
}

async function stagesOf(id: string): Promise<{ fromStage: string; toStage: string }[]> {
  const response = await app.send('GET', `/api/clients/opportunities/${id}/stages`, associate);

  return ((await response.json()) as { stages: { fromStage: string; toStage: string }[] }).stages;
}

/** Puts a deal straight into a POC of its own, as signing its contract does (#285). */
async function intoItsPoc(id: string): Promise<void> {
  await intoAPoc(admin, id);
}

/* -------------------------------------------------------------------- losing a deal */

describe('marking a deal lost', () => {
  /* CLI 51. With a reason from the lost list, and a note. */
  it('ends it where it stands, with its reason and note, dated today', async () => {
    const deal = await aDeal();
    await moved(deal.id, 'PROPOSAL');

    expect(
      await lost(associate, deal.id, {
        reasonId: lostFor['Chose a competitor'],
        note: '  Went with the incumbent on price  ',
      }),
    ).toMatchObject({
      stage: 'PROPOSAL',
      outcome: 'LOST',
      endedOn: PINNED_DATE,
      ending: {
        reason: { id: lostFor['Chose a competitor'], label: 'Chose a competitor' },
        note: 'Went with the incumbent on price',
      },
      may: { change: false, move: false, decidePoc: false, lose: false },
    });
  });

  it('needs no note', async () => {
    const deal = await aDeal();

    for (const note of [undefined, null, '   ']) {
      const other = await aDeal(associate, 'Cloud9');
      expect((await lost(associate, other.id, { reasonId: lostFor.Price, note })).ending).toEqual({
        reason: { id: lostFor.Price, label: 'Price' },
        note: null,
      });
    }
    expect((await find(deal.id)).outcome).toBe('OPEN');
  });

  /* CLI 26. The ending is in the history, at the stage it ended at, with the note. */
  it('is a stage change in its history, from where it stood to the same stage', async () => {
    const deal = await aDeal();
    await moved(deal.id, 'NEGOTIATION');
    await lost(associate, deal.id, { reasonId: lostFor['No budget'], note: 'Budget frozen' });

    const { stages } = (await (
      await app.send('GET', `/api/clients/opportunities/${deal.id}/stages`, associate)
    ).json()) as { stages: unknown[] };
    expect(stages[0]).toMatchObject({
      fromStage: 'NEGOTIATION',
      toStage: 'NEGOTIATION',
      toOutcome: 'LOST',
      note: 'Budget frozen',
      changedBy: { id: people.officer },
    });
  });

  /* CLI 51. Any time before its POC starts: from Discovery, and from Contract signed with no POC.
     A deal with a POC is in it from its signing (#285), so it never waits at Contract signed. */
  it('may be done at any stage before its POC starts', async () => {
    const early = await aDeal();
    expect((await lost(associate, early.id, { reasonId: lostFor['Went quiet'] })).stage).toBe(
      'DISCOVERY',
    );

    const signed = await aDeal(associate, 'Cloud9');
    await app.send('PATCH', `/api/clients/opportunities/${signed.id}`, associate, {
      hasPoc: false,
    });
    await moved(signed.id, 'CONTRACT_SIGNED');
    expect(await lost(associate, signed.id, { reasonId: lostFor['Not a fit'] })).toMatchObject({
      stage: 'CONTRACT_SIGNED',
      outcome: 'LOST',
    });
  });

  /* CLI 52, POC_DECIDES. A deal in a started POC ends converted or exited, never lost. */
  it('is refused once its POC has started, and the screen is told so', async () => {
    const deal = await aDeal();
    await intoItsPoc(deal.id);

    for (const as of [associate, bdManager]) {
      expect(await refused(await lose(as, deal.id, { reasonId: lostFor.Price }), 409)).toEqual({
        error: 'PocEndsIt',
        message:
          'The CreditStudio deal is in its POC, so it ends by the POC converting or exiting. It ' +
          'is not marked lost.',
      });
    }
    expect(await find(deal.id, bdManager)).toMatchObject({
      outcome: 'OPEN',
      ending: null,
      may: { change: true, lose: false },
    });
  });

  /* CLI 55, CLI 56. */
  it('is refused once it has ended, lost or won', async () => {
    const deal = await aDeal();
    await lost(associate, deal.id, { reasonId: lostFor.Price });

    expect(
      await refused(await lose(bdManager, deal.id, { reasonId: lostFor['Not a fit'] }), 409),
    ).toMatchObject({ error: 'OpportunityEnded' });
    expect((await find(deal.id)).ending?.reason.label).toBe('Price');
    expect(await stagesOf(deal.id)).toHaveLength(2);

    const won = await aDeal(associate, 'Cloud9');
    await app.send('PATCH', `/api/clients/opportunities/${won.id}`, associate, { hasPoc: false });
    await moved(won.id, 'CONTRACT_SIGNED');
    await moved(won.id, 'LIVE');
    expect(
      await refused(await lose(associate, won.id, { reasonId: lostFor.Price }), 409),
    ).toMatchObject({ error: 'OpportunityEnded' });
  });

  /* CLI 11, CLI 56. The product is free for a new deal, which starts at Discovery. */
  it('leaves the client free to open another deal for the product', async () => {
    const deal = await aDeal();
    await lost(associate, deal.id, { reasonId: lostFor.Price });

    expect((await aDeal()).stage).toBe('DISCOVERY');
  });
});

/* ------------------------------------------------------------------ the reason given */

describe('the reason a deal is lost for', () => {
  /* TDD's REASON_REQUIRED. */
  it('is required', async () => {
    const deal = await aDeal();

    for (const body of [{}, { reasonId: null }, { reasonId: '' }, { note: 'No reason' }]) {
      expect(await refused(await lose(associate, deal.id, body), 400)).toEqual({
        error: 'InvalidEnding',
        message: 'Choose why the deal was lost.',
        field: 'reasonId',
      });
    }
    expect((await find(deal.id)).outcome).toBe('OPEN');
  });

  it('is one there is', async () => {
    const deal = await aDeal();

    expect(await refused(await lose(associate, deal.id, { reasonId: 7 }), 400)).toMatchObject({
      error: 'InvalidEnding',
      field: 'reasonId',
    });
    expect(
      await refused(await lose(associate, deal.id, { reasonId: '987654321' }), 400),
    ).toMatchObject({ error: 'ReasonNotOffered', field: 'reasonId' });
  });

  /* CLI 51. From the lost list, not the exit list. */
  it('is from the lost list', async () => {
    const deal = await aDeal();

    expect(
      await refused(
        await lose(associate, deal.id, { reasonId: exitedFor['Client withdrew'] }),
        400,
      ),
    ).toEqual({
      error: 'ReasonNotOffered',
      message:
        '"Client withdrew" is a reason for exiting a POC, not for losing a deal. Choose one from ' +
        'the losing a deal list.',
      field: 'reasonId',
    });
  });

  /* CLI 54. A retired reason is given to no new deal. */
  it('is not retired', async () => {
    const deal = await aDeal();
    await admin.query(`UPDATE clients_reason SET retired_on = '2026-01-01' WHERE id = $1`, [
      lostFor.Price,
    ]);

    expect(await refused(await lose(associate, deal.id, { reasonId: lostFor.Price }), 400)).toEqual(
      {
        error: 'ReasonNotOffered',
        message: '"Price" is retired. Choose another reason.',
        field: 'reasonId',
      },
    );
  });

  it('comes with a note that is text, and not too long', async () => {
    const deal = await aDeal();

    for (const note of [7, 'x'.repeat(2001)]) {
      expect(
        await refused(await lose(associate, deal.id, { reasonId: lostFor.Price, note }), 400),
      ).toMatchObject({ error: 'InvalidEnding', field: 'note' });
    }
  });
});

/* ------------------------------------------------------------- the lists offered */

describe('the reasons offered', () => {
  it('are each list, in the order added, without retired ones', async () => {
    await admin.query(`UPDATE clients_reason SET retired_on = '2026-01-01' WHERE id = $1`, [
      lostFor['Timing not right'],
    ]);

    const response = await app.send('GET', '/api/clients/reasons', associate);
    expect(response.status).toBe(200);
    const lists = (await response.json()) as Record<string, { label: string }[]>;

    expect(lists.LOST.map((reason) => reason.label)).toEqual([
      'Price',
      'Chose a competitor',
      'No budget',
      'Went quiet',
      'Not a fit',
      'Other',
    ]);
    expect(lists.EXITED.map((reason) => reason.label)).toEqual([
      'Did not meet the success metrics',
      'Usage too low',
      'Client withdrew',
      'Integration problems',
      'Commercial terms',
      'Other',
    ]);
    expect(lists.LOST[0]).toEqual({
      id: lostFor.Price,
      appliesTo: 'LOST',
      label: 'Price',
      retiredOn: null,
    });
  });

  /* NFR CLI SEC 04. */
  it('are nothing to somebody without a role', async () => {
    expect((await app.send('GET', '/api/clients/reasons', nobody)).status).toBe(404);
  });
});

/* ------------------------------------------------------------------------- who */

describe('who may mark a deal lost', () => {
  /* CLI 13. */
  it('is its owner, or a BD manager', async () => {
    const mine = await aDeal(associate);
    const theirs = await aDeal(associate, 'Cloud9');

    expect((await lose(associate, mine.id, { reasonId: lostFor.Price })).status).toBe(200);
    expect((await lose(bdManager, theirs.id, { reasonId: lostFor.Price })).status).toBe(200);
  });

  /* AC L22. Told whose it is. */
  it('is not another associate, who is told whose it is', async () => {
    const deal = await aDeal(associate);

    expect(
      await refused(await lose(colleague, deal.id, { reasonId: lostFor.Price }), 403),
    ).toMatchObject({ error: 'NotAuthorised' });
    expect((await find(deal.id, colleague)).may.lose).toBe(false);
    expect((await find(deal.id)).may.lose).toBe(true);
    expect((await find(deal.id)).outcome).toBe('OPEN');
  });

  /* NFR CLI SEC 04. */
  it('is nobody without a role, who is told nothing, for a deal or for no deal', async () => {
    const deal = await aDeal();

    for (const id of [deal.id, '987654321', 'nonsense']) {
      expect((await lose(nobody, id, { reasonId: lostFor.Price })).status).toBe(404);
    }
    expect((await find(deal.id)).outcome).toBe('OPEN');
  });

  it('is of a deal that exists', async () => {
    expect(
      await refused(await lose(associate, '987654321', { reasonId: lostFor.Price }), 404),
    ).toMatchObject({ error: 'OpportunityNotFound' });
  });
});

/* ------------------------------------------------------------- a deal in its POC */

describe('a deal in a started POC', () => {
  /** What the POC service will be, once #287 adds it: the one caller of these moves. */
  function thePoc(today = PINNED_DATE): StageForPoc {
    return new StageForPoc(
      new ClientsOpportunityRepository(db),
      new ClientsReasonRepository(db),
      new ClientsRoleRepository(db),
      new EmployeeRepository(db),
      new CompanyCalendar(db),
      () => today,
    );
  }

  /** The CS lead ending the POC. Who may is the POC service's to ask, not this. */
  function csLead() {
    return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
  }

  /* CLI 52. Neither marked lost nor moved by hand; its POC ending decides. */
  it('is not marked lost, nor moved anywhere by hand', async () => {
    const deal = await aDeal();
    await intoItsPoc(deal.id);

    expect(
      await refused(await lose(associate, deal.id, { reasonId: lostFor.Price }), 409),
    ).toMatchObject({ error: 'PocEndsIt' });
    for (const toStage of ['LIVE', 'CONTRACT_SIGNED', 'DISCOVERY']) {
      expect(
        (
          await app.send('POST', `/api/clients/opportunities/${deal.id}/stage`, bdManager, {
            toStage,
            note: 'By hand',
          })
        ).status,
      ).toBe(409);
    }
    expect(await find(deal.id, bdManager)).toMatchObject({
      stage: 'POC',
      outcome: 'OPEN',
      may: { move: false, lose: false },
    });
  });

  /* CLI 48, CLI 49, CLI 25. Converted: Live, won, and its product added to the client. */
  it('ends converted: won at Live, its product added to what the client uses', async () => {
    const deal = await aDeal();
    await intoItsPoc(deal.id);

    expect(await thePoc().convert(csLead(), deal.id)).toMatchObject({
      stage: 'LIVE',
      outcome: 'WON',
      endedOn: PINNED_DATE,
      ending: null,
    });
    expect((await stagesOf(deal.id))[0]).toMatchObject({
      fromStage: 'POC',
      toStage: 'LIVE',
      toOutcome: 'WON',
    });

    const { rows } = await admin.query(
      `SELECT since_on::text, won_by FROM clients_client_product
        WHERE client_id = $1 AND product_id = $2`,
      [adb, products.CreditStudio],
    );
    expect(rows).toEqual([{ since_on: PINNED_DATE, won_by: deal.id }]);
  });

  /* CLI 48, CLI 52. Exited: at POC, with why and which products the POC ran on. */
  it('ends exited, where it stands, with its reason and note', async () => {
    const deal = await aDeal();
    await intoItsPoc(deal.id);

    expect(
      await thePoc().exit(csLead(), deal.id, {
        reasonId: exitedFor['Usage too low'],
        note: 'Ran on CreditStudio only',
      }),
    ).toMatchObject({
      stage: 'POC',
      outcome: 'EXITED',
      endedOn: PINNED_DATE,
      ending: {
        reason: { id: exitedFor['Usage too low'], label: 'Usage too low' },
        note: 'Ran on CreditStudio only',
      },
    });
    expect((await stagesOf(deal.id))[0]).toMatchObject({
      fromStage: 'POC',
      toStage: 'POC',
      toOutcome: 'EXITED',
    });
    expect(await find(deal.id, bdManager)).toMatchObject({
      may: { change: false, move: false, lose: false },
    });
  });

  /* CLI 52. Only a deal in a started POC ends by its POC, at Contract signed with no POC included. */
  it('is the only deal that ends converted or exited', async () => {
    const deal = await aDeal();
    await app.send('PATCH', `/api/clients/opportunities/${deal.id}`, associate, { hasPoc: false });
    await moved(deal.id, 'CONTRACT_SIGNED');

    const exit = { reasonId: exitedFor['Client withdrew'], note: 'Ran on CreditStudio' };
    await expect(thePoc().convert(csLead(), deal.id)).rejects.toMatchObject({
      name: 'NotInItsPoc',
      message:
        'The CreditStudio deal is not in a started POC, so it does not end by a POC ' +
        'converting or exiting. Move it on, or mark it lost.',
    });
    await expect(thePoc().exit(csLead(), deal.id, exit)).rejects.toMatchObject({
      name: 'NotInItsPoc',
    });
    expect(await find(deal.id)).toMatchObject({ stage: 'CONTRACT_SIGNED', outcome: 'OPEN' });
  });

  /* CLI 55, CLI 56. Once ended, it ends no other way. */
  it('ends once', async () => {
    const deal = await aDeal();
    await intoItsPoc(deal.id);
    await thePoc().exit(csLead(), deal.id, {
      reasonId: exitedFor['Client withdrew'],
      note: 'Ran on CreditStudio',
    });

    await expect(thePoc().convert(csLead(), deal.id)).rejects.toMatchObject({
      name: 'OpportunityEnded',
    });
    expect(await find(deal.id)).toMatchObject({ stage: 'POC', outcome: 'EXITED' });
  });

  it('is a deal that exists', async () => {
    await expect(thePoc().convert(csLead(), '987654321')).rejects.toMatchObject({
      name: 'OpportunityNotFound',
    });
  });

  /* CLI 52, CLI 54, TDD's REASON_REQUIRED. What an exit is asked with. */
  describe('exiting', () => {
    let deal: DealJson;
    const ranOn = 'Ran on CreditStudio and Federation';

    beforeEach(async () => {
      deal = await aDeal();
      await intoItsPoc(deal.id);
    });

    /** Asks for the exit, and says what refused it. */
    async function refusal(asked: unknown): Promise<unknown> {
      return thePoc()
        .exit(csLead(), deal.id, asked)
        .then(
          () => 'went through',
          (error: unknown) => {
            const { name, message, field } = error as Error & { field?: string };
            return { name, message, field };
          },
        );
    }

    it('needs a reason', async () => {
      for (const reasonId of [undefined, null, '']) {
        expect(await refusal({ reasonId, note: ranOn })).toEqual({
          name: 'InvalidEnding',
          message: 'Choose why the POC was exited.',
          field: 'reasonId',
        });
      }
      expect(await refusal({ reasonId: 7, note: ranOn })).toMatchObject({
        name: 'InvalidEnding',
        field: 'reasonId',
      });
      expect(await refusal({ reasonId: '987654321', note: ranOn })).toMatchObject({
        name: 'ReasonNotOffered',
        field: 'reasonId',
      });
    });

    it('needs a note saying which products the POC ran on', async () => {
      for (const note of [undefined, null, '', '   ']) {
        expect(await refusal({ reasonId: exitedFor['Client withdrew'], note })).toEqual({
          name: 'InvalidEnding',
          message: 'Say which products the POC ran on.',
          field: 'note',
        });
      }
      for (const note of [7, 'x'.repeat(2001)]) {
        expect(await refusal({ reasonId: exitedFor['Client withdrew'], note })).toMatchObject({
          name: 'InvalidEnding',
          field: 'note',
        });
      }
    });

    /* CLI 52. From the exit list, not the lost list. */
    it('takes a reason from the exit list', async () => {
      expect(await refusal({ reasonId: lostFor.Price, note: ranOn })).toEqual({
        name: 'ReasonNotOffered',
        message:
          '"Price" is a reason for losing a deal, not for exiting a POC. Choose one from the ' +
          'exiting a POC list.',
        field: 'reasonId',
      });
    });

    /* CLI 54. */
    it('takes no retired reason', async () => {
      await admin.query(`UPDATE clients_reason SET retired_on = '2026-01-01' WHERE id = $1`, [
        exitedFor['Commercial terms'],
      ]);

      expect(await refusal({ reasonId: exitedFor['Commercial terms'], note: ranOn })).toEqual({
        name: 'ReasonNotOffered',
        message: '"Commercial terms" is retired. Choose another reason.',
        field: 'reasonId',
      });
    });

    it('leaves the deal as it was when refused', async () => {
      await refusal({ reasonId: lostFor.Price, note: '' });

      expect(await find(deal.id)).toMatchObject({ stage: 'POC', outcome: 'OPEN', ending: null });
      expect(await stagesOf(deal.id)).toHaveLength(1);
    });

    it('keeps the note trimmed, as written', async () => {
      expect(
        await thePoc().exit(csLead(), deal.id, {
          reasonId: exitedFor['Client withdrew'],
          note: `  ${ranOn}  `,
        }),
      ).toMatchObject({ ending: { note: ranOn } });
    });

    /* A deal not in a started POC is told so before what it was asked with is read. */
    it('is refused for a deal not in its POC whatever it is asked with', async () => {
      const early = await aDeal(associate, 'Cloud9');

      await expect(thePoc().exit(csLead(), early.id, {})).rejects.toMatchObject({
        name: 'NotInItsPoc',
      });
    });
  });

  /* CLI 53, AC L16. An exit gives the BD manager an internal debrief, five working days on: the
     deal owner's line manager, who is a BD manager (#279). The officer, who owns these deals,
     reports to the team lead. */
  describe("an exit's debrief", () => {
    interface StepRow {
      client_id: string;
      opportunity_id: string;
      description: string;
      due_on: string;
      owner_id: string;
      source: string;
      done_at: Date | null;
      created_by: string;
    }

    async function stepsOf(dealId: string): Promise<StepRow[]> {
      return (
        await admin.query<StepRow>(
          `SELECT client_id, opportunity_id, description, due_on::text, owner_id, source,
                  done_at, created_by
             FROM clients_next_step WHERE opportunity_id = $1 ORDER BY owner_id`,
          [dealId],
        )
      ).rows;
    }

    const exit = { reasonId: '', note: 'Ran on CreditStudio' };

    beforeEach(async () => {
      exit.reasonId = exitedFor['Client withdrew'];
      /* The holidays around the dates below, as these tests say they are and no others. */
      await admin.query(
        `DELETE FROM holiday WHERE holiday_date BETWEEN '2026-10-01' AND '2027-01-31'`,
      );
    });

    /** Makes the officer's line manager, the team lead, a BD manager. */
    async function lineManagerIsABdManager(): Promise<void> {
      await new ClientsRoleRepository(db).grant(
        people.teamLead,
        'BD_MANAGER',
        people.headOfHr,
        'them',
      );
    }

    it("is a next step for the owner's line manager, due five working days after the exit", async () => {
      await lineManagerIsABdManager();
      const deal = await aDeal();
      await intoItsPoc(deal.id);

      /* Friday 30 October 2026: Monday to Friday the week after is five. */
      await thePoc('2026-10-30').exit(csLead(), deal.id, exit);

      expect(await stepsOf(deal.id)).toEqual([
        {
          client_id: adb,
          opportunity_id: deal.id,
          description: 'Internal debrief on the ADB CreditStudio POC exit',
          due_on: '2026-11-06',
          owner_id: people.teamLead,
          source: 'DEBRIEF',
          done_at: null,
          created_by: people.officer,
        },
      ]);
    });

    /* Done when: an exit creates the debrief on the right date, skipping weekends and holidays. */
    it('skips weekends and public holidays', async () => {
      for (const [name, day] of [
        ['Christmas Day', '2026-12-25'],
        ['Boxing Day, observed', '2026-12-28'],
      ]) {
        await admin.query('INSERT INTO holiday (name, holiday_date) VALUES ($1, $2)', [name, day]);
      }
      const deal = await aDeal();
      await intoItsPoc(deal.id);

      /* Thursday 24 December: the 25th and 28th are holidays, the 26th and 27th a weekend. */
      await thePoc('2026-12-24').exit(csLead(), deal.id, exit);

      expect((await stepsOf(deal.id)).map((step) => step.due_on)).toEqual(['2027-01-04']);
    });

    /* #279. The line manager's alone, not every BD manager's, whoever exits the POC. */
    it("is the owner's line manager's alone, whoever exits the POC", async () => {
      await lineManagerIsABdManager();
      const deal = await aDeal();
      await intoItsPoc(deal.id);

      await thePoc('2026-10-30').exit(
        signedInAs(people.commercialDirector, { roles: ['EMPLOYEE'], isManager: false }),
        deal.id,
        exit,
      );

      expect((await stepsOf(deal.id)).map((step) => step.owner_id)).toEqual([people.teamLead]);
    });

    /* #279. A line manager with no BD manager role could not open it: every BD manager's. */
    it("is every BD manager's, where the owner's line manager is not one", async () => {
      await new ClientsRoleRepository(db).grant(people.ceo, 'BD_MANAGER', people.headOfHr, 'them');
      const deal = await aDeal();
      await intoItsPoc(deal.id);

      await thePoc('2026-10-30').exit(csLead(), deal.id, exit);

      const steps = await stepsOf(deal.id);
      expect(steps.map((step) => step.owner_id).sort()).toEqual(
        [people.commercialDirector, people.ceo].sort(),
      );
      expect(new Set(steps.map((step) => step.due_on))).toEqual(new Set(['2026-11-06']));
    });

    it('is not given to a line manager whose BD manager grant has ended', async () => {
      const former = await new ClientsRoleRepository(db).grant(
        people.teamLead,
        'BD_MANAGER',
        people.headOfHr,
        'them',
      );
      /* Ended by the database's clock, which granted it: the app's may be a moment behind. */
      await admin.query(
        `UPDATE clients_role SET ended_at = now(), ended_by = $2, ended_reason = 'REVOKED'
          WHERE id = $1`,
        [former.id, people.headOfHr],
      );
      const deal = await aDeal();
      await intoItsPoc(deal.id);

      await thePoc('2026-10-30').exit(csLead(), deal.id, exit);

      expect((await stepsOf(deal.id)).map((step) => step.owner_id)).toEqual([
        people.commercialDirector,
      ]);
    });

    /* Where nobody holds the role, the debrief is not lost: it is whoever exited the POC's. */
    it('is whoever exited the POC, where there is no BD manager', async () => {
      await admin.query(
        `UPDATE clients_role SET ended_at = now(), ended_by = $1, ended_reason = 'REVOKED'
          WHERE role = 'BD_MANAGER' AND ended_at IS NULL`,
        [people.headOfHr],
      );
      const deal = await aDeal();
      await intoItsPoc(deal.id);

      await thePoc('2026-10-30').exit(csLead(), deal.id, exit);

      expect((await stepsOf(deal.id)).map((step) => step.owner_id)).toEqual([people.officer]);
    });

    it('is not given by an exit that was refused, nor by losing a deal', async () => {
      const deal = await aDeal();
      await intoItsPoc(deal.id);
      await thePoc('2026-10-30')
        .exit(csLead(), deal.id, { reasonId: exit.reasonId, note: '' })
        .catch(() => undefined);

      const other = await aDeal(associate, 'Cloud9');
      await lost(associate, other.id, { reasonId: lostFor.Price });

      expect(await stepsOf(deal.id)).toEqual([]);
      expect(await stepsOf(other.id)).toEqual([]);
    });
  });
});

/* ------------------------------------------------------ keeping the reason lists */

describe('the reason lists, kept by a BD manager', () => {
  interface ReasonJson {
    id: string;
    appliesTo: string;
    label: string;
    retiredOn: string | null;
    inUse: boolean;
  }

  function setUp(method: string, path: string, as: Asker = bdManager, body?: unknown) {
    return app.send(method, `/api/clients/setup/reasons${path}`, as, body);
  }

  async function listed(): Promise<ReasonJson[]> {
    const response = await setUp('GET', '');
    expect(response.status).toBe(200);

    return ((await response.json()) as { reasons: ReasonJson[] }).reasons;
  }

  async function added(appliesTo: string, label: string): Promise<ReasonJson> {
    const response = await setUp('POST', '', bdManager, { appliesTo, label });
    expect(response.status).toBe(201);

    return (await response.json()) as ReasonJson;
  }

  async function offeredForLoss(): Promise<string[]> {
    const lists = (await (await app.send('GET', '/api/clients/reasons', associate)).json()) as {
      LOST: { id: string }[];
    };

    return lists.LOST.map((reason) => reason.id);
  }

  /* CLI 54, CLI 104. */
  it('are both lists, retired reasons marked, and which a deal has ended for', async () => {
    const deal = await aDeal();
    await lost(associate, deal.id, { reasonId: lostFor.Price });
    await setUp('POST', `/${lostFor['Went quiet']}/retire`);

    const reasons = await listed();
    expect(reasons.find((reason) => reason.id === lostFor.Price)).toEqual({
      id: lostFor.Price,
      appliesTo: 'LOST',
      label: 'Price',
      retiredOn: null,
      inUse: true,
    });
    expect(reasons.find((reason) => reason.id === lostFor['Went quiet'])).toMatchObject({
      retiredOn: expect.any(String),
      inUse: false,
    });
    expect(reasons.filter((reason) => reason.appliesTo === 'EXITED')).toHaveLength(6);
  });

  it('take a new reason on either list, which is offered at once', async () => {
    const inHouse = await added('LOST', '  Went with   in-house build ');
    expect(inHouse).toMatchObject({
      appliesTo: 'LOST',
      label: 'Went with in-house build',
      retiredOn: null,
      inUse: false,
    });
    await added('EXITED', 'Champion left the client');

    expect(await offeredForLoss()).toContain(inHouse.id);
  });

  it('name each reason once on its list, ignoring case and spacing', async () => {
    const response = await setUp('POST', '', bdManager, { appliesTo: 'LOST', label: ' price ' });

    expect(await refused(response, 409)).toEqual({
      error: 'ReasonLabelTaken',
      message:
        'There is already a reason for losing a deal called "price". Each is named once on ' +
        'its list, so that the reasons can be counted.',
      field: 'label',
    });
    /* The other list may have the same words. */
    expect((await added('EXITED', 'Price')).label).toBe('Price');
  });

  it('take a reason that says something, on one of the two lists', async () => {
    const cases: [unknown, string][] = [
      [{ appliesTo: 'LOST', label: '   ' }, 'label'],
      [{ appliesTo: 'LOST', label: 'x'.repeat(121) }, 'label'],
      [{ appliesTo: 'PAUSED', label: 'Board said no' }, 'appliesTo'],
      [{ label: 'Board said no' }, 'appliesTo'],
    ];

    for (const [body, field] of cases) {
      expect(await refused(await setUp('POST', '', bdManager, body), 400)).toMatchObject({
        error: 'InvalidReason',
        field,
      });
    }
  });

  /* #279. Reworded while unused; kept as it was once a deal has ended for it. */
  it('reword a reason no deal has ended for, and not one that a deal has', async () => {
    const typo = await added('LOST', 'Bord said no');
    const reword = (label: string) => setUp('PATCH', `/${typo.id}`, bdManager, { label });

    expect((await reword('Board said no')).status).toBe(204);

    const deal = await aDeal();
    await lost(associate, deal.id, { reasonId: typo.id });

    expect(await refused(await reword('Board said later'), 409)).toEqual({
      error: 'ReasonInUse',
      message:
        'A deal has ended for "Board said no", so its words are kept as they were. Retire it ' +
        'and add the new words as another reason.',
    });
    /* Sending the words it has is no change, so a form that sends them is not refused. */
    expect((await reword('Board said no')).status).toBe(204);
    expect((await find(deal.id)).ending?.reason.label).toBe('Board said no');
  });

  /* CLI 54. Retired: offered for no new deal, kept by those that ended for it; and back again. */
  it('retire a reason, in use or not, and bring it back', async () => {
    const deal = await aDeal();
    await lost(associate, deal.id, { reasonId: lostFor.Price });

    expect((await setUp('POST', `/${lostFor.Price}/retire`)).status).toBe(204);
    expect(await offeredForLoss()).not.toContain(lostFor.Price);
    expect((await find(deal.id)).ending?.reason.label).toBe('Price');

    expect((await setUp('POST', `/${lostFor.Price}/restore`)).status).toBe(204);
    expect(await offeredForLoss()).toContain(lostFor.Price);
  });

  /* CLI 54. Deleted only while unused; one in use is retired instead. */
  it('delete a reason no deal has ended for, and not one that a deal has', async () => {
    const typo = await added('EXITED', 'Duplicate by mistake');
    expect((await setUp('DELETE', `/${typo.id}`)).status).toBe(204);
    expect((await listed()).map((reason) => reason.id)).not.toContain(typo.id);

    const deal = await aDeal();
    await lost(associate, deal.id, { reasonId: lostFor['Not a fit'] });
    expect(await refused(await setUp('DELETE', `/${lostFor['Not a fit']}`), 409)).toEqual({
      error: 'ReasonInUse',
      message:
        'A deal has ended for "Not a fit", so it is kept. Retire it instead, and it is offered ' +
        'for no new deal.',
    });
    expect((await listed()).map((reason) => reason.id)).toContain(lostFor['Not a fit']);
  });

  /* NFR CLI AUD 01. */
  it('are audited, a delete included', async () => {
    const typo = await added('LOST', 'Bord said no');
    await setUp('PATCH', `/${typo.id}`, bdManager, { label: 'Board said no' });
    await setUp('DELETE', `/${typo.id}`);

    const { rows } = await admin.query<{ action: string; actor_employee_id: string }>(
      `SELECT action, actor_employee_id FROM audit_log
        WHERE entity = 'clients_reason' AND entity_id = $1 ORDER BY id`,
      [typo.id],
    );
    expect(rows).toEqual([
      { action: 'CREATE', actor_employee_id: people.commercialDirector },
      { action: 'UPDATE', actor_employee_id: people.commercialDirector },
      { action: 'DELETE', actor_employee_id: people.commercialDirector },
    ]);
  });

  it('name a reason there is', async () => {
    for (const id of ['987654321', 'nonsense']) {
      expect(await refused(await setUp('POST', `/${id}/retire`), 404)).toMatchObject({
        error: 'ReasonNotFound',
      });
    }
  });

  /* CLI 54, CLI 92, TDD 12.1. A BD manager's; an associate is told so, nobody else nothing. */
  it('are kept by nobody else', async () => {
    const id = lostFor.Price;
    const asks = (as: Asker) => [
      setUp('GET', '', as),
      setUp('POST', '', as, { appliesTo: 'LOST', label: 'Board said no' }),
      setUp('PATCH', `/${id}`, as, { label: 'Dear' }),
      setUp('POST', `/${id}/retire`, as),
      setUp('POST', `/${id}/restore`, as),
      setUp('DELETE', `/${id}`, as),
    ];

    for (const response of await Promise.all(asks(associate))) {
      expect(response.status).toBe(403);
    }
    for (const response of await Promise.all(asks(nobody))) {
      expect(response.status).toBe(404);
    }
    expect((await listed()).find((reason) => reason.id === id)).toMatchObject({
      label: 'Price',
      retiredOn: null,
    });
  });
});

/* --------------------------------------------- an ended deal on its client's page */

/*
 * CLI 55. An ended deal leaves the live pipeline and stays on the client's history, with its
 * stages, activities and reason. Done when: a lost deal disappears from the pipeline and still
 * shows on the client page with its reason.
 *
 * There is no pipeline screen yet (My pipeline is #282, the company pipeline #289), so what is
 * proved here is the client page's half: its open deals, which its figures are taken from, and
 * its ended ones beneath.
 */
describe("an ended deal, on its client's page", () => {
  interface PageJson {
    opportunities: (DealJson & { product: { name: string } })[];
  }

  async function pageOf(as: Asker = associate): Promise<PageJson> {
    const response = await app.send('GET', `/api/clients/clients/${adb}`, as);
    expect(response.status).toBe(200);

    return (await response.json()) as PageJson;
  }

  /** A deal exited by its POC, as the POC service will exit it (#287). */
  async function exited(product: string): Promise<DealJson> {
    const deal = await aDeal(associate, product);
    await intoItsPoc(deal.id);
    await new StageForPoc(
      new ClientsOpportunityRepository(db),
      new ClientsReasonRepository(db),
      new ClientsRoleRepository(db),
      new EmployeeRepository(db),
      new CompanyCalendar(db),
      () => PINNED_DATE,
    ).exit(signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false }), deal.id, {
      reasonId: exitedFor['Usage too low'],
      note: 'Ran on Cloud9 only',
    });

    return deal;
  }

  it('leaves the open deals, and stays beneath them with how far it came and why it ended', async () => {
    const creditStudio = await aDeal(associate, 'CreditStudio');
    await moved(creditStudio.id, 'PROPOSAL');
    await lost(associate, creditStudio.id, {
      reasonId: lostFor['Chose a competitor'],
      note: 'Went with the incumbent',
    });
    const cloud9 = await exited('Cloud9');
    const onboard = await aDeal(associate, 'OnboardStudio');

    const { opportunities } = await pageOf();

    /* Open first, then ended, each newest first. */
    expect(opportunities.map((deal) => [deal.product.name, deal.outcome])).toEqual([
      ['OnboardStudio', 'OPEN'],
      ['Cloud9', 'EXITED'],
      ['CreditStudio', 'LOST'],
    ]);
    expect(opportunities.filter((deal) => deal.outcome === 'OPEN').map((deal) => deal.id)).toEqual([
      onboard.id,
    ]);

    expect(opportunities[2]).toMatchObject({
      id: creditStudio.id,
      stage: 'PROPOSAL',
      endedOn: PINNED_DATE,
      ending: {
        reason: { id: lostFor['Chose a competitor'], label: 'Chose a competitor' },
        note: 'Went with the incumbent',
      },
      may: { change: false, move: false, decidePoc: false, lose: false },
      moves: [],
    });
    expect(opportunities[1]).toMatchObject({
      id: cloud9.id,
      stage: 'POC',
      endedOn: PINNED_DATE,
      ending: {
        reason: { id: exitedFor['Usage too low'], label: 'Usage too low' },
        note: 'Ran on Cloud9 only',
      },
      may: { change: false, move: false, decidePoc: false, lose: false },
    });
  });

  it('shows the same to everybody with a role, its owner or not', async () => {
    const deal = await aDeal();
    await lost(associate, deal.id, { reasonId: lostFor.Price });

    for (const as of [associate, colleague, bdManager]) {
      expect((await pageOf(as)).opportunities[0]).toMatchObject({
        outcome: 'LOST',
        ending: { reason: { label: 'Price' } },
      });
    }
  });

  /* CLI 55. With its stages and its activity: every move it made, and the ending, with its note. */
  it('keeps every stage it was at, and the ending is in the client activity', async () => {
    const deal = await aDeal();
    await moved(deal.id, 'QUALIFICATION');
    await lost(associate, deal.id, { reasonId: lostFor['Went quiet'], note: 'No reply since May' });

    expect((await stagesOf(deal.id)).map((change) => [change.fromStage, change.toStage])).toEqual([
      ['QUALIFICATION', 'QUALIFICATION'],
      ['DISCOVERY', 'QUALIFICATION'],
      [null, 'DISCOVERY'],
    ]);

    const { activity } = (await (
      await app.send('GET', `/api/clients/clients/${adb}/activity`, associate)
    ).json()) as {
      activity: { kind: string; deal: { id: string }; toOutcome?: string; note?: string }[];
    };
    expect(activity[0]).toMatchObject({
      kind: 'STAGE',
      deal: { id: deal.id },
      toOutcome: 'LOST',
      note: 'No reply since May',
    });
  });

  /* CLI 55. And its past values, which no longer change. */
  it('keeps what it was worth', async () => {
    const deal = await aDeal();
    await app.send('PATCH', `/api/clients/opportunities/${deal.id}`, associate, {
      value: { amount: '60000', currency: 'USD' },
      probability: 40,
    });
    await lost(associate, deal.id, { reasonId: lostFor.Price });

    expect((await pageOf()).opportunities[0]).toMatchObject({
      value: { amountMinor: 6_000_000, currency: 'USD' },
      probability: 40,
    });
    const { history } = (await (
      await app.send('GET', `/api/clients/opportunities/${deal.id}/history`, associate)
    ).json()) as { history: { value: { amountMinor: number } | null }[] };
    expect(history[0].value).toEqual({ amountMinor: 6_000_000, currency: 'USD' });
  });
});

/* ---------------------------------------------------------- re-engaging a client */

/*
 * CLI 56, AC L17. Re-engaging a client after a loss or an exit starts a new deal at Discovery,
 * and the ended one is never reopened: it stays as it ended, beside the new one.
 */
describe('re-engaging a client after a loss or an exit', () => {
  /** Everything about a deal that ending it fixed, as its page and history show it. */
  async function asItEnded(id: string) {
    const deal = await find(id);

    return {
      deal: {
        stage: deal.stage,
        outcome: deal.outcome,
        endedOn: deal.endedOn,
        ending: deal.ending,
      },
      stages: (await stagesOf(id)).length,
    };
  }

  async function exitedDeal(): Promise<DealJson> {
    const deal = await aDeal();
    await intoItsPoc(deal.id);
    await new StageForPoc(
      new ClientsOpportunityRepository(db),
      new ClientsReasonRepository(db),
      new ClientsRoleRepository(db),
      new EmployeeRepository(db),
      new CompanyCalendar(db),
      () => PINNED_DATE,
    ).exit(signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false }), deal.id, {
      reasonId: exitedFor['Client withdrew'],
      note: 'Ran on CreditStudio',
    });

    return deal;
  }

  async function lostDeal(): Promise<DealJson> {
    const deal = await aDeal();
    await app.send('PATCH', `/api/clients/opportunities/${deal.id}`, associate, {
      value: { amount: '60000', currency: 'USD' },
      probability: 40,
      hasPoc: true,
    });
    await moved(deal.id, 'NEGOTIATION');
    await lost(associate, deal.id, { reasonId: lostFor.Price, note: 'Too dear this year' });

    return deal;
  }

  for (const [how, ended] of [
    ['lost', lostDeal],
    ['exited', exitedDeal],
  ] as const) {
    it(`starts a new deal at Discovery for the same product once the last was ${how}`, async () => {
      const old = await ended();
      const before = await asItEnded(old.id);

      const response = await app.send('POST', '/api/clients/opportunities', associate, {
        clientId: adb,
        productId: products.CreditStudio,
      });
      expect(response.status).toBe(201);
      const fresh = (await response.json()) as DealJson & {
        value: unknown;
        probability: unknown;
        hasPoc: unknown;
      };

      /* New, at Discovery, open, and carrying nothing over from the old one. */
      expect(fresh.id).not.toBe(old.id);
      expect(fresh).toMatchObject({
        stage: 'DISCOVERY',
        outcome: 'OPEN',
        endedOn: null,
        ending: null,
        value: null,
        probability: null,
        hasPoc: null,
        may: { change: true, move: true, lose: true },
      });
      expect(await stagesOf(fresh.id)).toHaveLength(1);

      /* AC L17. The ended one is untouched. */
      expect(await asItEnded(old.id)).toEqual(before);

      /* Both on the client page: the new one with the open, the old one with the ended. */
      const { opportunities } = (await (
        await app.send('GET', `/api/clients/clients/${adb}`, associate)
      ).json()) as { opportunities: DealJson[] };
      expect(opportunities.map((deal) => [deal.id, deal.outcome])).toEqual([
        [fresh.id, 'OPEN'],
        [old.id, how === 'lost' ? 'LOST' : 'EXITED'],
      ]);
    });
  }

  /* CLI 56. An ended deal is not reopened by any way in: edited, moved, or ended again. */
  it('never reopens the ended deal, whichever way it is asked', async () => {
    const old = await lostDeal();
    const before = await asItEnded(old.id);

    for (const response of [
      await app.send('PATCH', `/api/clients/opportunities/${old.id}`, bdManager, {
        probability: 90,
      }),
      await app.send('POST', `/api/clients/opportunities/${old.id}/stage`, bdManager, {
        toStage: 'DISCOVERY',
        note: 'Talking again',
      }),
      await lose(bdManager, old.id, { reasonId: lostFor['Not a fit'] }),
    ]) {
      expect(await refused(response, 409)).toMatchObject({
        error: 'OpportunityEnded',
        message:
          'This CreditStudio deal was lost, so it is kept as it ended. Open a new deal to take ' +
          'it up again.',
      });
    }
    expect(await asItEnded(old.id)).toEqual(before);
  });

  /* CLI 11. A client still has one open deal per product: re-engaging twice is refused. */
  it('is one new deal, not two', async () => {
    await lostDeal();
    await aDeal();

    const second = await app.send('POST', '/api/clients/opportunities', associate, {
      clientId: adb,
      productId: products.CreditStudio,
    });
    expect(await refused(second, 409)).toMatchObject({ error: 'OpportunityAlreadyOpen' });
  });
});
