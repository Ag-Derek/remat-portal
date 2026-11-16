-- Up Migration

-- Each client is recorded once. #276, Clients SRS CLI 02.
--
-- Two people adding the same bank a week apart is how a pipeline ends up with two ADBs, each
-- holding half the history. So a name is the same name whatever its case and however it is
-- spaced: "ADB", " adb" and "Agricultural  Development Bank" against "agricultural development
-- bank" are each one client, not two. Runs of spaces, tabs or line breaks inside a name count as
-- one space, and those at either end count as none.
--
-- Held by the database, so that two requests racing each other cannot both get in.

/* A name as it is compared: lower case, every run of white space one space, none at the ends.
   One function, so that the index and every lookup that finds the client already there agree on
   what "the same name" means. */
CREATE FUNCTION clients_name_key(name TEXT) RETURNS TEXT
    LANGUAGE sql
    IMMUTABLE
    STRICT
    PARALLEL SAFE
    RETURN lower(btrim(regexp_replace(name, '\s+', ' ', 'g')));

CREATE UNIQUE INDEX uq_clients_client_name ON clients_client (clients_name_key(name));

/* A name of nothing but tabs or line breaks is no name either, which btrim alone, trimming only
   spaces, let through. */
ALTER TABLE clients_client
    DROP CONSTRAINT clients_client_named,
    ADD CONSTRAINT clients_client_named CHECK (clients_name_key(name) <> '');

-- Down Migration

ALTER TABLE clients_client
    DROP CONSTRAINT clients_client_named,
    ADD CONSTRAINT clients_client_named CHECK (btrim(name) <> '');
DROP INDEX IF EXISTS uq_clients_client_name;
DROP FUNCTION IF EXISTS clients_name_key(TEXT);
