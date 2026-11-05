-- Up Migration

-- A team lead: somebody whose reports are drawn beside them on the organisation chart, under
-- their own manager, rather than beneath them.
--
-- For a lead who runs a team day to day and approves its leave, but is not where the team sits
-- in the organisation. The reports still report to them: `manager_id` is untouched, so leave is
-- routed, balances are shown and access is decided exactly as before. Only the drawing changes.
--
-- A column on `employee` rather than a table beside it, so that `employee_is_audited` records
-- every change to it with the rest of the record. HR's, as everything but the profile is.

ALTER TABLE employee
    ADD COLUMN team_lead BOOLEAN NOT NULL DEFAULT false;

-- Down Migration

ALTER TABLE employee
    DROP COLUMN IF EXISTS team_lead;
