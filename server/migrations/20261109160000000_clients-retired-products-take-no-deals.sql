-- Up Migration

-- A retired product takes no new deals, and keeps everything already recorded against it.
-- #293, Clients SRS CLI 08.
--
-- Keeping what is recorded is already so: nothing in clients is deleted, retiring is a date, and
-- lms_app holds no DELETE on a product or a line. This is the other half, written before there
-- are deals to refuse, so that the table that holds them cannot be built without it: the
-- opportunities migration attaches it with
--
--     CREATE TRIGGER clients_opportunity_product_takes_new_deals
--         BEFORE INSERT OR UPDATE OF product_id ON clients_opportunity
--         FOR EACH ROW EXECUTE FUNCTION clients_product_takes_new_deals();
--
-- A deal already open on a product carries on when the product is retired; only a new one, or
-- one moved onto it, is refused. A product in a retired line is retired with it, but the line is
-- asked as well, so that a product restored by hand into a retired line still takes nothing.

CREATE FUNCTION clients_product_takes_new_deals() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    product_name TEXT;
BEGIN
    SELECT p.name INTO product_name
      FROM clients_product p
      JOIN clients_product_line l ON l.id = p.line_id
     WHERE p.id = NEW.product_id
       AND (p.retired_on IS NOT NULL OR l.retired_on IS NOT NULL);

    IF product_name IS NOT NULL THEN
        RAISE EXCEPTION '% is retired, so it takes no new deals.', product_name
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'clients_product_takes_new_deals';
    END IF;

    RETURN NEW;
END
$$;

-- Down Migration

DROP FUNCTION IF EXISTS clients_product_takes_new_deals();
