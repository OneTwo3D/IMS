-- expand-only
-- Per-event FX rates for purchasing, step 2 (behind the system switch `purchase_event_fx_rates_enabled`, default off).
-- purchase_order_fx_locks: the rate a foreign purchase order's goods lock at, read READ-ONLY from the supplier prepayment the owner records in Xero
-- (Spend Money > Prepayment, Reference = the PO number), with its provenance. One row per purchase order. Nothing writes it while the switch is off.
-- purchase_receipts.fx_rate_source: which rule valued a receipt's goods (XERO_PREPAYMENT or FX_TABLE). NULL = valued at the PO rate, as every
-- receipt was before.
-- Additive only: a new table and one nullable column, no backfill (production is reinstalled).

CREATE TABLE "purchase_order_fx_locks" (
  "id"                    TEXT           NOT NULL,
  "po_id"                 TEXT           NOT NULL,
  "source"                TEXT           NOT NULL,
  "currency"              TEXT           NOT NULL,
  "rate_to_base"          DECIMAL(28,12) NOT NULL,
  "xero_prepayment_id"    TEXT           NOT NULL,
  "xero_tenant_id"        TEXT,
  "xero_contact_id"       TEXT           NOT NULL,
  "prepayment_date"       DATE           NOT NULL,
  "prepayment_total"      DECIMAL(18,4)  NOT NULL,
  "prepayment_status"     TEXT           NOT NULL,
  "read_at"               TIMESTAMP(3)   NOT NULL,
  "read_by_id"            TEXT,
  "first_used_at"         TIMESTAMP(3),
  CONSTRAINT "purchase_order_fx_locks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "purchase_order_fx_locks_rate_positive" CHECK ("rate_to_base" > 0)
);
CREATE UNIQUE INDEX "purchase_order_fx_locks_po_id_key" ON "purchase_order_fx_locks"("po_id");
ALTER TABLE "purchase_order_fx_locks" ADD CONSTRAINT "purchase_order_fx_locks_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_receipts" ADD COLUMN "fx_rate_source" TEXT;
