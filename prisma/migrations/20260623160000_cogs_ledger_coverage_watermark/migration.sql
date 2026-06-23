-- khdw: durable coverage watermark for the COGS subledger reconciliation. The
-- cogs_subledger_movements ledger is append-only and has NO pre-deploy history, so
-- the reconciliation must only reconcile windows that opened on/after the date the
-- ledger began capturing every COGS posting — which is the date this migration (and
-- the ledger write-sites it ships with) is deployed. Stored as a plain YYYY-MM-DD
-- string (non-sensitive setting → raw value, matching serializeSettingValue).
--
-- CURRENT_DATE is the deploy date. A reconciliation window (opening, closing] counts
-- only postings dated strictly after `opening`, so a window whose opening >= this
-- watermark contains only fully-captured (post-deploy) postings. ON CONFLICT DO
-- NOTHING keeps the original watermark if the migration is ever re-run.
INSERT INTO "settings" ("key", "value", "updatedAt")
VALUES ('cogs_ledger_coverage_start_date', CURRENT_DATE::text, NOW())
ON CONFLICT ("key") DO NOTHING;
