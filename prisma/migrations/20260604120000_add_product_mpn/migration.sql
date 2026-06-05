-- Add optional manufacturer part number alongside SKU and Barcode/EAN identifiers.
ALTER TABLE "products" ADD COLUMN "mpn" TEXT;
