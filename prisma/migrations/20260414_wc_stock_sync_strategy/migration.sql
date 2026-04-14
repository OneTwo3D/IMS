CREATE TYPE "WcStockSyncReason" AS ENUM ('IMS_CHANGE', 'WC_WEBHOOK', 'DAILY_RECONCILIATION', 'MANUAL');

CREATE TYPE "WcStockSyncJobStatus" AS ENUM ('PENDING', 'FAILED');

CREATE TABLE "wc_stock_sync_states" (
    "productId" TEXT NOT NULL,
    "lastPushedQty" INTEGER,
    "lastPushedAt" TIMESTAMP(3),
    "lastPushedWcId" BIGINT,
    "lastWebhookQty" INTEGER,
    "lastWebhookAt" TIMESTAMP(3),
    "lastCorrectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wc_stock_sync_states_pkey" PRIMARY KEY ("productId")
);

CREATE TABLE "wc_stock_sync_jobs" (
    "productId" TEXT NOT NULL,
    "reason" "WcStockSyncReason" NOT NULL DEFAULT 'IMS_CHANGE',
    "status" "WcStockSyncJobStatus" NOT NULL DEFAULT 'PENDING',
    "force" BOOLEAN NOT NULL DEFAULT false,
    "webhookQty" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wc_stock_sync_jobs_pkey" PRIMARY KEY ("productId")
);

CREATE INDEX "wc_stock_sync_jobs_status_availableAt_idx" ON "wc_stock_sync_jobs"("status", "availableAt");

ALTER TABLE "wc_stock_sync_states"
ADD CONSTRAINT "wc_stock_sync_states_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "wc_stock_sync_jobs"
ADD CONSTRAINT "wc_stock_sync_jobs_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
