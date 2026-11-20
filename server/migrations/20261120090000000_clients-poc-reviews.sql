-- Up Migration

-- Running a POC: one deal each, its review meetings, and moving its CS lead. #285, Clients SRS
-- CLI 27, CLI 29, CLI 33, CLI 34, TDD 4.3, TDD 4.5, TDD 6.2.
--
-- **One deal per POC** (the user, 20 November 2026, over CLI 27's "one or more"). Signing a deal
-- with a POC starts one for it alone; a second deal for the same client and line signed later
-- starts its own.
--
-- **Review meetings** (CLI 33). Starting a POC gives its CS lead three next steps: the Day 7
-- showcase, the Week 6 midpoint review and the Week 9 activation review, each dated from the
-- start. A review is recorded as an activity of its own kind, saying which review it was and
-- whether the senior decision maker was there (CLI 34). The CS lead or a BD manager records it.
-- Attended, it closes that review's step. Not attended, it does not count: the step is closed and
-- a replacement is due seven days after the meeting (TDD 6.2, the user, 20 November 2026).
--
-- **The CS lead moves** (CLI 29, CLI 92). A BD manager may hand a POC to anybody holding a clients
-- role, and the POC's open review steps go with it.

-- ------------------------------------------------------------------------ one deal per POC

DROP INDEX idx_clients_opportunity_poc;
CREATE UNIQUE INDEX uq_clients_opportunity_one_per_poc ON clients_opportunity (poc_id)
    WHERE poc_id IS NOT NULL;

/* For the foreign keys below, which keep a review and its steps on the POC's own client. */
ALTER TABLE clients_poc ADD CONSTRAINT uq_clients_poc_of_client UNIQUE (id, client_id);

-- --------------------------------------------------------------------------- review steps

ALTER TABLE clients_next_step
    /* The POC a review step is for. */
    ADD COLUMN poc_id       BIGINT,
    /* Which review: the Day 7 showcase, the Week 6 midpoint, the Week 9 activation (CLI 33). */
    ADD COLUMN review_kind  VARCHAR(6),

    ADD CONSTRAINT clients_next_step_poc_is_the_clients
        FOREIGN KEY (poc_id, client_id) REFERENCES clients_poc (id, client_id),
    ADD CONSTRAINT clients_next_step_review_kind_known
        CHECK (review_kind IN ('DAY7', 'WEEK6', 'WEEK9')),
    /* A review step names its POC and which review it is, and only a review step does. */
    ADD CONSTRAINT clients_next_step_review_names_its_poc
        CHECK ((source = 'REVIEW') = (poc_id IS NOT NULL AND review_kind IS NOT NULL));

/* A POC's review steps, which its page and moving its CS lead ask for. */
CREATE INDEX idx_clients_next_step_poc ON clients_next_step (poc_id) WHERE poc_id IS NOT NULL;

/* Whose a step is changes only where an open review step follows its POC to a new CS lead. Every
   other step stays its owner's, as #280 made it. */
CREATE FUNCTION clients_next_step_owner_moves_with_its_poc() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
       AND (OLD.source <> 'REVIEW' OR OLD.done_at IS NOT NULL
            OR NEW.owner_id <> (SELECT cs_lead_id FROM clients_poc WHERE id = OLD.poc_id)) THEN
        RAISE EXCEPTION 'A next step stays its owner''s, but for an open review step following '
                        'its POC to a new CS lead.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_next_step_owner_moves_with_its_poc';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER clients_next_step_owner_moves_with_its_poc
    BEFORE UPDATE OF owner_id ON clients_next_step
    FOR EACH ROW EXECUTE FUNCTION clients_next_step_owner_moves_with_its_poc();

-- ---------------------------------------------------------------------- review activities

ALTER TABLE clients_activity
    ADD COLUMN poc_id       BIGINT,
    ADD COLUMN review_kind  VARCHAR(6),
    /* Whether the senior decision maker was there: the CCO or COO at a bank, the CEO or MD at a
       brokerage (CLI 34). A review without them does not count. */
    ADD COLUMN dm_attended  BOOLEAN,

    ADD CONSTRAINT clients_activity_poc_is_the_clients
        FOREIGN KEY (poc_id, client_id) REFERENCES clients_poc (id, client_id),
    ADD CONSTRAINT clients_activity_review_kind_known
        CHECK (review_kind IN ('DAY7', 'WEEK6', 'WEEK9')),
    /* TDD's act_review, and a review is about the POC's deal. */
    ADD CONSTRAINT clients_activity_review_says_which_and_who_came
        CHECK ((kind = 'REVIEW') = (poc_id IS NOT NULL AND review_kind IS NOT NULL
                                    AND dm_attended IS NOT NULL)),
    ADD CONSTRAINT clients_activity_review_names_its_deal
        CHECK (kind <> 'REVIEW' OR opportunity_id IS NOT NULL);

ALTER TABLE clients_activity DROP CONSTRAINT clients_activity_kind_known;
ALTER TABLE clients_activity
    ADD CONSTRAINT clients_activity_kind_known
        CHECK (kind IN ('CALL', 'MEETING', 'DEMO', 'PROPOSAL', 'FINANCIALS', 'REVIEW', 'NOTE'));

/* A POC's reviews, which its page asks for. */
CREATE INDEX idx_clients_activity_poc ON clients_activity (poc_id) WHERE poc_id IS NOT NULL;

-- ---------------------------------------------------------------------------- privileges

/* The CS lead, moved by a BD manager, which the audit trigger on clients_poc records (TDD 13);
   and an open review step's owner, which follows it. Which review an activity or a step is, and
   whether the decision maker came, are never corrected: they decided what happened next. */
GRANT UPDATE (cs_lead_id) ON clients_poc TO lms_app;
GRANT UPDATE (owner_id) ON clients_next_step TO lms_app;

-- Down Migration

REVOKE UPDATE (owner_id) ON clients_next_step FROM lms_app;
REVOKE UPDATE (cs_lead_id) ON clients_poc FROM lms_app;

DROP INDEX IF EXISTS idx_clients_activity_poc;
ALTER TABLE clients_activity DROP CONSTRAINT clients_activity_kind_known;
ALTER TABLE clients_activity
    ADD CONSTRAINT clients_activity_kind_known
        CHECK (kind IN ('CALL', 'MEETING', 'DEMO', 'PROPOSAL', 'FINANCIALS', 'NOTE'));
ALTER TABLE clients_activity
    DROP CONSTRAINT IF EXISTS clients_activity_review_names_its_deal,
    DROP CONSTRAINT IF EXISTS clients_activity_review_says_which_and_who_came,
    DROP CONSTRAINT IF EXISTS clients_activity_review_kind_known,
    DROP CONSTRAINT IF EXISTS clients_activity_poc_is_the_clients,
    DROP COLUMN IF EXISTS dm_attended,
    DROP COLUMN IF EXISTS review_kind,
    DROP COLUMN IF EXISTS poc_id;

DROP TRIGGER IF EXISTS clients_next_step_owner_moves_with_its_poc ON clients_next_step;
DROP FUNCTION IF EXISTS clients_next_step_owner_moves_with_its_poc();
DROP INDEX IF EXISTS idx_clients_next_step_poc;
ALTER TABLE clients_next_step
    DROP CONSTRAINT IF EXISTS clients_next_step_review_names_its_poc,
    DROP CONSTRAINT IF EXISTS clients_next_step_review_kind_known,
    DROP CONSTRAINT IF EXISTS clients_next_step_poc_is_the_clients,
    DROP COLUMN IF EXISTS review_kind,
    DROP COLUMN IF EXISTS poc_id;

ALTER TABLE clients_poc DROP CONSTRAINT IF EXISTS uq_clients_poc_of_client;

DROP INDEX IF EXISTS uq_clients_opportunity_one_per_poc;
CREATE INDEX idx_clients_opportunity_poc ON clients_opportunity (poc_id) WHERE poc_id IS NOT NULL;
