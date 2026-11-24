-- Up Migration

-- The POC flags the morning alerts have told each person about. #290, Clients SRS CLI 72.
--
-- **A flag is worked out on read and never stored** (#286), so whether it has been told is kept
-- here instead: once per POC, flag, the moment it was flagged from, and person told (the user, 24
-- November 2026). At Risk again, Stalled again, or a new decision date passed after an extension
-- each have a new moment and are told again. Low and no usage are flagged from Day 63, the same
-- moment every time, so each is told once a POC.
--
-- **Written with the email that tells it** (#290 task 4). A person's rows go in the same
-- transaction as their email's row in the outbox, so there is never an email queued whose flags
-- are not recorded, nor a flag recorded that no email carries. Per person, so the CS lead told
-- and their BD manager not yet (a run stopped between the two) leaves the manager still to tell.
--
-- **The job's own record, and nothing else's** ("notifications never change anything"). Nothing
-- about the POC is changed by its being told.

CREATE TABLE clients_poc_alert (
    poc_id        BIGINT NOT NULL REFERENCES clients_poc(id),
    flag          VARCHAR(24) NOT NULL,
    /* The moment it was flagged from, as poc.ts works it out. */
    since         TIMESTAMPTZ NOT NULL,
    recipient_id  BIGINT NOT NULL REFERENCES employee(id),
    /* The morning it was told on. */
    alerted_on    DATE NOT NULL,
    alerted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (poc_id, flag, since, recipient_id),

    CONSTRAINT clients_poc_alert_flag_known CHECK (
        flag IN ('NO_CORRECTIVE_ACTION', 'EXIT_DECISION', 'LOW_USAGE', 'NO_USAGE', 'PAST_DECISION')
    )
);

-- --------------------------------------------------------------------------- append only

CREATE TRIGGER clients_poc_alert_is_never_changed
    BEFORE UPDATE ON clients_poc_alert
    FOR EACH ROW
    EXECUTE FUNCTION refuse_update('A POC alert is kept as it was sent.');

CREATE TRIGGER clients_poc_alert_is_never_deleted
    BEFORE DELETE ON clients_poc_alert
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'A POC alert is kept, or the next morning would send it again.'
    );

/* No audit trigger: the system writes it, and the table is its own record. */

-- ---------------------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT: written once, read, and nothing else. */

-- Down Migration

DROP TABLE IF EXISTS clients_poc_alert;
