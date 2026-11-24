-- Up Migration

-- What a BD manager may change about a checklist item, from the setup screen. #284, Clients SRS
-- CLI 40, CLI 42.
--
-- Its words, where it comes in its group, whether it is for POC deals only, and whether it is
-- retired. Never its line, client type or group: an item for another checklist is a new item.
-- Nothing is deleted; an item no longer wanted is retired, and every copy already taken keeps it.
-- Every change reaches only deals and POCs copied after it (CLI 40), since a copy is its own.

GRANT UPDATE (label, sort, poc_only, retired_on) ON clients_checklist_item TO lms_app;

-- Down Migration

REVOKE UPDATE (label, sort, poc_only, retired_on) ON clients_checklist_item FROM lms_app;
