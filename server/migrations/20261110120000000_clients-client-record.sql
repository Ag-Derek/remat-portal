-- Up Migration

-- A client: one record per bank, broker or lender the department sells to. #276, Clients SRS
-- CLI 05.
--
-- The client is the record; the deals on it, its contacts and the products it already uses each
-- hang off it. Nothing is deleted: a client stays, with everything recorded against it.

-- ------------------------------------------------------------------------- client types

/* What kind of institution a client is. A table rather than a fixed list, so that a kind the
   department starts selling to is added without a migration (#276). Seeded below with the five
   it sells to today. Like a product line, renamed and retired, never deleted: a client of a
   retired type keeps it. */
CREATE TABLE clients_client_type (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(60) NOT NULL,
    retired_on  DATE,

    CONSTRAINT clients_client_type_named CHECK (btrim(name) <> '')
);

/* Each named once, ignoring case and surrounding spaces, as lines and products are. */
CREATE UNIQUE INDEX uq_clients_client_type_name ON clients_client_type (lower(btrim(name)));

-- ------------------------------------------------------------------------------ clients

CREATE TABLE clients_client (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(120) NOT NULL,
    type_id     BIGINT NOT NULL REFERENCES clients_client_type(id),
    /* Who looks after it: whoever created it, until it is moved to somebody else. */
    owner_id    BIGINT NOT NULL REFERENCES employee(id),
    note        VARCHAR(2000),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT clients_client_named CHECK (btrim(name) <> ''),

    /* A note left empty is no note, so that the screen shows it as missing rather than as a
       blank it cannot tell from one. */
    CONSTRAINT clients_client_note_not_blank CHECK (note IS NULL OR btrim(note) <> '')
);

/* Somebody's clients, which My pipeline asks for. */
CREATE INDEX idx_clients_client_owner ON clients_client (owner_id);
CREATE INDEX idx_clients_client_type ON clients_client (type_id);

-- ------------------------------------------------------------------- audit, NFR CLI AUD 01

CREATE TRIGGER clients_client_type_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON clients_client_type
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

CREATE TRIGGER clients_client_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON clients_client
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

-- ---------------------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT, and USAGE on the sequences. A type is
   renamed and retired. A client changes everything a person may change, and keeps when it was
   created. Nothing is deleted. */
GRANT UPDATE (name, retired_on) ON clients_client_type TO lms_app;
GRANT UPDATE (name, type_id, owner_id, note) ON clients_client TO lms_app;

-- ------------------------------------------------------------------- the types sold to today

/* Named in the audit log as this migration, rather than "not named by the writer". */
SELECT set_config('lms.audit.actor', 'migration: the current client types (#276)', true);

INSERT INTO clients_client_type (name)
VALUES ('Bank'), ('Broker'), ('Microfinance institution'), ('Digital lender'), ('DFI');

-- Down Migration

DROP TABLE IF EXISTS clients_client;
DROP TABLE IF EXISTS clients_client_type;
