-- Up Migration

-- Ending a deal without winning it: lost before its POC starts, or exited from a started POC, each
-- with a reason from a list. #279, Clients SRS CLI 51 to CLI 56, TDD 4.2, TDD 4.5.
--
-- The reason sits on the deal, with a note, so the client page can say why every ended deal ended
-- (CLI 55). The move that ends it is a row in clients_stage_change like any other, from the stage
-- it stood at to the same stage, with its outcome after: the stage says how far it came.

-- ------------------------------------------------------------------ the two lists, CLI 54

/* Why deals are lost, and why POCs are exited. Data rather than a fixed list, so the BD manager
   keeps them without a developer (CLI 54), which the setup screen does. Like a product, renamed
   and retired, never deleted: a deal that ended for a reason keeps it. Beyond TDD 4.5, retired on
   a day as products, lines and client types are, rather than at an instant. */
CREATE TABLE clients_reason (
    id          BIGSERIAL PRIMARY KEY,
    applies_to  VARCHAR(6) NOT NULL,
    label       VARCHAR(120) NOT NULL,
    retired_on  DATE,

    CONSTRAINT clients_reason_applies_to_known CHECK (applies_to IN ('LOST', 'EXITED')),
    CONSTRAINT clients_reason_labelled CHECK (btrim(label) <> '')
);

/* Each named once in its list, ignoring case and surrounding spaces, as products are. The same
   words may be on both lists. */
CREATE UNIQUE INDEX uq_clients_reason_label
    ON clients_reason (applies_to, lower(btrim(label)));

CREATE TRIGGER clients_reason_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON clients_reason
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

-- ------------------------------------------------------------- the shape of an ended deal

ALTER TABLE clients_opportunity
    /* Why it was lost or exited (CLI 51, CLI 52). Null while open, and on a won deal. */
    ADD COLUMN reason_id  BIGINT REFERENCES clients_reason(id),
    /* Anything more to say: optional when lost, and when exited, which products the POC ran on
       (CLI 52). Beyond TDD 4.2, which has TEXT: a length, as every free text column in clients
       has. */
    ADD COLUMN end_note   VARCHAR(2000),

    /* TDD's opp_lost_shape. Lost before any POC starts, and never once Live (CLI 51). */
    ADD CONSTRAINT clients_opportunity_lost_shape
        CHECK (outcome <> 'LOST' OR (stage NOT IN ('POC', 'LIVE') AND reason_id IS NOT NULL)),

    /* TDD's opp_exit_shape, and CLI 52's note: exited only from a started POC, with a reason and
       which products it ran on. */
    ADD CONSTRAINT clients_opportunity_exit_shape
        CHECK (outcome <> 'EXITED'
               OR (stage = 'POC' AND reason_id IS NOT NULL AND end_note IS NOT NULL)),

    /* Beyond TDD 4.2: a reason and a closing note belong to a deal that ended without winning,
       and to no other. */
    ADD CONSTRAINT clients_opportunity_reason_only_when_ended
        CHECK ((reason_id IS NOT NULL) = (outcome IN ('LOST', 'EXITED'))),
    ADD CONSTRAINT clients_opportunity_end_note_only_when_ended
        CHECK (end_note IS NULL OR outcome IN ('LOST', 'EXITED')),

    /* Left out is null, never an empty string. */
    ADD CONSTRAINT clients_opportunity_end_note_not_blank
        CHECK (end_note IS NULL OR btrim(end_note) <> '');

CREATE INDEX idx_clients_opportunity_reason ON clients_opportunity (reason_id)
    WHERE reason_id IS NOT NULL;

/* The history holds no ending the deal itself could not have had. */
ALTER TABLE clients_stage_change
    ADD CONSTRAINT clients_stage_change_lost_before_poc
        CHECK (to_outcome <> 'LOST' OR to_stage NOT IN ('POC', 'LIVE')),
    ADD CONSTRAINT clients_stage_change_exited_from_poc
        CHECK (to_outcome <> 'EXITED' OR to_stage = 'POC');

-- ------------------------------------------------- a reason from the right list, still in use

/* A CHECK sees one row; which list a reason is on, and whether it is retired, are on another. A
   lost deal takes a lost reason and an exited one an exit reason, and a retired reason is kept
   by the deals that ended for it but given to no new one (CLI 54). Named to fire after
   clients_opportunity_ended_is_fixed, which refuses any change to an ended deal first. */
CREATE FUNCTION clients_opportunity_reason_fits() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    reason clients_reason%ROWTYPE;
BEGIN
    /* A reason on a deal that is not lost or exited is clients_opportunity_reason_only_when_ended's
       to refuse, in its own words. */
    IF NEW.reason_id IS NULL OR NEW.reason_id IS NOT DISTINCT FROM OLD.reason_id
       OR NEW.outcome NOT IN ('LOST', 'EXITED') THEN
        RETURN NEW;
    END IF;

    SELECT * INTO reason FROM clients_reason WHERE id = NEW.reason_id;

    IF reason.applies_to IS DISTINCT FROM NEW.outcome THEN
        RAISE EXCEPTION 'A deal % takes a reason from the % list.',
                        lower(NEW.outcome), lower(NEW.outcome)
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_opportunity_reason_from_its_list';
    END IF;

    IF reason.retired_on IS NOT NULL THEN
        RAISE EXCEPTION 'That reason is retired, so no deal ends for it now.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_opportunity_reason_in_use';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER clients_opportunity_reason_fits
    BEFORE UPDATE ON clients_opportunity
    FOR EACH ROW EXECUTE FUNCTION clients_opportunity_reason_fits();

-- ---------------------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT, and USAGE on the sequence. A reason is
   renamed and retired; nothing is deleted. A deal's reason and note are written by the stage
   service as it ends the deal, and the triggers above hold them whoever writes. */
GRANT UPDATE (label, retired_on) ON clients_reason TO lms_app;
GRANT UPDATE (reason_id, end_note) ON clients_opportunity TO lms_app;

-- ------------------------------------------------------------------- a starter set, TDD 14

/* For the BD manager to edit (TDD 14, migration 6). Neither the SRS nor the POC SOPs give the
   lists, so these are a start, not a rule. */
SELECT set_config('lms.audit.actor', 'migration: a starter set of lost and exit reasons (#279)',
                  true);

INSERT INTO clients_reason (applies_to, label)
VALUES ('LOST', 'Price'),
       ('LOST', 'Chose a competitor'),
       ('LOST', 'No budget'),
       ('LOST', 'Went quiet'),
       ('LOST', 'Timing not right'),
       ('LOST', 'Not a fit'),
       ('LOST', 'Other'),
       ('EXITED', 'Did not meet the success metrics'),
       ('EXITED', 'Usage too low'),
       ('EXITED', 'Client withdrew'),
       ('EXITED', 'Integration problems'),
       ('EXITED', 'Commercial terms'),
       ('EXITED', 'Other');

-- Down Migration

REVOKE UPDATE (reason_id, end_note) ON clients_opportunity FROM lms_app;
DROP TRIGGER IF EXISTS clients_opportunity_reason_fits ON clients_opportunity;
DROP FUNCTION IF EXISTS clients_opportunity_reason_fits();
ALTER TABLE clients_stage_change
    DROP CONSTRAINT IF EXISTS clients_stage_change_exited_from_poc,
    DROP CONSTRAINT IF EXISTS clients_stage_change_lost_before_poc;
DROP INDEX IF EXISTS idx_clients_opportunity_reason;
ALTER TABLE clients_opportunity
    DROP CONSTRAINT IF EXISTS clients_opportunity_end_note_not_blank,
    DROP CONSTRAINT IF EXISTS clients_opportunity_end_note_only_when_ended,
    DROP CONSTRAINT IF EXISTS clients_opportunity_reason_only_when_ended,
    DROP CONSTRAINT IF EXISTS clients_opportunity_exit_shape,
    DROP CONSTRAINT IF EXISTS clients_opportunity_lost_shape,
    DROP COLUMN IF EXISTS end_note,
    DROP COLUMN IF EXISTS reason_id;
DROP TABLE IF EXISTS clients_reason;
