-- Up Migration

-- Every stage change a deal makes, with who made it, when, and the note where one was given.
-- #278, Clients SRS CLI 21, CLI 26, TDD 4.2, NFR CLI REC 01, REC 02, AUD 02.
--
-- One row when a deal is opened, at Discovery, and one for every move after: forward, back, to
-- Live, or ending where it stands. Each says where the deal went from and to, and the outcome it
-- had after, so that the deal as it stood on any past day can be told from this table alone (NFR
-- CLI REC 02), which is what the reports are built from (TDD 9).
--
-- Written by the application in the same transaction as the move it records, through the one
-- repository method that moves a deal, as the value history is.

CREATE TABLE clients_stage_change (
    id              BIGSERIAL PRIMARY KEY,
    opportunity_id  BIGINT NOT NULL REFERENCES clients_opportunity(id),

    /* Null on the row that opens the deal. */
    from_stage      VARCHAR(16),
    to_stage        VARCHAR(16) NOT NULL,
    /* Its outcome after the move: still open, or won at Live, or lost or exited (#279). */
    to_outcome      VARCHAR(8) NOT NULL,

    /* Why, in the mover's words. Required for a move back (CLI 21). Beyond TDD 4.2, which has
       TEXT: a length, as every free text column in clients has. */
    note            VARCHAR(2000),

    changed_by      BIGINT NOT NULL REFERENCES employee(id),
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    /* Beyond TDD 4.2: a row holds nothing the deal itself could not have held. */
    CONSTRAINT clients_stage_change_stages_known
        CHECK (clients_stage_rank(to_stage) IS NOT NULL
               AND (from_stage IS NULL OR clients_stage_rank(from_stage) IS NOT NULL)),
    CONSTRAINT clients_stage_change_outcome_known
        CHECK (to_outcome IN ('OPEN', 'WON', 'LOST', 'EXITED')),
    CONSTRAINT clients_stage_change_won_is_live
        CHECK ((to_outcome = 'WON') = (to_stage = 'LIVE')),

    /* The first row is the deal being opened, at Discovery and open (CLI 12). */
    CONSTRAINT clients_stage_change_opens_at_discovery
        CHECK (from_stage IS NOT NULL OR (to_stage = 'DISCOVERY' AND to_outcome = 'OPEN')),

    /* CLI 21. A move back says why. */
    CONSTRAINT clients_stage_change_back_has_a_note
        CHECK (from_stage IS NULL
               OR clients_stage_rank(to_stage) >= clients_stage_rank(from_stage)
               OR note IS NOT NULL),

    /* Left out is null, never an empty string. */
    CONSTRAINT clients_stage_change_note_not_blank
        CHECK (note IS NULL OR btrim(note) <> '')
);

/* A deal's history, oldest first, which its page asks for. */
CREATE INDEX idx_clients_stage_change_deal ON clients_stage_change (opportunity_id, changed_at);

-- --------------------------------------------------------- append only, NFR CLI REC 01

/* A past move is what happened. Changing one rewrites how far the deal had come on that day, and
   every report built from it (CLI 26, NFR CLI REC 02). */
CREATE TRIGGER clients_stage_change_is_never_changed
    BEFORE UPDATE ON clients_stage_change
    FOR EACH ROW
    EXECUTE FUNCTION refuse_update(
        'A past stage change is what happened. Move the deal instead, which adds a row.'
    );

CREATE TRIGGER clients_stage_change_is_never_deleted
    BEFORE DELETE ON clients_stage_change
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'A past stage change is kept for good, so that how far a deal came can always be told.'
    );

/* No audit trigger: this table is its own record (NFR CLI AUD 02). AUDITED_ENTITIES does not
   name it. */

-- ---------------------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT, and USAGE on the sequence: written once,
   read, and nothing else. */

-- ------------------------------------------------- deals opened before this table existed

/* Each starts its history where it stands: at Discovery, as every one is, put down to its owner
   when it was opened. */
INSERT INTO clients_stage_change
    (opportunity_id, from_stage, to_stage, to_outcome, changed_by, changed_at)
SELECT id, NULL, stage, outcome, owner_id, created_at
  FROM clients_opportunity;

-- Down Migration

DROP TABLE IF EXISTS clients_stage_change;
