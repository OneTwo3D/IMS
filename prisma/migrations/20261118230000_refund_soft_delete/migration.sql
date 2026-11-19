-- Refund delete becomes a SOFT delete (owner decision 2026-11-18): the refund row and its lines are kept for audit and
-- marked deleted; readers skip a row with deleted_at set. Additive; every existing row is live (NULL).
ALTER TABLE "sales_order_refunds" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "sales_order_refunds" ADD COLUMN "deleted_by_id" TEXT;
ALTER TABLE "sales_order_refunds" ADD COLUMN "delete_reason" TEXT;
CREATE INDEX "sales_order_refunds_orderId_deleted_at_idx" ON "sales_order_refunds"("orderId", "deleted_at");
