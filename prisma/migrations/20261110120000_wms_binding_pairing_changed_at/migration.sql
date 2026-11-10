-- When a WMS binding was last pointed at a different IMS warehouse, external warehouse or connection.
-- A stock-sync dry run counts as evidence for going live only if it started after this instant.
-- Existing bindings are stamped with the migration time, so every dry run recorded before it is treated
-- as NOT matching and a fresh dry run is required before live corrections can be confirmed.
ALTER TABLE "external_wms_bindings" ADD COLUMN "pairingChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
