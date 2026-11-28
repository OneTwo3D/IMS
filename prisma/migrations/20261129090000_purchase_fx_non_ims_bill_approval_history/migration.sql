-- expand-only
-- Per-event FX rates for purchasing (switch and interlock off): a re-confirmation of a bill posted outside IMS keeps the confirmation it replaces, here,
-- instead of deleting it (the live table keeps one row per bill). Additive: a new table, no backfill.

CREATE TABLE "purchase_fx_non_ims_bill_approval_history" (
    "id" TEXT NOT NULL,
    "approval_id" TEXT NOT NULL,
    "po_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "superseded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded_by" TEXT NOT NULL,

    CONSTRAINT "purchase_fx_non_ims_bill_approval_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "purchase_fx_non_ims_bill_approval_history_invoice_id_idx" ON "purchase_fx_non_ims_bill_approval_history"("invoice_id");
