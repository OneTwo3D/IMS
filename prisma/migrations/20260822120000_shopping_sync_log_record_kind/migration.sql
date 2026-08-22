-- o3d-xnwu r8 (Codex HIGH): give shopping_sync_logs a discriminator, because "it has an entityId"
-- stopped meaning "it is a refund park".
--
-- WHAT WENT WRONG. r7 replaced an exclusion-based refund-park query with a positive one:
-- connector='woocommerce', direction='FROM_CONNECTOR', entityType='SalesOrder', an actionable
-- status, and entityId IS NOT NULL. Every clause is written by IMS and nothing is decided by
-- absence, which was the point. What it is NOT is refund-specific. The held sales invoice
-- (o3d-k26m.6, holdWcSalesInvoiceForMissingNumber) writes exactly those five values, so it is
-- admitted as an actionable refund park: the recovery inbox lists an invoice hold and offers
-- "Wrong order" / "Dismiss" refund actions on it.
--
-- It runs the other way too, and that direction WRITES. heldSalesInvoiceQueueWhere selects on
-- payload->>'reason' = 'missing_wc_invoice_number'. A refund park persists the RAW WOOCOMMERCE
-- REFUND, whose `reason` is free text a human types when issuing the refund — so a park with that
-- reason is selected by the hold's own findFirst-and-update and by its release sweep, both of which
-- overwrite the row.
--
-- WHY A COLUMN AND NOT A PAYLOAD FIELD. The payload of a refund park is the store's, and a field in
-- it can be typed by an operator. r7 exists because that was already a live defect. This table had
-- no scalar left to tell the families apart: it has exactly connector, direction, status,
-- entityType, entityId, externalId, payload, errorMessage, syncedAt, createdAt — no action, no
-- reason, no kind. So one is added.
--
-- (syncedAt was considered and rejected. A park happens to be written with syncedAt set and a hold
-- with it NULL, so it would work today — but syncedAt means "when this synced", an unsettled PENDING
-- park carrying one is an oddity rather than a design, and a predicate built on it would empty the
-- recovery inbox the day somebody corrects that oddity.)
--
-- SAFE BY THE CONVENTIONS: a nullable ADD COLUMN with no default, so it is metadata-only on
-- Postgres 11+, asserts nothing about historical rows, and needs no marker.
ALTER TABLE "shopping_sync_logs" ADD COLUMN "recordKind" TEXT;

-- THE BACKFILL, AND IT IS NOT OPTIONAL. Both new predicates ask for their own value BY NAME — a
-- park is a row that SAYS it is a park — so an existing row left NULL is invisible to them. For a
-- refund park that means invisible to the recovery inbox, which is the precise defect r7 closed;
-- for a hold it means an invoice that is never released.
--
-- BOTH STATEMENTS ONLY EVER WRITE A NULL CELL, so they are idempotent and safe to re-run at any
-- time. That matters — see the deploy order below.
--
-- ORDER MATTERS: holds first, then "everything else actionable is a park".

-- 1. THE HELD SALES INVOICES, identified POSITIVELY and by a shape the store cannot forge. The
--    payload is built by buildHeldSalesInvoicePayload, so it carries a top-level accountingPayload
--    OBJECT, a salesOrderId equal to the row's own entityId, and a metaKey. A raw WooCommerce refund
--    body has none of those: an operator can type the `reason` string, but they cannot introduce a
--    nested accountingPayload object or an IMS order id. All four clauses together, never the reason
--    alone.
UPDATE "shopping_sync_logs"
   SET "recordKind" = 'WC_HELD_SALES_INVOICE'
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

-- 2. THE REFUND PARKS. Deliberately the WHOLE of what activeRefundParkWhere returns today, minus the
--    holds stamped above — externalId is not required here even though every park written by
--    upsertRefundPark has one, because the invariant that must hold across this deploy is "every row
--    the inbox lists today is still listed tomorrow", not "every row the unique index covers".
UPDATE "shopping_sync_logs"
   SET "recordKind" = 'WC_REFUND_PARK'
 WHERE "recordKind" IS NULL
   AND connector = 'woocommerce'
   AND direction = 'FROM_CONNECTOR'
   AND "entityType" = 'SalesOrder'
   AND status IN ('PENDING', 'FAILED', 'QUARANTINED')
   AND "entityId" IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- DEPLOY ORDER — READ THIS BEFORE SHIPPING.
--
--   1. APPLY THIS MIGRATION FIRST. It is additive and nullable and the running binary neither reads
--      nor writes "recordKind", so it is a no-op for the version in production.
--   2. DEPLOY THE APPLICATION SECOND. From that moment every park and every hold is stamped as it is
--      written, and both predicates require the stamp.
--   3. RE-RUN THE TWO UPDATE STATEMENTS ABOVE, VERBATIM, AFTER STEP 2. Between steps 1 and 2 the OLD
--      binary keeps writing parks and holds with a NULL recordKind, and those rows are invisible to
--      the new predicates until this runs. They are idempotent by construction (each only writes a
--      NULL cell), so re-running them is free and skipping them is not.
--
--      Preferable, if the window can take it: quiesce the WooCommerce refund sweep and the order
--      import between steps 1 and 2, and step 3 becomes a verification rather than a repair.
--
-- HOW A MISSED STEP 3 SHOWS UP, so it cannot be missed silently: an unstamped legacy park is not
-- found by upsertRefundPark's own park lookup, so the next delivery of that refund tries to INSERT a
-- second actionable park and hits shopping_sync_logs_active_refund_park_uq. That index is deliberately
-- NOT changed by this migration — it stays keyed on (connector, "externalId") over the wider
-- predicate, so the failure mode is a loud unique violation rather than two live parks for one
-- refund.
--
-- VERIFY (both must return 0 once step 3 has run):
--   SELECT count(*) FROM "shopping_sync_logs"
--    WHERE "recordKind" IS NULL AND connector = 'woocommerce' AND direction = 'FROM_CONNECTOR'
--      AND "entityType" = 'SalesOrder' AND "entityId" IS NOT NULL
--      AND status IN ('PENDING', 'FAILED', 'QUARANTINED');
--   SELECT count(*) FROM "shopping_sync_logs"
--    WHERE "recordKind" = 'WC_REFUND_PARK' AND payload->>'salesOrderId' = "entityId";
-- ---------------------------------------------------------------------------------------------
