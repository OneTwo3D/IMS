-- expand-only
-- Per-event FX rates for purchasing (behind `purchase_event_fx_rates_enabled` and its interlock, both off): the owner's gate for bills that reached Xero
-- outside IMS. One row per bill an admin confirmed (npm run purchase-fx:non-ims-bills -- --yes --confirm-admin): from then on the exchange-rate
-- difference reconciliation treats the bill as being in Stock in Transit and posts its one-off journal through the accounting queue. Additive: a new
-- table, no backfill; nothing writes it while the switch is off.

CREATE TABLE "purchase_fx_non_ims_bill_approvals" (
    "id" TEXT NOT NULL,
    "po_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "approved_by" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "proposed_transit_delta" DECIMAL(18,2) NOT NULL,
    "approved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_fx_non_ims_bill_approvals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "purchase_fx_non_ims_bill_approvals_invoice_id_key" ON "purchase_fx_non_ims_bill_approvals"("invoice_id");
CREATE INDEX "purchase_fx_non_ims_bill_approvals_po_id_idx" ON "purchase_fx_non_ims_bill_approvals"("po_id");
