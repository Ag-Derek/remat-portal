-- Up Migration

-- The products a client already uses, each with the date it started. #276, Clients SRS CLI 04,
-- TDD 4.1.
--
-- Added by hand for a client that was using a product before this system existed, by anybody
-- with a clients role. Once opportunities are built, winning one adds its product here too, and
-- `won_by` names the opportunity that did.

CREATE TABLE clients_client_product (
    /* Beyond TDD 4.1, whose key is (client_id, product_id): the audit trigger names one row by
       one column. The pair is still held to one row below. */
    id          BIGSERIAL PRIMARY KEY,
    client_id   BIGINT NOT NULL REFERENCES clients_client(id),
    product_id  BIGINT NOT NULL REFERENCES clients_product(id),
    /* The day the client started using it. */
    since_on    DATE NOT NULL,
    /* Beyond TDD 4.1. The day they stopped, or null while they use it. A client that stops is
       marked, not deleted, so the client page still says what they once had. */
    ended_on    DATE,
    /* The opportunity that won it, where one did (CLI 25). Its foreign key is added by the
       opportunities migration, as TDD 4.1 says. Null for one added by hand. */
    won_by      BIGINT,

    CONSTRAINT clients_client_product_ends_after_it_starts CHECK (ended_on >= since_on)
);

/* Each product once per client (TDD 4.1's primary key). A client that stops and starts again is
   the same row, its end date taken away. */
CREATE UNIQUE INDEX uq_clients_client_product
    ON clients_client_product (client_id, product_id);

-- ------------------------------------------------------------------- audit, NFR CLI AUD 01

CREATE TRIGGER clients_client_product_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON clients_client_product
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

-- ---------------------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT, and USAGE on the sequence. The dates are
   corrected; which client and which product it is never changes, and nothing is deleted.
   `won_by` is set once, when it is inserted. */
GRANT UPDATE (since_on, ended_on) ON clients_client_product TO lms_app;

-- Down Migration

DROP TABLE IF EXISTS clients_client_product;
