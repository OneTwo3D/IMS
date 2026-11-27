-- unpaid-invoice deferral: additive only. Two NULLABLE columns with no default and one new enum type. NULL is the meaning every existing
-- row already has (deferred on the day it was paid), so nothing is backfilled and a predecessor serving across the window
-- writes rows that read exactly as before. Only Group A1 with `xero_defer_unpaid_invoiced_revenue_enabled` on writes them.
CREATE TYPE "RevenueDeferralBasis" AS ENUM ('PAID', 'INVOICE');

ALTER TABLE "sales_orders"
  ADD COLUMN "accounting_revenue_deferral_basis" "RevenueDeferralBasis",
  ADD COLUMN "accounting_revenue_deferral_event_at" TIMESTAMP(3);
