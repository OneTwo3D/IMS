-- GR/IR (goods received, not invoiced) accrual: an append-only sub-ledger written with each receipt, bill, bill edit, supplier return
-- and return-generated credit note, plus the sync type of the daily-batch reclass journal that posts it (behind a setting, default off).
-- Additive only. No backfill: production is reinstalled; stage uses scripts/grir-opening-balance.ts.

-- AlterEnum
ALTER TYPE "AccountingSyncType" ADD VALUE IF NOT EXISTS 'DAILY_BATCH_GRIR_RECLASS';

CREATE TABLE "grir_subledger_movements" (
  "id" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_ref" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "po_id" TEXT NOT NULL,
  "po_line_id" TEXT,
  "supplier_id" TEXT NOT NULL,
  "qty_delta" DECIMAL(18,6),
  "base_delta" DECIMAL(18,6) NOT NULL,
  "journal_date" TIMESTAMP(3) NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "xero_batch_ref" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "grir_subledger_movements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "grir_subledger_movements_idempotency_key_key" ON "grir_subledger_movements"("idempotency_key");
CREATE INDEX "grir_subledger_movements_po_id_idx" ON "grir_subledger_movements"("po_id");
CREATE INDEX "grir_subledger_movements_supplier_id_idx" ON "grir_subledger_movements"("supplier_id");
CREATE INDEX "grir_subledger_movements_journal_date_idx" ON "grir_subledger_movements"("journal_date");
CREATE INDEX "grir_subledger_movements_xero_batch_ref_idx" ON "grir_subledger_movements"("xero_batch_ref");
