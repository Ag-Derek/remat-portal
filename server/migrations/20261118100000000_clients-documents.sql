-- Up Migration

-- Documents: files kept on an activity or a deal. #281, Clients SRS CLI 67 to CLI 70, TDD 4.6.
--
-- A proposal, the financials, a BRD, a configuration sheet, a signed contract: attached to the
-- activity that sent it, or to the deal it is about (CLI 67). A POC joins the places a document
-- may go with the POC (#285).
--
-- The bytes are in the private bucket behind core's Storage, and the row holds the key it issued
-- (CLI 68). What the file is was read from its bytes, never from its name (CLI 69). Each file is
-- virus scanned as leave's are: an infected one is refused before anything is written, and one the
-- scanner could not be reached for is kept PENDING and cannot be downloaded until it is cleared.
--
-- Unlike leave's certificates nothing deletes on a timer (CLI 70, TDD 4.6, NFR CLI REC 03). The
-- leave purge reads only leave's own rows, so it never reaches these keys. A file goes only when
-- whoever attached it takes it off within a day of attaching it, and then its bytes go and its row
-- stays, saying so. No row is ever deleted (CLI 57).
--
-- Who may attach is the service's (#281, the user, 18 November 2026): to an activity, whoever
-- logged it, at any time; to a deal, anybody with a role, open or ended.

CREATE TABLE clients_document (
    id                BIGSERIAL PRIMARY KEY,
    /* Beyond TDD 4.6: the client it is about, which keeps its activity or deal on that client,
       and which the client page lists by. */
    client_id         BIGINT NOT NULL REFERENCES clients_client(id),
    activity_id       BIGINT,
    opportunity_id    BIGINT,

    /* The uploader's own name for it. A label, never a path, never read to say what it is. */
    original_filename VARCHAR(255) NOT NULL,
    /* The handle Storage issued: 32 random bytes as hex. Never sent to a browser. */
    storage_key       CHAR(64) NOT NULL UNIQUE,
    /* What the bytes say they are (CLI 69). */
    content_type      VARCHAR(100) NOT NULL,
    size_bytes        BIGINT NOT NULL,
    checksum_sha256   CHAR(64) NOT NULL,

    /* PENDING, CLEAN or INFECTED, as leave's. */
    scan_status       VARCHAR(10) NOT NULL,
    scan_signature    TEXT,
    scanned_by        TEXT,
    scanned_at        TIMESTAMPTZ,

    uploaded_by       BIGINT NOT NULL REFERENCES employee(id),
    uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    /* Taken off by whoever attached it, within a day: its bytes deleted, this row kept with who
       and when (#281, the user, 18 November 2026), so that CLI 57's "never deleted" holds for the
       record while a wrong file does not stay readable. */
    removed_at        TIMESTAMPTZ,
    removed_by        BIGINT REFERENCES employee(id),
    CONSTRAINT clients_document_removal_says_who
        CHECK ((removed_at IS NULL) = (removed_by IS NULL)),

    /* TDD 4.6's doc_owner, before the POC adds its third place. */
    CONSTRAINT clients_document_on_one_thing CHECK (num_nonnulls(activity_id, opportunity_id) = 1),
    CONSTRAINT clients_document_activity_is_the_clients
        FOREIGN KEY (activity_id, client_id) REFERENCES clients_activity (id, client_id),
    CONSTRAINT clients_document_deal_is_the_clients
        FOREIGN KEY (opportunity_id, client_id) REFERENCES clients_opportunity (id, client_id),

    /* Read back by the suite against ACCEPTED_DOCUMENT_TYPES in document.ts. */
    CONSTRAINT clients_document_content_type_accepted CHECK (content_type IN (
        'application/pdf',
        'image/jpeg',
        'image/png',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation')),
    /* MAX_DOCUMENT_BYTES, 50 MB, the limit the user set for #281. */
    CONSTRAINT clients_document_size_within_the_cap CHECK (
        size_bytes > 0 AND size_bytes <= 50 * 1024 * 1024),
    CONSTRAINT clients_document_checksum_is_a_sha256 CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT clients_document_storage_key_is_a_key CHECK (storage_key ~ '^[0-9a-f]{64}$'),
    CONSTRAINT clients_document_filename_is_a_name CHECK (
        btrim(original_filename) <> ''
        AND original_filename !~ '[/\\]'
        AND original_filename NOT IN ('.', '..')),
    CONSTRAINT clients_document_scan_status_known CHECK (
        scan_status IN ('PENDING', 'CLEAN', 'INFECTED')),
    /* An equivalence, so "has this been scanned" has one answer. */
    CONSTRAINT clients_document_verdict_is_stamped CHECK (
        (scan_status = 'PENDING') = (scanned_at IS NULL)
        AND (scan_status = 'PENDING') = (scanned_by IS NULL)),
    CONSTRAINT clients_document_signature_names_an_infection CHECK (
        scan_signature IS NULL OR scan_status = 'INFECTED')
);

CREATE INDEX idx_clients_document_client ON clients_document (client_id, uploaded_at DESC);
CREATE INDEX idx_clients_document_activity ON clients_document (activity_id)
    WHERE activity_id IS NOT NULL;
CREATE INDEX idx_clients_document_deal ON clients_document (opportunity_id)
    WHERE opportunity_id IS NOT NULL;

-- ------------------------------------------------- and the file itself never changes

/* Only the verdict moves, and only out of PENDING, as leave's attachments. */
CREATE FUNCTION clients_document_is_the_file_it_was() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.client_id         IS DISTINCT FROM OLD.client_id
    OR NEW.activity_id       IS DISTINCT FROM OLD.activity_id
    OR NEW.opportunity_id    IS DISTINCT FROM OLD.opportunity_id
    OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
    OR NEW.storage_key       IS DISTINCT FROM OLD.storage_key
    OR NEW.content_type      IS DISTINCT FROM OLD.content_type
    OR NEW.size_bytes        IS DISTINCT FROM OLD.size_bytes
    OR NEW.checksum_sha256   IS DISTINCT FROM OLD.checksum_sha256
    OR NEW.uploaded_by       IS DISTINCT FROM OLD.uploaded_by
    OR NEW.uploaded_at       IS DISTINCT FROM OLD.uploaded_at
    THEN
        RAISE EXCEPTION 'Document % is the file that was uploaded, where it was put.', OLD.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'clients_document_is_the_file_it_was',
                  HINT = 'Attach the right file. CLI 67.';
    END IF;

    IF OLD.scan_status <> 'PENDING' AND NEW.scan_status IS DISTINCT FROM OLD.scan_status THEN
        RAISE EXCEPTION 'Document % was already scanned and called %.', OLD.id, OLD.scan_status
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'clients_document_is_scanned_once',
                  HINT = 'A verdict is given once.';
    END IF;

    /* Taken off once, and never put back. */
    IF OLD.removed_at IS NOT NULL
       AND (NEW.removed_at IS DISTINCT FROM OLD.removed_at
            OR NEW.removed_by IS DISTINCT FROM OLD.removed_by)
    THEN
        RAISE EXCEPTION 'Document % was already removed.', OLD.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'clients_document_is_removed_once',
                  HINT = 'A removal is made once and stands.';
    END IF;

    /* Only within a day of attaching it, as an activity is corrected only within its day. */
    IF OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL
       AND now() > OLD.uploaded_at + interval '24 hours'
    THEN
        RAISE EXCEPTION 'Document % was attached more than 24 hours ago, so it stays.', OLD.id
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_document_removable_for_a_day',
                  HINT = 'Attach the right file beside it.';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER clients_document_is_the_file_it_was
    BEFORE UPDATE ON clients_document
    FOR EACH ROW EXECUTE FUNCTION clients_document_is_the_file_it_was();

/* No audit trigger: the row is frozen but for its verdict, and it says who uploaded it and when
   itself. AUDITED_ENTITIES does not name it. */

-- ---------------------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT, and USAGE on the sequence. UPDATE is the
   verdict and the removal, each held by the trigger. No DELETE: no row goes (CLI 57, CLI 70). */
GRANT UPDATE (scan_status, scan_signature, scanned_by, scanned_at, removed_at, removed_by)
    ON clients_document TO lms_app;

-- Down Migration

-- The rows go and the bytes do not: storage is not a migration's to empty.

DROP TABLE IF EXISTS clients_document;
DROP FUNCTION IF EXISTS clients_document_is_the_file_it_was();
