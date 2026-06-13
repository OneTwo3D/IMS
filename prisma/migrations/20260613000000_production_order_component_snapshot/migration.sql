-- audit-H6: freeze BOM component requirements onto the production order at IN_PROGRESS.
ALTER TABLE "production_orders" ADD COLUMN "componentSnapshot" JSONB;
