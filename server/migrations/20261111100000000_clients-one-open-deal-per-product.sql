-- Up Migration

-- A client has at most one open deal per product. #277, Clients SRS CLI 11, TDD 4.2, AC L01.
--
-- Two people opening CreditStudio at ADB a week apart is how a pipeline counts one sale twice,
-- each copy holding half the history. A second may be opened once the first has ended, won, lost
-- or exited (CLI 56): re-engaging a client starts a new deal rather than reopening the old one.
--
-- Held by the database, so that two requests racing each other cannot both get in, and so that
-- the workbook import, which writes through the same table, is held to it too.

/* TDD 4.2's uq_opp_open, named with `clients_` as every index here is, because index names are
   schema wide. */
CREATE UNIQUE INDEX uq_clients_opportunity_open
    ON clients_opportunity (client_id, product_id)
    WHERE outcome = 'OPEN';

-- Down Migration

DROP INDEX IF EXISTS uq_clients_opportunity_open;
