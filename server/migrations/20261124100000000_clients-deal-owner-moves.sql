-- Up Migration

-- A BD manager moves clients, open deals and running POCs to somebody else. #289, Clients SRS
-- CLI 92, CLI 96, TDD 11 (POST /opportunities/{id}/owner).
--
-- A deal's owner may now change. The deal is audited (clients_opportunity_is_audited), so every
-- move is in the audit log by trigger, with who made it (NFR CLI AUD 01). An ended deal is history
-- and keeps its owner: clients_opportunity_ended_is_fixed refuses any change to one.

GRANT UPDATE (owner_id) ON clients_opportunity TO lms_app;

-- Open next steps follow what they are on to its new owner (the user, 24 November 2026). Until
-- now only an open review step could change hands, following its POC to a new CS lead (#285).
-- Now also an open step on a deal, following the deal to its new owner, and an open step on the
-- client alone, on no deal or POC, following the client to its new owner. Each only to whoever
-- now holds what it is on, so a step is never handed to somebody at random, and a closed step
-- stays whose it was.
CREATE OR REPLACE FUNCTION clients_next_step_owner_moves_with_its_poc() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    follows BIGINT;
BEGIN
    IF NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id THEN
        RETURN NEW;
    END IF;

    IF OLD.done_at IS NULL THEN
        IF OLD.source = 'REVIEW' THEN
            SELECT cs_lead_id INTO follows FROM clients_poc WHERE id = OLD.poc_id;
        ELSIF OLD.opportunity_id IS NOT NULL THEN
            SELECT owner_id INTO follows FROM clients_opportunity WHERE id = OLD.opportunity_id;
        ELSIF OLD.poc_id IS NULL THEN
            SELECT owner_id INTO follows FROM clients_client WHERE id = OLD.client_id;
        END IF;
    END IF;

    IF follows IS NULL OR NEW.owner_id <> follows THEN
        RAISE EXCEPTION 'A next step stays its owner''s, but for an open one following what it is '
                        'on to its new owner or CS lead.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_next_step_owner_moves_with_its_poc';
    END IF;

    RETURN NEW;
END
$$;

-- Down Migration

CREATE OR REPLACE FUNCTION clients_next_step_owner_moves_with_its_poc() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
       AND (OLD.source <> 'REVIEW' OR OLD.done_at IS NOT NULL
            OR NEW.owner_id <> (SELECT cs_lead_id FROM clients_poc WHERE id = OLD.poc_id)) THEN
        RAISE EXCEPTION 'A next step stays its owner''s, but for an open review step following '
                        'its POC to a new CS lead.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_next_step_owner_moves_with_its_poc';
    END IF;

    RETURN NEW;
END
$$;

REVOKE UPDATE (owner_id) ON clients_opportunity FROM lms_app;
