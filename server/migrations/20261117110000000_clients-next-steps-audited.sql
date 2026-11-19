-- Up Migration

-- Next steps in the audit log. #280.
--
-- A closed step can be reopened, by its owner or a BD manager, and reopening clears who closed it
-- and when (CLI 64, #280). The audit log is where that close is kept: every step made, closed and
-- reopened, with who did each, as an activity's corrections are.

CREATE TRIGGER clients_next_step_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON clients_next_step
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

-- Down Migration

DROP TRIGGER IF EXISTS clients_next_step_is_audited ON clients_next_step;
