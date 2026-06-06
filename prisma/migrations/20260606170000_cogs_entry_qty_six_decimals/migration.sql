-- Preserve fractional COGS consumption quantities to 6 decimal places while
-- keeping the previous 8-digit integer headroom from DECIMAL(12,4).
-- DEPLOYMENT: this ALTER COLUMN TYPE rewrites cogs_entries and takes an
-- ACCESS EXCLUSIVE lock for the duration. IMS is not live yet; for any live
-- tenant, check cogs_entries row count first and run during a maintenance
-- window after draining queued COGS-related accounting work.
ALTER TABLE "cogs_entries"
  ALTER COLUMN "qty" TYPE DECIMAL(14,6)
  USING "qty"::DECIMAL(14,6);
