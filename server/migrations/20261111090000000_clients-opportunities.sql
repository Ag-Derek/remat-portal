-- Up Migration

-- An opportunity: one client and one product, with an owner, a value, a probability and the half
-- year it is expected to close. #277, Clients SRS CLI 10 to CLI 17, TDD 4.2.
--
-- The client is the record and the opportunity is the unit (TDD 1): a bank buying CreditStudio
-- and OnboardStudio is two deals, each moving on its own. A deal is called an opportunity in the
-- tables and a deal on the screen; they are the same thing.
--
-- Stages and the POC decision are #278's, and ending a deal as lost or exited is #279's; each adds
-- its columns and the constraints of TDD 4.2 that read them. This migration holds what a deal is.
-- Its outcome is here because "open" is what one open deal per client and product is about, and
-- every deal starts open; nothing may change it until the stage service exists to do it.

CREATE TABLE clients_opportunity (
    id               BIGSERIAL PRIMARY KEY,
    /* Exactly one client, for good: see the privileges below. */
    client_id        BIGINT NOT NULL REFERENCES clients_client(id),
    /* Exactly one product. A retired one takes no new deals: see the trigger below. */
    product_id       BIGINT NOT NULL REFERENCES clients_product(id),
    /* Who works it: whoever created it, until a BD manager moves it to somebody else. */
    owner_id         BIGINT NOT NULL REFERENCES employee(id),

    /* Open until it is won, lost or exited (#278, #279). */
    outcome          VARCHAR(8) NOT NULL DEFAULT 'OPEN',

    /* What it is worth, in minor units (pesewas or cents) of one currency (TDD 8). Cedis and
       dollars are never added together, so the currency is kept with every amount. Both null
       while nobody knows, so that it is shown as missing rather than as nothing. */
    value_minor      BIGINT,
    currency         CHAR(3),

    /* How likely it is to close, as a whole percentage. Null while nobody has said. */
    probability      SMALLINT,

    /* The half year it is expected to close in: H1 2027. Both null while nobody has said. */
    close_half       CHAR(2),
    close_year       SMALLINT,

    /* What is holding the deal up today, whatever its stage (CLI 16). Null when nothing is. */
    waiting_on       VARCHAR(20),
    /* Beyond TDD 4.2, which has TEXT: a length, as every free text column in clients has. */
    waiting_note     VARCHAR(2000),

    /* What the client said they want, in their words or near them. */
    stated_interest  VARCHAR(2000),

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT clients_opportunity_outcome_known
        CHECK (outcome IN ('OPEN', 'WON', 'LOST', 'EXITED')),

    CONSTRAINT clients_opportunity_currency_known CHECK (currency IN ('GHS', 'USD')),

    /* An amount means nothing without its currency, and a currency nothing without an amount. */
    CONSTRAINT clients_opportunity_value_pair CHECK ((value_minor IS NULL) = (currency IS NULL)),

    CONSTRAINT clients_opportunity_value_not_negative CHECK (value_minor >= 0),

    CONSTRAINT clients_opportunity_probability_a_percentage CHECK (probability BETWEEN 0 AND 100),

    CONSTRAINT clients_opportunity_close_half_known CHECK (close_half IN ('H1', 'H2')),

    /* A half without a year, or a year without a half, is no date to close by. */
    CONSTRAINT clients_opportunity_close_pair CHECK ((close_half IS NULL) = (close_year IS NULL)),

    /* Beyond TDD 4.2. A year somebody could mean, not 27 for 2027. */
    CONSTRAINT clients_opportunity_close_year_plausible CHECK (close_year BETWEEN 2000 AND 2100),

    /* Beyond TDD 4.2, which leaves the list to SRS CLI 16. */
    CONSTRAINT clients_opportunity_waiting_on_known
        CHECK (waiting_on IN ('DEMO', 'PROPOSAL_RESPONSE', 'PAPERWORK', 'SIGNATURE',
                              'CLIENT_DECISION', 'OTHER')),

    /* CLI 16: "other, with a note". The note may say more about any of the others too, but is
       about what the deal waits on, so there is none while it waits on nothing. */
    CONSTRAINT clients_opportunity_other_has_a_note
        CHECK (waiting_on IS DISTINCT FROM 'OTHER' OR waiting_note IS NOT NULL),
    CONSTRAINT clients_opportunity_note_is_about_waiting
        CHECK (waiting_note IS NULL OR waiting_on IS NOT NULL),

    /* Beyond TDD 4.2. Left out is null, never an empty string, so that the screen shows it as
       missing. */
    CONSTRAINT clients_opportunity_waiting_note_not_blank
        CHECK (waiting_note IS NULL OR btrim(waiting_note) <> ''),
    CONSTRAINT clients_opportunity_stated_interest_not_blank
        CHECK (stated_interest IS NULL OR btrim(stated_interest) <> '')
);

/* Somebody's open deals, which My pipeline asks for (TDD 4.2, 7). */
CREATE INDEX idx_clients_opportunity_owner ON clients_opportunity (owner_id) WHERE outcome = 'OPEN';
/* Beyond TDD 4.2. A client's deals, open and ended, which every client page asks for. */
CREATE INDEX idx_clients_opportunity_client ON clients_opportunity (client_id);

-- --------------------------------------------- a retired product takes no new deals, CLI 08

/* Written by #293 before there were deals to refuse, so that this table could not be built
   without it. */
CREATE TRIGGER clients_opportunity_product_takes_new_deals
    BEFORE INSERT OR UPDATE OF product_id ON clients_opportunity
    FOR EACH ROW EXECUTE FUNCTION clients_product_takes_new_deals();

-- ------------------------------------------------- the deal that won a product, TDD 4.1

/* Left without a foreign key by #276 until there was a table for it to name. */
ALTER TABLE clients_client_product
    ADD CONSTRAINT clients_client_product_won_by_fkey
    FOREIGN KEY (won_by) REFERENCES clients_opportunity(id);

-- ------------------------------------------------------------------- audit, NFR CLI AUD 01

/* Who created a deal, and every change of its owner. Value and probability changes are kept in
   their own history as well (NFR CLI AUD 02), which a later migration adds. */
CREATE TRIGGER clients_opportunity_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON clients_opportunity
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

-- ---------------------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT, and USAGE on the sequence. Nothing is
   updated yet: what an owner or a BD manager may change is granted with the means to change it,
   and the outcome only ever by the stage service (#278). Which client a deal is for never
   changes, and nothing is deleted. */

-- Down Migration

ALTER TABLE clients_client_product DROP CONSTRAINT IF EXISTS clients_client_product_won_by_fkey;
DROP TABLE IF EXISTS clients_opportunity;
