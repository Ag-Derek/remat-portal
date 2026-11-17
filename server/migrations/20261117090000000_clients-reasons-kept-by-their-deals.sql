-- Up Migration

-- The lost and exit lists, kept by a BD manager. #279, Clients SRS CLI 54, TDD 3, TDD 4.5.
--
-- "A reason in use may be retired but not deleted" (CLI 54), and the user settled the rest (#279):
-- a reason no deal has ended for may be deleted, and reworded; one a deal has ended for is kept
-- as it was, so that every deal that ended for it says what it was told, and may only be retired,
-- and brought back. "In use" is a deal naming it, whatever that deal's outcome since.
--
-- Held here whoever writes: deleting one in use is refused by the deal's foreign key to it, and
-- rewording one in use by the trigger below.

/* Deleted only while no deal names it, which clients_opportunity_reason_id_fkey holds: a deal
   that ended for it keeps it (CLI 54, CLI 55). The audit trigger records the delete. */
GRANT DELETE ON clients_reason TO lms_app;

/* A reason's words, fixed once a deal has ended for it. Retiring and restoring it is still
   allowed; so is rewording it while nothing names it, a typo just added say. */
CREATE FUNCTION clients_reason_words_kept_once_used() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.label IS DISTINCT FROM OLD.label
       AND EXISTS (SELECT 1 FROM clients_opportunity WHERE reason_id = OLD.id) THEN
        RAISE EXCEPTION 'A deal has ended for this reason, so its words are kept as they were.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_reason_words_kept_once_used';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER clients_reason_words_kept_once_used
    BEFORE UPDATE ON clients_reason
    FOR EACH ROW EXECUTE FUNCTION clients_reason_words_kept_once_used();

-- Down Migration

DROP TRIGGER IF EXISTS clients_reason_words_kept_once_used ON clients_reason;
DROP FUNCTION IF EXISTS clients_reason_words_kept_once_used();
REVOKE DELETE ON clients_reason FROM lms_app;
