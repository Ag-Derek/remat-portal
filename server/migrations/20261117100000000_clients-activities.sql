-- Up Migration

-- Activities: what happened with a client, and on what day. #280, Clients SRS CLI 58 to CLI 64,
-- TDD 4.5.
--
-- A call, a meeting, a demo or a note, logged against any client and optionally one of its deals,
-- open or ended (CLI 55, #280). The day it happened, which may be any day up to today (CLI 61); the
-- service refuses a later one, since an activity is something that has happened.
--
-- Fixed a day after it is logged (CLI 62, TDD 17 item 2): the trigger below refuses any change or
-- removal after that, whoever asks. Within the day only whoever logged it may correct it, which is
-- the policy's; a correction after that is a further note.
--
-- Left for later, with what they need: a review meeting, with its POC, which review it is and
-- whether the decision maker attended (CLI 33, CLI 34), comes with the POC (#285); a proposal sent,
-- with its amount and the value change it makes (CLI 65), comes with proposals (#281). Each widens
-- the list of kinds below.
--
-- Also here, for the next steps an activity offers (CLI 63, CLI 64): which activity a step came
-- from, and closing a step, which only its owner does and nothing does by itself.

CREATE TABLE clients_activity (
    id              BIGSERIAL PRIMARY KEY,
    client_id       BIGINT NOT NULL REFERENCES clients_client(id),
    /* The deal it was about, where it was about one: one of this client's. */
    opportunity_id  BIGINT,

    kind            VARCHAR(10) NOT NULL,
    /* The day it happened, not the day it was typed (CLI 61). */
    happened_on     DATE NOT NULL,
    /* Who it was with, in words: "Ama Owusu (CCO) and their IT lead". */
    with_whom       VARCHAR(200),
    /* What came of it. */
    outcome         TEXT,

    logged_by       BIGINT NOT NULL REFERENCES employee(id),
    logged_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT clients_activity_kind_known
        CHECK (kind IN ('CALL', 'MEETING', 'DEMO', 'NOTE')),
    /* Left out is nothing said, never an empty answer. */
    CONSTRAINT clients_activity_with_whom_not_blank
        CHECK (with_whom IS NULL OR btrim(with_whom) <> ''),
    CONSTRAINT clients_activity_outcome_not_blank
        CHECK (outcome IS NULL OR btrim(outcome) <> ''),
    /* For a next step's foreign key to it, which keeps a step on its activity's client. */
    CONSTRAINT uq_clients_activity_of_client UNIQUE (id, client_id)
);

/* A deal named by an activity or a next step is one of that client's. A deal's client never
   changes, so the pair is as fixed as the deal's id. */
ALTER TABLE clients_opportunity
    ADD CONSTRAINT uq_clients_opportunity_of_client UNIQUE (id, client_id);

ALTER TABLE clients_activity
    ADD CONSTRAINT clients_activity_deal_is_the_clients
        FOREIGN KEY (opportunity_id, client_id) REFERENCES clients_opportunity (id, client_id);

/* TDD's idx_act_client: a client's activity by the day it happened, which its page asks for. */
CREATE INDEX idx_clients_activity_client ON clients_activity (client_id, happened_on DESC);
/* TDD's idx_act_logger: somebody's activity in a period, which their meeting report asks for. */
CREATE INDEX idx_clients_activity_logger ON clients_activity (logged_by, happened_on);
/* A deal's activity, which the client page filters to. */
CREATE INDEX idx_clients_activity_deal ON clients_activity (opportunity_id)
    WHERE opportunity_id IS NOT NULL;

/* TDD 4.5: fixed 24 hours after it is logged, against a change or a removal alike. */
CREATE FUNCTION clients_activity_fixed_after_a_day() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF now() > OLD.logged_at + interval '24 hours' THEN
        RAISE EXCEPTION 'This activity was logged more than 24 hours ago, so it is fixed. '
                        'Log a note to correct it.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_activity_fixed_after_a_day';
    END IF;

    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER clients_activity_fixed_after_a_day
    BEFORE UPDATE OR DELETE ON clients_activity
    FOR EACH ROW EXECUTE FUNCTION clients_activity_fixed_after_a_day();

/* What it said before each correction, and who made it. */
CREATE TRIGGER clients_activity_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON clients_activity
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

-- --------------------------------------------------------------------------- next steps

/* The activity a step was offered with (CLI 63), TDD 4.5's from_activity: one of the step's
   client's, as its deal is. */
ALTER TABLE clients_next_step ADD COLUMN from_activity BIGINT;

ALTER TABLE clients_next_step
    ADD CONSTRAINT clients_next_step_activity_is_the_clients
        FOREIGN KEY (from_activity, client_id) REFERENCES clients_activity (id, client_id),
    ADD CONSTRAINT clients_next_step_deal_is_the_clients
        FOREIGN KEY (opportunity_id, client_id) REFERENCES clients_opportunity (id, client_id),
    /* Beyond TDD 4.5: a step from an activity names it, and only such a step does. */
    ADD CONSTRAINT clients_next_step_activity_names_its_activity
        CHECK ((source = 'ACTIVITY') = (from_activity IS NOT NULL));

-- ---------------------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT, and USAGE on the sequence.

   An activity is corrected within its day: what it was, when, with whom, what came of it, and
   which of the client's deals. Never its client, nor who logged it or when. Nothing is deleted
   (CLI 57).

   A step is closed by its owner, who and when (CLI 64). */
GRANT UPDATE (kind, happened_on, with_whom, outcome, opportunity_id) ON clients_activity TO lms_app;
GRANT UPDATE (done_at, done_by) ON clients_next_step TO lms_app;

-- Down Migration

REVOKE UPDATE (done_at, done_by) ON clients_next_step FROM lms_app;

ALTER TABLE clients_next_step
    DROP CONSTRAINT IF EXISTS clients_next_step_activity_names_its_activity,
    DROP CONSTRAINT IF EXISTS clients_next_step_deal_is_the_clients,
    DROP CONSTRAINT IF EXISTS clients_next_step_activity_is_the_clients;
ALTER TABLE clients_next_step DROP COLUMN IF EXISTS from_activity;

DROP TABLE IF EXISTS clients_activity;
DROP FUNCTION IF EXISTS clients_activity_fixed_after_a_day();

ALTER TABLE clients_opportunity DROP CONSTRAINT IF EXISTS uq_clients_opportunity_of_client;
