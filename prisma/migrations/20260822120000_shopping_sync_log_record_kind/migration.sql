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
-- WooCommerce's refund dialog — and still selects refund parks with a predicate that has no
-- recordKind clause at all. That is the exact collision "recordKind" exists to remove, and the old
-- binary can recreate it AFTER the backfill has run.
--
-- THE REQUIRED ORDER. Every step is mandatory, and every step is now EXECUTED rather than described
-- (see "THE ORDER IS AN ANCESTOR" below). There is no supported variant of this that runs the old
-- binary against the migrated schema.
--
--   1. STOP AND DRAIN THE OLD BINARY FIRST. Nothing may be writing shopping_sync_logs: the
--      WooCommerce refund sweep, the order import/poll, the webhook handler, the refund-park
--      recovery action and the held-invoice release sweep all write it. "Quiesce" here means the
--      process is stopped, not merely idle — an idle sweep is one webhook away from writing.
--   2. APPLY THIS MIGRATION. Additive and nullable, so it is metadata-only.
--   3. RUN THE TWO UPDATE STATEMENTS ABOVE (they are part of this file and run with it). They only
--      ever write a NULL cell, so they are idempotent and safe to re-run at any time.
--   4. RUN THE VERIFICATION CHECKS. They are declared beside this file as `verify.sql`: five
--      statements, each returning one row of (check_name, violations), every count required to be
--      zero. `scripts/run-migration-verifications.mjs` runs them after the schema has moved and
--      before anything is started, and a non-zero count stops the cutover.
--
--      A non-zero answer means something wrote this table after step 1, i.e. the predecessor was
--      still live. The response is to stop it, establish what the rows are (see check 2's caveat in
--      verify.sql — the repair is NOT unconditional), and re-verify.
--   5. START THE NEW BUILD. From this moment every park and every hold is stamped as it is written,
--      and both predicates require the stamp.
--
-- WHAT HAPPENS IF STEP 1 IS SKIPPED — three failures, and only one of them is repairable:
--
--   (a) THE OLD BINARY CREATES UNSTAMPED ROWS. A hold or a park written between the backfill and
--       the new build carries a NULL recordKind and is invisible to BOTH new predicates: the hold
--       is never released, so the order is never invoiced, and the park is never listed in the
--       recovery inbox. This one IS repairable — re-running step 3 stamps it, ONCE THE ROWS HAVE
--       BEEN LOOKED AT (check 2 is a superset; see its caveat in verify.sql) — which is why the
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
--       That is check 3 in verify.sql, and it is mandatory like the others: the cutover fails and
--       the new build is not started if it returns anything but zero. Saying this failure mode was
--       invisible was worse than leaving it unchecked; saying a script enforces it when no such
--       script exists is the same mistake in the other direction, and both are now behind us.
--
--       AND CHECK 3 NO LONGER READS `status` (Codex MEDIUM). It used to require PENDING, which is
--       the status the overwrite lands on — so the predecessor's OWN release sweep, flipping the
--       same row to SYNCED or FAILED, switched the check off while the corruption stood untouched.
--       The contradiction is between the stamp and the payload. The status is not part of it.
--
--   (c) THE OLD BINARY RETIRES A HELD SALES INVOICE THROUGH THE REFUND-PARK RECOVERY ACTION, AND
--       THIS IS NOT REPAIRABLE EITHER. This is (b) in the opposite direction and it was missing
--       from every earlier revision of this block, including the "what is still not covered"
--       paragraph that claimed to bound what was left (Codex MEDIUM). The recovery action
--       (lib/domain/sales/refund-park-recovery.ts, o3d-54p) selects actionable parks — and the OLD
--       version of activeRefundParkWhere has no recordKind clause, which is the r8 defect itself.
--       So the recovery inbox lists a HELD SALES INVOICE and offers an operator two acts on it:
--
--         * DISMISS  — writes status = 'SYNCED', syncedAt = now, errorMessage = a note beginning
--                      'Recovered by operator:'. The hold leaves heldSalesInvoiceQueueWhere's
--                      PENDING selector permanently: the invoice is never posted, and nothing
--                      anywhere says the order is still waiting for one. The payload is untouched
--                      and the stamp, if any, is untouched, so checks 1, 2 AND 3 all return zero.
--         * REASSIGN — writes a new entityId and leaves the payload deliberately alone, so the
--                      hold now sits on one order while naming another. It also breaks check 3's
--                      identity clause (payload->>'salesOrderId' = "entityId") on any row check 3
--                      was catching, which is a second way for (b) to go quiet after the fact.
--
--       CHECKS 4 AND 5 ARE THOSE TWO SIGNATURES. The recovery note prefix is written by exactly one
--       code path, and the CURRENT version of that path requires recordKind = 'WC_REFUND_PARK', so
--       it can never land on a held invoice; and buildHeldSalesInvoicePayload always writes
--       salesOrderId equal to the row's own entityId, so a hold-shaped payload naming a different
--       order has no legitimate producer. Neither check reads recordKind, on purpose: the same act
--       against an UNSTAMPED hold from case (a) has no stamp to test.
--
--       WHAT IS STILL NOT COVERED, stated so the correction does not overclaim: the old release
--       sweep can also flip a mis-selected PARK to FAILED or SYNCED and replace its errorMessage
--       with a sweep message, WITHOUT touching the payload. That row keeps a refund body and a park
--       stamp, so it has no contradictory shape to query for. It is a lesser corruption — the
--       refund evidence survives — but it is real, and stopping the writer first remains the
--       defence for it. Which is why step 1 is a step and not a note: the checks are the second
--       line, not a licence to skip the first.
--
-- ---------------------------------------------------------------------------------------------
-- THE ORDER IS AN ANCESTOR, NOT A REQUEST. READ THIS BEFORE TRUSTING ANY SENTENCE ABOVE.
--
-- An earlier revision of this file said, correctly at the time, that neither step 1 nor step 4 was
-- automated here and that both were MANUAL. It also asked a reader to honour a MERGE DEPENDENCY on
-- a sibling branch. A comment is not a merge dependency: nothing stopped this migration shipping
-- first, and shipping first is exactly failure modes (b) and (c).
--
-- SO THE DEPENDENCY IS NOW A COMMIT ORDER. This branch is REBASED ONTO o3d-batch-deployseq
-- (o3d-2sm1.x). Every commit that reorders the deploy is an ancestor of the commit that adds this
-- migration, so there is no history in which this migration is applied by a tree that does not
-- already contain the stop, the fence and the runner. Git enforces it; no reviewer has to.
--
-- WHAT THOSE ANCESTORS GIVE THIS MIGRATION:
--
--   * `scripts/deploy.sh`, `scripts/update.sh` AND `scripts/install.sh` all run
--     build -> validate -> stop and drain every writer -> fence the database -> migrate -> verify
--     -> start. install.sh matters as much as the other two: it explicitly supports being re-run
--     over an existing installation, and in that case it detects the existing install, installs a
--     reboot fence, stops the service, fences the crontab, stops legacy PM2 and app-directory
--     processes, proves with the database that nothing else is connected, and only then migrates.
--     A rerun no longer migrates underneath a live predecessor, which is the one entrypoint most
--     likely to be used by somebody who does not know the deploy order.
--   * `scripts/run-migration-verifications.mjs` EXECUTES verify.sql on all three paths, after the
--     schema has moved and before anything is started, and a non-zero count stops the cutover.
--   * `prisma/migrations/verification-required.txt` NAMES this migration, so a future edit that
--     deletes verify.sql is a coverage gap CI fails on rather than a silent loss of the checks.
--
-- WHAT THIS BRANCH STILL DOES NOT DO: it does not edit deploy.sh, update.sh or install.sh. It does
-- not need to — it inherits them. This migration owns the CHECKS; the ancestors own the ORDER.
-- ---------------------------------------------------------------------------------------------
--
-- A LEGACY PARK THAT ESCAPES ANYWAY STILL FAILS LOUDLY: an unstamped park is not found by
-- upsertRefundPark's own park lookup, so the next delivery of that refund tries to INSERT a second
-- actionable park and hits shopping_sync_logs_active_refund_park_uq. That index is deliberately NOT
-- changed by this migration — it stays keyed on (connector, "externalId") over the wider predicate,
-- so the failure mode is a unique violation somebody sees rather than two live parks for one refund.
--
-- VERIFICATION QUERIES — ALL FIVE MUST RETURN 0. They live in `verify.sql` beside this file, NOT
-- in this comment: a second copy is a check that can drift from the one that is actually run.
--
--   1. shopping_sync_logs unstamped held sales invoice   — an old binary CREATED a hold after the
--                                                          backfill; it would never be released.
--   2. shopping_sync_logs unstamped refund park          — an unstamped row of PARK SHAPE. Usually
--                                                          an old binary that CREATED a park after
--                                                          the backfill — but it is a SUPERSET, and
--                                                          the repair is not unconditional. Read
--                                                          check 2's own comment before acting.
--   3. shopping_sync_logs park stamp over a held-invoice payload
--                                                        — an old binary OVERWROTE a stamped park
--                                                          with an invoice hold; case (b) above. In
--                                                          ANY status, so settling the row does not
--                                                          hide it.
--   4. shopping_sync_logs operator recovery note on a held-invoice payload
--                                                        — an old binary's recovery inbox let an
--                                                          operator DISMISS or REASSIGN a held
--                                                          sales invoice; case (c) above. A
--                                                          dismissed hold is never invoiced.
--   5. shopping_sync_logs held-invoice payload naming another order
--                                                        — the REASSIGN half of case (c), and the
--                                                          state check 3 loses when a row it was
--                                                          catching is moved.
--
-- 1 is repairable by re-running the two UPDATE statements above. 2 is repairable ONLY once the rows
-- have been confirmed to be refund parks: statement 2 stamps whatever it matches as
-- 'WC_REFUND_PARK', which puts the row in the recovery inbox with "Wrong order" / "Dismiss" refund
-- actions on it — the r8 defect, recreated by the remedy. 3, 4 and 5 are not repairable, and are an
-- incident: on 3 the refund evidence on those rows has been replaced; on 4 and 5 a held invoice has
-- been retired or moved by an operator who was shown the wrong row, and the orders behind them have
-- to be re-derived by hand.
-- ---------------------------------------------------------------------------------------------
