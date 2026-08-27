-- =============================================================================
-- POST-MIGRATION VERIFICATION — 20260822120000_shopping_sync_log_record_kind
--
-- These are the cutover checks this migration used to state in a comment block and ask a human to
-- run. `scripts/run-migration-verifications.mjs` EXECUTES them: it picks up every
-- prisma/migrations/<name>/verify.sql after the schema has moved and BEFORE the new build is
-- started, and refuses to start it if any check returns a non-zero count.
--
-- THAT RUNNER IS ON THIS BRANCH, AND SO IS THE ORDER IT DEPENDS ON. This branch is stacked on
-- o3d-batch-deployseq (o3d-2sm1.x) rather than merely naming it, so every commit that reorders the
-- deploy is an ANCESTOR of this migration and cannot be skipped. All three supported entrypoints —
-- scripts/deploy.sh, scripts/update.sh and scripts/install.sh, including an install.sh RERUN over an
-- existing installation — now build, validate, stop and drain every writer, fence the database,
-- migrate, run this file, and only then start. Nothing is manual any more, and this file's earlier
-- "run it yourself" wording is gone with the branch condition that produced it.
--
-- Prisma reads only migration.sql from a migration directory, so this file is invisible to the
-- migration step and carries no checksum risk either way.
--
-- THE CONTRACT: every statement returns EXACTLY ONE ROW of (check_name, violations), and every
-- violations must be 0. The checks are read-only.
--
-- WHAT A NON-ZERO ANSWER MEANS, and it is NOT the same sentence for all five. Checks 1, 3, 4 and 5
-- are signatures no legitimate writer can produce, so for those "non-zero" does mean "a predecessor
-- binary wrote this table after it was supposed to have been stopped". CHECK 2 IS A SUPERSET — it
-- asks "is anything of park shape unstamped?", which is a real invariant but a broader one, and its
-- own comment says what else can trip it and why the repair is conditional. An earlier revision of
-- this header claimed all of them had the narrow meaning; they do not.
--
-- WHY THERE ARE FIVE AND NOT THREE (Codex MEDIUM). The first three modelled ONE predecessor act —
-- the held-invoice writer overwriting a park — and modelled it in ONE state. They stopped seeing it
-- the moment anything moved afterwards, and they never looked at the act that goes the other way:
--
--   * check 3 used to require status = 'PENDING', so the old release sweep flipping the same row to
--     SYNCED or FAILED made the contradiction invisible while the damage stood. It is now
--     STATUS-INDEPENDENT: a park stamp over a held-invoice payload is a contradiction in every
--     status there is.
--   * the OLD REFUND-PARK RECOVERY ACTION (lib/domain/sales/refund-park-recovery.ts) selects parks
--     with a predicate that has NO recordKind clause, so it admits a HELD SALES INVOICE and offers
--     an operator "Wrong order" and "Dismiss" on it. A DISMISS stamps the hold SYNCED with a
--     recovery note — the held invoice is silently retired and may never be invoiced. A REASSIGN
--     moves its entityId to another order. Checks 1-3 all return zero for both. Checks 4 and 5 are
--     those two signatures.
--
-- Run again after any repair. Check 1 is repairable by re-running the two UPDATE statements in
-- migration.sql, which only ever write a NULL cell. CHECK 2 IS REPAIRABLE ONLY AFTER THE ROWS HAVE
-- BEEN IDENTIFIED — see its comment; blindly re-running statement 2 is itself a defect. A non-zero
-- answer on check 3, 4 or 5 is NOT repairable automatically and needs the incident handling in
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
--    READ THIS BEFORE ACTING ON A NON-ZERO ANSWER. Unlike the other four this is NOT a signature
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
--    NO STATUS CLAUSE, AND THAT IS THE CORRECTION (Codex MEDIUM). This check used to require
--    status = 'PENDING' because that is the status the overwrite lands on. But the SAME predecessor
--    that produced the row goes on running: its release sweep flips a mis-selected row to SYNCED or
--    FAILED without touching the payload, and at that instant the check went quiet while the
--    corruption was untouched. The contradiction is between the STAMP and the PAYLOAD; the status
--    is not part of it, in either direction, and a check that reads a column it does not need is a
--    check with an off switch the damage controls.
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
   AND "entityId" IS NOT NULL
   AND jsonb_typeof(payload) = 'object'
   AND payload->>'reason' = 'missing_wc_invoice_number'
   AND jsonb_typeof(payload->'accountingPayload') = 'object'
   AND payload->>'salesOrderId' = "entityId"
   AND payload->>'metaKey' IS NOT NULL;

-- 4. NO OPERATOR RECOVERY NOTE ON A HELD-INVOICE PAYLOAD — the collision running the OTHER way, and
--    the one the "what is still not covered" paragraph used to omit entirely.
--
--    The refund-park recovery action (o3d-54p) lets an operator say "this park is stale": DISMISS
--    writes status = 'SYNCED', syncedAt = now and errorMessage = a note beginning
--    'Recovered by operator:' (REFUND_PARK_RECOVERY_NOTE_PREFIX); REASSIGN writes the same note with
--    status = 'PENDING' and a new entityId. THE PREDECESSOR'S VERSION OF THAT ACTION HAS NO
--    recordKind CLAUSE — it is the same r7 predicate the discriminator exists to replace — so it
--    lists a HELD SALES INVOICE as a recoverable refund park and offers both outcomes on it.
--
--    A dismissal of a hold is the worst outcome in this file that leaves the payload intact: the
--    held invoice is stamped SYNCED, drops out of the release sweep's PENDING selector for ever, and
--    the order is never invoiced. Nothing about the row is NULL, nothing about it is unstamped, and
--    its payload is unchanged — so checks 1, 2 and 3 ALL return zero over it. Only the note gives it
--    away.
--
--    AND THE NOTE IS UNFORGEABLE HERE. The prefix is written by exactly one code path, and the
--    CURRENT version of that path requires recordKind = 'WC_REFUND_PARK', so it can never put a note
--    on a held invoice. `accountingPayload` (an OBJECT) and `metaKey` are the two members only
--    buildHeldSalesInvoicePayload writes, and an operator typing into WooCommerce's refund dialog
--    controls neither. A genuine refund park dismissed by an operator carries the note over a RAW
--    REFUND BODY and is not selected. The stamp is deliberately NOT in this check: an UNSTAMPED hold
--    (case (a)) that the same action then dismissed must be caught too, and it carries no stamp to
--    test.
SELECT 'shopping_sync_logs operator recovery note on a held-invoice payload' AS check_name,
       count(*)                                                              AS violations
  FROM "shopping_sync_logs"
 WHERE connector = 'woocommerce'
   AND direction = 'FROM_CONNECTOR'
   AND "entityType" = 'SalesOrder'
   AND "errorMessage" LIKE 'Recovered by operator:%'
   AND jsonb_typeof(payload) = 'object'
   AND jsonb_typeof(payload->'accountingPayload') = 'object'
   AND payload->>'metaKey' IS NOT NULL;

-- 5. NO HELD-INVOICE PAYLOAD THAT NAMES A DIFFERENT ORDER FROM THE ROW IT SITS ON — the REASSIGN
--    half of the same act, and the reason check 3 alone is not enough even without its status bug.
--
--    buildHeldSalesInvoicePayload ALWAYS writes salesOrderId equal to the row's entityId: a hold
--    names the order it holds. buildRefundParkReassignData writes a new entityId and DELIBERATELY
--    leaves the payload alone (it is the only copy of what the store sent). So the predecessor's
--    recovery action, having admitted a hold as a park, moves the row to another order and leaves a
--    payload still naming the first one. That contradiction has no other producer.
--
--    IT IS ALSO WHAT CHECK 3 LOSES ON THE WAY PAST. Check 3's identity clause is
--    payload->>'salesOrderId' = "entityId" — so a REASSIGN of a row that check 3 was catching makes
--    check 3 go quiet, by moving the very column it compares. 3 and 5 are complements: one holds
--    while the payload still agrees with the row, the other from the moment it stops.
--
--    IS DISTINCT FROM, not <>: a hold-shaped payload that has LOST its salesOrderId is a
--    contradiction of the same kind, and `<>` against a missing member is UNKNOWN and selects
--    nothing. The stamp is out of this one for the same reason it is out of check 4.
SELECT 'shopping_sync_logs held-invoice payload naming another order' AS check_name,
       count(*)                                                       AS violations
  FROM "shopping_sync_logs"
 WHERE connector = 'woocommerce'
   AND direction = 'FROM_CONNECTOR'
   AND "entityType" = 'SalesOrder'
   AND "entityId" IS NOT NULL
   AND jsonb_typeof(payload) = 'object'
   AND jsonb_typeof(payload->'accountingPayload') = 'object'
   AND payload->>'metaKey' IS NOT NULL
   AND payload->>'salesOrderId' IS DISTINCT FROM "entityId";
