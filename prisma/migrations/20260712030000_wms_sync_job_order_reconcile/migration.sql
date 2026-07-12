-- q66in.4.4: scheduled order-level reconciliation runs get their own job type.
ALTER TYPE "WmsSyncJobType" ADD VALUE IF NOT EXISTS 'ORDER_RECONCILE';

-- Rotation stamp: the capped reconcile verifies least-recently-checked links first.
ALTER TABLE "wms_order_push_links" ADD COLUMN "reconcileCheckedAt" TIMESTAMP(3);
