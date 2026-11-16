-- Up Migration

-- Who may use clients: its two granted roles. #274, Clients TDD 4.8, SRS CLI 88.
--
-- Granted rather than derived. Nothing the company already keeps says who sells, so a portal
-- System Administrator grants each one from the roles screen inside clients (CLI 94). There is
-- no seed grant: the first BD manager is granted there too.
--
-- Grants end, they are not deleted, so the table is the history of who held what and who
-- decided it. Held by clients rather than by core, as compliance_role is (TDD 17, item 1).
--
-- Index names carry `clients_`, because index names are schema wide and compliance_role already
-- has a uq_role_live.

CREATE TABLE clients_role (
    id           BIGSERIAL PRIMARY KEY,
    employee_id  BIGINT NOT NULL REFERENCES employee(id),
    role         VARCHAR(10) NOT NULL CHECK (role IN ('BD_MANAGER', 'ASSOCIATE')),
    granted_by   BIGINT NOT NULL REFERENCES employee(id),
    granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at     TIMESTAMPTZ,
    /* NULL when it ended because the holder left and nobody acted (CLI 95). */
    ended_by     BIGINT REFERENCES employee(id),
    ended_reason VARCHAR(8),

    /* Beyond TDD 4.8, where the two reasons are a comment. As compliance_role. */
    CONSTRAINT clients_role_ending_known CHECK (ended_reason IN ('REVOKED', 'LEFT')),
    CONSTRAINT clients_role_ends_with_a_reason CHECK ((ended_at IS NULL) = (ended_reason IS NULL)),

    /* Beyond TDD 4.8. A grant withdrawn was withdrawn by somebody; only leaving ends one with
       nobody behind it. */
    CONSTRAINT clients_role_revoked_by_someone CHECK (
        ended_reason IS DISTINCT FROM 'REVOKED' OR ended_by IS NOT NULL),

    /* Beyond TDD 4.8. A grant ends after it began. */
    CONSTRAINT clients_role_ends_after_granted CHECK (ended_at >= granted_at)
);

/* A person holds each role once at a time, and may be granted it again once it has ended. */
CREATE UNIQUE INDEX uq_clients_role_live
    ON clients_role(employee_id, role) WHERE ended_at IS NULL;

/* Any number of people may be BD manager at once. TDD 4.8's uq_one_bdm (SRS CLI 89) was left
   out on purpose (#274): the department will grow, and a limit of one would need a migration to
   lift. Anything that addresses "the BD manager" addresses every current one. */

/* What a person holds, which every clients request asks. */
CREATE INDEX idx_clients_role_person ON clients_role(employee_id) WHERE ended_at IS NULL;

/* Default privileges give lms_app SELECT and INSERT, and USAGE on the sequence. A grant is
   ended, and nothing else about it ever changes; nothing is deleted. */
GRANT UPDATE (ended_at, ended_by, ended_reason) ON clients_role TO lms_app;

-- Down Migration

DROP TABLE IF EXISTS clients_role;
