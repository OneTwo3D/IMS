-- expand-only
-- Per-event FX rates for purchasing (switch and interlock off): the basis an owner's confirmation of a bill posted outside IMS was made on is FROZEN with
-- it, and the confirmation goes STALE when that basis no longer holds. Additive: nullable columns, no backfill.
--
-- stock_units: the order's goods unit cost per order line (supplier currency, after the header discount) the journal is measured on.
-- bill_fingerprint: the IMS bill (its lines' quantities and amounts, its net) as it was confirmed.
-- xero_tenant_id: the Xero organisation that answered the read.
-- stale_at / stale_reason: when and why the confirmation stopped holding (the IMS bill edited, the order's cost edited, the bill linked to another Xero
--   bill). A stale confirmation's journal is held where it is until the bill is confirmed again.

ALTER TABLE "purchase_fx_non_ims_bill_approvals" ADD COLUMN "stock_units" JSONB;
ALTER TABLE "purchase_fx_non_ims_bill_approvals" ADD COLUMN "bill_fingerprint" TEXT;
ALTER TABLE "purchase_fx_non_ims_bill_approvals" ADD COLUMN "xero_tenant_id" TEXT;
ALTER TABLE "purchase_fx_non_ims_bill_approvals" ADD COLUMN "stale_at" TIMESTAMP(3);
ALTER TABLE "purchase_fx_non_ims_bill_approvals" ADD COLUMN "stale_reason" TEXT;
