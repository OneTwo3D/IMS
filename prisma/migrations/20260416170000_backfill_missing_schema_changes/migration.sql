-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.

ALTER TYPE "AccountingSyncType" ADD VALUE 'SALES_INVOICE';
ALTER TYPE "AccountingSyncType" ADD VALUE 'CREDIT_NOTE';
ALTER TYPE "AccountingSyncType" ADD VALUE 'STOCK_IN_TRANSIT';
ALTER TYPE "AccountingSyncType" ADD VALUE 'STOCK_RECEIPT';
ALTER TYPE "AccountingSyncType" ADD VALUE 'COGS_REVERSAL';
ALTER TYPE "AccountingSyncType" ADD VALUE 'STOCK_ALLOCATION';
ALTER TYPE "AccountingSyncType" ADD VALUE 'DAILY_BATCH_REVENUE_DEFERRAL';
ALTER TYPE "AccountingSyncType" ADD VALUE 'DAILY_BATCH_INVENTORY_ALLOC';
ALTER TYPE "AccountingSyncType" ADD VALUE 'DAILY_BATCH_GROUP_B';
ALTER TYPE "AccountingSyncType" ADD VALUE 'UNEARNED_REV_REVERSAL';

-- Remove incorrect polymorphic FKs from the initial schema.
ALTER TABLE "accounting_sync_logs" DROP CONSTRAINT "xero_sync_cogs";
ALTER TABLE "accounting_sync_logs" DROP CONSTRAINT "xero_sync_po";
ALTER TABLE "shopping_sync_logs" DROP CONSTRAINT "wc_sync_order";
ALTER TABLE "shopping_sync_logs" DROP CONSTRAINT "wc_sync_product";

ALTER TABLE "accounting_sync_logs"
ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "purchase_invoices"
ADD COLUMN "paidAt" TIMESTAMP(3);

ALTER TABLE "sales_orders"
ADD COLUMN "accounting_allocation_batch_amount" DECIMAL(18,4),
ADD COLUMN "accounting_inventory_allocated_date" TIMESTAMP(3),
ADD COLUMN "accounting_revenue_deferred_date" TIMESTAMP(3),
ADD COLUMN "accounting_unearned_revenue_amount" DECIMAL(18,4),
ADD COLUMN "invoicePdfPath" TEXT,
ADD COLUMN "paymentMethod" TEXT,
ADD COLUMN "paymentMethodTitle" TEXT;

ALTER TABLE "shipments"
ADD COLUMN "accounting_cogs_batch_amount" DECIMAL(18,4),
ADD COLUMN "accounting_revenue_recognized_amount" DECIMAL(18,4),
ADD COLUMN "accounting_shipment_journal_date" TIMESTAMP(3);

ALTER TABLE "stock_sync_jobs"
ALTER COLUMN "updatedAt" DROP DEFAULT;

ALTER TABLE "stock_sync_states"
ALTER COLUMN "updatedAt" DROP DEFAULT;

CREATE TABLE "accounting_tokens" (
    "id" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tenantName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounting_tokens_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "accounting_sync_logs_status_createdAt_idx" ON "accounting_sync_logs"("status", "createdAt");
CREATE UNIQUE INDEX "product_options_productId_name_key" ON "product_options"("productId", "name");
CREATE INDEX "purchase_orders_supplierId_idx" ON "purchase_orders"("supplierId");
CREATE INDEX "purchase_orders_createdAt_idx" ON "purchase_orders"("createdAt");
CREATE INDEX "sales_orders_createdAt_idx" ON "sales_orders"("createdAt");
