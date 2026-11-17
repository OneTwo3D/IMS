-- Additive: one table recording a WooCommerce-vs-IMS order divergence found read-only by the order.updated path. One row per order (unique order_id);
-- reopened on a new difference, closed when a later delivery matches. Nothing existing is touched.
CREATE TABLE "wc_order_divergences" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "external_order_number" TEXT,
    "differences" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "seen_count" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "resolution" TEXT,

    CONSTRAINT "wc_order_divergences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wc_order_divergences_order_id_key" ON "wc_order_divergences"("order_id");
CREATE INDEX "wc_order_divergences_open_idx" ON "wc_order_divergences"("resolved_at", "first_seen_at");
