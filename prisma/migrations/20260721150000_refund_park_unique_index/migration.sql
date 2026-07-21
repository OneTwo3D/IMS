-- prisma-schema-scope-ok: db-native partial UNIQUE index — Prisma cannot represent a partial index WHERE
-- predicate, so this cannot live in schema.prisma; it enforces one actionable refund park per refund.
--
-- o3d-7yf finding 4: make the refund-park dedup RACE-PROOF at the database level. upsertRefundPark's
-- findFirst-then-create has no uniqueness, so two concurrent deliveries of the same WooCommerce refund can
-- both observe no park and both insert. A PARTIAL UNIQUE INDEX enforces at most one ACTIONABLE park per
-- (connector, externalId); the loser of a race gets a unique violation and falls back to updating the
-- winner's row.
--
-- Scoped tightly to REFUND parks: connector='woocommerce', direction='FROM_CONNECTOR',
-- entityType='SalesOrder', an actionable status, AND entityId IS NOT NULL. That last discriminator is what
-- separates a refund park (entityId = the IMS order id) from an order-IMPORT failure log (same
-- connector/direction/type + an externalId but NO entityId) and from the entity-less missing-FX queue rows
-- — so neither the dedup DELETE nor the index touch those.

-- First collapse any pre-existing duplicate actionable REFUND parks (keep the newest per
-- connector+externalId), or the index build would fail. Import-failure rows (entityId IS NULL) are excluded.
DELETE FROM "shopping_sync_logs" a
USING "shopping_sync_logs" b
WHERE a.connector = 'woocommerce' AND a.direction = 'FROM_CONNECTOR' AND a."entityType" = 'SalesOrder'
  AND a.status IN ('PENDING', 'FAILED', 'QUARANTINED') AND a."externalId" IS NOT NULL AND a."entityId" IS NOT NULL
  AND b.connector = a.connector AND b.direction = a.direction AND b."entityType" = a."entityType"
  AND b.status IN ('PENDING', 'FAILED', 'QUARANTINED') AND b."externalId" = a."externalId" AND b."entityId" IS NOT NULL
  AND (b."createdAt" > a."createdAt" OR (b."createdAt" = a."createdAt" AND b.id > a.id));

CREATE UNIQUE INDEX "shopping_sync_logs_active_refund_park_uq"
ON "shopping_sync_logs" (connector, "externalId")
WHERE connector = 'woocommerce'
  AND direction = 'FROM_CONNECTOR'
  AND "entityType" = 'SalesOrder'
  AND status IN ('PENDING', 'FAILED', 'QUARANTINED')
  AND "externalId" IS NOT NULL
  AND "entityId" IS NOT NULL;
