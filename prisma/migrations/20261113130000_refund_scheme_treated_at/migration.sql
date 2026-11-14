-- Additive: when a refund was recorded under the EU IOSS/VOEC/DDP scheme path. Nullable, no default, no existing row is touched.
ALTER TABLE "sales_order_refunds" ADD COLUMN "scheme_treated_at" TIMESTAMP(3);
