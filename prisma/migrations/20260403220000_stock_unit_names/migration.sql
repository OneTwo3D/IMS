ALTER TABLE "purchase_units" ADD COLUMN "stockUnitName" TEXT NOT NULL DEFAULT 'pcs';
ALTER TABLE "products" ADD COLUMN "stockUnit" TEXT NOT NULL DEFAULT 'pcs';
