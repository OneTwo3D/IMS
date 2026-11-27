-- Unpaid-invoice deferral, unwind on a voided or deleted invoice. Additive only: four NULLABLE columns, no default, no
-- backfill. NULL on every existing row means "no unwind owed", which is true of every order deferred before this change.
ALTER TABLE "sales_orders"
  ADD COLUMN "accounting_revenue_deferral_unwind_owed_at" TIMESTAMP(3),
  ADD COLUMN "accounting_revenue_deferral_unwind_reason" TEXT,
  ADD COLUMN "accounting_revenue_deferral_unwound_amount" DECIMAL(18,4),
  ADD COLUMN "accounting_revenue_deferral_unwind_ref" TEXT;
