-- 6oyu.4 (epic khdw): dedicated STOCK_IN_TRANSIT subledger-movement ledger for the
-- daily-batch transit GL reconciliation. Transit is a clearing account moved by
-- purchase bills (debits) and receipt/reclass/credit-note/cancellation postings
-- (credits); this ledger captures every such posting uniformly as a signed row so
-- the reconciliation can tie Σ subledger movement to the GL transit period movement.
-- Mirrors cogs_subledger_movements (20260623150000).

CREATE TABLE "transit_subledger_movements" (
  "id" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_ref" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "base_delta" DECIMAL(18,6) NOT NULL,
  "journal_date" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "transit_subledger_movements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "transit_subledger_movements_idempotency_key_key" ON "transit_subledger_movements"("idempotency_key");
CREATE INDEX "transit_subledger_movements_journal_date_idx" ON "transit_subledger_movements"("journal_date");
