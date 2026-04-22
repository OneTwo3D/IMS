DO $$
BEGIN
  CREATE TYPE "WmsAsnSourceType" AS ENUM (
    'PURCHASE_ORDER',
    'PURCHASE_ORDER_LINE',
    'STOCK_TRANSFER',
    'STOCK_TRANSFER_LINE'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "WmsAsnStatus" AS ENUM (
    'CREATE_PENDING',
    'CREATE_IN_FLIGHT',
    'OPEN',
    'PARTIALLY_BOOKED_IN',
    'BOOKED_IN'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "WmsSyncLogAction" AS ENUM (
    'created',
    'updated',
    'noop',
    'sync',
    'backfill',
    'conflict',
    'skip',
    'discrepancy',
    'error',
    'asn_line_reconciled',
    'asn_line_mapped'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
DECLARE
  invalid_asn_source_type_count integer;
  invalid_asn_status_count integer;
  invalid_asn_line_source_type_count integer;
  invalid_sync_log_action_count integer;
BEGIN
  SELECT COUNT(*) INTO invalid_asn_source_type_count
  FROM "wms_asn_maps"
  WHERE "sourceType" NOT IN ('PURCHASE_ORDER', 'PURCHASE_ORDER_LINE', 'STOCK_TRANSFER', 'STOCK_TRANSFER_LINE');

  SELECT COUNT(*) INTO invalid_asn_status_count
  FROM "wms_asn_maps"
  WHERE "status" NOT IN ('CREATE_PENDING', 'CREATE_IN_FLIGHT', 'OPEN', 'PARTIALLY_BOOKED_IN', 'BOOKED_IN');

  SELECT COUNT(*) INTO invalid_asn_line_source_type_count
  FROM "wms_asn_line_maps"
  WHERE "sourceType" NOT IN ('PURCHASE_ORDER', 'PURCHASE_ORDER_LINE', 'STOCK_TRANSFER', 'STOCK_TRANSFER_LINE');

  SELECT COUNT(*) INTO invalid_sync_log_action_count
  FROM "wms_sync_logs"
  WHERE "action" NOT IN ('created', 'updated', 'noop', 'sync', 'backfill', 'conflict', 'skip', 'discrepancy', 'error', 'asn_line_reconciled', 'asn_line_mapped');

  IF invalid_asn_source_type_count > 0 OR invalid_asn_status_count > 0 OR invalid_asn_line_source_type_count > 0 OR invalid_sync_log_action_count > 0 THEN
    RAISE EXCEPTION USING MESSAGE = format(
      'WMS enum hardening aborted: invalid values found (asnSourceType=%s, asnStatus=%s, asnLineSourceType=%s, syncLogAction=%s).',
      invalid_asn_source_type_count,
      invalid_asn_status_count,
      invalid_asn_line_source_type_count,
      invalid_sync_log_action_count
    );
  END IF;
END $$;

ALTER TABLE "wms_asn_maps"
  ALTER COLUMN "sourceType" TYPE "WmsAsnSourceType"
  USING ("sourceType"::"WmsAsnSourceType"),
  ALTER COLUMN "status" TYPE "WmsAsnStatus"
  USING ("status"::"WmsAsnStatus");

ALTER TABLE "wms_asn_line_maps"
  ALTER COLUMN "sourceType" TYPE "WmsAsnSourceType"
  USING ("sourceType"::"WmsAsnSourceType");

ALTER TABLE "wms_sync_logs"
  ALTER COLUMN "action" TYPE "WmsSyncLogAction"
  USING ("action"::"WmsSyncLogAction");

