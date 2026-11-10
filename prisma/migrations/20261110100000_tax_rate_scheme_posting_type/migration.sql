-- Tax rates: the scheme posting type column, again, as a no-op.
--
-- This migration directory existed for a short time in this branch's history (the migration below was renamed to this name and renamed back), and a migration that
-- has ever been committed may not be deleted from HEAD (tests/scripts/migration-verifications.test.ts). It therefore stays, and it is idempotent: the column was added by
-- 20261109230000_tax_rate_scheme_posting_type, which sorts first, so on every database this adds nothing.
ALTER TABLE "tax_rates" ADD COLUMN IF NOT EXISTS "scheme_posting_tax_type" TEXT;
