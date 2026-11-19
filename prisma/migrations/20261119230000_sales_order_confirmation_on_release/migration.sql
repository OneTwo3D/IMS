-- Additive: one-shot claim marker for the release-time order confirmation e-mail (orders imported held). Nullable, no backfill: existing orders never qualify.
ALTER TABLE "sales_orders" ADD COLUMN "confirmationOnReleasePendingAt" TIMESTAMP(3);
