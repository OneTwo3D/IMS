DROP INDEX IF EXISTS "external_wms_bindings_warehouseId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "external_wms_bindings_connector_warehouseId_key"
  ON "external_wms_bindings"("connector", "warehouseId");

CREATE INDEX IF NOT EXISTS "external_wms_bindings_warehouseId_idx"
  ON "external_wms_bindings"("warehouseId");
