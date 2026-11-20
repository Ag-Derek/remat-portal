-- Up Migration

-- The POC: up to ten weeks, free, under the signed contract, for one client and one product line.
-- #285, Clients SRS CLI 27 to CLI 31, TDD 4.3, TDD 5.
--
-- **Signing the contract starts the POC.** The user, 19 November 2026, over SRS CLI 28 and CLI
-- 31 and TDD 5, which put a Pre-POC wait between the two while the gates are ticked. So a deal
-- with a POC that is moved to Contract signed is moved on into its POC in the same transaction:
-- the POC is made, started that day, its decision date set ten weeks later (CLI 31), and the
-- deal's history says it went through Contract signed on the way (CLI 26). No deal with a POC is
-- ever left at Contract signed, which `clients_opportunity_signing_starts_its_poc` holds at
-- commit.
--
-- Its CS lead is the owner of the deal that started it (the user, #279 and 19 November 2026),
-- even where that owner holds no clients role any more: the POC is then flagged as needing
-- reassignment (CLI 96) rather than refused.
--
-- Left for the issues they belong to: the usage targets (#286), the extension and the end
-- (#287), which relax `clients_poc_ten_weeks` and add `ended_on`; moving the CS lead (#285,
-- item 3); review meetings as next steps (#285, item 6).

CREATE TABLE clients_poc (
    id              BIGSERIAL PRIMARY KEY,
    client_id       BIGINT NOT NULL REFERENCES clients_client(id),
    /* Every deal it covers is for a product in this line (CLI 27, TDD 4.3). */
    line_id         BIGINT NOT NULL REFERENCES clients_product_line(id),
    /* The client's type as it was when the POC was made, which its checklist is chosen by.
       Changing the client's type later does not change it (CLI 30). */
    client_type_id  BIGINT NOT NULL REFERENCES clients_client_type(id),
    /* Who runs it (CLI 29). The owner of the deal that started it, to begin with. */
    cs_lead_id      BIGINT NOT NULL REFERENCES employee(id),

    /* The day the contract was signed, which started it. */
    started_on      DATE NOT NULL,
    /* Ten weeks after the start (CLI 31). */
    decision_on     DATE NOT NULL,

    created_by      BIGINT NOT NULL REFERENCES employee(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    /* CLI 31: the decision falls ten weeks, seventy days, after the start. The extension (#287)
       will allow up to thirty days more, once. */
    CONSTRAINT clients_poc_ten_weeks CHECK (decision_on = started_on + 70)
);

/* A client's POCs, which its page and the POC list ask for. */
CREATE INDEX idx_clients_poc_client ON clients_poc (client_id);
/* Somebody's POCs, which My pipeline asks for (CLI 97). */
CREATE INDEX idx_clients_poc_cs_lead ON clients_poc (cs_lead_id);

-- ------------------------------------------------------------- the deals a POC covers

/* A POC covers its deals through the deal, not a join table, because a deal is in at most one
   POC (CLI 27, TDD 4.3). */
ALTER TABLE clients_opportunity
    ADD COLUMN poc_id BIGINT REFERENCES clients_poc(id),

    /* The other half of TDD's opp_poc_stage: a deal in its POC names it. */
    ADD CONSTRAINT clients_opportunity_poc_stage_names_its_poc
        CHECK (stage <> 'POC' OR poc_id IS NOT NULL),
    /* Only a deal with a POC is in one (CLI 27). */
    ADD CONSTRAINT clients_opportunity_in_a_poc_has_one
        CHECK (poc_id IS NULL OR has_poc),
    /* A POC starts at signing, so no deal is in one before that. Live keeps the POC that
       converted it, as an exit keeps the one it was exited from. */
    ADD CONSTRAINT clients_opportunity_in_a_poc_once_signed
        CHECK (poc_id IS NULL OR stage IN ('CONTRACT_SIGNED', 'POC', 'LIVE'));

CREATE INDEX idx_clients_opportunity_poc ON clients_opportunity (poc_id) WHERE poc_id IS NOT NULL;

/* What a CHECK cannot see: the POC a deal names is for the deal's client and its product's line
   (CLI 27, TDD 4.3), and a deal stays in the POC it was put in. */
CREATE FUNCTION clients_opportunity_in_its_own_poc() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    poc clients_poc%ROWTYPE;
    deal_line BIGINT;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.poc_id IS NOT NULL
       AND NEW.poc_id IS DISTINCT FROM OLD.poc_id THEN
        RAISE EXCEPTION 'A deal stays in the POC it was put in.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_opportunity_poc_kept';
    END IF;

    IF NEW.poc_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.poc_id = OLD.poc_id) THEN
        RETURN NEW;
    END IF;

    SELECT * INTO poc FROM clients_poc WHERE id = NEW.poc_id;
    SELECT line_id INTO deal_line FROM clients_product WHERE id = NEW.product_id;

    IF poc.client_id <> NEW.client_id OR poc.line_id <> deal_line THEN
        RAISE EXCEPTION 'A deal is only in a POC for its own client and product line.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_opportunity_poc_same_client_and_line';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER clients_opportunity_in_its_own_poc
    BEFORE INSERT OR UPDATE OF poc_id ON clients_opportunity
    FOR EACH ROW EXECUTE FUNCTION clients_opportunity_in_its_own_poc();

/* Signing starts the POC: a deal with a POC is never left at Contract signed (the user, 19
   November 2026), open or ended there, so none is lost between its signing and its POC. Deferred
   to the commit, because the stage service moves it there and on into its POC in two steps, so
   that its history says it went through Contract signed (CLI 26), and only the state that will be
   stored is judged. The row is read again rather than trusted from NEW, which is how it stood
   after the statement that queued this, not at the end. */
CREATE FUNCTION clients_opportunity_signing_starts_its_poc() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM clients_opportunity
         WHERE id = NEW.id AND stage = 'CONTRACT_SIGNED' AND has_poc
    ) THEN
        RAISE EXCEPTION 'A deal with a POC goes into its POC when its contract is signed.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_opportunity_signing_starts_its_poc';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER clients_opportunity_signing_starts_its_poc
    AFTER INSERT OR UPDATE OF stage, has_poc ON clients_opportunity
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (NEW.stage = 'CONTRACT_SIGNED')
    EXECUTE FUNCTION clients_opportunity_signing_starts_its_poc();

-- ------------------------------------------------------------------- audit, NFR CLI AUD 01

/* Who made it and when, and every change of CS lead once it can be moved (TDD 13). */
CREATE TRIGGER clients_poc_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON clients_poc
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

-- ---------------------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT on clients_poc, and USAGE on its sequence.
   Nothing on it is updated until the CS lead can be moved, and nothing is deleted. A deal is put
   in its POC by the stage service, once. */
GRANT UPDATE (poc_id) ON clients_opportunity TO lms_app;

-- Down Migration

REVOKE UPDATE (poc_id) ON clients_opportunity FROM lms_app;
DROP TRIGGER IF EXISTS clients_poc_is_audited ON clients_poc;
DROP TRIGGER IF EXISTS clients_opportunity_signing_starts_its_poc ON clients_opportunity;
DROP FUNCTION IF EXISTS clients_opportunity_signing_starts_its_poc();
DROP TRIGGER IF EXISTS clients_opportunity_in_its_own_poc ON clients_opportunity;
DROP FUNCTION IF EXISTS clients_opportunity_in_its_own_poc();
DROP INDEX IF EXISTS idx_clients_opportunity_poc;
ALTER TABLE clients_opportunity
    DROP CONSTRAINT IF EXISTS clients_opportunity_in_a_poc_once_signed,
    DROP CONSTRAINT IF EXISTS clients_opportunity_in_a_poc_has_one,
    DROP CONSTRAINT IF EXISTS clients_opportunity_poc_stage_names_its_poc,
    DROP COLUMN IF EXISTS poc_id;
DROP TABLE IF EXISTS clients_poc;
