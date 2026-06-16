-- Product-level lead time: manual override + auto observed-from-PO value.
-- Both nullable, no backfill in-migration (observed is populated by the
-- recompute-product-lead-times cron / initial backfill run).
ALTER TABLE "products" ADD COLUMN "leadTimeDays" INTEGER;
ALTER TABLE "products" ADD COLUMN "observedLeadTimeDays" INTEGER;

-- Lead time is a positive whole number of days or NULL (use observed/default). Guard
-- against imports / direct writes storing 0 or negative, which the `?? fallback` chain
-- would otherwise treat as a real lead time.
ALTER TABLE "products" ADD CONSTRAINT "products_lead_time_days_positive"
  CHECK ("leadTimeDays" IS NULL OR "leadTimeDays" > 0);
ALTER TABLE "products" ADD CONSTRAINT "products_observed_lead_time_days_positive"
  CHECK ("observedLeadTimeDays" IS NULL OR "observedLeadTimeDays" > 0);
