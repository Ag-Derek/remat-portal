-- Up Migration

-- The seven stage ladder a deal climbs, the POC decision, and the win at Live. #278, Clients SRS
-- CLI 18 to CLI 25, TDD 4.2, TDD 5.
--
-- Stage and outcome are two columns, not one (TDD 1, principle 2). The stage says how far a deal
-- came; the outcome, which #277 added, says whether it is still open or ended won, lost or exited.
-- A deal lost at Negotiation keeps Negotiation as its stage, which is the question everybody asks
-- next.
--
-- The ladder is held here, whoever writes: the stage service, the workbook import, or somebody at
-- a psql prompt (TDD 4.2, "the constraints are the ladder"). The service says no first, in a
-- sentence; these say no when anything gets past it.
--
-- Left for later, with the tables they read: the qualification gate into Negotiation (CLI 22),
-- the pre-POC gate and the POC a deal enters POC with (CLI 23, TDD's opp_poc_stage, which needs
-- poc_id), and the shape of a lost or exited deal (CLI 51, CLI 52, which need reasons, #279).

/* Where a deal stands on the ladder, as a number to compare: Discovery is 1, Live is 7 (CLI 18).
   The list is fixed and is not data. */
CREATE FUNCTION clients_stage_rank(stage TEXT) RETURNS INTEGER
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT array_position(
        ARRAY['DISCOVERY', 'QUALIFICATION', 'PROPOSAL', 'NEGOTIATION',
              'CONTRACT_SIGNED', 'POC', 'LIVE'],
        stage)
$$;

ALTER TABLE clients_opportunity
    /* Every deal starts at Discovery (CLI 12), and every existing one is there: nothing could
       move one before this. */
    ADD COLUMN stage     VARCHAR(16) NOT NULL DEFAULT 'DISCOVERY',
    /* Whether it will have a POC (CLI 19). Null until somebody has said. */
    ADD COLUMN has_poc   BOOLEAN,
    /* The day it ended, won, lost or exited (CLI 25). Null while it is open. */
    ADD COLUMN ended_on  DATE,

    ADD CONSTRAINT clients_opportunity_stage_known
        CHECK (stage IN ('DISCOVERY', 'QUALIFICATION', 'PROPOSAL', 'NEGOTIATION',
                         'CONTRACT_SIGNED', 'POC', 'LIVE')),

    /* TDD's opp_won_is_live. Nothing is won without being Live, and nothing Live is anything but
       won (CLI 25): a signed contract is not a win. */
    ADD CONSTRAINT clients_opportunity_won_is_live
        CHECK ((outcome = 'WON') = (stage = 'LIVE')),

    /* TDD's opp_poc_decided. Nobody reaches Contract signed without saying whether there is a
       POC (CLI 19). */
    ADD CONSTRAINT clients_opportunity_poc_decided
        CHECK (has_poc IS NOT NULL
               OR stage IN ('DISCOVERY', 'QUALIFICATION', 'PROPOSAL', 'NEGOTIATION')),

    /* Half of TDD's opp_poc_stage: only a deal with a POC is ever in one. The POC work adds the
       other half, that it names the POC it is in. */
    ADD CONSTRAINT clients_opportunity_poc_stage_has_poc
        CHECK (stage <> 'POC' OR has_poc),

    /* TDD's opp_ended_shape. An ended deal says when it ended, and an open one has not. */
    ADD CONSTRAINT clients_opportunity_ended_shape
        CHECK ((outcome = 'OPEN') = (ended_on IS NULL));

/* Open deals at each stage, which the pipeline and the dashboard count (CLI 98, CLI 102). */
CREATE INDEX idx_clients_opportunity_stage ON clients_opportunity (stage) WHERE outcome = 'OPEN';

-- ---------------------------------------------------- the moves a CHECK cannot see, TDD 4.2

/* A CHECK sees one row as it is; these rules are about the move from one row to the next, so a
   trigger holds them. Named to fire after clients_opportunity_ended_is_fixed, which refuses any
   change to an ended deal first and says so. */
CREATE FUNCTION clients_opportunity_keeps_to_the_ladder() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    signed CONSTANT INTEGER := clients_stage_rank('CONTRACT_SIGNED');
BEGIN
    /* CLI 12. Every deal starts at Discovery, open. The workbook import too: it opens each deal
       and then moves it, so its history says how it got there. */
    IF TG_OP = 'INSERT' THEN
        IF NEW.stage <> 'DISCOVERY' OR NEW.outcome <> 'OPEN' THEN
            RAISE EXCEPTION 'A new deal starts at Discovery, open, and is moved on from there.'
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'clients_opportunity_starts_at_discovery';
        END IF;

        RETURN NEW;
    END IF;

    /* CLI 19. Once the contract is signed, whether there is a POC is settled. */
    IF NEW.has_poc IS DISTINCT FROM OLD.has_poc
       AND clients_stage_rank(OLD.stage) >= signed THEN
        RAISE EXCEPTION 'The contract is signed, so whether there is a POC is settled.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_opportunity_poc_decision_fixed';
    END IF;

    /* CLI 21. From Contract signed onward a deal never moves back. */
    IF clients_stage_rank(NEW.stage) < clients_stage_rank(OLD.stage)
       AND clients_stage_rank(OLD.stage) >= signed THEN
        RAISE EXCEPTION 'The contract is signed, so the deal does not move back.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_opportunity_no_way_back';
    END IF;

    /* TDD 5, step 5. A deal enters POC from Contract signed and nowhere else. */
    IF NEW.stage = 'POC' AND OLD.stage <> 'POC' AND OLD.stage <> 'CONTRACT_SIGNED' THEN
        RAISE EXCEPTION 'A deal enters its POC once the contract is signed, and not before.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_opportunity_poc_after_signing';
    END IF;

    /* CLI 24. Live comes from Contract signed where there is no POC, or from the POC where there
       is one. A deal with a POC never skips it. */
    IF NEW.stage = 'LIVE' AND OLD.stage <> 'LIVE'
       AND NOT ((OLD.stage = 'CONTRACT_SIGNED' AND OLD.has_poc IS FALSE) OR OLD.stage = 'POC') THEN
        RAISE EXCEPTION 'A deal goes live from Contract signed with no POC, or from its POC.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_opportunity_live_after_signing';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER clients_opportunity_keeps_to_the_ladder
    BEFORE INSERT OR UPDATE ON clients_opportunity
    FOR EACH ROW EXECUTE FUNCTION clients_opportunity_keeps_to_the_ladder();

-- ------------------------------------------------- the product a won deal adds, CLI 04, 25

/* Winning a deal adds its product to what the client uses, naming the deal that won it. Where
   the client had the product once and stopped, winning it again starts it again from that day,
   and the deal that won it back is the one named; the audit log keeps the dates it had before.
   Where they use it already, nothing changes. */
GRANT UPDATE (won_by) ON clients_client_product TO lms_app;

-- ---------------------------------------------------------------------------- privileges

/* Moved by the stage service, which writes the history with every move (TDD 3), and the POC
   decision by the deal's owner or a BD manager. The trigger above and
   clients_opportunity_ended_is_fixed hold every one of these, whoever writes. */
GRANT UPDATE (stage, outcome, has_poc, ended_on) ON clients_opportunity TO lms_app;

-- Down Migration

REVOKE UPDATE (stage, outcome, has_poc, ended_on) ON clients_opportunity FROM lms_app;
REVOKE UPDATE (won_by) ON clients_client_product FROM lms_app;
DROP TRIGGER IF EXISTS clients_opportunity_keeps_to_the_ladder ON clients_opportunity;
DROP FUNCTION IF EXISTS clients_opportunity_keeps_to_the_ladder();
DROP INDEX IF EXISTS idx_clients_opportunity_stage;
ALTER TABLE clients_opportunity
    DROP CONSTRAINT IF EXISTS clients_opportunity_ended_shape,
    DROP CONSTRAINT IF EXISTS clients_opportunity_poc_stage_has_poc,
    DROP CONSTRAINT IF EXISTS clients_opportunity_poc_decided,
    DROP CONSTRAINT IF EXISTS clients_opportunity_won_is_live,
    DROP CONSTRAINT IF EXISTS clients_opportunity_stage_known,
    DROP COLUMN IF EXISTS ended_on,
    DROP COLUMN IF EXISTS has_poc,
    DROP COLUMN IF EXISTS stage;
DROP FUNCTION IF EXISTS clients_stage_rank(TEXT);
