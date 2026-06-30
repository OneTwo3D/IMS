-- G4 (vn92.3): track the last WMS status pushed to the storefront, decoupled from the
-- cached status, so a failed storefront push retries instead of being masked by the gate.
ALTER TABLE "wms_order_status_snapshots" ADD COLUMN "wcPushedStatus" TEXT;
