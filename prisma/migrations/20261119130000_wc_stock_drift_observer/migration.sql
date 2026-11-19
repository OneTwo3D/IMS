-- Additive: the WooCommerce stock-drift observer (switchover o3d-zvec.3, step W). Three new tables; nothing existing is touched.
-- A snapshot is the last stock quantity the observer saw for one WooCommerce product or variation; an event is a change that no order,
-- refund or IMS push explains; a run records that the observer looked (and whether it read the whole catalogue).
CREATE TABLE "wc_stock_snapshots" (
    "external_product_id" TEXT NOT NULL,
    "sku" TEXT,
    "quantity" INTEGER,
    "observed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wc_stock_snapshots_pkey" PRIMARY KEY ("external_product_id")
);

CREATE TABLE "wc_stock_drift_events" (
    "id" TEXT NOT NULL,
    "external_product_id" TEXT NOT NULL,
    "sku" TEXT,
    "from_quantity" INTEGER,
    "to_quantity" INTEGER,
    "previous_observed_at" TIMESTAMP(3) NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wc_stock_drift_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "wc_stock_drift_events_observed_idx" ON "wc_stock_drift_events"("observed_at");

CREATE TABLE "wc_stock_drift_runs" (
    "id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "products_seen" INTEGER NOT NULL DEFAULT 0,
    "drift_found" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "wc_stock_drift_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "wc_stock_drift_runs_started_idx" ON "wc_stock_drift_runs"("started_at");
