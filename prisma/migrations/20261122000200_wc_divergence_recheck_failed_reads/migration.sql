-- o3d-7d84p: failed live reads of a deferred WooCommerce order comparison are counted apart from attempts. Additive, NOT NULL with a constant default (no rewrite of meaning, no backfill).
ALTER TABLE "wc_order_divergence_rechecks" ADD COLUMN "failed_reads" INTEGER NOT NULL DEFAULT 0;
