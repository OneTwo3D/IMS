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
UPDATE "external_wms_bindings" b
SET "lastStockSyncSuccessAt" = s."lastSuccess"
FROM (
  SELECT j."connector", j."warehouseId", MAX(COALESCE(j."finishedAt", j."startedAt")) AS "lastSuccess"
  FROM "wms_sync_jobs" j
  WHERE j."type" = 'STOCK_SYNC' AND j."status" IN ('SUCCEEDED', 'PARTIAL') AND j."warehouseId" IS NOT NULL
  GROUP BY j."connector", j."warehouseId"
) s
WHERE b."lastStockSyncStatus" = 'FAILED'
  AND b."connector" = s."connector"
  AND b."warehouseId" = s."warehouseId";
