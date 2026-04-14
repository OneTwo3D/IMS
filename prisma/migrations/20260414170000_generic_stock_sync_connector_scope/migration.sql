ALTER TYPE "WcStockSyncReason" RENAME TO "StockSyncReason";
ALTER TYPE "WcStockSyncJobStatus" RENAME TO "StockSyncJobStatus";

ALTER TABLE "wc_stock_sync_states" RENAME TO "stock_sync_states";
ALTER TABLE "wc_stock_sync_jobs" RENAME TO "stock_sync_jobs";

ALTER TABLE "stock_sync_states"
  RENAME CONSTRAINT "wc_stock_sync_states_productId_fkey" TO "stock_sync_states_productId_fkey";

ALTER TABLE "stock_sync_jobs"
  RENAME CONSTRAINT "wc_stock_sync_jobs_productId_fkey" TO "stock_sync_jobs_productId_fkey";

ALTER TABLE "stock_sync_states"
  ADD COLUMN "connector" TEXT NOT NULL DEFAULT 'woocommerce';

ALTER TABLE "stock_sync_jobs"
  ADD COLUMN "connector" TEXT NOT NULL DEFAULT 'woocommerce';

ALTER TABLE "stock_sync_states"
  ALTER COLUMN "connector" DROP DEFAULT;

ALTER TABLE "stock_sync_jobs"
  ALTER COLUMN "connector" DROP DEFAULT;

ALTER TABLE "stock_sync_states"
  RENAME COLUMN "lastPushedWcId" TO "lastPushedRemoteId";

ALTER TABLE "stock_sync_states"
  ALTER COLUMN "lastPushedRemoteId" TYPE TEXT USING "lastPushedRemoteId"::TEXT;

ALTER TABLE "stock_sync_states"
  DROP CONSTRAINT "wc_stock_sync_states_pkey",
  ADD CONSTRAINT "stock_sync_states_pkey" PRIMARY KEY ("connector", "productId");

ALTER TABLE "stock_sync_jobs"
  DROP CONSTRAINT "wc_stock_sync_jobs_pkey",
  ADD CONSTRAINT "stock_sync_jobs_pkey" PRIMARY KEY ("connector", "productId");

DROP INDEX "wc_stock_sync_jobs_status_availableAt_idx";

CREATE INDEX "stock_sync_jobs_connector_status_availableAt_idx"
ON "stock_sync_jobs"("connector", "status", "availableAt");
