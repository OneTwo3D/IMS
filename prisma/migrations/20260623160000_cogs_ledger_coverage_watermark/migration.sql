-- khdw: durable coverage watermark for the COGS subledger reconciliation. The
-- cogs_subledger_movements ledger is append-only and has NO pre-deploy history, so
-- the reconciliation must only reconcile windows that opened on/after the date the
-- ledger began capturing every COGS posting — which is the date this migration (and
-- the ledger write-sites it ships with) is deployed. Stored as a plain YYYY-MM-DD
-- string (non-sensitive setting → raw value, matching serializeSettingValue).
--
-- Watermark = the day AFTER the migration applies (CURRENT_DATE + 1). The migration
-- runs as part of deploy but the new app code (which writes the ledger rows) goes
-- live moments later; a midnight-crossing rollout could otherwise let a posting dated
-- on the deploy date be written by OLD code with no ledger row yet still pass the
-- gate. Using deploy_date + 1 guarantees the first reconcilable window contains only
-- postings made while the new code is fully live. A reconciliation window
-- (opening, closing] counts only postings dated strictly after `opening`, so a window
-- whose opening >= this watermark contains only fully-captured postings.
--
-- to_char(..., 'YYYY-MM-DD') is datestyle-independent (CURRENT_DATE::text is not).
-- ON CONFLICT DO NOTHING keeps the original watermark if the migration is re-run.
INSERT INTO "settings" ("key", "value", "updatedAt")
VALUES ('cogs_ledger_coverage_start_date', to_char(CURRENT_DATE + INTERVAL '1 day', 'YYYY-MM-DD'), NOW())
ON CONFLICT ("key") DO NOTHING;
