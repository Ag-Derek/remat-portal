-- Up Migration

-- The days the clients morning notifications have run for. #290, Clients TDD 10.
--
-- **One row a day.** The job is checked every minute from 07:30 (the user, 24 November 2026); the
-- first check of a day runs it and writes the day here once it has finished, and every later
-- check that day finds the row and does nothing. Written at the end, not the start, so a run that
-- dies halfway is run again by the next check.
--
-- **The job's own record, and nothing else's** (#290, "notifications never change anything"). It
-- reads the deals, steps and POCs and writes only this, and the emails it queues.

CREATE TABLE clients_notification_run (
    /* The company's day the run was for, which is UTC's (Accra is UTC+0 all year). */
    run_on  DATE PRIMARY KEY,
    ran_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------- append only

CREATE TRIGGER clients_notification_run_is_never_changed
    BEFORE UPDATE ON clients_notification_run
    FOR EACH ROW
    EXECUTE FUNCTION refuse_update(
        'A day the notifications ran for is kept as it was written.'
    );

CREATE TRIGGER clients_notification_run_is_never_deleted
    BEFORE DELETE ON clients_notification_run
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'A day the notifications ran for is kept, or the next run would send that day again.'
    );

/* No audit trigger: the system writes it, and the table is its own record. */

-- ---------------------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT: written once, read, and nothing else. */

-- Down Migration

DROP TABLE IF EXISTS clients_notification_run;
