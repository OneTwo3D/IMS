-- A tax re-key (lib/tax/tax-rekey.ts) points the rate it deactivated at its replacement, so document writers can resolve a stale id.
ALTER TABLE "tax_rates" ADD COLUMN "replaced_by_id" TEXT;
