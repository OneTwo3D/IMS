-- Additive: one new discrepancy category, for an IMS SKU rename the warehouse product has not followed. No table or row is touched.
ALTER TYPE "WmsDiscrepancyCategory" ADD VALUE 'PRODUCT_SKU_RENAMED';
