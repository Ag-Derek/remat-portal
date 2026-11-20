-- Up Migration

-- What is being done about a POC's health: the corrective action At Risk asks for, and the reset
-- Stalled asks for. #286, Clients SRS CLI 35, the POC SOPs.
--
-- **An action answers one health** (the user, 20 November 2026). It names the row of the POC's
-- health history it was written against, which must be the POC's health at the time, and At Risk
-- or Stalled. Which it is, a corrective action or a reset, follows from that health. So "an action
-- since it moved into At Risk" is the link, not a comparison of times: moving out and back in asks
-- for a new one.
--
-- Setting the health asks for one but lets it be skipped; it is added later on the POC's page. If
-- none answers At Risk 48 hours after the move, the POC is flagged; if none answers Stalled seven
-- days after, it is flagged for an exit decision. The flags are worked out on read, never stored,
-- and never change the health.
--
-- Written once, never changed or deleted: what was said would be done is kept, as the health is.

/* For the foreign key below, which keeps an action on its own POC's health. */
ALTER TABLE clients_poc_health ADD CONSTRAINT uq_clients_poc_health_of_poc UNIQUE (id, poc_id);

CREATE TABLE clients_poc_action (
    id          BIGSERIAL PRIMARY KEY,
    poc_id      BIGINT NOT NULL REFERENCES clients_poc(id),
    /* The At Risk or Stalled row of its health history it answers. */
    health_id   BIGINT NOT NULL,

    /* What is being done, in the writer's words. */
    body        VARCHAR(2000) NOT NULL,

    logged_by   BIGINT NOT NULL REFERENCES employee(id),
    logged_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT clients_poc_action_health_is_the_pocs
        FOREIGN KEY (health_id, poc_id) REFERENCES clients_poc_health (id, poc_id),
    CONSTRAINT clients_poc_action_says_something CHECK (btrim(body) <> '')
);

/* The actions answering a health, which a POC's list row and page ask for. */
CREATE INDEX idx_clients_poc_action_health ON clients_poc_action (health_id);
/* A POC's actions, which its page asks for. */
CREATE INDEX idx_clients_poc_action_poc ON clients_poc_action (poc_id, logged_at);

/* What a foreign key cannot see: the health it answers is the POC's now, and asks for something.
   The POC is locked first, as setting its health locks it, so an action never answers a health
   being replaced at the same moment. */
CREATE FUNCTION clients_poc_action_answers_the_current_health() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    current_row clients_poc_health%ROWTYPE;
BEGIN
    PERFORM 1 FROM clients_poc WHERE id = NEW.poc_id FOR UPDATE;

    SELECT * INTO current_row
      FROM clients_poc_health
     WHERE poc_id = NEW.poc_id
     ORDER BY set_at DESC, id DESC
     LIMIT 1;

    IF current_row.id IS DISTINCT FROM NEW.health_id
       OR current_row.health NOT IN ('AT_RISK', 'STALLED') THEN
        RAISE EXCEPTION 'An action answers the POC''s health now, and only At Risk or Stalled '
                        'asks for one.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_poc_action_answers_the_current_health';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER clients_poc_action_answers_the_current_health
    BEFORE INSERT ON clients_poc_action
    FOR EACH ROW EXECUTE FUNCTION clients_poc_action_answers_the_current_health();

-- --------------------------------------------------------- append only, NFR CLI REC 01

CREATE TRIGGER clients_poc_action_is_never_changed
    BEFORE UPDATE ON clients_poc_action
    FOR EACH ROW
    EXECUTE FUNCTION refuse_update(
        'An action is kept as it was written. Write another instead, which adds a row.'
    );

CREATE TRIGGER clients_poc_action_is_never_deleted
    BEFORE DELETE ON clients_poc_action
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'An action is kept for good, so that what was done about a POC can always be told.'
    );

/* No audit trigger: this table is its own record (NFR CLI AUD 02), as the health is. */

-- ---------------------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT, and USAGE on the sequence: written once,
   read, and nothing else. */

-- Down Migration

DROP TABLE IF EXISTS clients_poc_action;
DROP FUNCTION IF EXISTS clients_poc_action_answers_the_current_health();
ALTER TABLE clients_poc_health DROP CONSTRAINT IF EXISTS uq_clients_poc_health_of_poc;
