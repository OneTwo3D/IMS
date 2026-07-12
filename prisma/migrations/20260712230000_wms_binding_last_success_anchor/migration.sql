-- q66in.4.6 (Codex r5): the watchdog's staleness anchor must be the last
-- SUCCESSFUL sync — lastStockSyncAt advances on FAILED attempts too, so a
-- binding failing every cadence never looked stale. Backfill from
-- lastStockSyncAt so healthy existing bindings don't mass-alert on deploy.
ALTER TABLE "external_wms_bindings" ADD COLUMN "lastStockSyncSuccessAt" TIMESTAMP(3);
UPDATE "external_wms_bindings" SET "lastStockSyncSuccessAt" = "lastStockSyncAt" WHERE "lastStockSyncStatus" IS DISTINCT FROM 'FAILED';

-- Bindings whose LATEST attempt failed still had prior successes (Codex r6):
-- recover the true last success from job history so they alert three
-- intervals after that success, not immediately on deploy. Bindings with no
-- successful job ever stay NULL and correctly anchor on their creation time.
-- Correlated per FAILED binding (Codex r7): a full-history aggregation would
-- extend the ALTER TABLE exclusive-lock window; this shape rides the
-- (connector, type, status, startedAt) index and FAILED bindings are few.
UPDATE "external_wms_bindings" b
SET "lastStockSyncSuccessAt" = (
  SELECT MAX(COALESCE(j."finishedAt", j."startedAt"))
  FROM "wms_sync_jobs" j
  WHERE j."connector" = b."connector"
    AND j."warehouseId" = b."warehouseId"
    AND j."type" = 'STOCK_SYNC'
    AND j."status" IN ('SUCCEEDED', 'PARTIAL')
)
WHERE b."lastStockSyncStatus" = 'FAILED';
