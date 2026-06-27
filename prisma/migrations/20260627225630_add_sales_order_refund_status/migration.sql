-- Orthogonal refund disposition for sales orders (epic: orthogonal refund status).
-- Additive + safe-default column; backfill derives the disposition from the legacy
-- status values that currently encode refund state. Guarded for idempotency so a
-- partially-applied migration can be safely re-run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RefundDisposition') THEN
    CREATE TYPE "RefundDisposition" AS ENUM ('NONE', 'PARTIAL', 'FULL');
  END IF;
END $$;

ALTER TABLE "sales_orders"
  ADD COLUMN IF NOT EXISTS "refundStatus" "RefundDisposition" NOT NULL DEFAULT 'NONE';

-- Single bounded backfill (one pass, halves the lock surface vs two UPDATEs).
SET LOCAL statement_timeout = '60s';
UPDATE "sales_orders"
SET "refundStatus" = CASE
    WHEN "status" = 'REFUNDED' THEN 'FULL'::"RefundDisposition"
    WHEN "status" = 'PARTIALLY_REFUNDED' THEN 'PARTIAL'::"RefundDisposition"
  END
WHERE "status" IN ('REFUNDED', 'PARTIALLY_REFUNDED')
  AND "refundStatus" = 'NONE';
