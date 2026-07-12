-- q66in.4.6 (Codex r5): the watchdog's staleness anchor must be the last
-- SUCCESSFUL sync — lastStockSyncAt advances on FAILED attempts too, so a
-- binding failing every cadence never looked stale. Backfill from
-- lastStockSyncAt so healthy existing bindings don't mass-alert on deploy.
ALTER TABLE "external_wms_bindings" ADD COLUMN "lastStockSyncSuccessAt" TIMESTAMP(3);
UPDATE "external_wms_bindings" SET "lastStockSyncSuccessAt" = "lastStockSyncAt" WHERE "lastStockSyncStatus" IS DISTINCT FROM 'FAILED';
