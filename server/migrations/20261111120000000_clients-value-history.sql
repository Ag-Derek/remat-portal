-- Up Migration

-- What a deal was said to be worth, and how likely to close, each time either changed. #277,
-- Clients SRS CLI 49, CLI 65, TDD 4.2, NFR CLI REC 01, REC 02, AUD 02.
--
-- The deal holds its current value and probability, because every pipeline read needs them and
-- none needs the history (TDD 4.2). This table holds how they got there: one row when the deal is
-- opened, and one each time its value or probability changes, each the whole of both as they
-- stood after it, with who and when. "It was $60,000 before the proposal" is answered from here
-- (AC L19), and so is any report that needs a deal as it stood last month (NFR CLI REC 02).
--
-- Written by the application in the same transaction as the change it records, through the one
-- repository method that changes a deal's figures, so that the two cannot disagree.

CREATE TABLE clients_value_change (
    id              BIGSERIAL PRIMARY KEY,
    opportunity_id  BIGINT NOT NULL REFERENCES clients_opportunity(id),

    /* Both, as they stood after the change: null where it was missing then. */
    value_minor     BIGINT,
    currency        CHAR(3),
    probability     SMALLINT,

    /* What changed it. MANUAL, an owner or BD manager editing the deal or opening it; PROPOSAL,
       a proposal sent (CLI 65, #281); CONVERSION, a POC converting (CLI 49); IMPORT, the
       workbooks (#283). */
    source          VARCHAR(10) NOT NULL,
    /* The proposal, where source is PROPOSAL. Its foreign key is added with activities (#280). */
    activity_id     BIGINT,

    changed_by      BIGINT NOT NULL REFERENCES employee(id),
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    /* Beyond TDD 4.2, which has the columns and leaves these to the deal's own constraints: a
       row holds nothing the deal itself could not have held. */
    CONSTRAINT clients_value_change_currency_known CHECK (currency IN ('GHS', 'USD')),
    CONSTRAINT clients_value_change_value_pair CHECK ((value_minor IS NULL) = (currency IS NULL)),
    CONSTRAINT clients_value_change_value_not_negative CHECK (value_minor >= 0),
    CONSTRAINT clients_value_change_probability_a_percentage
        CHECK (probability BETWEEN 0 AND 100),
    CONSTRAINT clients_value_change_source_known
        CHECK (source IN ('MANUAL', 'PROPOSAL', 'CONVERSION', 'IMPORT')),
    /* A proposal names the activity that sent it, and nothing else names one. */
    CONSTRAINT clients_value_change_proposal_names_it
        CHECK ((source = 'PROPOSAL') = (activity_id IS NOT NULL))
);

/* A deal's history, oldest first, which its page asks for. */
CREATE INDEX idx_clients_value_change_deal ON clients_value_change (opportunity_id, changed_at);

-- --------------------------------------------------------- append only, NFR CLI REC 01

/* A past value is what was said at the time. Changing one rewrites what the pipeline looked like
   then, and every report built from it (NFR CLI REC 02). The shared functions the leave ledger
   and the audit log use, with a hint of this table's own. */
CREATE TRIGGER clients_value_change_is_never_changed
    BEFORE UPDATE ON clients_value_change
    FOR EACH ROW
    EXECUTE FUNCTION refuse_update(
        'A past value is what was said then. Change the deal instead, which adds a row.'
    );

CREATE TRIGGER clients_value_change_is_never_deleted
    BEFORE DELETE ON clients_value_change
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'A past value is kept for good, so that the pipeline as it stood can always be told.'
    );

/* No audit trigger: this table is its own record (NFR CLI AUD 02), and auditing it would write a
   second copy of every row it holds. AUDITED_ENTITIES does not name it. */

-- ---------------------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT, and USAGE on the sequence: written once,
   read, and nothing else. */

-- ------------------------------------------------- deals opened before this table existed

/* Each starts its history with the figures it holds now, put down to its owner when it was
   opened. Any change made to them before today is in the audit log, which says who and when. */
INSERT INTO clients_value_change
    (opportunity_id, value_minor, currency, probability, source, changed_by, changed_at)
SELECT id, value_minor, currency, probability, 'MANUAL', owner_id, created_at
  FROM clients_opportunity;

-- Down Migration

DROP TABLE IF EXISTS clients_value_change;
