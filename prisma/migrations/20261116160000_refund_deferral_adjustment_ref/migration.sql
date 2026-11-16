-- Additive: the Group A1 adjustment journal that netted a refund out of its order's revenue deferral. Nullable, no default, no backfill: every existing row reads NULL (never netted by the batch; a deferral stored before this column is gross).
ALTER TABLE "sales_order_refunds" ADD COLUMN "deferral_adjustment_ref" TEXT;
