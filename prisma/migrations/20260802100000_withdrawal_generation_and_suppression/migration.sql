-- o3d-6x66: monotonic hold generation, so a stale operator release cannot
-- clear a hold that now represents a NEWER customer request.
--
-- NOT NULL with a DEFAULT, which Postgres stores as metadata only on a modern
-- server: no table rewrite, and existing rows correctly read as generation 0.
ALTER TABLE "sales_orders" ADD COLUMN "withdrawalHoldGeneration" INTEGER NOT NULL DEFAULT 0;

-- Nullable: pre-existing holds have no handled-status history, and NULL
-- correctly reads as "unknown", which makes the next submitted event count as
-- new rather than silently deduplicating it.
ALTER TABLE "sales_orders" ADD COLUMN "withdrawalLastWcStatus" TEXT;
ALTER TABLE "sales_orders" ADD COLUMN "withdrawalLastWcEventAt" TIMESTAMP(3);

-- o3d-d82p: durable memory of an unlinked withdrawal import we refused, so a
-- STALE order.created arriving afterwards cannot import the order anyway.
CREATE TABLE "wc_withdrawal_suppressions" (
  "connector"       TEXT NOT NULL,
  "externalOrderId" TEXT NOT NULL,
  "wcStatus"        TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastCheckedAt"   TIMESTAMP(3),
  "revision"        INTEGER NOT NULL DEFAULT 0,
  "claimToken"      TEXT,
  "claimedAt"       TIMESTAMP(3),
  "clearPendingSince" TIMESTAMP(3),
  CONSTRAINT "wc_withdrawal_suppressions_pkey" PRIMARY KEY ("connector", "externalOrderId")
);
