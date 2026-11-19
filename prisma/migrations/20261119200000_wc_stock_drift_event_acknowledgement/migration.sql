-- Additive: a reviewed acknowledgement of a stock-drift event (who, when, why). Existing rows stay unacknowledged.
ALTER TABLE "wc_stock_drift_events" ADD COLUMN "acknowledged_at" TIMESTAMP(3);
ALTER TABLE "wc_stock_drift_events" ADD COLUMN "acknowledged_by" TEXT;
ALTER TABLE "wc_stock_drift_events" ADD COLUMN "acknowledged_note" TEXT;
