-- Up Migration

-- The product lines and products the company sells today. #293.
--
-- A migration rather than the seed, so production has them too. From here they are a BD
-- manager's to keep on the setup screen. A line or product somebody already added by hand under
-- the same name, in any case, is left as it is rather than refused.

/* Named in the audit log as this migration, rather than "not named by the writer". */
SELECT set_config('lms.audit.actor', 'migration: the current product lines (#293)', true);

INSERT INTO clients_product_line (name)
VALUES ('Symphony'), ('Dura Capital'), ('Riskflow'), ('AIC One')
ON CONFLICT (lower(btrim(name))) DO NOTHING;

INSERT INTO clients_product (line_id, name)
SELECT l.id, p.name
  FROM (VALUES
          ('Symphony', 'Messaging'),
          ('Symphony', 'Federation'),
          ('Symphony', 'Cloud9'),
          ('Dura Capital', 'OnboardStudio'),
          ('Dura Capital', 'CreditStudio'),
          ('Dura Capital', 'MicroStudio'),
          ('Riskflow', 'Treasury'),
          ('Riskflow', 'ALM'),
          ('AIC One', 'ComplyOn'),
          ('AIC One', 'Proba Workflows'),
          ('AIC One', 'EngageNet'),
          ('AIC One', 'Proba Analytics'),
          ('AIC One', 'Orcaa.ai'),
          ('AIC One', 'X-Verdict')
       ) AS p (line, name)
  JOIN clients_product_line l ON lower(btrim(l.name)) = lower(p.line)
ON CONFLICT (lower(btrim(name))) DO NOTHING;

-- Down Migration

SELECT set_config('lms.audit.actor', 'migration: the current product lines (#293), rolled back', true);

DELETE FROM clients_product
 WHERE lower(btrim(name)) IN (
         'messaging', 'federation', 'cloud9', 'onboardstudio', 'creditstudio', 'microstudio',
         'treasury', 'alm', 'complyon', 'proba workflows', 'engagenet', 'proba analytics',
         'orcaa.ai', 'x-verdict');

DELETE FROM clients_product_line l
 WHERE lower(btrim(l.name)) IN ('symphony', 'dura capital', 'riskflow', 'aic one')
   AND NOT EXISTS (SELECT 1 FROM clients_product p WHERE p.line_id = l.id);
