-- Supports accounting reconciliation's recent terminal-order scan:
-- WHERE status IN (...) AND "updatedAt" >= ... ORDER BY "updatedAt" DESC.
CREATE INDEX "sales_orders_status_updatedAt_idx"
  ON "sales_orders" ("status", "updatedAt" DESC);
