-- expand-only
-- Per-event FX rates for purchasing (switch and interlock off): what the owner's confirmation of a bill posted outside IMS was based on. The command reads
-- the bill's Xero document once (read-only) and stores the answer with the confirmation, so the journal is measured on what is really in Stock in
-- Transit (the Xero bill's own CurrencyRate) and Xero is not asked twice. Additive: nullable columns, no backfill.
--
-- xero_invoice_id: the Xero bill the confirmation was read from. xero_currency_rate: its CurrencyRate (1 base = rate foreign).
-- xero_transit_base: the base value of its lines on the Stock in Transit account. stock_transit_base: the part of it that is the order's goods cost
-- (the basis of the exchange-rate journal; the rest is the bill's price difference, which stays on transit).

ALTER TABLE "purchase_fx_non_ims_bill_approvals" ADD COLUMN "xero_invoice_id" TEXT;
ALTER TABLE "purchase_fx_non_ims_bill_approvals" ADD COLUMN "xero_currency_rate" DECIMAL(28,12);
ALTER TABLE "purchase_fx_non_ims_bill_approvals" ADD COLUMN "xero_transit_base" DECIMAL(18,2);
ALTER TABLE "purchase_fx_non_ims_bill_approvals" ADD COLUMN "stock_transit_base" DECIMAL(18,2);
