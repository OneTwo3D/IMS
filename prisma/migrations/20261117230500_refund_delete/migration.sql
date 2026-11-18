-- o3d-ngmt.22: delete a refund recorded in error, and void its credit note in the ledger.
-- Additive only: one sync type, one table, one nullable column with an index. Nothing existing is rewritten.

-- AlterEnum
ALTER TYPE "AccountingSyncType" ADD VALUE 'CREDIT_NOTE_VOID';

-- AlterTable: which return movement created a layer (NULL on every row that exists today; never backfilled).
ALTER TABLE "cost_layers" ADD COLUMN "return_movement_id" TEXT;
CREATE INDEX "cost_layers_return_movement_id_idx" ON "cost_layers"("return_movement_id");

-- CreateTable
CREATE TABLE "sales_order_refund_deletions" (
    "id" TEXT NOT NULL,
    "refund_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "credit_note_number" TEXT,
    "accounting_credit_note_id" TEXT,
    "total_base" DECIMAL(18,4) NOT NULL,
    "total_foreign" DECIMAL(18,4) NOT NULL,
    "reason" TEXT,
    "deleted_by_id" TEXT,
    "deleted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "void_sync_log_id" TEXT,
    "reversal" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "sales_order_refund_deletions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_order_refund_deletions_refund_id_key" ON "sales_order_refund_deletions"("refund_id");
CREATE INDEX "sales_order_refund_deletions_order_id_idx" ON "sales_order_refund_deletions"("order_id");
