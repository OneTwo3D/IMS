-- Intentionally a no-op. An earlier revision of this branch seeded an adjustment reason called "Stock count" here; that seed was dropped
-- because a seeded row changes behaviour while the switch `stock_adjustment_reason_cost_required` is off (bulk-dialog default, the
-- free-text reason box, the adjustment report). The file stays because a migration this branch has added may not be deleted. Nothing
-- was ever applied from it. The owner creates, activates and maps a "Stock count" reason in Settings before turning the switch on.
SELECT 1;
