CREATE TYPE "WmsStockSyncMode" AS ENUM (
  'DISABLED',
  'NOTIFICATION_ONLY',
  'ALIGN_TO_WMS'
);

CREATE TYPE "WmsStockMasterSystem" AS ENUM (
  'IMS',
  'WMS'
);

CREATE TYPE "WmsBundleSyncDirection" AS ENUM (
  'DISABLED',
  'IMS_TO_WMS',
  'WMS_TO_IMS'
);

CREATE TYPE "WmsReturnsMode" AS ENUM (
  'DISABLED',
  'POLL',
  'WEBHOOK'
);

CREATE TYPE "WmsSyncJobType" AS ENUM (
  'STOCK_SYNC',
  'PRODUCT_SYNC',
  'BUNDLE_SYNC',
  'ASN_CREATE',
  'ASN_CALLBACK',
  'RETURNS_SYNC',
  'PRODUCT_VERIFY'
);

CREATE TYPE "WmsSyncJobStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'PARTIAL'
);

CREATE TYPE "WmsDiscrepancyCategory" AS ENUM (
  'MISSING_IN_IMS',
  'MISSING_IN_WMS',
  'QTY_MISMATCH',
  'UNMAPPED_SKU',
  'RECEIPT_TIMING_CONFLICT',
  'BUNDLE_DERIVATION_CONFLICT',
  'BARCODE_CONFLICT',
  'BARCODE_BACKFILLED_FROM_WMS'
);

CREATE TYPE "WmsDiscrepancyStatus" AS ENUM (
  'OPEN',
  'ACKNOWLEDGED',
  'RESOLVED',
  'IGNORED'
);

CREATE TYPE "WmsReturnsInboxStatus" AS ENUM (
  'NEW',
  'UNDER_REVIEW',
  'RESTOCKED',
  'QUARANTINED',
  'REFUNDED_ONLY',
  'REPLACED',
  'INSPECT',
  'DISMISSED'
);

CREATE TABLE "wms_connections" (
  "id" TEXT NOT NULL,
  "connector" TEXT NOT NULL,
  "label" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "baseUrl" TEXT,
  "orderLookupConnector" TEXT,
  "tokenExpiresAt" TIMESTAMP(3),
  "lastAuthAt" TIMESTAMP(3),
  "callbackSecretId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "wms_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "external_wms_bindings" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "warehouseId" TEXT NOT NULL,
  "connector" TEXT NOT NULL,
  "externalWarehouseId" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "stockSyncMode" "WmsStockSyncMode" NOT NULL DEFAULT 'NOTIFICATION_ONLY',
  "stockMasterSystem" "WmsStockMasterSystem" NOT NULL DEFAULT 'IMS',
  "bundleSyncDirection" "WmsBundleSyncDirection" NOT NULL DEFAULT 'DISABLED',
  "returnsMode" "WmsReturnsMode" NOT NULL DEFAULT 'DISABLED',
  "syncFrequencyMinutes" INTEGER NOT NULL DEFAULT 60,
  "discrepancyThresholds" JSONB,
  "reportRecipients" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "lastStockSyncAt" TIMESTAMP(3),
  "lastStockSyncStatus" "WmsSyncJobStatus",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "external_wms_bindings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wms_product_links" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "connector" TEXT NOT NULL,
  "externalProductId" TEXT NOT NULL,
  "payloadHash" TEXT,
  "lastKnownBarcode" TEXT,
  "metadata" JSONB,
  "lastSyncedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "wms_product_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wms_bundle_links" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "connector" TEXT NOT NULL,
  "externalBundleId" TEXT NOT NULL,
  "checksum" TEXT,
  "lastSyncedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "wms_bundle_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wms_asn_maps" (
  "id" TEXT NOT NULL,
  "connector" TEXT NOT NULL,
  "externalAsnId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "warehouseId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "lastCallbackAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "wms_asn_maps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wms_asn_line_maps" (
  "id" TEXT NOT NULL,
  "asnMapId" TEXT NOT NULL,
  "externalAsnLineId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceLineId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "sku" TEXT NOT NULL,
  "expectedQty" DECIMAL(12,4) NOT NULL,
  "qtyAccountedViaSnapshot" DECIMAL(12,4) NOT NULL DEFAULT 0,
  "qtyAccountedViaReceipt" DECIMAL(12,4) NOT NULL DEFAULT 0,
  "lastProcessedReceivedQty" DECIMAL(12,4) NOT NULL DEFAULT 0,
  "lastCallbackAt" TIMESTAMP(3),

  CONSTRAINT "wms_asn_line_maps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wms_sync_jobs" (
  "id" TEXT NOT NULL,
  "connector" TEXT NOT NULL,
  "type" "WmsSyncJobType" NOT NULL,
  "status" "WmsSyncJobStatus" NOT NULL,
  "warehouseId" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3),
  "totalChecked" INTEGER NOT NULL DEFAULT 0,
  "matched" INTEGER NOT NULL DEFAULT 0,
  "mismatched" INTEGER NOT NULL DEFAULT 0,
  "corrected" INTEGER NOT NULL DEFAULT 0,
  "skipped" INTEGER NOT NULL DEFAULT 0,
  "errors" INTEGER NOT NULL DEFAULT 0,
  "summary" JSONB,
  "triggeredBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "wms_sync_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wms_sync_logs" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "sku" TEXT,
  "productId" TEXT,
  "action" TEXT NOT NULL,
  "imsQtyBefore" DECIMAL(12,4),
  "imsQtyAfter" DECIMAL(12,4),
  "wmsQty" DECIMAL(12,4),
  "delta" DECIMAL(12,4),
  "reason" TEXT,
  "payload" JSONB,

  CONSTRAINT "wms_sync_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wms_stock_snapshots" (
  "id" TEXT NOT NULL,
  "connector" TEXT NOT NULL,
  "warehouseId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "externalQty" DECIMAL(12,4) NOT NULL,
  "imsQtyAtSync" DECIMAL(12,4) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "wms_stock_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wms_stock_discrepancies" (
  "id" TEXT NOT NULL,
  "connector" TEXT NOT NULL,
  "warehouseId" TEXT NOT NULL,
  "productId" TEXT,
  "sku" TEXT,
  "category" "WmsDiscrepancyCategory" NOT NULL,
  "status" "WmsDiscrepancyStatus" NOT NULL DEFAULT 'OPEN',
  "imsValue" TEXT,
  "wmsValue" TEXT,
  "delta" DECIMAL(12,4),
  "message" TEXT,
  "detectionCount" INTEGER NOT NULL DEFAULT 1,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "resolvedBy" TEXT,
  "resolvedNote" TEXT,

  CONSTRAINT "wms_stock_discrepancies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wms_inbound_receipt_events" (
  "id" TEXT NOT NULL,
  "connector" TEXT NOT NULL,
  "externalEventId" TEXT NOT NULL,
  "externalAsnId" TEXT,
  "payload" JSONB NOT NULL,
  "processedAt" TIMESTAMP(3),
  "processingError" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "wms_inbound_receipt_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wms_returns_inbox" (
  "id" TEXT NOT NULL,
  "connector" TEXT NOT NULL,
  "externalReturnId" TEXT NOT NULL,
  "orderId" TEXT,
  "productId" TEXT,
  "sku" TEXT,
  "qty" DECIMAL(12,4),
  "reason" TEXT,
  "reference" TEXT,
  "warehouseId" TEXT,
  "receivedAt" TIMESTAMP(3),
  "status" "WmsReturnsInboxStatus" NOT NULL DEFAULT 'NEW',
  "rawPayload" JSONB,
  "resolvedAt" TIMESTAMP(3),
  "resolvedBy" TEXT,
  "resolutionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "wms_returns_inbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wms_connections_connector_key"
  ON "wms_connections"("connector");

CREATE UNIQUE INDEX "external_wms_bindings_warehouseId_key"
  ON "external_wms_bindings"("warehouseId");

CREATE UNIQUE INDEX "external_wms_bindings_connector_externalWarehouseId_key"
  ON "external_wms_bindings"("connector", "externalWarehouseId");

CREATE UNIQUE INDEX "wms_product_links_connector_externalProductId_key"
  ON "wms_product_links"("connector", "externalProductId");

CREATE UNIQUE INDEX "wms_product_links_connector_productId_key"
  ON "wms_product_links"("connector", "productId");

CREATE INDEX "wms_product_links_productId_idx"
  ON "wms_product_links"("productId");

CREATE UNIQUE INDEX "wms_bundle_links_connector_externalBundleId_key"
  ON "wms_bundle_links"("connector", "externalBundleId");

CREATE UNIQUE INDEX "wms_bundle_links_connector_productId_key"
  ON "wms_bundle_links"("connector", "productId");

CREATE UNIQUE INDEX "wms_asn_maps_connector_externalAsnId_key"
  ON "wms_asn_maps"("connector", "externalAsnId");

CREATE INDEX "wms_asn_maps_sourceType_sourceId_idx"
  ON "wms_asn_maps"("sourceType", "sourceId");

CREATE UNIQUE INDEX "wms_asn_line_maps_asnMapId_externalAsnLineId_key"
  ON "wms_asn_line_maps"("asnMapId", "externalAsnLineId");

CREATE INDEX "wms_asn_line_maps_sourceType_sourceLineId_idx"
  ON "wms_asn_line_maps"("sourceType", "sourceLineId");

CREATE INDEX "wms_asn_line_maps_productId_idx"
  ON "wms_asn_line_maps"("productId");

CREATE INDEX "wms_sync_jobs_connector_type_status_startedAt_idx"
  ON "wms_sync_jobs"("connector", "type", "status", "startedAt");

CREATE INDEX "wms_sync_logs_jobId_idx"
  ON "wms_sync_logs"("jobId");

CREATE UNIQUE INDEX "wms_stock_snapshots_connector_warehouseId_productId_key"
  ON "wms_stock_snapshots"("connector", "warehouseId", "productId");

CREATE INDEX "wms_stock_snapshots_warehouseId_productId_idx"
  ON "wms_stock_snapshots"("warehouseId", "productId");

CREATE INDEX "wms_stock_discrepancies_connector_status_category_idx"
  ON "wms_stock_discrepancies"("connector", "status", "category");

CREATE INDEX "wms_stock_discrepancies_productId_idx"
  ON "wms_stock_discrepancies"("productId");

CREATE UNIQUE INDEX "wms_inbound_receipt_events_connector_externalEventId_key"
  ON "wms_inbound_receipt_events"("connector", "externalEventId");

CREATE INDEX "wms_inbound_receipt_events_externalAsnId_idx"
  ON "wms_inbound_receipt_events"("externalAsnId");

CREATE UNIQUE INDEX "wms_returns_inbox_connector_externalReturnId_key"
  ON "wms_returns_inbox"("connector", "externalReturnId");

CREATE INDEX "wms_returns_inbox_status_connector_idx"
  ON "wms_returns_inbox"("status", "connector");

ALTER TABLE "external_wms_bindings"
  ADD CONSTRAINT "external_wms_bindings_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "wms_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "external_wms_bindings"
  ADD CONSTRAINT "external_wms_bindings_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "wms_product_links"
  ADD CONSTRAINT "wms_product_links_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "wms_bundle_links"
  ADD CONSTRAINT "wms_bundle_links_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "wms_asn_line_maps"
  ADD CONSTRAINT "wms_asn_line_maps_asnMapId_fkey"
  FOREIGN KEY ("asnMapId") REFERENCES "wms_asn_maps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "wms_sync_logs"
  ADD CONSTRAINT "wms_sync_logs_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "wms_sync_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
