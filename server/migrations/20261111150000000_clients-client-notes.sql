-- Up Migration

-- Notes on a client: as many as are wanted, each with a heading and the note itself. #278, on the
-- client page's Notes card.
--
-- Standing facts about a client, "How they buy", "Who signs off", rather than things that happened
-- on a day, which are its activity. Any number of them, each with a heading to find it by, so the
-- card can list the headings and open one at a time.
--
-- Written by anybody with a clients role; changed and archived by whoever wrote it or a BD
-- manager. Archived rather than deleted, since nothing in clients is (CLI 57): an archived note is
-- kept, folded away, and can be brought back.
--
-- Replaces the one free text note a client had (#276), which is moved in here as its first note,
-- headed "Note", and then dropped. Every value it ever held is in the audit log as well.

CREATE TABLE clients_client_note (
    id           BIGSERIAL PRIMARY KEY,
    /* Which client, for good. */
    client_id    BIGINT NOT NULL REFERENCES clients_client(id),
    /* What the card lists, to find a note by. */
    heading      VARCHAR(120) NOT NULL,
    body         VARCHAR(4000) NOT NULL,
    /* Who wrote it, and when; neither changes. */
    written_by   BIGINT NOT NULL REFERENCES employee(id),
    written_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    /* When it was last changed, or null if it never was. Who changed it is in the audit log. */
    edited_at    TIMESTAMPTZ,
    /* When it was archived, or null while it is current. */
    archived_at  TIMESTAMPTZ,

    /* Left out is no note at all, never an empty one. */
    CONSTRAINT clients_client_note_heading_not_blank CHECK (btrim(heading) <> ''),
    CONSTRAINT clients_client_note_body_not_blank CHECK (btrim(body) <> '')
);

/* A client's notes, newest first, which its page asks for. */
CREATE INDEX idx_clients_client_note_client ON clients_client_note (client_id, written_at);

-- ------------------------------------------------------------------- audit, NFR CLI AUD 01

/* Who wrote each note, and every change to it and its archiving. */
CREATE TRIGGER clients_client_note_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON clients_client_note
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

-- ---------------------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT, and USAGE on the sequence. Its words change,
   and it is archived and brought back. Which client, who wrote it and when never change, and
   nothing is deleted. */
GRANT UPDATE (heading, body, edited_at, archived_at) ON clients_client_note TO lms_app;

-- ------------------------------------------------- the one note a client had until now

/* Each becomes the client's first note, headed "Note", put down to the client's owner as of when
   the client was recorded: who wrote it and when is in the audit log. */
INSERT INTO clients_client_note (client_id, heading, body, written_by, written_at)
SELECT id, 'Note', note, owner_id, created_at
  FROM clients_client
 WHERE note IS NOT NULL;

REVOKE UPDATE (note) ON clients_client FROM lms_app;
ALTER TABLE clients_client DROP CONSTRAINT clients_client_note_not_blank;
ALTER TABLE clients_client DROP COLUMN note;

-- Down Migration

ALTER TABLE clients_client ADD COLUMN note VARCHAR(2000);
ALTER TABLE clients_client
    ADD CONSTRAINT clients_client_note_not_blank CHECK (note IS NULL OR btrim(note) <> '');
GRANT UPDATE (note) ON clients_client TO lms_app;

/* The newest current note of each, which is as near to one note as many come to. */
UPDATE clients_client c
   SET note = left(n.body, 2000)
  FROM (SELECT DISTINCT ON (client_id) client_id, body
          FROM clients_client_note
         WHERE archived_at IS NULL
         ORDER BY client_id, written_at DESC) n
 WHERE n.client_id = c.id;

DROP TABLE IF EXISTS clients_client_note;
