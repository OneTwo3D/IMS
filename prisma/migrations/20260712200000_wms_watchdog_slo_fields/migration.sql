-- q66in.4.6: WMS watchdog SLO anchors + alert-dedupe stamps (all nullable).
ALTER TABLE "wms_asn_maps" ADD COLUMN "eta" TIMESTAMP(3);
ALTER TABLE "wms_asn_maps" ADD COLUMN "sloAlertedAt" TIMESTAMP(3);
ALTER TABLE "external_wms_bindings" ADD COLUMN "staleSyncAlertedAt" TIMESTAMP(3);
