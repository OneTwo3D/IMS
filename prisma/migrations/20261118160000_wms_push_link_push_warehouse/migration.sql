-- The IMS warehouse a warehouse (WMS) order was created for. ADDITIVE ONLY: nullable, no default, no backfill (existing links read as "unknown",
-- and a despatch for them falls back to the order's ship-from warehouse).
ALTER TABLE "wms_order_push_links" ADD COLUMN "push_warehouse_id" TEXT;
