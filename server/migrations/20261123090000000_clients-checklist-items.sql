-- Up Migration

-- The checklists: items kept per product line and client type, in five groups. #284, Clients SRS
-- CLI 39, TDD 4.4.
--
-- This is the template, which a BD manager keeps (CLI 40). What a deal or a POC is judged by is a
-- copy taken from it when it applies (#284, later items), so editing an item here never changes
-- one already copied. A line and client type with no items has no checklist, and every gate
-- passes for it (CLI 43): there is no row saying "no checklist", only the absence of items.
--
-- Left for the items of #284 they belong to: the copies and their ticks, and what the setup
-- screen may change.

CREATE TABLE clients_checklist_item (
    id              BIGSERIAL PRIMARY KEY,
    line_id         BIGINT NOT NULL REFERENCES clients_product_line(id),
    /* Beyond TDD 4.4, which has a fixed list of types in a column: client types are a table
       (#276), so an item names one. */
    client_type_id  BIGINT NOT NULL REFERENCES clients_client_type(id),
    /* Which part of the deal or POC it belongs to: the criteria before Negotiation, the gates
       before the POC, and the checks of each of its three phases (CLI 32, CLI 39). */
    grp             VARCHAR(14) NOT NULL,
    label           VARCHAR(200) NOT NULL,
    /* Where it comes in its group. Ties fall back to the order items were added. */
    sort            SMALLINT NOT NULL,
    /* A qualification criterion that applies only to a deal with a POC, such as the decision
       maker committing to the review meetings (CLI 41, SRS §17). A deal whose has_poc is false
       is not held to it; one that hasn't said yet is. */
    poc_only        BOOLEAN NOT NULL DEFAULT false,
    /* Beyond TDD 4.4's retired_at: retired on a day, as products, lines, types and reasons are.
       A retired item is copied onto nothing new, and every copy already taken keeps it. */
    retired_on      DATE,

    CONSTRAINT clients_checklist_item_group_known
        CHECK (grp IN ('QUALIFICATION', 'PRE_POC', 'FOUNDATION', 'DEEPENING', 'CONVERTING')),
    CONSTRAINT clients_checklist_item_labelled CHECK (btrim(label) <> ''),
    /* Only a qualification criterion can be: every other group is about the POC already. */
    CONSTRAINT clients_checklist_item_poc_only_qualifies
        CHECK (NOT poc_only OR grp = 'QUALIFICATION')
);

/* Each named once in its group of a checklist, ignoring case and surrounding spaces, as reasons
   are on their list. The same words may be in another group, or on another checklist. */
CREATE UNIQUE INDEX uq_clients_checklist_item_label
    ON clients_checklist_item (line_id, client_type_id, grp, lower(btrim(label)));

/* A checklist read in its order: the line and type a deal or POC is for, group by group. */
CREATE INDEX idx_clients_checklist_item_checklist
    ON clients_checklist_item (line_id, client_type_id, grp, sort);

/* Who added, changed or retired an item, by trigger (NFR CLI AUD 01). */
CREATE TRIGGER clients_checklist_item_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON clients_checklist_item
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

/* Default privileges give lms_app SELECT and INSERT, and USAGE on the sequence. What a BD manager
   may change about an item comes with the checklist editor (#284). */

-- Down Migration

DROP TABLE IF EXISTS clients_checklist_item;
