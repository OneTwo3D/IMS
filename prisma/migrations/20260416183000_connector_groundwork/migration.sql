ALTER TABLE "accounting_accounts"
  ADD COLUMN "connector" TEXT NOT NULL DEFAULT 'xero';

DROP INDEX IF EXISTS "accounting_accounts_externalAccountId_key";
CREATE UNIQUE INDEX "accounting_accounts_connector_externalAccountId_key"
  ON "accounting_accounts"("connector", "externalAccountId");
CREATE INDEX "accounting_accounts_connector_active_code_idx"
  ON "accounting_accounts"("connector", "active", "code");

ALTER TABLE "accounting_sync_logs"
  ADD COLUMN "connector" TEXT NOT NULL DEFAULT 'xero';

DROP INDEX IF EXISTS "accounting_sync_logs_referenceType_referenceId_idx";
DROP INDEX IF EXISTS "accounting_sync_logs_status_createdAt_idx";
DROP INDEX IF EXISTS "accounting_sync_logs_status_processingStartedAt_idx";
CREATE INDEX "accounting_sync_logs_connector_referenceType_referenceId_idx"
  ON "accounting_sync_logs"("connector", "referenceType", "referenceId");
CREATE INDEX "accounting_sync_logs_connector_status_createdAt_idx"
  ON "accounting_sync_logs"("connector", "status", "createdAt");
CREATE INDEX "accounting_sync_logs_connector_status_processingStartedAt_idx"
  ON "accounting_sync_logs"("connector", "status", "processingStartedAt");

ALTER TABLE "accounting_tokens"
  ADD COLUMN "connector" TEXT NOT NULL DEFAULT 'xero';

CREATE UNIQUE INDEX "accounting_tokens_connector_key"
  ON "accounting_tokens"("connector");
CREATE UNIQUE INDEX "accounting_tokens_connector_tenantId_key"
  ON "accounting_tokens"("connector", "tenantId");

ALTER TABLE "shopping_sync_logs"
  ADD COLUMN "connector" TEXT NOT NULL DEFAULT 'woocommerce';

ALTER TABLE "shopping_sync_logs"
  ALTER COLUMN "externalId" TYPE TEXT USING CASE
    WHEN "externalId" IS NULL THEN NULL
    ELSE "externalId"::TEXT
  END;

DROP INDEX IF EXISTS "shopping_sync_logs_entityType_entityId_idx";
CREATE INDEX "shopping_sync_logs_connector_entityType_entityId_idx"
  ON "shopping_sync_logs"("connector", "entityType", "entityId");
CREATE INDEX "shopping_sync_logs_connector_externalId_createdAt_idx"
  ON "shopping_sync_logs"("connector", "externalId", "createdAt");

ALTER TABLE "shopping_tax_rate_mappings"
  ADD COLUMN "connector" TEXT NOT NULL DEFAULT 'woocommerce';

ALTER TABLE "shopping_tax_rate_mappings"
  ALTER COLUMN "externalTaxRateId" TYPE TEXT USING "externalTaxRateId"::TEXT;

DROP INDEX IF EXISTS "shopping_tax_rate_mappings_externalTaxRateId_key";
CREATE UNIQUE INDEX "shopping_tax_rate_mappings_connector_externalTaxRateId_key"
  ON "shopping_tax_rate_mappings"("connector", "externalTaxRateId");
CREATE INDEX "shopping_tax_rate_mappings_connector_externalName_idx"
  ON "shopping_tax_rate_mappings"("connector", "externalName");

ALTER TABLE "shopping_status_mappings"
  ADD COLUMN "connector" TEXT NOT NULL DEFAULT 'woocommerce';

DROP INDEX IF EXISTS "shopping_status_mappings_externalStatus_key";
CREATE UNIQUE INDEX "shopping_status_mappings_connector_externalStatus_key"
  ON "shopping_status_mappings"("connector", "externalStatus");
CREATE INDEX "shopping_status_mappings_connector_imsStatus_idx"
  ON "shopping_status_mappings"("connector", "imsStatus");

CREATE TABLE "shopping_product_links" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "connector" TEXT NOT NULL,
  "externalProductId" TEXT NOT NULL,
  "externalParentId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "shopping_product_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shopping_customer_links" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "connector" TEXT NOT NULL,
  "externalCustomerId" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "shopping_customer_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shopping_order_links" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "connector" TEXT NOT NULL,
  "externalOrderId" TEXT NOT NULL,
  "externalOrderNumber" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "shopping_order_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shopping_product_links_connector_externalProductId_key"
  ON "shopping_product_links"("connector", "externalProductId");
CREATE UNIQUE INDEX "shopping_product_links_connector_productId_key"
  ON "shopping_product_links"("connector", "productId");
CREATE INDEX "shopping_product_links_productId_idx"
  ON "shopping_product_links"("productId");

CREATE UNIQUE INDEX "shopping_customer_links_connector_externalCustomerId_key"
  ON "shopping_customer_links"("connector", "externalCustomerId");
CREATE UNIQUE INDEX "shopping_customer_links_connector_customerId_key"
  ON "shopping_customer_links"("connector", "customerId");
CREATE INDEX "shopping_customer_links_customerId_idx"
  ON "shopping_customer_links"("customerId");

CREATE UNIQUE INDEX "shopping_order_links_connector_externalOrderId_key"
  ON "shopping_order_links"("connector", "externalOrderId");
CREATE UNIQUE INDEX "shopping_order_links_connector_orderId_key"
  ON "shopping_order_links"("connector", "orderId");
CREATE INDEX "shopping_order_links_connector_externalOrderNumber_idx"
  ON "shopping_order_links"("connector", "externalOrderNumber");
CREATE INDEX "shopping_order_links_orderId_idx"
  ON "shopping_order_links"("orderId");

ALTER TABLE "shopping_product_links"
  ADD CONSTRAINT "shopping_product_links_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shopping_customer_links"
  ADD CONSTRAINT "shopping_customer_links_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shopping_order_links"
  ADD CONSTRAINT "shopping_order_links_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "shopping_product_links" (
  "id",
  "productId",
  "connector",
  "externalProductId",
  "createdAt",
  "updatedAt"
)
SELECT
  md5('shopping_product_links:' || "id" || ':' || CURRENT_TIMESTAMP::TEXT),
  "id",
  'woocommerce',
  "externalProductId"::TEXT,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "products"
WHERE "externalProductId" IS NOT NULL;

INSERT INTO "shopping_customer_links" (
  "id",
  "customerId",
  "connector",
  "externalCustomerId",
  "createdAt",
  "updatedAt"
)
SELECT
  md5('shopping_customer_links:' || "id" || ':' || CURRENT_TIMESTAMP::TEXT),
  "id",
  'woocommerce',
  "externalCustomerId"::TEXT,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "customers"
WHERE "externalCustomerId" IS NOT NULL;

INSERT INTO "shopping_order_links" (
  "id",
  "orderId",
  "connector",
  "externalOrderId",
  "externalOrderNumber",
  "createdAt",
  "updatedAt"
)
SELECT
  md5('shopping_order_links:' || "id" || ':' || CURRENT_TIMESTAMP::TEXT),
  "id",
  'woocommerce',
  "externalOrderId"::TEXT,
  "externalOrderNumber",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "sales_orders"
WHERE "externalOrderId" IS NOT NULL;
