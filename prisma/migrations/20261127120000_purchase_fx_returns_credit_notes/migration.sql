-- expand-only
-- Per-event FX rates for purchasing, step 3b (behind the system switch `purchase_event_fx_rates_enabled`, default off). Additive only: nullable
-- columns and one new table, no backfill. Nothing writes any of them while the switch is off and no bill or receipt was ever valued under it.
--
-- supplier_credit_notes.fx_rate_source: which rule set the credit's rate ('BILL' = the bill it reverses was valued under the switch, so the credit
--   takes that bill's exact rate; 'FX_TABLE' = a credit with no bill, at the fx_rates rate on its own date). NULL = as before (the bill's 8dp rate).
-- supplier_credit_notes.fx_event_rate_to_base: the exact rate the credit is valued and posted at (1 base = rate foreign); fx_rate_to_base keeps its
--   8dp copy. NULL as above.
-- supplier_credit_notes.ppv_base: the base-currency part of the credit coded to the purchase price variance account (a return credit reversing a
--   bill whose price difference went to that account). NULL = the whole credit is on Stock in Transit, as before.
-- purchase_orders.fx_prepayment_refused_*: the remembered refusal of the order's Xero prepayment read (it could not be established), so automatic
--   receipts in every process wait the same window instead of asking again; ignored once a newer lock or "no prepayment" answer exists.
-- purchase_fx_variance_shadows: an exchange-rate difference journal the producer-side hold recorded as a SHADOW (not sent by IMS). The target-state
--   reconciliation counts it as settled, so the difference is never caught up later by a live journal.

ALTER TABLE "supplier_credit_notes" ADD COLUMN "fx_rate_source" TEXT;
ALTER TABLE "supplier_credit_notes" ADD COLUMN "fx_event_rate_to_base" DECIMAL(28,12);
ALTER TABLE "supplier_credit_notes" ADD COLUMN "ppv_base" DECIMAL(18,4);
ALTER TABLE "purchase_orders" ADD COLUMN "fx_prepayment_refused_at" TIMESTAMP(3);
ALTER TABLE "purchase_orders" ADD COLUMN "fx_prepayment_refused_until" TIMESTAMP(3);
ALTER TABLE "purchase_orders" ADD COLUMN "fx_prepayment_refused_reason" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN "fx_prepayment_refused_transient" BOOLEAN;

CREATE TABLE "purchase_fx_variance_shadows" (
    "id" TEXT NOT NULL,
    "po_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "base_delta" DECIMAL(18,2) NOT NULL,
    "journal_date" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_fx_variance_shadows_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "purchase_fx_variance_shadows_idempotency_key_key" ON "purchase_fx_variance_shadows"("idempotency_key");
CREATE INDEX "purchase_fx_variance_shadows_po_id_idx" ON "purchase_fx_variance_shadows"("po_id");
