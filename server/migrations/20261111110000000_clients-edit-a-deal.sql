-- Up Migration

-- Editing a deal: its value, probability, expected close, what it is waiting on and the client's
-- stated interest. #277, Clients SRS CLI 13, TDD 11 (`PATCH /api/clients/opportunities/{id}`).
--
-- Whose it is to edit, its owner's or a BD manager's, is clientsPolicy.changeDeal's. What may
-- change at all is held here, for whoever writes.

/* The figures and words about a deal, and nothing else. Which client and product a deal is for
   never changes: a deal for the wrong product is ended and another opened. Its owner is moved by
   a BD manager, and its outcome by the stage service, each granted with the means to do it. */
GRANT UPDATE (value_minor, currency, probability, close_half, close_year,
              waiting_on, waiting_note, stated_interest)
    ON clients_opportunity TO lms_app;

-- --------------------------------------------------------- an ended deal is fixed, CLI 55, 56

/* A deal that is won, lost or exited stays on the client's history as it ended (CLI 55), and is
   never reopened (CLI 56): re-engaging the client starts a new one. So once its outcome is not
   OPEN nothing about it changes, whoever writes, the stage service and the import included. The
   move that ends it is allowed, because the row it starts from is open. */
CREATE FUNCTION clients_opportunity_ended_is_fixed() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.outcome <> 'OPEN' THEN
        RAISE EXCEPTION 'This deal has ended, so it is kept as it ended and is not changed.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_opportunity_ended_is_fixed';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER clients_opportunity_ended_is_fixed
    BEFORE UPDATE ON clients_opportunity
    FOR EACH ROW EXECUTE FUNCTION clients_opportunity_ended_is_fixed();

-- Down Migration

DROP TRIGGER IF EXISTS clients_opportunity_ended_is_fixed ON clients_opportunity;
DROP FUNCTION IF EXISTS clients_opportunity_ended_is_fixed();
REVOKE UPDATE (value_minor, currency, probability, close_half, close_year,
               waiting_on, waiting_note, stated_interest)
    ON clients_opportunity FROM lms_app;
