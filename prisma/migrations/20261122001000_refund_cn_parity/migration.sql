-- o3d-k26m.17: refund -> credit-note parity with the November 2026 storefront plugin fixes, written only while the switch
-- `wc_refund_credit_note_parity_enabled` is on. Additive, nullable or defaulted, no backfill: every existing row reads as before.
--   store_credit_refund        the WooCommerce refund was issued as store credit (o3d-store-credit-refund): its credit note is never allocated.
--   eas_fee_gap_foreign        the landed-cost fee the credit note credits beyond what the storefront refund paid (EAS left it out of the amount).
--   storefront_amount_foreign  what the storefront refund paid out, recorded only when the credit note credits more (the fee gap above).
ALTER TABLE "sales_order_refunds" ADD COLUMN "store_credit_refund" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "sales_order_refunds" ADD COLUMN "eas_fee_gap_foreign" DECIMAL(18,4);
ALTER TABLE "sales_order_refunds" ADD COLUMN "storefront_amount_foreign" DECIMAL(18,4);
