-- Additive: a part of the paid amount that the ledger no longer holds (o3d-cdhl). Two nullable columns on sales_orders
-- (NULL for every existing order) and one new history table. Nothing is backfilled and nothing is dropped.
ALTER TABLE "sales_orders" ADD COLUMN "payment_removed_foreign" DECIMAL(18,4);
ALTER TABLE "sales_orders" ADD COLUMN "payment_removed_at" TIMESTAMP(3);

CREATE TABLE "payment_removal_reconciliations" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "accounting_invoice_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount_foreign" DECIMAL(18,4) NOT NULL,
    "recorded_paid_foreign" DECIMAL(18,4) NOT NULL,
    "ledger_paid_foreign" DECIMAL(18,4) NOT NULL,
    "document_total_foreign" DECIMAL(18,4) NOT NULL,
    "shortfall_before_foreign" DECIMAL(18,4) NOT NULL,
    "shortfall_after_foreign" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "matched_payment_ids" JSONB NOT NULL DEFAULT '[]',
    "ledger_action" TEXT NOT NULL DEFAULT 'OPERATOR_DECISION',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_removal_reconciliations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payment_removal_reconciliations_order_id_idx" ON "payment_removal_reconciliations"("order_id");

ALTER TABLE "payment_removal_reconciliations" ADD CONSTRAINT "payment_removal_reconciliations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
