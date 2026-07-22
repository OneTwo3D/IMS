-- bhdm.7: an IMS product whose stored country of origin is a nonblank value that is not an assigned ISO 3166-1
-- alpha-2 country is recorded as a discrepancy (rather than silently declared as CN to the WMS/customs),
-- mirroring INVALID_HS_CODE.
ALTER TYPE "WmsDiscrepancyCategory" ADD VALUE IF NOT EXISTS 'INVALID_COUNTRY_OF_ORIGIN';
