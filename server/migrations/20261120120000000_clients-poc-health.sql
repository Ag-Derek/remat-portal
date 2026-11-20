-- Up Migration

-- A POC's health: On Track, At Risk or Stalled, set by its CS lead or a BD manager, with every
-- change kept. #286, Clients SRS CLI 35, TDD 4.3.
--
-- **Every POC has a health from its start** (the user, 20 November 2026): signing the contract
-- writes its first row, On Track, by whoever signed it, in the same transaction that makes it.
-- `clients_poc_has_a_health` holds that at the commit.
--
-- **The history is the health.** A POC's health is its latest row; nothing on clients_poc holds
-- it. Each row is a change: setting the health it already has is refused
-- (`clients_poc_health_changes`), so the history never says "At Risk" twice running and the
-- 48-hour and seven-day clocks (#286) run from the move into it. A note is optional on every row.
--
-- The flags (#286) never change it: they are worked out on read from this history, the usage
-- figures and the clock, and nothing writes here but somebody choosing a health.

CREATE TABLE clients_poc_health (
    id          BIGSERIAL PRIMARY KEY,
    poc_id      BIGINT NOT NULL REFERENCES clients_poc(id),

    health      VARCHAR(8) NOT NULL,
    /* Why, in the setter's words. */
    note        VARCHAR(2000),

    set_by      BIGINT NOT NULL REFERENCES employee(id),
    set_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT clients_poc_health_known CHECK (health IN ('ON_TRACK', 'AT_RISK', 'STALLED')),
    /* Left out is null, never an empty string. */
    CONSTRAINT clients_poc_health_note_not_blank CHECK (note IS NULL OR btrim(note) <> '')
);

/* A POC's history, oldest first, and its latest row, which its list and page ask for. */
CREATE INDEX idx_clients_poc_health_poc ON clients_poc_health (poc_id, set_at, id);

/* What a CHECK cannot see: a POC starts On Track, and every row after changes it. The POC is
   locked first, so two people setting it at once are judged one after the other. */
CREATE FUNCTION clients_poc_health_changes() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    current_health VARCHAR(8);
BEGIN
    PERFORM 1 FROM clients_poc WHERE id = NEW.poc_id FOR UPDATE;

    SELECT health INTO current_health
      FROM clients_poc_health
     WHERE poc_id = NEW.poc_id
     ORDER BY set_at DESC, id DESC
     LIMIT 1;

    IF current_health IS NULL AND NEW.health <> 'ON_TRACK' THEN
        RAISE EXCEPTION 'A POC starts On Track.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_poc_health_starts_on_track';
    END IF;

    IF current_health = NEW.health THEN
        RAISE EXCEPTION 'The POC''s health is that already.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_poc_health_changes';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER clients_poc_health_changes
    BEFORE INSERT ON clients_poc_health
    FOR EACH ROW EXECUTE FUNCTION clients_poc_health_changes();

/* Every POC has a health, from the transaction that makes it. Deferred to the commit, because the
   POC is made before its first row can name it. */
CREATE FUNCTION clients_poc_has_a_health() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM clients_poc_health WHERE poc_id = NEW.id) THEN
        RAISE EXCEPTION 'A POC starts with a health, On Track.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_poc_has_a_health';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER clients_poc_has_a_health
    AFTER INSERT ON clients_poc
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION clients_poc_has_a_health();

-- --------------------------------------------------------- append only, NFR CLI REC 01

/* A past health is what somebody judged on that day. Changing one rewrites when the POC was at
   risk, and the flags and reports read from it. */
CREATE TRIGGER clients_poc_health_is_never_changed
    BEFORE UPDATE ON clients_poc_health
    FOR EACH ROW
    EXECUTE FUNCTION refuse_update(
        'A past health is what was judged then. Set the health again instead, which adds a row.'
    );

CREATE TRIGGER clients_poc_health_is_never_deleted
    BEFORE DELETE ON clients_poc_health
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'A past health is kept for good, so that when a POC was at risk can always be told.'
    );

/* No audit trigger: this table is its own record (NFR CLI AUD 02), as the stage history is.
   AUDITED_ENTITIES does not name it. */

-- ---------------------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT, and USAGE on the sequence: written once,
   read, and nothing else. */

-- --------------------------------------------------- POCs started before this table existed

/* Each starts its history On Track, put down to whoever signed its contract, when they did. */
INSERT INTO clients_poc_health (poc_id, health, set_by, set_at)
SELECT id, 'ON_TRACK', created_by, created_at
  FROM clients_poc;

-- Down Migration

DROP TRIGGER IF EXISTS clients_poc_has_a_health ON clients_poc;
DROP FUNCTION IF EXISTS clients_poc_has_a_health();
DROP TABLE IF EXISTS clients_poc_health;
DROP FUNCTION IF EXISTS clients_poc_health_changes();
