-- Up Migration

-- A deal's and a POC's own copy of their checklist, taken when it comes to apply. #284, Clients
-- SRS CLI 40, TDD 4.4.
--
-- What a deal or POC is judged by is the copy, not the template, so a BD manager editing the
-- checklist later changes nothing already copied (CLI 40): a label reworded, an item added or
-- retired, all reach only deals and POCs copied after.
--
-- When (the user, 23 November 2026):
--   * A deal is given its qualification criteria and its pre-POC gates the first time it leaves
--     Discovery, for whichever stage it goes to: skipping Qualification is allowed. Both groups
--     go on the deal, because signing starts the POC (#285), so the gates have to be met before
--     the deal is signed rather than before a POC that no longer waits. A deal without a POC is
--     simply not asked for its pre-POC gates (item 7). Taken from the deal's product line and its
--     client's type as they are then.
--   * A POC is given its Foundation, Deepening and Converting checks as it is made, at signing,
--     from the line and client type it was made for.
-- A line and type with no items give a deal or POC no checks, and it stays that way: a checklist
-- added to the line later reaches only deals and POCs copied after (CLI 43).
--
-- Copied by the database, whoever moves the deal or makes the POC, and only by it: lms_app may
-- read the copies and nothing else, as it may only read leave_balance. Ticking them is #284 item
-- 5, and judging the gates by them items 6 and 7.

CREATE TABLE clients_check (
    id              BIGSERIAL PRIMARY KEY,
    /* Whose it is: a deal's criteria and gates, or a POC's phase checks. */
    opportunity_id  BIGINT REFERENCES clients_opportunity(id),
    poc_id          BIGINT REFERENCES clients_poc(id),
    /* The template item it was copied from, which may since have been retired or changed. */
    source_item_id  BIGINT NOT NULL REFERENCES clients_checklist_item(id),
    /* The item as it stood when copied. */
    grp             VARCHAR(14) NOT NULL,
    label           VARCHAR(200) NOT NULL,
    poc_only        BOOLEAN NOT NULL,
    sort            SMALLINT NOT NULL,
    copied_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT clients_check_one_owner CHECK (num_nonnulls(opportunity_id, poc_id) = 1),
    CONSTRAINT clients_check_group_known
        CHECK (grp IN ('QUALIFICATION', 'PRE_POC', 'FOUNDATION', 'DEEPENING', 'CONVERTING')),
    /* Beyond TDD 4.4's check_grp, which had only the criteria on the deal: the pre-POC gates are
       there too, since signing starts the POC. */
    CONSTRAINT clients_check_group_fits_owner
        CHECK ((grp IN ('QUALIFICATION', 'PRE_POC')) = (opportunity_id IS NOT NULL)),
    CONSTRAINT clients_check_poc_only_qualifies CHECK (NOT poc_only OR grp = 'QUALIFICATION')
);

/* Each item copied once onto a deal or POC; these are also how either's checks are read. */
CREATE UNIQUE INDEX uq_clients_check_deal_item
    ON clients_check (opportunity_id, source_item_id) WHERE opportunity_id IS NOT NULL;
CREATE UNIQUE INDEX uq_clients_check_poc_item
    ON clients_check (poc_id, source_item_id) WHERE poc_id IS NOT NULL;

/* When a deal was given its checks, which is also how it is known to have had them: a deal on a
   line with no checklist was given none, and isn't given a later one. Null until it first leaves
   Discovery. */
ALTER TABLE clients_opportunity ADD COLUMN checklist_copied_at TIMESTAMPTZ;

-- ------------------------------------------------------------------------------- copying

/* The deal's criteria and gates, the first time it leaves Discovery. SECURITY DEFINER because
   lms_app writes nothing to clients_check and must not, and the stage service's move has to be
   able to set this off. A deal is made with no copy, whatever its insert said. */
CREATE FUNCTION clients_opportunity_copies_its_checklist() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.checklist_copied_at := NULL;
        RETURN NEW;
    END IF;

    IF OLD.stage <> 'DISCOVERY' OR NEW.stage = 'DISCOVERY' OR OLD.checklist_copied_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO clients_check (opportunity_id, source_item_id, grp, label, poc_only, sort)
    SELECT NEW.id, i.id, i.grp, i.label, i.poc_only, i.sort
      FROM clients_product p
      JOIN clients_client c ON c.id = NEW.client_id
      JOIN clients_checklist_item i
        ON i.line_id = p.line_id AND i.client_type_id = c.type_id
     WHERE p.id = NEW.product_id
       AND i.grp IN ('QUALIFICATION', 'PRE_POC')
       AND i.retired_on IS NULL;

    NEW.checklist_copied_at := now();
    RETURN NEW;
END
$$;

CREATE TRIGGER clients_opportunity_copies_its_checklist
    BEFORE INSERT OR UPDATE OF stage ON clients_opportunity
    FOR EACH ROW EXECUTE FUNCTION clients_opportunity_copies_its_checklist();

/* The POC's phase checks, as it is made. SECURITY DEFINER for the same reason. */
CREATE FUNCTION clients_poc_copies_its_checklist() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO clients_check (poc_id, source_item_id, grp, label, poc_only, sort)
    SELECT NEW.id, i.id, i.grp, i.label, i.poc_only, i.sort
      FROM clients_checklist_item i
     WHERE i.line_id = NEW.line_id
       AND i.client_type_id = NEW.client_type_id
       AND i.grp IN ('FOUNDATION', 'DEEPENING', 'CONVERTING')
       AND i.retired_on IS NULL;

    RETURN NULL;
END
$$;

CREATE TRIGGER clients_poc_copies_its_checklist
    AFTER INSERT ON clients_poc
    FOR EACH ROW EXECUTE FUNCTION clients_poc_copies_its_checklist();

-- --------------------------------------------------------- deals and POCs open today

/* Named in the audit log as this migration, for the deals it marks as copied. */
SELECT set_config('lms.audit.actor', 'migration: checklists copied onto open deals and POCs (#284)', true);

/* Open deals already past Discovery are given theirs now, nothing ticked (the user, 23 November
   2026). Ended deals are not: nothing they could be judged by is left. */
INSERT INTO clients_check (opportunity_id, source_item_id, grp, label, poc_only, sort)
SELECT o.id, i.id, i.grp, i.label, i.poc_only, i.sort
  FROM clients_opportunity o
  JOIN clients_product p ON p.id = o.product_id
  JOIN clients_client c ON c.id = o.client_id
  JOIN clients_checklist_item i ON i.line_id = p.line_id AND i.client_type_id = c.type_id
 WHERE o.outcome = 'OPEN'
   AND o.stage <> 'DISCOVERY'
   AND i.grp IN ('QUALIFICATION', 'PRE_POC')
   AND i.retired_on IS NULL;

UPDATE clients_opportunity
   SET checklist_copied_at = now()
 WHERE outcome = 'OPEN' AND stage <> 'DISCOVERY';

/* And POCs still running, their phase checks. */
INSERT INTO clients_check (poc_id, source_item_id, grp, label, poc_only, sort)
SELECT poc.id, i.id, i.grp, i.label, i.poc_only, i.sort
  FROM clients_poc poc
  JOIN clients_opportunity o ON o.poc_id = poc.id AND o.outcome = 'OPEN'
  JOIN clients_checklist_item i
    ON i.line_id = poc.line_id AND i.client_type_id = poc.client_type_id
 WHERE i.grp IN ('FOUNDATION', 'DEEPENING', 'CONVERTING')
   AND i.retired_on IS NULL;

-- ---------------------------------------------------------------------------- privileges

/* Read, and nothing else. The copies are the database's to write, through the triggers above. */
REVOKE INSERT ON clients_check FROM lms_app;
REVOKE USAGE ON SEQUENCE clients_check_id_seq FROM lms_app;
GRANT SELECT ON clients_check TO lms_app;

-- Down Migration

DROP TRIGGER IF EXISTS clients_poc_copies_its_checklist ON clients_poc;
DROP FUNCTION IF EXISTS clients_poc_copies_its_checklist();
DROP TRIGGER IF EXISTS clients_opportunity_copies_its_checklist ON clients_opportunity;
DROP FUNCTION IF EXISTS clients_opportunity_copies_its_checklist();
ALTER TABLE clients_opportunity DROP COLUMN IF EXISTS checklist_copied_at;
DROP TABLE IF EXISTS clients_check;
