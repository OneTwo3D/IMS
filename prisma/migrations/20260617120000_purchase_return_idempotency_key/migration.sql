-- Add a nullable idempotency key to purchase_returns so duplicate return
-- submissions/retries can be deduped. purchase_returns is a small, low-write
-- table (one row per supplier return), so a non-concurrent unique index is
-- acceptable; existing rows keep NULL (Postgres allows multiple NULLs in a
-- unique index).
ALTER TABLE "purchase_returns" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "purchase_returns_idempotencyKey_key" ON "purchase_returns"("idempotencyKey");
