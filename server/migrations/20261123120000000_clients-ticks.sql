-- Up Migration

-- Ticking and unticking a deal's or a POC's checks, with who and when, every one kept. #284,
-- Clients SRS CLI 41, TDD 4.4.
--
-- **The history is the state.** A check is ticked if its latest row says so, and unticked if it
-- has none or its latest says not; nothing on clients_check holds it. Each row is a change: a
-- tick on a ticked check, or an untick on one that isn't, is refused (`clients_tick_changes`), so
-- the history says only what moved (the user, 23 November 2026). No note: TDD 4.4 has none.
--
-- Only while the deal or POC is open (the user, 23 November 2026): once ended, nothing is judged
-- by its checks any more, and they are kept as they ended. A criterion can be unticked after its
-- gate was passed; that is recorded, and the deal stays where it is.

CREATE TABLE clients_tick (
    id          BIGSERIAL PRIMARY KEY,
    check_id    BIGINT NOT NULL REFERENCES clients_check(id),
    ticked      BOOLEAN NOT NULL,
    ticked_by   BIGINT NOT NULL REFERENCES employee(id),
    ticked_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* A check's history, and its latest row, which is its state. */
CREATE INDEX idx_clients_tick_check ON clients_tick (check_id, ticked_at, id);

/* What a CHECK cannot see: every row changes the check, and its deal or POC is still open. The
   check is locked first, so two people ticking it at once are judged one after the other.
   SECURITY DEFINER for that lock alone, since lms_app may only read clients_check. */
CREATE FUNCTION clients_tick_changes() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
AS $$
DECLARE
    on_deal BIGINT;
    on_poc BIGINT;
    now_ticked BOOLEAN;
BEGIN
    SELECT opportunity_id, poc_id INTO on_deal, on_poc
      FROM clients_check WHERE id = NEW.check_id FOR UPDATE;

    IF EXISTS (
        SELECT 1 FROM clients_opportunity o
         WHERE (o.id = on_deal OR o.poc_id = on_poc) AND o.outcome <> 'OPEN'
    ) THEN
        RAISE EXCEPTION 'Its deal or POC has ended, so its checks are kept as they ended.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_tick_while_open';
    END IF;

    SELECT ticked INTO now_ticked
      FROM clients_tick
     WHERE check_id = NEW.check_id
     ORDER BY ticked_at DESC, id DESC
     LIMIT 1;

    IF coalesce(now_ticked, false) = NEW.ticked THEN
        RAISE EXCEPTION 'The check is that already.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_tick_changes';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER clients_tick_changes
    BEFORE INSERT ON clients_tick
    FOR EACH ROW EXECUTE FUNCTION clients_tick_changes();

-- --------------------------------------------------------- append only, NFR CLI REC 01

/* Who ticked what, and when, is what a gate was passed on. */
CREATE TRIGGER clients_tick_is_never_changed
    BEFORE UPDATE ON clients_tick
    FOR EACH ROW
    EXECUTE FUNCTION refuse_update(
        'A tick is what somebody said then. Tick or untick it again instead, which adds a row.'
    );

CREATE TRIGGER clients_tick_is_never_deleted
    BEFORE DELETE ON clients_tick
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'A tick is kept for good, so that what a gate was passed on can always be told.'
    );

/* No audit trigger: this table is its own record (NFR CLI AUD 02), as a POC's health is.
   AUDITED_ENTITIES does not name it. */

-- ---------------------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT, and USAGE on the sequence: written once,
   read, and nothing else. */

-- Down Migration

DROP TABLE IF EXISTS clients_tick;
DROP FUNCTION IF EXISTS clients_tick_changes();
