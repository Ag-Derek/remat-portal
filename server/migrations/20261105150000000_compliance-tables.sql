-- Up Migration

-- The compliance register: its seven tables. #245, Compliance TDD 4 and 13.
--
-- Both kinds of item produce one kind of thing, an obligation: one time something falls due.
-- An expiring item's next obligation is created by a completion; a recurring item's by the
-- calendar. The two unique indexes on compliance_obligation are the whole difference between
-- them, held as constraints rather than as code.
--
-- Overdue and due soon are not stored. They are `due_on` against today, read in TDD 7.
--
-- Nothing that exists is altered and nothing is backfilled. The append only triggers, the
-- immutable kind and the audit trigger on compliance_item are #246; the two default reminder
-- schedules are #247. There is no seed grant: the first oversight role is granted by a System
-- Administrator through the roles screen.

-- ------------------------------------------------------------------------ items, TDD 4.1

CREATE TABLE compliance_item (
    id                   BIGSERIAL PRIMARY KEY,
    name                 VARCHAR(160) NOT NULL,
    kind                 VARCHAR(10) NOT NULL CHECK (kind IN ('EXPIRES', 'RECURS')),
    issuer               VARCHAR(160),
    reference            VARCHAR(120),
    note                 TEXT,

    owner_id             BIGINT NOT NULL REFERENCES employee(id),
    backup_id            BIGINT NOT NULL REFERENCES employee(id),
    currency             CHAR(3) NOT NULL CHECK (currency IN ('GHS', 'USD')),

    /* Recurring items only. MONTHLY falls due `due_months_after` months after the period
       ends, on `due_day`; ANNUAL the period's year plus `due_months_after` years, on
       (`due_month`, `due_day`). A `due_day` of 0 is the last day of the month. PAYE for
       October is due in November, which is why the offset defaults to one. */
    cycle                VARCHAR(10) CHECK (cycle IN ('MONTHLY', 'ANNUAL')),
    due_day              SMALLINT CHECK (due_day BETWEEN 0 AND 31),
    due_month            SMALLINT CHECK (due_month BETWEEN 1 AND 12),
    due_months_after     SMALLINT NOT NULL DEFAULT 1,

    /* Reminders, as data (CMP 31). The offsets before `due_on`, then what happens after the
       last of them. Filled from the default for the kind and editable afterwards. */
    reminder_days_before INT[] NOT NULL,
    reminder_cadence     VARCHAR(10) NOT NULL CHECK (reminder_cadence IN ('WEEKLY', 'DAILY')),

    retired_on           DATE,
    retired_reason       TEXT,
    retired_by           BIGINT REFERENCES employee(id),

    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    /* OWNER_IS_BACKUP. */
    CONSTRAINT item_owner_not_backup CHECK (owner_id <> backup_id),

    CONSTRAINT item_kind_shape CHECK (
        (kind = 'RECURS' AND cycle IS NOT NULL AND due_day IS NOT NULL)
        OR (kind = 'EXPIRES' AND cycle IS NULL AND due_day IS NULL AND due_month IS NULL)),

    CONSTRAINT item_retired_shape CHECK (
        (retired_on IS NULL) = (retired_reason IS NULL)),

    /* Beyond TDD 4.1. dueDateFor() cannot place an annual return without its month, and a
       month on a monthly filing would be a rule nothing reads. */
    CONSTRAINT item_annual_has_month CHECK (
        cycle IS NULL OR (cycle = 'ANNUAL') = (due_month IS NOT NULL)),

    /* Beyond TDD 4.1. Retiring takes a reason and is done by somebody (#253). */
    CONSTRAINT item_retired_by_someone CHECK (
        (retired_on IS NULL) = (retired_by IS NULL)
        AND (retired_reason IS NULL OR btrim(retired_reason) <> ''))
);

CREATE INDEX idx_item_live ON compliance_item(id) WHERE retired_on IS NULL;
CREATE INDEX idx_item_owner ON compliance_item(owner_id, backup_id);

CREATE TRIGGER compliance_item_set_updated_at
    BEFORE UPDATE ON compliance_item
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------------ obligations, TDD 4.2

CREATE TABLE compliance_obligation (
    id             BIGSERIAL PRIMARY KEY,
    item_id        BIGINT NOT NULL REFERENCES compliance_item(id),

    /* Recurring only; NULL identifies an expiring item's obligation. */
    period_label   VARCHAR(40),
    period_start   DATE,
    period_end     DATE,

    /* The date the rule gives, kept so a holiday change is applied to it rather than to an
       already adjusted date, and so a screen can say why `due_on` differs. */
    nominal_due_on DATE,
    /* NULL where the date is not yet known. */
    due_on         DATE,

    status         VARCHAR(12) NOT NULL DEFAULT 'OPEN'
                   CHECK (status IN ('NEEDS_DATE', 'OPEN', 'CLOSED', 'CANCELLED')),

    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    /* TDD 4.2 has `(status = 'NEEDS_DATE') = (due_on IS NULL)`, which refuses to cancel an
       obligation that never had a date, so an item that needs one could not be retired
       (#253). A cancelled obligation keeps whatever date it had, including none. */
    CONSTRAINT ob_needs_date CHECK (
        (status = 'NEEDS_DATE') = (due_on IS NULL) OR status = 'CANCELLED'),

    CONSTRAINT ob_period_shape CHECK (
        (period_label IS NULL AND period_start IS NULL AND period_end IS NULL)
        OR (period_label IS NOT NULL AND period_start IS NOT NULL AND period_end IS NOT NULL)),

    /* Beyond TDD 4.2. The two dates arrive together, and a period runs forwards. */
    CONSTRAINT ob_dates_together CHECK ((nominal_due_on IS NULL) = (due_on IS NULL)),
    CONSTRAINT ob_period_forwards CHECK (period_end >= period_start),

    /* Beyond TDD 4.2. A permit expires on the day printed on it (CMP 15, TDD 6.2): only a
       filing deadline is moved off a weekend. The mistake TDD 6.2 calls the most likely in
       the design, refused where it would be written. */
    CONSTRAINT ob_expiry_never_moves CHECK (
        period_label IS NOT NULL OR due_on IS NOT DISTINCT FROM nominal_due_on)
);

/* An expiring item has at most one obligation outstanding at any time. */
CREATE UNIQUE INDEX uq_expiring_one_open
    ON compliance_obligation(item_id)
    WHERE period_label IS NULL AND status IN ('NEEDS_DATE', 'OPEN');

/* A recurring item has exactly one obligation per period. TDD 4.2 says "ever"; a period
   cancelled when its item was retired does not count, so that bringing the item back creates
   the period afresh rather than finding it taken (#254). */
CREATE UNIQUE INDEX uq_period_once
    ON compliance_obligation(item_id, period_start)
    WHERE period_start IS NOT NULL AND status <> 'CANCELLED';

CREATE INDEX idx_ob_due ON compliance_obligation(status, due_on);

/* An item's history. */
CREATE INDEX idx_ob_item ON compliance_obligation(item_id);

-- ------------------------------------------------------- completions and reversals, TDD 4.3

CREATE TABLE compliance_completion (
    id             BIGSERIAL PRIMARY KEY,
    obligation_id  BIGINT NOT NULL REFERENCES compliance_obligation(id),
    completed_on   DATE NOT NULL,
    /* Computed once, when it is recorded, and never again (CMP 21). */
    days_late      INT NOT NULL DEFAULT 0 CHECK (days_late >= 0),
    /* Pesewas or cents. TDD 9. */
    amount_minor   BIGINT,
    currency       CHAR(3) CHECK (currency IN ('GHS', 'USD')),
    /* Expiring items only; drives the next obligation. */
    new_expiry_on  DATE,
    note           TEXT,
    recorded_by    BIGINT NOT NULL REFERENCES employee(id),
    recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    /* Copied up from compliance_reversal, because a partial unique index cannot hold a
       subquery. */
    reversed_at    TIMESTAMPTZ,

    CONSTRAINT completion_amount_pair CHECK ((amount_minor IS NULL) = (currency IS NULL)),

    /* Beyond TDD 4.3. */
    CONSTRAINT completion_amount_not_negative CHECK (amount_minor >= 0)
);

/* One live completion per obligation. A reversed one no longer counts. */
CREATE UNIQUE INDEX uq_one_live_completion
    ON compliance_completion(obligation_id) WHERE reversed_at IS NULL;

CREATE INDEX idx_completion_obligation ON compliance_completion(obligation_id);

CREATE TABLE compliance_reversal (
    id             BIGSERIAL PRIMARY KEY,
    completion_id  BIGINT NOT NULL UNIQUE REFERENCES compliance_completion(id),
    reason         TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
    reversed_by    BIGINT NOT NULL REFERENCES employee(id),
    reversed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------------- documents, TDD 4.4

/* No `file_deleted_at` and no purge. A tax clearance certificate is a company record whose
   value is still being there in three years (NFR CMP REC 01); the attachment purge must not
   be pointed at this table. */

CREATE TABLE compliance_document (
    id                BIGSERIAL PRIMARY KEY,
    completion_id     BIGINT NOT NULL REFERENCES compliance_completion(id),
    original_filename VARCHAR(255) NOT NULL,
    storage_key       VARCHAR(512) NOT NULL UNIQUE,
    /* Sniffed, not from the client. */
    content_type      VARCHAR(100) NOT NULL,
    size_bytes        BIGINT NOT NULL,
    checksum_sha256   CHAR(64) NOT NULL,
    uploaded_by       BIGINT NOT NULL REFERENCES employee(id),
    uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    /* Beyond TDD 4.4. */
    CONSTRAINT document_not_empty CHECK (size_bytes > 0),
    CONSTRAINT document_checksum_is_a_sha256 CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_document_completion ON compliance_document(completion_id);

-- ------------------------------------------------------------- reminder ledger, TDD 4.5

/* The key makes a second run on the same day a no op (NFR CMP REL 01). Keyed on the day the
   reminder was for, so a run that was missed is caught up by the next (NFR CMP REL 02). */

CREATE TABLE compliance_reminder_sent (
    obligation_id  BIGINT NOT NULL REFERENCES compliance_obligation(id),
    sent_for_date  DATE NOT NULL,
    kind           VARCHAR(12) NOT NULL CHECK (kind IN ('OFFSET', 'CADENCE', 'ESCALATION')),
    sent_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (obligation_id, sent_for_date, kind)
);

-- --------------------------------------------------------------- granted roles, TDD 4.6

/* Oversight and viewer only. Owner and backup are columns on the item, manager is the
   reporting line, and no access is the absence of all four. Grants end, they are not deleted
   (CMP 58). */

CREATE TABLE compliance_role (
    id           BIGSERIAL PRIMARY KEY,
    employee_id  BIGINT NOT NULL REFERENCES employee(id),
    role         VARCHAR(16) NOT NULL CHECK (role IN ('OVERSIGHT', 'VIEWER')),
    granted_by   BIGINT NOT NULL REFERENCES employee(id),
    granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at     TIMESTAMPTZ,
    /* NULL when it ended because the holder left and nobody acted. */
    ended_by     BIGINT REFERENCES employee(id),
    ended_reason VARCHAR(32),

    /* Beyond TDD 4.6, where the two reasons are a comment. */
    CONSTRAINT role_ending_known CHECK (ended_reason IN ('REVOKED', 'LEFT')),
    CONSTRAINT role_ends_with_a_reason CHECK ((ended_at IS NULL) = (ended_reason IS NULL))
);

CREATE UNIQUE INDEX uq_role_live
    ON compliance_role(employee_id, role) WHERE ended_at IS NULL;

CREATE INDEX idx_role_person ON compliance_role(employee_id) WHERE ended_at IS NULL;

-- ---------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT on all seven, and USAGE on their
   sequences. Only what must change is widened, and nothing is ever deleted. */

/* Edited, reassigned, retired and restored. */
GRANT UPDATE ON compliance_item TO lms_app;

/* Closed, reopened, cancelled, dated, and moved when a public holiday changes. */
GRANT UPDATE ON compliance_obligation TO lms_app;

/* Marked reversed, and nothing else. */
GRANT UPDATE (reversed_at) ON compliance_completion TO lms_app;

/* Ended, and nothing else. */
GRANT UPDATE (ended_at, ended_by, ended_reason) ON compliance_role TO lms_app;

/* compliance_reversal, compliance_document and compliance_reminder_sent are appended to and
   never changed. */

-- Down Migration

DROP TABLE IF EXISTS compliance_role;
DROP TABLE IF EXISTS compliance_reminder_sent;
DROP TABLE IF EXISTS compliance_document;
DROP TABLE IF EXISTS compliance_reversal;
DROP TABLE IF EXISTS compliance_completion;
DROP TABLE IF EXISTS compliance_obligation;
DROP TABLE IF EXISTS compliance_item;
