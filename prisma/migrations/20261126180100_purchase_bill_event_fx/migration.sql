-- expand-only
-- Per-event FX rates for purchasing, step 3 (behind the system switch `purchase_event_fx_rates_enabled`, default off). Additive only: nullable
-- columns (and one zero-default counter), no backfill. Nothing writes any of them while the switch is off.
--
-- purchase_invoices.fx_rate_source: which rule set the bill's rate ('XERO_PREPAYMENT' = the order's prepayment lock, 'FX_TABLE' = the fx_rates
--   rate on the bill date). NULL = the bill was valued at the PO rate (switch off, base currency, or a bill from before the column).
-- purchase_invoices.fx_event_rate_to_base: the exact rate the bill was valued and posted at (1 base = rate foreign); fx_rate_to_base keeps its 8dp copy.
-- purchase_invoices.ppv_base: the base-currency total of the bill's purchase price variance lines (coded to the PPV account, not to transit).
-- purchase_invoice_lines.stock_unit_foreign: the PO goods unit cost the line's stock part is billed at (4dp, supplier currency); the rest of the
--   line is its PPV part. NULL = the line was not split.
-- cost_layers.fx_rate_source: the rule that valued the layer's goods (as purchase_receipts.fx_rate_source), so a layer laid without a receipt row
--   (a Mintsoft alignment) still says how it was valued.
-- wms_inbound_receipt_events.fx_wait_started_at / fx_wait_count: the current episode of book-in waits on the purchase exchange rate, so the waits
--   are capped (3 days or 10 waits) instead of retried for ever.

ALTER TABLE "purchase_invoices" ADD COLUMN "fx_rate_source" TEXT;
ALTER TABLE "purchase_invoices" ADD COLUMN "fx_event_rate_to_base" DECIMAL(28,12);
ALTER TABLE "purchase_invoices" ADD COLUMN "ppv_base" DECIMAL(18,4);
ALTER TABLE "purchase_invoice_lines" ADD COLUMN "stock_unit_foreign" DECIMAL(18,6);
ALTER TABLE "cost_layers" ADD COLUMN "fx_rate_source" TEXT;
ALTER TABLE "wms_inbound_receipt_events" ADD COLUMN "fx_wait_started_at" TIMESTAMP(3);
ALTER TABLE "wms_inbound_receipt_events" ADD COLUMN "fx_wait_count" INTEGER NOT NULL DEFAULT 0;
