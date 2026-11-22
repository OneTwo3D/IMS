-- o3d-pnc8p: the OPEN FEE REPAYMENT is a record of its own, as o3d-ioss-xero 0.2.6 keeps `_o3d_ioss_fee_open`: a refund whose credit note credits a landed-cost fee
-- EAS left out of the refund amount (eas_fee_gap_foreign > 0) stays open until an operator states the fee's repayment was applied to that credit note in Xero.
-- Additive, nullable, no backfill: every existing fee-gap refund reads as open, which is what it is.
--   fee_repayment_applied_at    when the operator acknowledged the repayment as applied.
--   fee_repayment_applied_by    who (the IMS user id); kept even if the user is later removed.
--   fee_repayment_applied_note  what they said they did.
ALTER TABLE "sales_order_refunds" ADD COLUMN "fee_repayment_applied_at" TIMESTAMP(3);
ALTER TABLE "sales_order_refunds" ADD COLUMN "fee_repayment_applied_by" TEXT;
ALTER TABLE "sales_order_refunds" ADD COLUMN "fee_repayment_applied_note" TEXT;
