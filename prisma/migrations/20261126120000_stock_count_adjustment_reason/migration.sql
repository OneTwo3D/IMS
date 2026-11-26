-- Additive, insert-if-missing. Stock counts post their variances under an adjustment reason called "Stock count" when the operator
-- chooses none and the switch `stock_adjustment_reason_cost_required` is on. Seed it so stock counts stay workable once the switch
-- is turned on. It carries NO account: the owner maps one in Settings > Adjustment reasons (an unmapped valued variance is refused
-- while accounting sync is on, naming this reason). Skipped when any reason of that name already exists (case-insensitive), so a
-- reason the owner or a first load already configured is never duplicated or changed. No existing row is touched.
INSERT INTO "adjustment_reasons" ("id", "name", "sort_order", "active", "created_at", "updated_at")
SELECT 'sysreason_stock_count', 'Stock count', 0, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "adjustment_reasons" WHERE lower(trim("name")) = 'stock count');
