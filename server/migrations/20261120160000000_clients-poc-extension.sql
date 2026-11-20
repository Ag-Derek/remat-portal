-- Up Migration

-- A POC's one extension: up to thirty days more, with a written plan and a new decision date.
-- #287, Clients SRS CLI 31, the POC SOPs.
--
-- **Once** (#287). A POC is extended at most one time, by 1 to 30 days, and the extension is never
-- changed afterwards: a second is refused here, whatever writes it
-- (`clients_poc_extended_once`). Its CS lead or a BD manager extends it, any time while its deal
-- is open, past its decision date included (the user, 20 November 2026).
--
-- **The decision date follows.** It was always ten weeks after the start
-- (`clients_poc_ten_weeks`); now it is ten weeks plus the extension's days, so the date and the
-- extension can never disagree. Phase, day and the flags read the new date on their own.
--
-- The audit trigger on clients_poc already records who extended it and what it said before.

ALTER TABLE clients_poc
    /* How many days more, 1 to 30. */
    ADD COLUMN extension_days  SMALLINT,
    /* What will be done with them, in the extender's words. */
    ADD COLUMN extension_plan  VARCHAR(4000),
    ADD COLUMN extended_by     BIGINT REFERENCES employee(id),
    ADD COLUMN extended_at     TIMESTAMPTZ,

    /* All four or none: an extension says how long, why, who and when. */
    ADD CONSTRAINT clients_poc_extension_whole
        CHECK ((extension_days IS NULL) = (extension_plan IS NULL)
               AND (extension_days IS NULL) = (extended_by IS NULL)
               AND (extension_days IS NULL) = (extended_at IS NULL)),
    ADD CONSTRAINT clients_poc_extension_up_to_thirty_days
        CHECK (extension_days BETWEEN 1 AND 30),
    ADD CONSTRAINT clients_poc_extension_has_a_plan
        CHECK (extension_plan IS NULL OR btrim(extension_plan) <> '');

ALTER TABLE clients_poc DROP CONSTRAINT clients_poc_ten_weeks;
ALTER TABLE clients_poc
    /* CLI 31: ten weeks, seventy days, after the start, and the extension's days on top. */
    ADD CONSTRAINT clients_poc_decision_date
        CHECK (decision_on = started_on + 70 + COALESCE(extension_days, 0));

/* What a CHECK cannot see: an extension is made once and kept, and only while the POC runs. */
CREATE FUNCTION clients_poc_extended_once() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.extension_days IS NOT DISTINCT FROM OLD.extension_days
       AND NEW.extension_plan IS NOT DISTINCT FROM OLD.extension_plan
       AND NEW.extended_by IS NOT DISTINCT FROM OLD.extended_by
       AND NEW.extended_at IS NOT DISTINCT FROM OLD.extended_at
       AND NEW.decision_on = OLD.decision_on THEN
        RETURN NEW;
    END IF;

    IF OLD.extension_days IS NOT NULL THEN
        RAISE EXCEPTION 'A POC is extended once. This one has been.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_poc_extended_once';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM clients_opportunity WHERE poc_id = NEW.id AND outcome = 'OPEN') THEN
        RAISE EXCEPTION 'A POC is extended while it runs, not once its deal has ended.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_poc_extended_while_running';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER clients_poc_extended_once
    BEFORE UPDATE OF extension_days, extension_plan, extended_by, extended_at, decision_on
    ON clients_poc
    FOR EACH ROW EXECUTE FUNCTION clients_poc_extended_once();

-- ---------------------------------------------------------------------------- privileges

/* The extension, written once, and the decision date it moves. */
GRANT UPDATE (decision_on, extension_days, extension_plan, extended_by, extended_at)
    ON clients_poc TO lms_app;

-- Down Migration

REVOKE UPDATE (decision_on, extension_days, extension_plan, extended_by, extended_at)
    ON clients_poc FROM lms_app;
DROP TRIGGER IF EXISTS clients_poc_extended_once ON clients_poc;
DROP FUNCTION IF EXISTS clients_poc_extended_once();
ALTER TABLE clients_poc DROP CONSTRAINT IF EXISTS clients_poc_decision_date;
ALTER TABLE clients_poc
    DROP CONSTRAINT IF EXISTS clients_poc_extension_has_a_plan,
    DROP CONSTRAINT IF EXISTS clients_poc_extension_up_to_thirty_days,
    DROP CONSTRAINT IF EXISTS clients_poc_extension_whole,
    DROP COLUMN IF EXISTS extended_at,
    DROP COLUMN IF EXISTS extended_by,
    DROP COLUMN IF EXISTS extension_plan,
    DROP COLUMN IF EXISTS extension_days;
ALTER TABLE clients_poc ADD CONSTRAINT clients_poc_ten_weeks CHECK (decision_on = started_on + 70);
