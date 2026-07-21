-- o3d-7yf finding 4: make the refund-park dedup RACE-PROOF at the database level. upsertRefundPark's
-- findFirst-then-create has no uniqueness, so two concurrent deliveries of the same WooCommerce refund can
-- both observe no park and both insert. A PARTIAL UNIQUE INDEX enforces at most one ACTIONABLE park per
-- (connector, externalId); the loser of a race gets a unique violation and falls back to updating the
-- winner's row.

-- First collapse any pre-existing duplicate actionable parks (keep the newest per connector+externalId),
-- or the index build would fail.
DELETE FROM "shopping_sync_logs" a
USING "shopping_sync_logs" b
WHERE a.connector = 'woocommerce' AND a.direction = 'FROM_CONNECTOR' AND a."entityType" = 'SalesOrder'
  AND a.status IN ('PENDING', 'FAILED', 'QUARANTINED') AND a."externalId" IS NOT NULL
  AND b.connector = a.connector AND b.direction = a.direction AND b."entityType" = a."entityType"
  AND b.status IN ('PENDING', 'FAILED', 'QUARANTINED') AND b."externalId" = a."externalId"
  AND (b."createdAt" > a."createdAt" OR (b."createdAt" = a."createdAt" AND b.id > a.id));

CREATE UNIQUE INDEX "shopping_sync_logs_active_refund_park_uq"
ON "shopping_sync_logs" (connector, "externalId")
WHERE direction = 'FROM_CONNECTOR'
  AND "entityType" = 'SalesOrder'
  AND status IN ('PENDING', 'FAILED', 'QUARANTINED')
  AND "externalId" IS NOT NULL;
