-- Up Migration

-- The people the department deals with at a client. #276, Clients SRS CLI 03, CLI 05.
--
-- Added and corrected by anybody with a clients role, not only the client's owner: whoever met
-- the new head of IT is the one who knows their number. A contact who moves on is removed, not
-- deleted, so the record still shows who was dealt with before; the audit log says who changed
-- what.

CREATE TABLE clients_contact (
    id          BIGSERIAL PRIMARY KEY,
    /* Exactly one client, for good: see the privileges below. */
    client_id   BIGINT NOT NULL REFERENCES clients_client(id),
    name        VARCHAR(120) NOT NULL,
    job_title   VARCHAR(120),
    email       VARCHAR(254),
    phone       VARCHAR(40),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    /* When they stopped being somebody to deal with there. Null while they are. */
    removed_at  TIMESTAMPTZ,

    CONSTRAINT clients_contact_named CHECK (clients_name_key(name) <> ''),

    /* Left out is null, never an empty string, so that the screen shows it as missing. */
    CONSTRAINT clients_contact_job_title_not_blank CHECK (job_title IS NULL OR btrim(job_title) <> ''),
    CONSTRAINT clients_contact_email_not_blank CHECK (email IS NULL OR btrim(email) <> ''),
    CONSTRAINT clients_contact_phone_not_blank CHECK (phone IS NULL OR btrim(phone) <> ''),

    CONSTRAINT clients_contact_removed_after_added CHECK (removed_at >= created_at)
);

/* A client's contacts, which every client page asks for. */
CREATE INDEX idx_clients_contact_client ON clients_contact (client_id);

-- ------------------------------------------------------------------- audit, NFR CLI AUD 01

CREATE TRIGGER clients_contact_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON clients_contact
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

-- ---------------------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT, and USAGE on the sequence. Corrected,
   removed and brought back. Never moved to another client, which would rewrite who was dealt
   with where, and never deleted. */
GRANT UPDATE (name, job_title, email, phone, removed_at) ON clients_contact TO lms_app;

-- Down Migration

DROP TABLE IF EXISTS clients_contact;
