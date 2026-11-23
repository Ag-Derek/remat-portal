-- Up Migration

-- HR is taken out of leave approval, for now. FR 38a, FR 48b.
--
-- The manager decides leave on their own, and unpaid leave goes to the Chief Executive alone.
-- The Chief Executive keeps what they already had: everybody's leave on one page, and the
-- power to reverse any decision once it is made.
--
--   | Chain before      | Chain after |
--   |-------------------|-------------|
--   | Manager then HR   | Manager     |
--   | HR then CEO       | CEO         |
--   | any other with HR | the same, HR left out and the rest renumbered |
--   | HR alone          | Manager     |
--
-- Nothing about the HR desk is deleted. It is still one of the three desks a chain may name,
-- so an HR Administrator can put it back on the approval chains screen, and:
--
--   * every chain as it stood is kept in `leave_type_approval_step_with_hr`, which the down
--     migration restores;
--   * `ensure_statutory_approval_chains()` keeps the HR shape behind a switch:
--     `ensure_statutory_approval_chains(true)` writes Manager then HR, and HR then CEO, as it
--     used to.
--
-- Requests already waiting at the HR desk are not moved here. Closing a stage moves days
-- (a final yes takes them, a final no gives them back), and that is the balance service's
-- job, so the application does it at start-up: `LeaveRequestService.closeTheHrStage`.

SELECT set_config('lms.audit.actor', 'migration: HR taken out of leave approval', true);

-- ------------------------------------------------------- every chain as it stood

/* Owner only. Nothing in the application reads it; it is what the down migration puts back. */

CREATE TABLE leave_type_approval_step_with_hr AS
    SELECT leave_type_id, step_order, approver_role
      FROM leave_type_approval_step;

REVOKE ALL ON leave_type_approval_step_with_hr FROM lms_app;

-- ----------------------------------------------------------- the chains, without HR

/* Delete and insert rather than update, for the reason the approval chain migration gives:
   a chain is replaced whole. The hole check is deferred to COMMIT, by which time every chain
   is numbered 1 to n again. */

CREATE TEMPORARY TABLE chain_without_hr ON COMMIT DROP AS
    SELECT leave_type_id,
           (row_number() OVER (PARTITION BY leave_type_id ORDER BY step_order))::SMALLINT
               AS step_order,
           approver_role
      FROM leave_type_approval_step
     WHERE approver_role <> 'HR'
       AND leave_type_id IN (SELECT leave_type_id
                               FROM leave_type_approval_step
                              WHERE approver_role = 'HR');

/* A chain that was HR alone would be left with nobody, so it goes to the manager. */

INSERT INTO chain_without_hr (leave_type_id, step_order, approver_role)
    SELECT DISTINCT step.leave_type_id, 1::SMALLINT, 'MANAGER'
      FROM leave_type_approval_step step
     WHERE step.approver_role = 'HR'
       AND NOT EXISTS (SELECT 1
                         FROM leave_type_approval_step other
                        WHERE other.leave_type_id = step.leave_type_id
                          AND other.approver_role <> 'HR');

DELETE FROM leave_type_approval_step
 WHERE leave_type_id IN (SELECT leave_type_id FROM chain_without_hr);

INSERT INTO leave_type_approval_step (leave_type_id, step_order, approver_role)
    SELECT leave_type_id, step_order, approver_role
      FROM chain_without_hr;

-- ------------------------------------------- and the repair writes the same chains

/* Given a parameter, so it is a new function rather than a new body: Postgres will not change
   a function's arguments in place. Called with none it writes the chains above. */

DROP FUNCTION ensure_statutory_approval_chains();

CREATE FUNCTION ensure_statutory_approval_chains(hr_approves BOOLEAN DEFAULT false)
    RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    named_by TEXT := current_setting('lms.audit.actor', true);
    given    INTEGER;
BEGIN
    PERFORM set_config(
        'lms.audit.actor',
        coalesce(nullif(btrim(named_by), ''), 'ensure_statutory_approval_chains()'),
        true);

    WITH unapprovable AS (
        SELECT type.id,
               CASE WHEN upper(type.code) IN ('UNPAID', 'MAT_EXT_UNPAID')
                    THEN CASE WHEN hr_approves THEN ARRAY['HR', 'CEO'] ELSE ARRAY['CEO'] END
                    ELSE CASE WHEN hr_approves THEN ARRAY['MANAGER', 'HR'] ELSE ARRAY['MANAGER'] END
               END AS chain
          FROM leave_type type
         WHERE NOT EXISTS (
             SELECT 1 FROM leave_type_approval_step step
              WHERE step.leave_type_id = type.id
         )
    ), written AS (
        INSERT INTO leave_type_approval_step (leave_type_id, step_order, approver_role)
        SELECT unapprovable.id, stage.step_order, stage.approver_role
          FROM unapprovable,
               unnest(unapprovable.chain) WITH ORDINALITY AS stage(approver_role, step_order)
        RETURNING leave_type_id
    )
    SELECT count(DISTINCT leave_type_id) INTO given FROM written;

    PERFORM set_config('lms.audit.actor', coalesce(named_by, ''), true);

    RETURN given;
END
$$;

REVOKE EXECUTE ON FUNCTION ensure_statutory_approval_chains(BOOLEAN) FROM PUBLIC;

SELECT set_config('lms.audit.actor', '', true);


-- Down Migration

SELECT set_config('lms.audit.actor', 'migration: HR put back into leave approval', true);

/* Every chain as it stood, for every type that is still here. A type created since keeps the
   chain it was given. Requests whose HR stage was closed stay decided: a rollback of the
   chains does not undo leave somebody has been told about. */

DELETE FROM leave_type_approval_step
 WHERE leave_type_id IN (SELECT leave_type_id FROM leave_type_approval_step_with_hr);

INSERT INTO leave_type_approval_step (leave_type_id, step_order, approver_role)
    SELECT kept.leave_type_id, kept.step_order, kept.approver_role
      FROM leave_type_approval_step_with_hr kept
     WHERE EXISTS (SELECT 1 FROM leave_type type WHERE type.id = kept.leave_type_id);

DROP TABLE leave_type_approval_step_with_hr;

DROP FUNCTION ensure_statutory_approval_chains(BOOLEAN);

CREATE FUNCTION ensure_statutory_approval_chains() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    named_by TEXT := current_setting('lms.audit.actor', true);
    given    INTEGER;
BEGIN
    PERFORM set_config(
        'lms.audit.actor',
        coalesce(nullif(btrim(named_by), ''), 'ensure_statutory_approval_chains()'),
        true);

    WITH unapprovable AS (
        SELECT type.id,
               CASE WHEN upper(type.code) IN ('UNPAID', 'MAT_EXT_UNPAID')
                    THEN ARRAY['HR', 'CEO']
                    ELSE ARRAY['MANAGER', 'HR']
               END AS chain
          FROM leave_type type
         WHERE NOT EXISTS (
             SELECT 1 FROM leave_type_approval_step step
              WHERE step.leave_type_id = type.id
         )
    ), written AS (
        INSERT INTO leave_type_approval_step (leave_type_id, step_order, approver_role)
        SELECT unapprovable.id, stage.step_order, stage.approver_role
          FROM unapprovable,
               unnest(unapprovable.chain) WITH ORDINALITY AS stage(approver_role, step_order)
        RETURNING leave_type_id
    )
    SELECT count(DISTINCT leave_type_id) INTO given FROM written;

    PERFORM set_config('lms.audit.actor', coalesce(named_by, ''), true);

    RETURN given;
END
$$;

REVOKE EXECUTE ON FUNCTION ensure_statutory_approval_chains() FROM PUBLIC;

SELECT set_config('lms.audit.actor', '', true);
