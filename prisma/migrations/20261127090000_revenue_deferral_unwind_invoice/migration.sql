-- Unpaid-invoice deferral: the invoice an owed unwind is for. Additive only: one NULLABLE column, no default, no backfill.
ALTER TABLE "sales_orders" ADD COLUMN "accounting_revenue_deferral_unwind_invoice_id" TEXT;
