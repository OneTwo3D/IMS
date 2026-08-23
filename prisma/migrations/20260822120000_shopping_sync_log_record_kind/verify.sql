-- =============================================================================
-- POST-MIGRATION VERIFICATION — 20260822120000_shopping_sync_log_record_kind
--
-- These are the cutover checks this migration used to state in a comment block and ask a human to
-- run. They are now EXECUTED by the deploy script: scripts/run-migration-verifications.mjs picks up
-- every prisma/migrations/<name>/verify.sql after the schema has moved and BEFORE the new build is
-- started, and refuses to start it if any check returns a non-zero count. The runner and the
-- reordered deploy sequence are o3d-2sm1.1 (branch o3d-batch-deployseq); this file is the half of
-- that contract this migration owns. Prisma reads only migration.sql from a migration directory, so
-- this file is invisible to the migration step and carries no checksum risk.
--
-- THE CONTRACT: every statement returns EXACTLY ONE ROW of (check_name, violations), and every
-- violations must be 0. The checks are read-only, and they must keep returning zero on every later
-- deploy — each one is written so that the only thing that can make it non-zero is a predecessor
-- binary writing this table after it was supposed to have been stopped.
--
-- Run again after any repair. A non-zero answer on checks 1 or 2 is repairable — re-run the two
-- UPDATE statements in migration.sql, which only ever write a NULL cell. A non-zero answer on
-- check 3 is NOT repairable automatically and needs the incident handling in migration.sql.
-- =============================================================================

-- 1. NO UNSTAMPED HOLD. Every held sales invoice must say so, or it is never released and the order
--    is never invoiced. A row matching this shape with a NULL recordKind was created after the
--    backfill ran, i.e. by a predecessor that was still serving.
SELECT 'shopping_sync_logs unstamped held sales invoice' AS check_name,
       count(*)                                          AS violations
  FROM "shopping_sync_logs"
 WHERE "recordKind" IS NULL
   AND connector = 'woocommerce'
   AND direction = 'FROM_CONNECTOR'
   AND "entityType" = 'SalesOrder'
   AND status = 'PENDING'
   AND "entityId" IS NOT NULL
   AND jsonb_typeof(payload) = 'object'
   AND payload->>'reason' = 'missing_wc_invoice_number'
   AND jsonb_typeof(payload->'accountingPayload') = 'object'
   AND payload->>'salesOrderId' = "entityId"
   AND payload->>'metaKey' IS NOT NULL;

-- 2. NO UNSTAMPED PARK. Every actionable row this table holds must name its family, or the recovery
--    inbox cannot see it — which is the precise defect the discriminator closes.
SELECT 'shopping_sync_logs unstamped refund park' AS check_name,
       count(*)                                   AS violations
  FROM "shopping_sync_logs"
 WHERE "recordKind" IS NULL
   AND connector = 'woocommerce'
   AND direction = 'FROM_CONNECTOR'
   AND "entityType" = 'SalesOrder'
   AND "entityId" IS NOT NULL
   AND status IN ('PENDING', 'FAILED', 'QUARANTINED');

-- 3. NO PARK STAMP OVER A HELD-INVOICE PAYLOAD — the overwrite that migration.sql used to call
--    undetectable.
--
--    An old binary selects held sales invoices by payload->>'reason' alone, with no recordKind
--    clause, so it can find a REFUND PARK whose operator happened to type
--    'missing_wc_invoice_number' into WooCommerce's refund dialog, and its findFirst-and-UPDATE
--    replaces the whole row's payload with a held-invoice one. It does not know the column, so it
--    leaves the row stamped 'WC_REFUND_PARK'.
--
--    THAT COMBINATION IS THE SIGNATURE, and nothing else produces it. The stamp says park; the
--    payload is the shape only buildHeldSalesInvoicePayload writes — a top-level accountingPayload
--    OBJECT, a salesOrderId equal to the row's own entityId, and a metaKey. A raw WooCommerce refund
--    body cannot carry those: an operator controls the free-text `reason` and nothing else, which is
--    exactly the reasoning the backfill above already relies on to tell the families apart. A
--    genuine hold is stamped 'WC_HELD_SALES_INVOICE' (backfill step 1 runs before step 2, and the
--    new writer stamps at write time), so it is not selected here either.
--
--    It stays zero for ever afterwards: the new hold writer stamps its own kind and its selector
--    requires that stamp, so no park can acquire a hold payload again. The day this returns
--    non-zero, a predecessor binary was writing this table.
SELECT 'shopping_sync_logs park stamp over a held-invoice payload' AS check_name,
       count(*)                                                    AS violations
  FROM "shopping_sync_logs"
 WHERE "recordKind" = 'WC_REFUND_PARK'
   AND connector = 'woocommerce'
   AND direction = 'FROM_CONNECTOR'
   AND "entityType" = 'SalesOrder'
   AND status = 'PENDING'
   AND "entityId" IS NOT NULL
   AND jsonb_typeof(payload) = 'object'
   AND payload->>'reason' = 'missing_wc_invoice_number'
   AND jsonb_typeof(payload->'accountingPayload') = 'object'
   AND payload->>'salesOrderId' = "entityId"
   AND payload->>'metaKey' IS NOT NULL;
