-- Up Migration

-- What clients sells: product lines, and the products in them. #293, Clients TDD 4.1,
-- SRS CLI 07 and CLI 08.
--
-- Lines are a table because Dura Capital forced them: it is three products, and the pipeline
-- still has to answer "how is Dura Capital doing" as one question. A line with a single
-- product costs one row and makes every filter the same shape (CLI 09).
--
-- Kept by a BD manager through the setup screen. Nothing is deleted: a product or a line is
-- retired, and everything recorded against it stays (CLI 08). The current lines are seeded by
-- the next migration.

CREATE TABLE clients_product_line (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(80) NOT NULL,
    retired_on  DATE,

    /* Beyond TDD 4.1. A line is named. */
    CONSTRAINT clients_line_named CHECK (btrim(name) <> '')
);

/* Beyond TDD 4.1, which has a plain UNIQUE: unique ignoring case and surrounding spaces, as
   client names are (CLI 02), so that "Cloud9" and "cloud9 " are one line and not two. */
CREATE UNIQUE INDEX uq_clients_line_name ON clients_product_line (lower(btrim(name)));

CREATE TABLE clients_product (
    id          BIGSERIAL PRIMARY KEY,
    /* Exactly one line (CLI 07), and never moved to another: see the privileges below. */
    line_id     BIGINT NOT NULL REFERENCES clients_product_line(id),
    name        VARCHAR(80) NOT NULL,
    retired_on  DATE,

    CONSTRAINT clients_product_named CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX uq_clients_product_name ON clients_product (lower(btrim(name)));

CREATE INDEX idx_clients_product_line ON clients_product (line_id);

-- ------------------------------------------------------------------- audit, NFR CLI AUD 01

/* Creating, renaming and retiring either is written to audit_log by the database, not by the
   application, with whoever `recording()` named as the writer. */

CREATE TRIGGER clients_product_line_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON clients_product_line
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

CREATE TRIGGER clients_product_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON clients_product
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

-- ---------------------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT on both, and USAGE on their sequences.
   Renamed and retired, and nothing else: a product's line is fixed once it is created, because
   moving it would rewrite every figure ever reported for the line it left. Nothing is deleted. */
GRANT UPDATE (name, retired_on) ON clients_product_line TO lms_app;
GRANT UPDATE (name, retired_on) ON clients_product TO lms_app;

-- Down Migration

DROP TABLE IF EXISTS clients_product;
DROP TABLE IF EXISTS clients_product_line;
