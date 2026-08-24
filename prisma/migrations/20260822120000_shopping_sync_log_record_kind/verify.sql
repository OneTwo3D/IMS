-- =============================================================================
-- POST-MIGRATION VERIFICATION — 20260822120000_shopping_sync_log_record_kind
--
-- These are the cutover checks this migration used to state in a comment block and ask a human to
-- run. They are written in the form `scripts/run-migration-verifications.mjs` executes: that runner
-- picks up every prisma/migrations/<name>/verify.sql after the schema has moved and BEFORE the new
-- build is started, and refuses to start it if any check returns a non-zero count.
--
-- *** THAT RUNNER IS NOT ON THIS BRANCH. *** It arrives with o3d-2sm1.1 (branch
-- o3d-batch-deployseq), which is NOT an ancestor of this one. Until that branch merges, NOTHING IN
-- THIS TREE EXECUTES THIS FILE, and this branch's own scripts/deploy.sh runs
-- migrate -> build -> stop -> start, i.e. it leaves the predecessor serving through the ALTER, both
-- backfill statements and the whole build. So on this branch:
--
--   * quiescence (migration.sql step 1) is MANUAL — stop the app yourself before migrating; and
--   * these checks are MANUAL — run this file through psql yourself, at step 4, and do not start
--     the new build unless all three counts are 0.
--
-- Prisma reads only migration.sql from a migration directory, so this file is invisible to the
-- migration step and carries no checksum risk either way.
--
-- THE CONTRACT: every statement returns EXACTLY ONE ROW of (check_name, violations), and every
-- violations must be 0. The checks are read-only.
--
-- WHAT A NON-ZERO ANSWER MEANS, and it is NOT the same sentence for all three. Checks 1 and 3 are
-- signatures no legitimate writer can produce, so for those "non-zero" does mean "a predecessor
-- binary wrote this table after it was supposed to have been stopped". CHECK 2 IS A SUPERSET — it
-- asks "is anything of park shape unstamped?", which is a real invariant but a broader one, and its
-- own comment says what else can trip it and why the repair is conditional. An earlier revision of
-- this header claimed all three had the narrow meaning; they do not.
--
-- Run again after any repair. Check 1 is repairable by re-running the two UPDATE statements in
-- migration.sql, which only ever write a NULL cell. CHECK 2 IS REPAIRABLE ONLY AFTER THE ROWS HAVE
-- BEEN IDENTIFIED — see its comment; blindly re-running statement 2 is itself a defect. A non-zero
-- answer on check 3 is NOT repairable automatically and needs the incident handling in
-- migration.sql.
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

-- 2. NO UNSTAMPED ROW OF PARK SHAPE. Every actionable row of this shape must name its family, or
--    the recovery inbox cannot see it — which is the precise defect the discriminator closes.
--
--    READ THIS BEFORE ACTING ON A NON-ZERO ANSWER. Unlike checks 1 and 3 this is NOT a signature
--    only a predecessor binary can produce, and the header used to say it was. It counts ANY
--    unstamped row of this shape, and the shape is five columns every WooCommerce-sourced,
--    order-scoped, actionable row shares. So the NEXT ROW FAMILY that carries an entityId and does
--    not stamp a recordKind trips this on EVERY deploy, for ever, written by the CURRENT binary.
--
--    AND THE OBVIOUS REMEDY WOULD THEN BE THE r8 DEFECT AGAIN. "Re-run the two UPDATE statements"
--    ends in statement 2, which stamps whatever it matches as 'WC_REFUND_PARK' — so a row of a
--    family that is not a refund park is declared one, listed in the recovery inbox, and offered
--    "Wrong order" and "Dismiss" refund actions. That is exactly the collision recordKind exists to
--    remove, recreated by the repair instead of by the old binary.
--
--    SO: on a non-zero answer, SELECT the rows and establish what they are before stamping
--    anything. If they are refund parks written by a predecessor, statement 2 is the repair. If
--    they are a new family, the fix is in the WRITER — give it a recordKind — and this check should
--    be narrowed to exclude it at the same time, never satisfied by stamping it as a park.
--
--    NARROWED as far as it can be without losing what it is for: `externalId IS NOT NULL` is a
--    property every park has (upsertRefundPark always supplies it, and the partial unique index
--    shopping_sync_logs_active_refund_park_uq requires it), and it excludes the row families that
--    carry an order id but no store-side id. It does NOT make the check park-specific — nothing in
--    this table's columns can — which is why the caveat above stands rather than being replaced by
--    the clause.
SELECT 'shopping_sync_logs unstamped refund park' AS check_name,
       count(*)                                   AS violations
  FROM "shopping_sync_logs"
 WHERE "recordKind" IS NULL
   AND connector = 'woocommerce'
   AND direction = 'FROM_CONNECTOR'
   AND "entityType" = 'SalesOrder'
   AND "entityId" IS NOT NULL
   AND "externalId" IS NOT NULL
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
--    non-zero, a predecessor binary was writing this table — and unlike check 2, that reading IS
--    exact, because the stamp/payload contradiction has no other producer.
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
