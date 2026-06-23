-- khdw: dedicated COGS subledger-movement ledger for the daily-batch COGS GL
-- reconciliation. Supersedes the SalesOrderRefund.cogs_reversal_* columns added
-- earlier in this same (unmerged) feature branch — those captured only the refund
-- stream, but the GL COGS account is also moved by shipment revaluations and
-- landed-cost adjustments. The ledger captures every non-dispatch COGS posting
-- uniformly. Dispatch COGS keeps its native home (shipments.accounting_cogs_batch_amount).

-- Drop the superseded refund-only columns (added in 20260623130000, never merged).
-- migration-convention-ok: DROP COLUMN because these columns were added earlier in
-- this same unmerged feature branch and are superseded by cogs_subledger_movements;
-- no merged/data-bearing environment has depended on them.
ALTER TABLE "sales_order_refunds" DROP COLUMN IF EXISTS "cogs_reversal_base";
ALTER TABLE "sales_order_refunds" DROP COLUMN IF EXISTS "cogs_reversal_journal_date";

CREATE TABLE "cogs_subledger_movements" (
  "id" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_ref" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "base_delta" DECIMAL(18,6) NOT NULL,
  "journal_date" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cogs_subledger_movements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cogs_subledger_movements_idempotency_key_key" ON "cogs_subledger_movements"("idempotency_key");
CREATE INDEX "cogs_subledger_movements_journal_date_idx" ON "cogs_subledger_movements"("journal_date");
