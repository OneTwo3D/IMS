-- Purchase units table
CREATE TABLE "purchase_units" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "abbreviation" TEXT NOT NULL,
    "conversionFactor" DECIMAL(12,4) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_units_pkey" PRIMARY KEY ("id")
);

-- Add purchase unit fields to PO lines
ALTER TABLE "purchase_order_lines" ADD COLUMN "purchaseUnitId" TEXT;
ALTER TABLE "purchase_order_lines" ADD COLUMN "purchaseUnitQty" DECIMAL(12,4);

-- Foreign key
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchaseUnitId_fkey" FOREIGN KEY ("purchaseUnitId") REFERENCES "purchase_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;
