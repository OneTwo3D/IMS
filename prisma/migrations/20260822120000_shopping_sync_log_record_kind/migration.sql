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
-- CUTOVER — QUIESCENCE IS REQUIRED, NOT ADVISORY. READ THIS BEFORE SHIPPING.
--
-- The steady-state discriminator is sound. This block is entirely about the WINDOW in which two
-- binaries could both be writing this table, because the OLD one still selects held sales invoices
-- by payload->>'reason' = 'missing_wc_invoice_number' — an OPERATOR-CONTROLLED string typed into
-- WooCommerce's refund dialog. That is the exact collision "recordKind" exists to remove, and the
-- old binary can recreate it AFTER the backfill has run.
--
-- THE REQUIRED ORDER. Every step is mandatory. There is no variant of this that runs the old binary
-- against the migrated schema.
--
--   1. STOP AND DRAIN THE OLD BINARY FIRST. Nothing may be writing shopping_sync_logs: the
--      WooCommerce refund sweep, the order import/poll, the webhook handler and the held-invoice
--      release sweep all write it. "Quiesce" here means the process is stopped, not merely idle —
--      an idle sweep is one webhook away from writing.
--   2. APPLY THIS MIGRATION. Additive and nullable, so it is metadata-only.
--   3. RUN THE TWO UPDATE STATEMENTS ABOVE (they are part of this file and run with it). They only
--      ever write a NULL cell, so they are idempotent and safe to re-run at any time.
--   4. THE VERIFICATION CHECKS RUN, AND THE DEPLOY SCRIPT RUNS THEM. They are declared beside this
--      file as `verify.sql`, in the form scripts/run-migration-verifications.mjs executes: three
--      statements, each returning one row of (check_name, violations), every count required to be
--      zero. The script runs them after the schema has moved and BEFORE the new build is started,
--      and refuses to start it on any non-zero answer. This step is therefore ENFORCED, not merely
--      written down — which is the whole difference from the previous revision of this block, where
--      the same queries sat in a comment that nothing executed. A non-zero answer means something
--      wrote this table after step 1, i.e. the predecessor was still live; the response is to stop
--      it, re-run step 3, and re-verify.
--   5. START THE NEW BUILD. From this moment every park and every hold is stamped as it is written,
--      and both predicates require the stamp.
--
-- WHAT HAPPENS IF STEP 1 IS SKIPPED — two failures, and only one of them is repairable:
--
--   (a) THE OLD BINARY CREATES UNSTAMPED ROWS. A hold or a park written between the backfill and
--       the new build carries a NULL recordKind and is invisible to BOTH new predicates: the hold
--       is never released, so the order is never invoiced, and the park is never listed in the
--       recovery inbox. This one IS repairable — re-running step 3 stamps it — which is why the
--       verification queries below exist and why a non-zero answer is a hard stop.
--
--   (b) THE OLD BINARY OVERWRITES AN ALREADY-STAMPED PARK, AND THIS IS NOT REPAIRABLE.
--       holdWcSalesInvoiceForMissingNumber does a findFirst-and-UPDATE, and the old binary's
--       predicate for it has no recordKind clause — so a refund park whose operator typed
--       'missing_wc_invoice_number' as the WooCommerce refund reason is selected and overwritten
--       with an invoice-hold payload. The old binary does not know the column, so it leaves
--       recordKind = 'WC_REFUND_PARK' on a row that is now a hold: THE STAMP LIES. Re-running
--       step 3 cannot fix it (the cell is not NULL and the statements only ever write NULL cells),
--       the refund evidence is gone, and the recovery inbox offers "Wrong order" / "Dismiss" on an
--       invoice payload. THE COLLISION IS BACK, SILENTLY. That is the whole reason step 1 is a
--       requirement rather than a preference.
--
--       AND IT IS DETECTABLE — AN EARLIER REVISION OF THIS BLOCK SAID IT WAS NOT, AND THAT WAS
--       WRONG (Codex MEDIUM). The claim was that an overwritten row "has a non-NULL recordKind and
--       every column of a park", so nothing distinguishes it. It does not have every column of a
--       park: it KEEPS THE PARK STAMP while ACQUIRING THE HELD-INVOICE PAYLOAD SHAPE, and that
--       combination is a contradiction no legitimate writer can produce. The payload shape is the
--       one the backfill above already trusts to tell the families apart — a top-level
--       accountingPayload OBJECT, a salesOrderId equal to the row's own entityId, and a metaKey —
--       none of which an operator can introduce through WooCommerce's refund dialog, where the only
--       thing they control is the free-text `reason`. So "stamped WC_REFUND_PARK *and* matching the
--       full held-invoice shape" selects exactly the rows (b) creates, and nothing else: a genuine
--       hold carries the hold stamp, and a genuine park carries a refund body.
--
--       That is check 3 in verify.sql, and it is mandatory like the other two: the cutover fails and
--       the new build is not started if it returns anything but zero. Saying this failure mode was
--       invisible was worse than leaving it unchecked — it told an operator there was no point
--       looking, so the damage would have stood unqueried rather than undetectable.
--
--       WHAT IS STILL NOT COVERED, stated so the correction does not overclaim: the old release
--       sweep can also flip a mis-selected park to FAILED or SYNCED and replace its errorMessage
--       WITHOUT touching the payload. That row keeps a refund body, so it has no contradictory
--       shape to query for. It is a lesser corruption — the refund evidence survives — but it is
--       real, and stopping the writer first remains the defence for it. Which is why step 1 is a
--       step and not a note: check 3 is the second line, not a licence to skip the first.
--
-- AUTOMATING THIS IS NOT THIS FILE'S JOB, AND IT HAS AN OWNER WHO HAS DONE IT: o3d-2sm1.1, on
-- branch o3d-batch-deployseq — "the deploy script applies the migration and leaves the PREDECESSOR
-- serving against the migrated schema". That branch reorders every supported entrypoint to
-- build -> validate -> stop and drain -> migrate -> verify -> start, fences the predecessor off on
-- any post-stop failure, and adds the verification hook (scripts/run-migration-verifications.mjs)
-- that executes the checks a migration declares in verify.sql. This migration is recorded on it as
-- one that needs quiescence.
--
-- SO THE DIVISION OF LABOUR IS: that branch owns the ORDER (step 1, which is the only defence
-- against (b) and against the errorMessage rewrite), and this migration owns the CHECKS — declared
-- next to this file rather than described in it, so they are run by the script instead of by
-- somebody remembering to. deploy.sh is deliberately NOT edited here: two branches rewriting the
-- same script would conflict and one would silently win.
--
-- A LEGACY PARK THAT ESCAPES ANYWAY STILL FAILS LOUDLY: an unstamped park is not found by
-- upsertRefundPark's own park lookup, so the next delivery of that refund tries to INSERT a second
-- actionable park and hits shopping_sync_logs_active_refund_park_uq. That index is deliberately NOT
-- changed by this migration — it stays keyed on (connector, "externalId") over the wider predicate,
-- so the failure mode is a unique violation somebody sees rather than two live parks for one refund.
--
-- VERIFICATION QUERIES — ALL THREE MUST RETURN 0. They live in `verify.sql` beside this file, NOT
-- in this comment, and that is the point of them: the deploy script runs that file at step 4 and
-- will not start the new build on a non-zero count. Copying them back into this block would
-- recreate the exact thing the hook exists to end — a check that can only be read.
--
--   1. shopping_sync_logs unstamped held sales invoice   — an old binary CREATED a hold after the
--                                                          backfill; it would never be released.
--   2. shopping_sync_logs unstamped refund park          — an old binary CREATED a park after the
--                                                          backfill; the inbox cannot see it.
--   3. shopping_sync_logs park stamp over a held-invoice payload
--                                                        — an old binary OVERWROTE a stamped park
--                                                          with an invoice hold; case (b) above.
--
-- 1 and 2 are repairable by re-running the two UPDATE statements above. 3 is not, and is an
-- incident: the refund evidence on those rows has been replaced.
-- ---------------------------------------------------------------------------------------------
