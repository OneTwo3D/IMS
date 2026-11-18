-- Stamped when a warehouse despatch shipped only the despatching warehouse's part of a mixed-warehouse order. ADDITIVE ONLY: nullable, no default, no backfill.
ALTER TABLE "wms_order_push_links" ADD COLUMN "partial_despatch_applied_at" TIMESTAMP(3);
