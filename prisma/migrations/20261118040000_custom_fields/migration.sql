-- Additive: operator-defined typed custom fields for products (variants included) and sales orders. Two new tables and two new
-- enums; nothing existing is altered. A definition is shared by both entities (the `entity` column); a value row belongs to exactly
-- one product OR one sales order. Values are typed columns, one filled per row, so the database can filter and check them.
CREATE TYPE "CustomFieldEntity" AS ENUM ('PRODUCT', 'SALES_ORDER');
CREATE TYPE "CustomFieldType" AS ENUM ('STRING', 'NUMBER', 'DECIMAL', 'BOOLEAN', 'DATE', 'DATETIME', 'JSON', 'LINK');

CREATE TABLE "custom_field_definitions" (
    "id" TEXT NOT NULL,
    "entity" "CustomFieldEntity" NOT NULL,
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "CustomFieldType" NOT NULL,
    "options" JSONB,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "custom_field_values" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "productId" TEXT,
    "salesOrderId" TEXT,
    "valueText" TEXT,
    "valueDecimal" DECIMAL(28,10),
    "valueBoolean" BOOLEAN,
    "valueDate" DATE,
    "valueDateTime" TIMESTAMP(3),
    "valueJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_field_values_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "custom_field_definitions_entity_key_key" ON "custom_field_definitions"("entity", "key");
CREATE INDEX "custom_field_definitions_entity_active_sortOrder_idx" ON "custom_field_definitions"("entity", "active", "sortOrder");
CREATE UNIQUE INDEX "custom_field_values_definitionId_productId_key" ON "custom_field_values"("definitionId", "productId");
CREATE UNIQUE INDEX "custom_field_values_definitionId_salesOrderId_key" ON "custom_field_values"("definitionId", "salesOrderId");
CREATE INDEX "custom_field_values_productId_idx" ON "custom_field_values"("productId");
CREATE INDEX "custom_field_values_salesOrderId_idx" ON "custom_field_values"("salesOrderId");

-- A definition that still has values cannot be deleted (RESTRICT); the owning product or order takes its values with it (CASCADE).
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "custom_field_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one owner, and exactly one filled value column (a blank value has no row).
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_one_owner_check" CHECK (num_nonnulls("productId", "salesOrderId") = 1);
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_one_value_check" CHECK (num_nonnulls("valueText", "valueDecimal", "valueBoolean", "valueDate", "valueDateTime", "valueJson") = 1);
