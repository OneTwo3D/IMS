-- Additive: a nullable claim column on wc_order_divergences, so the amendment write step acts once on one set of differences.
ALTER TABLE "wc_order_divergences" ADD COLUMN "amendment_claim" TEXT;
