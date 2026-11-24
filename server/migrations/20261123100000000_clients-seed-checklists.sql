-- Up Migration

-- The Symphony line's checklists, from the POC SOPs and the POC tracker. #284, CLI 39, TDD
-- migration 6.
--
-- One for banks, from the Bank POC workflow and the Federation Bank POC SOP, and one for
-- brokerages, from the Brokerage POC SOP, which covers Federation, Cloud9 or both. Microfinance
-- institutions, digital lenders and DFIs follow the brokerage list, as they already do for usage
-- targets (poc.ts), each with a copy of its own so a BD manager can change one without the others.
-- The other lines have no checklist yet, so every gate passes for them (CLI 43).
--
-- The tracker's phases fall into the groups as: Phase 1 is Foundation; Phase 2 and the midpoint
-- are Deepening; Phase 3 and conversion are Converting. Left out on purpose:
--   * "Contract signed" as a qualification criterion, and the "Signed Agreement" pre-POC gate.
--     Qualification criteria are what a deal needs before Negotiation, so no deal could pass;
--     moving the deal to Contract signed is the record of signing.
--   * The tracker rows another record already holds: the Day 60 and final reviews held, and who
--     was in the room (the review meetings, #285); the contract draft, the conversion contract
--     and the outcome (signed before the POC starts since SOP v2); and the usage figures.
-- Added from the SOPs, which the tracker lacks: the Client Intelligence Document, and for
-- brokerages the Configuration Sheet.
--
-- Two criteria on each list are POC only (CLI 41, following SRS §17's working assumption that
-- the review-meeting and POC set-up criteria apply only to POC deals): the decision maker's
-- commitment to the three review meetings, and starting the integration pre-configuration.
--
-- From here the lists are a BD manager's to keep. An item somebody already added by hand under
-- the same name, in any case, is left as it is rather than refused.

/* Named in the audit log as this migration, which is also how the Down finds what it added. */
SELECT set_config('lms.audit.actor', 'migration: the Symphony checklists from the POC SOPs (#284)', true);

/* Banks. Criteria 1 and 5 are the POC-only ones. */
INSERT INTO clients_checklist_item (line_id, client_type_id, grp, label, sort, poc_only)
SELECT l.id, t.id, i.grp, i.label, i.sort, (i.grp = 'QUALIFICATION' AND i.sort IN (1, 5))
  FROM (VALUES
          ('QUALIFICATION', 1, 'All three stakeholders identified (decision maker, COO, IT contact), each committed to three review meetings'),
          ('QUALIFICATION', 2, 'Stated interest captured verbatim for each stakeholder'),
          ('QUALIFICATION', 3, 'Point person identified'),
          ('QUALIFICATION', 4, 'Finance or procurement contact identified'),
          ('QUALIFICATION', 5, 'Integration pre-configuration started, at least 4 weeks before the start'),
          ('QUALIFICATION', 6, 'A defined pain point documented for each stakeholder'),
          ('PRE_POC',       1, 'Pricing shared'),
          ('PRE_POC',       2, 'User list final'),
          ('PRE_POC',       3, 'Metrics agreed'),
          ('PRE_POC',       4, 'Communication audit done'),
          ('PRE_POC',       5, 'Week 6 midpoint review booked'),
          ('PRE_POC',       6, 'IT and infrastructure confirmed'),
          ('PRE_POC',       7, 'Teams integration scoped'),
          ('PRE_POC',       8, 'Client Intelligence Document on file'),
          ('FOUNDATION',    1, 'Kickoff delivered'),
          ('FOUNDATION',    2, 'All users active'),
          ('FOUNDATION',    3, 'Champion briefed'),
          ('FOUNDATION',    4, 'First archive demo'),
          ('FOUNDATION',    5, 'Week 2 check-in'),
          ('DEEPENING',     1, 'Client messages captured'),
          ('DEEPENING',     2, 'Compliance reviewing'),
          ('DEEPENING',     3, 'Off-channel reduction visible'),
          ('DEEPENING',     4, 'Week 4 pulse check'),
          ('DEEPENING',     5, 'Compliance data shown'),
          ('DEEPENING',     6, 'Conversion signal positive'),
          ('CONVERTING',    1, 'Teams or Slack live'),
          ('CONVERTING',    2, 'Workflow embedded'),
          ('CONVERTING',    3, 'Compliance satisfaction rated')
       ) AS i (grp, sort, label)
  JOIN clients_product_line l ON lower(btrim(l.name)) = 'symphony'
  JOIN clients_client_type t ON lower(btrim(t.name)) = 'bank'
ON CONFLICT (line_id, client_type_id, grp, lower(btrim(label))) DO NOTHING;

/* Brokerages, and the institutions that follow them. Criteria 1 and 5 are the POC-only ones. */
INSERT INTO clients_checklist_item (line_id, client_type_id, grp, label, sort, poc_only)
SELECT l.id, t.id, i.grp, i.label, i.sort, (i.grp = 'QUALIFICATION' AND i.sort IN (1, 5))
  FROM (VALUES
          ('QUALIFICATION', 1, 'Decision maker (MD or Head of Trading) committed to three review meetings'),
          ('QUALIFICATION', 2, 'Stated interest captured verbatim'),
          ('QUALIFICATION', 3, 'Point person identified'),
          ('QUALIFICATION', 4, 'Finance or procurement contact identified'),
          ('QUALIFICATION', 5, 'Integration pre-configuration started, at least 4 weeks before the start'),
          ('PRE_POC',       1, 'User list final'),
          ('PRE_POC',       2, 'Metrics agreed'),
          ('PRE_POC',       3, 'Communication audit (5 dimensions) done'),
          ('PRE_POC',       4, 'Mandatory workflow identified'),
          ('PRE_POC',       5, 'Week 6 midpoint review booked'),
          ('PRE_POC',       6, 'Configuration Sheet filed'),
          ('PRE_POC',       7, 'Client Intelligence Document on file'),
          ('FOUNDATION',    1, 'Kickoff delivered'),
          ('FOUNDATION',    2, 'All users active'),
          ('FOUNDATION',    3, 'Workflow live on Cloud9'),
          ('FOUNDATION',    4, 'Cloud9 Mobile installed'),
          ('FOUNDATION',    5, 'Week 2 check-in'),
          ('DEEPENING',     1, 'Champion activated'),
          ('DEEPENING',     2, 'Champion recruited a peer'),
          ('DEEPENING',     3, 'Analytics data pulled'),
          ('DEEPENING',     4, 'Analytics shown to the team'),
          ('DEEPENING',     5, 'Week 4 pulse check'),
          ('DEEPENING',     6, 'Usage data presented'),
          ('DEEPENING',     7, 'Conversion signal positive'),
          ('CONVERTING',    1, 'Second workflow added'),
          ('CONVERTING',    2, 'Workflow embedded'),
          ('CONVERTING',    3, 'Messaging upsell started')
       ) AS i (grp, sort, label)
  JOIN clients_product_line l ON lower(btrim(l.name)) = 'symphony'
  JOIN clients_client_type t
    ON lower(btrim(t.name)) IN ('broker', 'microfinance institution', 'digital lender', 'dfi')
ON CONFLICT (line_id, client_type_id, grp, lower(btrim(label))) DO NOTHING;

-- Down Migration

SELECT set_config('lms.audit.actor', 'migration: the Symphony checklists from the POC SOPs (#284), rolled back', true);

/* What the Up added, and nothing a BD manager added beside it. */
DELETE FROM clients_checklist_item
 WHERE id IN (SELECT entity_id::BIGINT
                FROM audit_log
               WHERE entity = 'clients_checklist_item'
                 AND action = 'CREATE'
                 AND actor = 'migration: the Symphony checklists from the POC SOPs (#284)');
