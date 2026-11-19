-- Up Migration

-- Proposals and financials: two more kinds of activity, each about one deal. #281, Clients SRS
-- CLI 59, CLI 65, TDD 4.5.
--
-- How the department sells, as the user set it out on 18 November 2026, which is not quite what
-- CLI 65 and AC L19 say. A proposal tells a client what Remat wants to offer them, and usually
-- names no price: nobody knows what the deal is worth yet. Once the client agrees, asks for the
-- financials and sends its requirements (the BRD), the financials go out with a figure, and that
-- is when the deal has a value. So:
--
--   PROPOSAL    a proposal sent: the deal it was for, and its document (CLI 67). No amount.
--   FINANCIALS  the financials sent: the deal, the amount with its currency (CLI 74), and its
--               document. The amount becomes the deal's value, the earlier one kept (CLI 65).
--
-- Either is logged only on an open deal, and only by its owner or a BD manager, which the service
-- holds. Neither moves the deal's stage (TDD 3, TDD 4.5): a revised proposal sent during
-- Negotiation should not drag the deal back to Proposal.

ALTER TABLE clients_activity
    ADD COLUMN amount_minor BIGINT,
    ADD COLUMN currency     CHAR(3);

/* The kinds, with the two. A review meeting joins them with the POC (#285). FINANCIALS is ten
   letters, which the column holds exactly. */
ALTER TABLE clients_activity DROP CONSTRAINT clients_activity_kind_known;
ALTER TABLE clients_activity
    ADD CONSTRAINT clients_activity_kind_known
        CHECK (kind IN ('CALL', 'MEETING', 'DEMO', 'PROPOSAL', 'FINANCIALS', 'NOTE'));

ALTER TABLE clients_activity
    ADD CONSTRAINT clients_activity_currency_known CHECK (currency IN ('GHS', 'USD')),
    /* As a deal's value: nought is an amount, a negative one is not (TDD 4.2). */
    ADD CONSTRAINT clients_activity_amount_not_negative CHECK (amount_minor >= 0),
    ADD CONSTRAINT clients_activity_proposal_names_its_deal
        CHECK (kind <> 'PROPOSAL' OR opportunity_id IS NOT NULL),
    /* TDD 4.5's act_proposal, moved to the financials and split in two. Its single equivalence
       would let a call carry an amount where it named no deal, since both sides would be false. */
    ADD CONSTRAINT clients_activity_financials_say_what_and_for_which_deal
        CHECK (kind <> 'FINANCIALS'
               OR (amount_minor IS NOT NULL AND currency IS NOT NULL
                   AND opportunity_id IS NOT NULL)),
    ADD CONSTRAINT clients_activity_only_financials_have_an_amount
        CHECK (kind = 'FINANCIALS' OR (amount_minor IS NULL AND currency IS NULL));

-- -------------------------------------------------------------------- the deal's value history

/* What sets a deal's value from an activity is the financials, not a proposal, so the history's
   PROPOSAL source becomes FINANCIALS. Nothing ever wrote PROPOSAL: it was waiting for this issue.

   A row with that source names the financials that wrote it, as one with PROPOSAL was to name its
   proposal (#277), and now that activities exist the name is a foreign key, which #277 left for
   them. Each logging, correction of the amount, or correction away from the financials adds a
   row, so the trail says what changed the value and who changed it. */
ALTER TABLE clients_value_change
    DROP CONSTRAINT clients_value_change_source_known,
    DROP CONSTRAINT clients_value_change_proposal_names_it;

ALTER TABLE clients_value_change
    ADD CONSTRAINT clients_value_change_source_known
        CHECK (source IN ('MANUAL', 'FINANCIALS', 'CONVERSION', 'IMPORT')),
    ADD CONSTRAINT clients_value_change_financials_name_them
        CHECK ((source = 'FINANCIALS') = (activity_id IS NOT NULL)),
    ADD CONSTRAINT clients_value_change_from_an_activity
        FOREIGN KEY (activity_id) REFERENCES clients_activity (id);

/* The financials' rows on a deal, which putting its value back reads. */
CREATE INDEX idx_clients_value_change_activity ON clients_value_change (activity_id)
    WHERE activity_id IS NOT NULL;

-- ---------------------------------------------------------------------------- privileges

/* The amount is corrected within its day, as the rest of an activity is (CLI 62, #281). The
   activity's own trigger still fixes it after 24 hours. */
GRANT UPDATE (amount_minor, currency) ON clients_activity TO lms_app;

-- Down Migration

REVOKE UPDATE (amount_minor, currency) ON clients_activity FROM lms_app;

/* A row the financials wrote has no source to go back to, so the rollback refuses while any is
   recorded rather than calling them proposals. */
DROP INDEX IF EXISTS idx_clients_value_change_activity;
ALTER TABLE clients_value_change
    DROP CONSTRAINT IF EXISTS clients_value_change_from_an_activity,
    DROP CONSTRAINT IF EXISTS clients_value_change_financials_name_them,
    DROP CONSTRAINT IF EXISTS clients_value_change_source_known;
ALTER TABLE clients_value_change
    ADD CONSTRAINT clients_value_change_source_known
        CHECK (source IN ('MANUAL', 'PROPOSAL', 'CONVERSION', 'IMPORT')),
    ADD CONSTRAINT clients_value_change_proposal_names_it
        CHECK ((source = 'PROPOSAL') = (activity_id IS NOT NULL));

ALTER TABLE clients_activity
    DROP CONSTRAINT IF EXISTS clients_activity_only_financials_have_an_amount,
    DROP CONSTRAINT IF EXISTS clients_activity_financials_say_what_and_for_which_deal,
    DROP CONSTRAINT IF EXISTS clients_activity_proposal_names_its_deal,
    DROP CONSTRAINT IF EXISTS clients_activity_amount_not_negative,
    DROP CONSTRAINT IF EXISTS clients_activity_currency_known;

/* A proposal or financials has no kind to go back to, so the rollback refuses while any is
   recorded rather than turning them into notes. */
ALTER TABLE clients_activity DROP CONSTRAINT clients_activity_kind_known;
ALTER TABLE clients_activity
    ADD CONSTRAINT clients_activity_kind_known
        CHECK (kind IN ('CALL', 'MEETING', 'DEMO', 'NOTE'));

ALTER TABLE clients_activity
    DROP COLUMN IF EXISTS currency,
    DROP COLUMN IF EXISTS amount_minor;
