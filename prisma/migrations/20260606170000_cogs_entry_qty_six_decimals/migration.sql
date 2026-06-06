-- Preserve fractional COGS consumption quantities to 6 decimal places while
-- keeping the previous 8-digit integer headroom from DECIMAL(12,4).
ALTER TABLE "cogs_entries"
  ALTER COLUMN "qty" TYPE DECIMAL(14,6)
  USING "qty"::DECIMAL(14,6);
