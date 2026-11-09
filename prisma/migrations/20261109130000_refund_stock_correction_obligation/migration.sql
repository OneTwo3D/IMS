-- A storefront refund that returns quantity owes the storefront a stock correction: the store raised its own stock for the
-- refund before IMS heard of it, and IMS re-pushes its absolute level. The obligation is recorded on the refund row itself
-- so it cannot be lost between the refund's commit and the stock job.
--
-- ADDITIVE ONLY: one boolean with a constant default and one nullable timestamp on a table the previous build still
-- reads and writes without them. Safe to apply to a populated database while the previous build is serving: it omits
-- both columns on INSERT and gets FALSE / NULL, which is exactly "no obligation", the behaviour of every build before this one.
-- Existing rows are NOT backfilled: a refund that already exists owes nothing new.
ALTER TABLE "sales_order_refunds" ADD COLUMN "stock_correction_required" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "sales_order_refunds" ADD COLUMN "stock_correction_queued_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "sales_order_refunds_stock_correction_required_stock_correct_idx" ON "sales_order_refunds"("stock_correction_required", "stock_correction_queued_at");
