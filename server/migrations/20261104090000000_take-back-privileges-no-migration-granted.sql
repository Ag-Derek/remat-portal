-- Up Migration

-- Takes back what server/grants.sql gave lms_app, which no migration did.
--
-- That file was run by hand against production. It granted SELECT, INSERT, UPDATE and DELETE
-- on every table and view, took UPDATE and DELETE back from four, and changed the default
-- privileges so every table created afterwards got all four as well. That is the arrangement
-- the restricted-application-role migration warns against: grant everything and revoke a
-- few, which fails silently. It left employee deletable, leave_balance and role writable,
-- every decision and routing record editable, and pgmigrations open to the application.
--
-- The daily backup found it: the restore rebuilds the default privileges as the migrations
-- set them, and production's did not match.
--
-- What lms_app should hold is what a database built by migrations alone gives it. Each
-- REVOKE below takes away only what is beyond that, so on such a database this migration
-- changes nothing, and on production it returns the database to it. REVOKE of a privilege
-- that is not held does nothing, so the lists can be stated plainly.

-- ------------------------------------------------------------- new tables

/* The default goes back to SELECT and INSERT, as the restricted-application-role migration
   set it. grants.sql ran as the owner, the same role migrations run as. */
DO $$
BEGIN
    EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
        'REVOKE UPDATE, DELETE ON TABLES FROM lms_app',
        current_user);
END
$$;

-- --------------------------------------------------------- existing tables

/* Never the application's. */
REVOKE ALL ON pgmigrations FROM lms_app;

/* Read only. The cached balance is kept by the ledger's trigger, and roles are reference data. */
REVOKE INSERT, UPDATE, DELETE ON leave_balance, role FROM lms_app;

/* Views are read, never written through. */
REVOKE INSERT, UPDATE, DELETE
    ON balances_that_disagree_with_the_ledger, what_the_ledger_says FROM lms_app;

/* Append only: a record of something that happened is never edited or removed. */
REVOKE UPDATE, DELETE ON
    attachment_access,
    audit_log,
    leave_ledger_entry,
    leave_request_decision,
    leave_request_reassignment,
    leave_request_recalculation,
    leave_request_reclassification,
    leave_request_reversal,
    leave_request_routing,
    leave_request_withdrawal
FROM lms_app;

/* Edited, never deleted. */
REVOKE DELETE ON
    app_user,
    approval_delegation,
    attachment_download_link,
    department,
    employee,
    leave_cover,
    leave_entitlement_event,
    leave_request,
    leave_type,
    leave_year,
    organisation_setting
FROM lms_app;

/* Added and removed, never edited. */
REVOKE UPDATE ON email_opt_out, employee_photo, leave_type_approval_step, user_role FROM lms_app;

/* Some columns only. Revoking UPDATE on a table revokes it on every column as well, so the
   columns the retry and outbox migrations granted are granted again. */
REVOKE UPDATE, DELETE ON notification, email_outbox FROM lms_app;

GRANT UPDATE (read_at, emailed_at, email_failure, email_attempts, email_next_attempt_at,
              email_gave_up_at) ON notification TO lms_app;
GRANT UPDATE (status, attempts, next_attempt_at, last_error, delivered_to, sent_at, gave_up_at)
    ON email_outbox TO lms_app;

/* Untouched, because their migrations grant all four: holiday, leave_entitlement_rule,
   leave_plan, leave_request_attachment, leave_request_draft, notification_template,
   work_pattern, work_pattern_day. */

-- Down Migration

-- Nothing. Putting back what grants.sql gave would reopen the hole this closes.
