-- Add INVALID_HS_CODE to the WMS discrepancy category enum. Recorded when a product's
-- HS/CN code is not a declarable 2026 CN8 and was omitted from the WMS product push (bhdm.3).
ALTER TYPE "WmsDiscrepancyCategory" ADD VALUE IF NOT EXISTS 'INVALID_HS_CODE';
