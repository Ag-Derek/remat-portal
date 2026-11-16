-- Up Migration

-- The two default reminder schedules, one per kind. #247, SRS CMP 31–33, Compliance TDD 4.1
-- and 13.
--
--   EXPIRES: 90, 60 and 30 days before, then weekly, then daily once past the date.
--   RECURS:  5 working days before, then daily from the due date.
--
-- A default is copied onto an item when it is created, and from then on the item's schedule
-- is its own. Oversight edits the defaults without a deployment, as HR edits Rota's
-- entitlement rules.
--
-- TDD 4.1's columns cannot say either default as written, so compliance_item gains two
-- things here. `reminder_in_working_days` says whether the offsets count working days, read
-- by the reminder job off the item rather than off its kind, which only ObligationFactory
-- may branch on. And a cadence of NONE, for a schedule that says nothing between its last
-- offset and the due date. Every schedule is daily once due (TDD 8.1), so the recurring
-- default is one reminder a working week out and then daily.
--
-- There is no seed grant. The first oversight role is granted by a System Administrator
-- through the roles screen.

-- ------------------------------------------------------- the order offsets are listed in

/* Furthest first, with nothing repeated. TDD 7 reads the first offset as the point an item
   becomes due soon, so a schedule written {30, 60, 90} would turn a permit amber at thirty
   days rather than ninety, and nothing would look wrong. */

CREATE FUNCTION reminders_furthest_first(offsets INT[]) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT coalesce(bool_and(later.days < earlier.days), TRUE)
      FROM unnest(offsets) WITH ORDINALITY AS earlier(days, at)
      JOIN unnest(offsets) WITH ORDINALITY AS later(days, at) ON later.at = earlier.at + 1
$$;

-- ------------------------------------------------------------ what an item now holds

/* Compliance holds no items until somebody holds oversight, and nobody can until the roles
   screen exists, so there is nothing here to fill. The default only makes the statement
   total, and goes straight away: a writer says which it is, as it does for the offsets. */
ALTER TABLE compliance_item
    ADD COLUMN reminder_in_working_days BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE compliance_item
    ALTER COLUMN reminder_in_working_days DROP DEFAULT;

ALTER TABLE compliance_item
    DROP CONSTRAINT compliance_item_reminder_cadence_check,
    ADD CONSTRAINT item_cadence_known CHECK (reminder_cadence IN ('WEEKLY', 'DAILY', 'NONE')),
    ADD CONSTRAINT item_reminders_are_days_before CHECK (
        array_position(reminder_days_before, NULL) IS NULL
        AND 0 < ALL (reminder_days_before)
        AND reminders_furthest_first(reminder_days_before));

-- --------------------------------------------------------------- the defaults themselves

CREATE TABLE compliance_reminder_default (
    kind                     VARCHAR(10) PRIMARY KEY CHECK (kind IN ('EXPIRES', 'RECURS')),
    reminder_days_before     INT[] NOT NULL,
    reminder_in_working_days BOOLEAN NOT NULL,
    reminder_cadence         VARCHAR(10) NOT NULL,
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

    /* The same rules as an item's, which is what it is copied onto. */
    CONSTRAINT default_cadence_known CHECK (reminder_cadence IN ('WEEKLY', 'DAILY', 'NONE')),
    CONSTRAINT default_reminders_are_days_before CHECK (
        array_position(reminder_days_before, NULL) IS NULL
        AND 0 < ALL (reminder_days_before)
        AND reminders_furthest_first(reminder_days_before))
);

CREATE TRIGGER compliance_reminder_default_set_updated_at
    BEFORE UPDATE ON compliance_reminder_default
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- -------------------------------------------------------------- and who puts them back

/* Inserts a kind that has no default and never touches one that has, so that a schedule
   oversight has since changed survives the repair. Guarded on the kind with NOT EXISTS, as
   the leave reference data is. */

CREATE FUNCTION ensure_compliance_reminder_defaults() RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    inserted INTEGER;
BEGIN
    INSERT INTO compliance_reminder_default (
        kind, reminder_days_before, reminder_in_working_days, reminder_cadence
    )
    SELECT shipped.kind, shipped.days_before, shipped.in_working_days, shipped.cadence
      FROM (VALUES
        /* CMP 32. Ninety, sixty and thirty days before, then weekly until it expires. */
        ('EXPIRES', ARRAY[90, 60, 30], FALSE, 'WEEKLY'),

        /* CMP 33. Five working days before, then nothing until it is due. */
        ('RECURS', ARRAY[5], TRUE, 'NONE')
      ) AS shipped(kind, days_before, in_working_days, cadence)
     WHERE NOT EXISTS (
        SELECT 1 FROM compliance_reminder_default existing
         WHERE existing.kind = shipped.kind);

    GET DIAGNOSTICS inserted = ROW_COUNT;

    RETURN inserted;
END
$$;

/* Nobody but the owner may run it, as with the leave reference data. Restoring reference
   data is an operator's job, done knowingly. */
REVOKE EXECUTE ON FUNCTION ensure_compliance_reminder_defaults() FROM PUBLIC;

DO $$
DECLARE
    given INTEGER;
BEGIN
    given := ensure_compliance_reminder_defaults();

    RAISE NOTICE 'Gave a default reminder schedule to % kind(s) of compliance item.', given;
END
$$;

-- ---------------------------------------------------------------- privileges

/* Read and edited by oversight. The two rows are the migration's: there is no third kind to
   insert, and a kind without its default is repaired by the function above. */
REVOKE INSERT ON compliance_reminder_default FROM lms_app;
GRANT UPDATE ON compliance_reminder_default TO lms_app;

-- Down Migration

-- An item given a NONE cadence refuses the narrower check put back below, which is the right
-- answer: going back would leave its schedule saying something the old columns cannot.

DROP TABLE IF EXISTS compliance_reminder_default;
DROP FUNCTION IF EXISTS ensure_compliance_reminder_defaults();

ALTER TABLE compliance_item
    DROP CONSTRAINT IF EXISTS item_reminders_are_days_before,
    DROP CONSTRAINT IF EXISTS item_cadence_known,
    ADD CONSTRAINT compliance_item_reminder_cadence_check
        CHECK (reminder_cadence IN ('WEEKLY', 'DAILY'));

ALTER TABLE compliance_item
    DROP COLUMN IF EXISTS reminder_in_working_days;

DROP FUNCTION IF EXISTS reminders_furthest_first(INT[]);
