-- Up Migration

-- A POC's usage: how many users were enrolled and how many were active on a day. #286, the POC
-- SOPs.
--
-- **The percentage is worked out, never typed** (#286). Only the two counts are stored; active
-- over enrolled, as a whole percent rounded half up, is the application's (poc.ts), so it can
-- never disagree with the counts.
--
-- **A reading is kept for good** (the user, 20 November 2026). Recording another for a day that
-- has one replaces it in the figures, the latest recorded counting, and the earlier one stays in
-- the history. A reading is taken on a day from the POC's start to today; today is the
-- application's to judge, as the company's day, and the start is held here.

CREATE TABLE clients_poc_usage (
    id           BIGSERIAL PRIMARY KEY,
    poc_id       BIGINT NOT NULL REFERENCES clients_poc(id),

    /* The day the counts are for. */
    measured_on  DATE NOT NULL,
    enrolled     INTEGER NOT NULL,
    active       INTEGER NOT NULL,

    recorded_by  BIGINT NOT NULL REFERENCES employee(id),
    recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    /* Somebody is enrolled, or there is nothing to take a share of. */
    CONSTRAINT clients_poc_usage_someone_enrolled CHECK (enrolled >= 1),
    /* Active users are some of those enrolled. */
    CONSTRAINT clients_poc_usage_active_of_enrolled CHECK (active >= 0 AND active <= enrolled)
);

/* A POC's readings, the latest day and the latest recorded for it first, which its list row and
   page ask for. */
CREATE INDEX idx_clients_poc_usage_poc ON clients_poc_usage (poc_id, measured_on, recorded_at, id);

/* What a CHECK cannot see: the day is not before the POC started. */
CREATE FUNCTION clients_poc_usage_during_the_poc() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.measured_on < (SELECT started_on FROM clients_poc WHERE id = NEW.poc_id) THEN
        RAISE EXCEPTION 'A usage reading is for a day the POC had started.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_poc_usage_during_the_poc';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER clients_poc_usage_during_the_poc
    BEFORE INSERT ON clients_poc_usage
    FOR EACH ROW EXECUTE FUNCTION clients_poc_usage_during_the_poc();

-- --------------------------------------------------------- append only, NFR CLI REC 01

CREATE TRIGGER clients_poc_usage_is_never_changed
    BEFORE UPDATE ON clients_poc_usage
    FOR EACH ROW
    EXECUTE FUNCTION refuse_update(
        'A usage reading is kept as it was recorded. Record the day again instead, which adds a row.'
    );

CREATE TRIGGER clients_poc_usage_is_never_deleted
    BEFORE DELETE ON clients_poc_usage
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'A usage reading is kept for good, so that how a POC was used can always be told.'
    );

/* No audit trigger: this table is its own record (NFR CLI AUD 02), as the health is. */

-- ---------------------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT, and USAGE on the sequence: written once,
   read, and nothing else. */

-- Down Migration

DROP TABLE IF EXISTS clients_poc_usage;
DROP FUNCTION IF EXISTS clients_poc_usage_during_the_poc();
