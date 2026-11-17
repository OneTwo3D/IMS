-- Kept because a migration this branch once had may never be deleted (tests/scripts/migration-verifications.test.ts).
-- The change itself lives in 20261117190000_invoice_document_customer_request; this re-states it idempotently and
-- changes nothing on a database where that migration has run.
ALTER TABLE "invoice_document_fetch_states" ADD COLUMN IF NOT EXISTS "customer_requested_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "invoice_document_fetch_states_customer_requested_at_idx" ON "invoice_document_fetch_states"("customer_requested_at");
