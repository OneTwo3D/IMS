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
-- WHAT A NON-ZERO ANSWER MEANS, and it is NOT the same sentence for all of them. Checks 1, 3, 4, 5
-- and 7 are signatures no legitimate writer can produce, so for those "non-zero" does mean "a
-- predecessor binary wrote this table after it was supposed to have been stopped". CHECK 2 IS A SUPERSET — it
-- asks "is anything of park shape unstamped?", which is a real invariant but a broader one, and its
-- own comment says what else can trip it and why the repair is conditional. An earlier revision of
-- this header claimed all of them had the narrow meaning; they do not.
--
-- WHY THERE ARE SEVEN AND NOT SIX (Codex HIGH, round 13). Checks 1-6 all read THE ROW AS IT IS NOW,
-- and two of them rest on an assumption about WHICH WRITE WAS THE LAST ONE. A reassigned hold that
-- the predecessor then RE-HOLDS onto its new order has its payload, externalId and error message
-- overwritten wholesale — the identity equality is restored, the operator's note is gone, and the
-- backfill stamps what looks exactly like a legitimate hold. All six return zero over a destroyed
-- accounting payload.
--
-- THE AUDIT, check by check, because "does a later write switch this off?" is the question this
-- round asks of the whole file:
--
--   * CHECK 5 assumes a REASSIGN is the last payload-relevant mutation. It is not — the rewrite
--     above restores exactly the equality this check needs broken. THE DEFECT.
--   * CHECK 4 keys on the operator's note in `errorMessage`, and the same rewrite replaces it. A
--     DISMISS moves no entityId, so the predecessor re-holding the SAME order onto a dismissed row
--     does it there too, without any reassign being involved. THE DEFECT, second door.
--   * CHECK 3 needs the park STAMP as well as the shape, and the stamp is written by backfill
--     statement 2 — which never stamps a hold-shaped row. So it holds for a park the backfill had
--     already stamped and the predecessor then overwrote (a REASSIGN moves that row to check 5 and a
--     re-hold moves it back), and it is blind by construction to a row recovered BEFORE the
--     migration: the backfill sees the rewritten row and stamps it a HOLD.
--   * CHECK 6's rows are settled to SYNCED or FAILED, and both predecessor writers select PENDING
--     only, so nothing rewrites them afterwards. Stable.
--   * CHECKS 1 AND 2 want a NULL stamp, and the only writer of that column runs once, before these
--     checks do. Stable.
--
-- WHEN THE CURRENT STATE CAN BE MADE TO LOOK INNOCENT, THE EVIDENCE HAS TO COME FROM HISTORY. Check
-- 7 joins the `wc_refund_park_recovered` activity entries — written by `recoverParkedWcRefund`,
-- naming the row in metadata.shoppingSyncLogId, and never rewritten or deleted by any code path —
-- to the rows themselves, and fails when a row a park recovery once acted on is now shaped or
-- stamped as a held sales invoice. It is the only check here whose evidence is not in the row it
-- accuses, and therefore the only one a later write to that row cannot switch off.
--
-- AND ITS EVIDENCE IS AS DURABLE AS THE THING IT WITNESSES (o3d-xnwu r14, Codex HIGH). It was not.
-- The entry used to be written with `logActivity` AFTER the recovery transaction committed, and
-- `logActivity` SWALLOWS ITS OWN FAILURES — so not merely a crash but an ordinary transient write
-- error left the recovery committed with nothing here to join to. Worse, the entry is a WARNING and
-- `purgeExpiredActivityLogs` deletes WARNING entries after 60 days by default, so this check would
-- have gone quiet on its own, silently, and FIRST for the oldest incidents — the ones nobody has
-- looked at — while a cutover may run a year after the recovery. A verification check whose evidence
-- a retention cron deletes is not a verification check.
--
-- Both halves are closed, and it takes both:
--
--   * `recoverParkedWcRefund` writes the entry with `logActivityInTransaction`, INSIDE the same
--     transaction as the park mutation. It does not catch, so no recovery can commit without its
--     witness: a failed witness write aborts the recovery and the operator retries.
--   * `wc_refund_park_recovered` is in RETAINED_ACTIONS in lib/activity-log-cleanup.ts, so no
--     retention period can remove it.
--
-- AND SO IS THE ROW IT ACCUSES (o3d-xnwu r15, Codex HIGH). A durable witness is half a join. This
-- check drives FROM shopping_sync_logs and uses the witness only in an EXISTS subquery, so a
-- deleted row is not a half-evidenced accusation — it is ZERO VIOLATIONS. And the damage sequence
-- documented below ENDS in a deletable row: the predecessor rewrites the recovered park as a held
-- invoice, the ordinary release path settles it to SYNCED, and `purgeExpiredData` then expires it
-- on its ORIGINAL `createdAt` — six months by default, and possibly on the very next sweep if the
-- park was already old when it was recovered. lib/data-retention.ts now refuses to delete any
-- shopping_sync_logs row a `wc_refund_park_recovered` entry names, in the same statement that does
-- the deleting (a `NOT EXISTS`, not a pre-read id list, so a recovery committing mid-sweep cannot
-- be swept by it).
--
-- WHY THE ROW AND NOT MORE EVIDENCE IN THE WITNESS. The accusation is about the row's CURRENT
-- state, so no entry written at recovery time can carry it: the overwrite had not happened yet.
-- And the obvious substitute — treating an ABSENT witness-referenced row as an incident — is a
-- false-positive engine, because a legitimately recovered park settles to SYNCED and expires by age
-- like anything else. On any installation older than the retention period that would fail the
-- cutover over healthy history, which is the cutover outage this file keeps warning about. The
-- price of keeping the row instead is that these rows outlive the configured retention period
-- indefinitely; the set is bounded by manual operator recoveries and every member of it is a refund
-- whose money left the business, and components/settings/data-retention.tsx says so.
--
-- What remains is only what no design can remove: this check accuses nothing it cannot see, and it
-- never produces a false positive from a missing entry. A row already deleted by a predecessor
-- binary's retention sweep, before that exemption shipped, is beyond any check here.
--
-- WHY THERE ARE SIX AND NOT FIVE (Codex MEDIUM, round 5). Checks 1-5 model what the predecessor
-- WRITES INTO A ROW. They do not model what it does to a row's STATUS AND MESSAGE while leaving the
-- payload and the stamp alone — and that transition is not harmless, because the recovery inbox
-- selects on status. The old held-invoice release sweep selects a hold by payload->>'reason', which
-- is OPERATOR-CONTROLLED text, so it can pick up a genuine refund park; when the order behind it is
-- already invoiced it writes status = 'SYNCED' and a 'Superseded:' message and stops. The park's
-- payload is untouched and its stamp still says WC_REFUND_PARK, so all five earlier checks return
-- zero — and activeRefundParkWhere lists only PENDING/FAILED/QUARANTINED, so the park is gone from
-- the inbox for ever with a real, unrefunded amount on it. CHECK 6 IS THAT SIGNATURE, and it covers
-- the sweep's other two outcomes for the same reason.
--
-- This file's own comments already ACKNOWLEDGED that transition ("WHAT IS STILL NOT COVERED") and
-- enforced nothing about it. An honest note about a blind spot is still a blind spot.
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
-- answer on check 3, 4, 5, 6 or 7 is NOT repairable automatically and needs the incident handling in
-- migration.sql. On check 7 the activity entry names the order the park was taken FROM
-- (metadata.parkedOrderId) and the refund it described, which is where the lost payload has to be
-- reconstructed from. On check 6 in particular the row still holds the store's refund body, so the amount
-- is recoverable by hand — what has been lost is the row's place in the recovery inbox, and its own
-- error text.
--
-- ONE PREDICATE, FOUR READERS (Codex HIGH, round 10). "Is this row a held sales invoice?" is asked
-- in four places: backfill statement 1 and CHECK 1 ask it POSITIVELY, backfill statement 2 and
-- CHECK 6 ask it NEGATED. It is now the SAME five-clause text in all four — payload object, the
-- queue reason, an accountingPayload OBJECT, salesOrderId equal to the row's own entityId, and the
-- metaKey — and tests/prisma/shopping-sync-log-record-kind-verify.test.ts asserts that character
-- for character.
--
-- The two negating readers used to test ONE FIELD, `payload->>'metaKey' IS NULL`. A refund payload
-- is cast from the store's API response and stored unchanged, so an extension or a malformed
-- response can decorate it with an unrelated top-level `metaKey` — and that one forged field made
-- statement 2 refuse to stamp a genuine park AND made check 6 blind to the sweep superseding it.
-- A SINGLE FIELD IS NOT A SHAPE, and any field that arrives from an external system is forgeable.
--
-- The negation is spelled `(...) IS NOT TRUE`, never `NOT (...)`: the members compared may be
-- ABSENT, absent is SQL NULL, and `NOT (UNKNOWN)` is UNKNOWN — which would drop such a row out of
-- BOTH sides of the classification. Same trap as `<>` versus `IS DISTINCT FROM` in check 5.
-- =============================================================================

-- 1. NO UNSTAMPED HOLD. Every held sales invoice must say so, or it is never released and the order
--    is never invoiced. A row matching this shape with a NULL recordKind was created after the
--    backfill ran, i.e. by a predecessor that was still serving.
--
--    NO STATUS CLAUSE, AND IT IS THE THIRD TIME THIS FILE HAS HAD TO REMOVE ONE (Codex HIGH, round
--    5). This check used to require PENDING, which is the status a hold is WRITTEN in — not the
--    status it is always FOUND in. The predecessor's own release sweep settles a hold to FAILED when
--    its order cannot be found or its payload will not read, and its recovery inbox settles one to
--    SYNCED; at that instant this check went quiet over an unstamped hold that still exists.
--
--    THIS CHECK IS THE EXACT MIRROR OF BACKFILL STATEMENT 1, and it has to stay that way: the
--    prescribed repair is "re-run the two UPDATE statements", so anything this check reports must be
--    something statement 1 will stamp. While this check read a status and statement 1 read the same
--    status, they agreed and were both wrong together; a fix to one alone would have left the check
--    reporting rows the repair could not touch — and the repair would then have fallen through to
--    statement 2 and declared an invoice hold a refund park. Both now classify on the payload shape,
--    which no status transition rewrites.
SELECT 'shopping_sync_logs unstamped held sales invoice' AS check_name,
       count(*)                                          AS violations
  FROM "shopping_sync_logs"
 WHERE "recordKind" IS NULL
   AND connector = 'woocommerce'
   AND direction = 'FROM_CONNECTOR'
   AND "entityType" = 'SalesOrder'
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
--    ITS STATUS LIST IS DELIBERATE, AND IT WAS RE-EXAMINED (Codex HIGH, round 5, after the same
--    shape was found in check 1 and in backfill statement 1). This check DOES read status, and a
--    predecessor settling an unstamped park to SYNCED does switch it off. That is kept, because the
--    list is exactly activeRefundParkWhere's: an unstamped SYNCED row is invisible to the recovery
--    inbox whether it is stamped or not, so there is nothing this check could report that stamping
--    would fix. What makes that safe rather than merely arguable is CHECK 6, which reads neither the
--    status nor the stamp and catches the act that produced the SYNCED row in the first place.
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
--    body cannot carry that SET: an operator controls the free-text `reason`, and an extension that
--    decorates the refund object may add a stray member of its own, but neither produces an
--    accountingPayload OBJECT naming this row's entityId. THE WHOLE SHAPE IS THE TEST, never one
--    member of it — the same five clauses the backfill relies on to tell the families apart. A
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
--    THE SHAPE IS THE TEST, AND TWO FIELDS ARE NOT A SHAPE (Codex r11 HIGH). This check used to
--    require an `accountingPayload` OBJECT and a non-null `metaKey` and call the PAIR unforgeable.
--    Calling a pair of fields unforgeable does not create a trust boundary: a refund payload is cast
--    from the store's response and stored UNCHANGED, so a decorating extension controls every
--    top-level member of it. The r10 HIGH one check over is exactly that — a forged `metaKey` on a
--    genuine refund body — and this check, which reads BOTH of the fields that HIGH said could not
--    be trusted individually, kept the pair. A genuine refund park whose raw WooCommerce payload
--    happens to carry an `accountingPayload` object and any non-null `metaKey`, dismissed by an
--    operator through the recovery inbox, would be counted here.
--
--    AND BEING CAUGHT HERE IS NOT A SAFE DEGRADATION. verify.sql runs as the post-migration
--    verification hook, AFTER the schema has moved and while the application and the database are
--    both still fenced. A non-zero count is a failed deploy in that window, every retry fails
--    identically over the same untouched row, and the way out is a hand-edit of a customer's refund
--    evidence. A false positive here costs an outage; there is no "it will be looked at" reading.
--
--    AND A LONGER LIST OF FORGEABLE FIELDS IS STILL FORGEABLE (Codex r12 HIGH). r11 answered "two
--    fields are not a shape" by requiring eight — every member buildHeldSalesInvoicePayload writes.
--    Every one of them is a TOP-LEVEL member of a payload this file itself says is persisted
--    unchanged from the store's response, so a decorating extension controls all eight. Adding more
--    of the same kind of clause raises the price of a false positive; it does not change its
--    possibility, and the cost of one here is an outage (above).
--
--    THE DISCRIMINATOR HAD TO BE STRUCTURAL, AND THERE IS ONE. `WcRefund.id` is REQUIRED
--    (lib/connectors/woocommerce/sync/types.ts) and a park persists the refund body whole
--    (upsertRefundPark, `payload: wcRefund`), so EVERY refund park payload carries a top-level `id`.
--    buildHeldSalesInvoicePayload returns eight members and `id` is not among them, and neither
--    recovery action writes `payload` — so NO held-invoice payload has ever had one. That is an
--    asymmetry between the two shapes rather than another field a store could decorate:
--
--        AND payload->'id' IS NULL
--
--    It is spelled on `->` (the member) rather than `->>` (its text) so that a refund body carrying
--    `"id": null` is EXCLUDED too: `->` returns the json null, which IS NOT NULL, so the check does
--    not fire. Every ambiguity about `id` therefore resolves AWAY from the outage.
--
--    The same reasoning licenses `"externalId" = payload->>'externalOrderId'`:
--    holdWcSalesInvoiceForMissingNumber writes both from `wcOrder.id`, and neither recovery action
--    writes `externalId` (asserted in tests/prisma/shopping-sync-log-record-kind-verify.test.ts). A
--    park's externalId is the REFUND id, so a decorated refund body would have to name itself.
--
--    AND THE IDENTITY CLAUSE IS SPLIT BY MUTATION (Codex r12 HIGH). r11 omitted it from BOTH checks,
--    which is what let a decorated refund body with no `salesOrderId` at all be selected by check 5.
--    A DISMISS moves NEITHER entityId nor the payload, so THIS check requires the equality:
--
--        AND payload->>'salesOrderId' = "entityId"
--
--    Nothing is lost by that. A REASSIGN that broke the equality — with or without a DISMISS after
--    it — leaves a string salesOrderId naming the FIRST order, which is exactly what check 5 now
--    requires; check 5 reads neither the status nor the message, so reassign-then-dismiss lands
--    there.
--
--    The stamp is still deliberately NOT in this check: an UNSTAMPED hold (case (a)) that the same
--    action then dismissed must be caught too, and it carries no stamp to test.
SELECT 'shopping_sync_logs operator recovery note on a held-invoice payload' AS check_name,
       count(*)                                                              AS violations
  FROM "shopping_sync_logs"
 WHERE connector = 'woocommerce'
   AND direction = 'FROM_CONNECTOR'
   AND "entityType" = 'SalesOrder'
   AND "errorMessage" LIKE 'Recovered by operator:%'
   AND jsonb_typeof(payload) = 'object'
   AND payload->'id' IS NULL
   AND payload->>'reason' = 'missing_wc_invoice_number'
   AND payload->>'connector' = 'woocommerce'
   AND jsonb_typeof(payload->'externalOrderId') = 'string'
   AND jsonb_typeof(payload->'externalOrderNumber') = 'string'
   AND jsonb_typeof(payload->'orderNumber') = 'string'
   AND jsonb_typeof(payload->'metaKey') = 'string'
   AND jsonb_typeof(payload->'accountingPayload') = 'object'
   AND "externalId" = payload->>'externalOrderId'
   AND payload->>'salesOrderId' = "entityId";

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
--    `IS DISTINCT FROM` IS GONE, AND THAT IS THE FIX (Codex r12 HIGH). It was chosen so that a hold
--    payload which had LOST its salesOrderId would count as the same contradiction. What it actually
--    did was make an ABSENT member SATISFY the clause — and every raw WooCommerce refund body is a
--    payload with no salesOrderId. r11 answered that by requiring seven more top-level members, all
--    of which the store controls, so a sufficiently decorated genuine refund still selected here.
--    verify.sql runs after the migration with the application and the database both fenced, so that
--    is a deployment outage with an identical failure on every retry and a hand-edit of a customer's
--    refund evidence as the way out.
--
--    So this check now says exactly what a REASSIGN produces, and nothing wider:
--
--        AND jsonb_typeof(payload->'salesOrderId') = 'string'
--        AND payload->>'salesOrderId' <> "entityId"
--
--    buildRefundParkReassignData writes entityId and DELIBERATELY leaves the payload alone, so the
--    string that named the first order is still there. A missing member is no longer this check's
--    business, because — as the r12 finding puts it — it cannot be distinguished safely from
--    external decoration. It is diagnosed instead by the MANUAL, non-blocking query in migration.sql
--    ("A HOLD-SHAPED PAYLOAD WITH NO ORDER ID"), where a false positive costs a look rather than a
--    cutover.
--
--    It carries the same two structural discriminators as check 4 — `payload->'id' IS NULL`, which
--    no refund body can satisfy because `WcRefund.id` is required and a park stores the body whole,
--    and `"externalId" = payload->>'externalOrderId'` — and the same complete member list. Check 4
--    takes the identity EQUALITY (a DISMISS moves neither side); this one takes the INEQUALITY (a
--    REASSIGN moves entityId and only entityId), so between them the two halves of the act are
--    covered without either admitting a payload that names nothing at all. The stamp is out of this
--    one for the same reason it is out of check 4.
SELECT 'shopping_sync_logs held-invoice payload naming another order' AS check_name,
       count(*)                                                       AS violations
  FROM "shopping_sync_logs"
 WHERE connector = 'woocommerce'
   AND direction = 'FROM_CONNECTOR'
   AND "entityType" = 'SalesOrder'
   AND "entityId" IS NOT NULL
   AND jsonb_typeof(payload) = 'object'
   AND payload->'id' IS NULL
   AND payload->>'reason' = 'missing_wc_invoice_number'
   AND payload->>'connector' = 'woocommerce'
   AND jsonb_typeof(payload->'externalOrderId') = 'string'
   AND jsonb_typeof(payload->'externalOrderNumber') = 'string'
   AND jsonb_typeof(payload->'orderNumber') = 'string'
   AND jsonb_typeof(payload->'metaKey') = 'string'
   AND jsonb_typeof(payload->'accountingPayload') = 'object'
   AND "externalId" = payload->>'externalOrderId'
   AND jsonb_typeof(payload->'salesOrderId') = 'string'
   AND payload->>'salesOrderId' <> "entityId";

-- 6. NO HELD-RELEASE OUTCOME ON A ROW THAT IS NOT A HELD SALES INVOICE — the transition every
--    earlier check watched past, and the one this file's own prose used to admit it could not see.
--
--    THE ACT. `retryHeldWcSalesInvoiceReleases` (lib/connectors/woocommerce/sync/order-import.ts)
--    walks the held queue and settles the rows it cannot release. The PREDECESSOR'S version of
--    `heldSalesInvoiceQueueWhere` has no recordKind clause, so it selects on payload->>'reason' —
--    free text an operator types into WooCommerce's refund dialog — and therefore picks up genuine
--    REFUND PARKS. It then writes ONE OF THREE OUTCOMES, and each writes only `status`, `syncedAt`
--    and `errorMessage`:
--
--      * the order is already invoiced  -> status 'SYNCED', a 'Superseded: this order already
--                                          carries ledger document …' message;
--      * the order cannot be found      -> status 'FAILED', 'The sales order this invoice was held
--                                          for cannot be found …';
--      * the payload will not read      -> status 'FAILED', 'The held sales-invoice payload is
--                                          unreadable …' — which is what a park's raw refund body
--                                          looks like to the hold's own validator.
--
--    WHY THAT IS NOT COVERED BY CHECKS 1-5. The payload is untouched, so it is still a refund body:
--    checks 3, 4 and 5 all key on the held-invoice payload shape and see nothing. The stamp is
--    untouched, so it still says WC_REFUND_PARK: checks 1 and 2 want a NULL stamp. Every one of them
--    returns zero. Meanwhile `activeRefundParkWhere` lists only PENDING, FAILED and QUARANTINED —
--    so the SYNCED outcome removes a park carrying a real, unrefunded amount from the recovery inbox
--    permanently, and the FAILED outcomes replace whatever the park itself said with a sentence about
--    an invoice.
--
--    THE SIGNATURE, AND WHY IT CANNOT BE FORGED. These three sentences are written by exactly two
--    code paths, both of which act only on a row selected by the CURRENT
--    `heldSalesInvoiceQueueWhere` — and that predicate requires recordKind = 'WC_HELD_SALES_INVOICE'
--    and a hold payload. So a row that is NOT a hold carrying one of these messages has no
--    legitimate producer.
--
--    AND "NOT A HOLD" IS A SHAPE, NOT A FIELD (Codex HIGH, round 10). This check used to say
--    `payload->>'metaKey' IS NULL`, on the argument that buildHeldSalesInvoicePayload writes a
--    metaKey on every hold and a WooCommerce refund body has no such member. But a refund payload is
--    cast from the store's response and stored UNCHANGED, so an extension that decorates the refund
--    object — or a malformed response — can put an unrelated top-level `metaKey` on a genuine refund
--    body. The sweep then supersedes that park, writes SYNCED, and THIS CHECK GOES QUIET over it:
--    check 2 is off because of the status, checks 1 and 3-5 are off because the payload is still a
--    raw refund body, and check 6 was off because of the forged field. Verification returned zero
--    while a real unrefunded park sat permanently outside the recovery inbox.
--
--    SO IT NEGATES THE COMPLETE HELD-INVOICE PREDICATE — payload object, the queue reason, an
--    accountingPayload OBJECT, salesOrderId equal to the row's own entityId, and the key. That text
--    is check 1's, character for character, and backfill statement 1's and statement 2's; a test
--    asserts all four readers carry the same predicate, so it cannot drift in one place. A genuine
--    hold settled by the sweep matches the whole shape and is not selected here, which is what keeps
--    this check at zero on a healthy database for ever.
--
--    `IS NOT TRUE` AND NOT `NOT (...)`, because the members being compared may be ABSENT and absent
--    is SQL NULL: `NOT (UNKNOWN)` is UNKNOWN and selects nothing, so a plain NOT would drop a payload
--    with no `reason` at all out of BOTH sides of the classification. `IS NOT TRUE` folds UNKNOWN in
--    with FALSE, which is the reading wanted here: whatever is not provably a hold is not a hold.
--    Same trap as `<>` versus `IS DISTINCT FROM` in check 5, one level up.
--
--    NO STATUS CLAUSE AND NO STAMP CLAUSE, for the same reasons checks 3, 4 and 5 have neither: the
--    contradiction is between the MESSAGE and the PAYLOAD, and an unstamped park from case (a) that
--    the same sweep then settled has no stamp to test.
SELECT 'shopping_sync_logs held-release outcome on a row that is not a hold' AS check_name,
       count(*)                                                              AS violations
  FROM "shopping_sync_logs"
 WHERE connector = 'woocommerce'
   AND direction = 'FROM_CONNECTOR'
   AND "entityType" = 'SalesOrder'
   AND (
             jsonb_typeof(payload) = 'object'
         AND payload->>'reason' = 'missing_wc_invoice_number'
         AND jsonb_typeof(payload->'accountingPayload') = 'object'
         AND payload->>'salesOrderId' = "entityId"
         AND payload->>'metaKey' IS NOT NULL
       ) IS NOT TRUE
   AND ("errorMessage" = 'The sales order this invoice was held for cannot be found, so it can never be released. Nothing was posted.'
     OR "errorMessage" = 'The held sales-invoice payload is unreadable, so the invoice cannot be released automatically — queue it from the order.'
     OR "errorMessage" LIKE 'Superseded: this order already carries ledger document %');

-- 7. NO ROW A REFUND-PARK RECOVERY TOUCHED MAY NOW BE A HELD SALES INVOICE — the check that reads
--    HISTORY, because by this point the current state can be made to look innocent.
--
--    THE ACT, AND WHY THE SIX ABOVE ALL GO QUIET OVER IT (o3d-xnwu r13, Codex HIGH). Checks 1-6
--    model what a predecessor WRITES INTO A ROW, and each of them reads the row AS IT IS NOW. Check
--    5 in particular assumes a REASSIGN is the last payload-relevant mutation there will be. It is
--    not:
--
--      1. the predecessor's recovery inbox admits a held sales invoice for order A as a park and an
--         operator REASSIGNs it to order B. buildRefundParkReassignData writes entityId = B, status
--         PENDING and a 'Recovered by operator:' note, and DELIBERATELY leaves the payload alone —
--         so the row now carries A's held-invoice payload while sitting on B. Check 5 catches
--         exactly this.
--      2. then order B genuinely needs a hold. The PREDECESSOR'S `heldSalesInvoiceQueueWhere` has no
--         recordKind clause, so its findFirst on (entityId = B, payload->>'reason') SELECTS THIS
--         ROW, and holdWcSalesInvoiceForMissingNumber UPDATES it wholesale: payload, externalId,
--         errorMessage, status, syncedAt. payload.salesOrderId is B again — equal to entityId — the
--         operator's note is gone, and the externalId names B's WooCommerce order.
--
--    What is left is a row indistinguishable from a legitimate hold for B, which the backfill then
--    stamps WC_HELD_SALES_INVOICE. Check 5 needs salesOrderId <> entityId: quiet. Checks 3 and 4
--    need the operator's note in errorMessage: overwritten, quiet. Checks 1 and 2 need a NULL stamp:
--    stamped, quiet. Check 6 needs a row that is NOT hold-shaped: it is, quiet. ALL SIX RETURN ZERO
--    — and A's only held accounting payload has been destroyed, so A's invoice may never be queued.
--
--    WHEN THE CURRENT STATE CAN BE MADE TO LOOK INNOCENT, THE EVIDENCE HAS TO COME FROM HISTORY.
--    `recoverParkedWcRefund` writes a `wc_refund_park_recovered` activity entry naming the row it
--    acted on (metadata.shoppingSyncLogId) — IN THE SAME TRANSACTION as the park mutation
--    (`logActivityInTransaction`, which does not catch, so the recovery cannot commit without it),
--    exempt from activity-log retention, and rewritten or deleted by no code path. That entry is a
--    fact about the PAST that a later overwrite of the sync-log row cannot reach. So this check
--    says: a row a park recovery once acted on must never afterwards be shaped or stamped as a held
--    sales invoice.
--
--    BOTH OUTCOMES, NOT ONLY REASSIGN. A DISMISS leaves entityId alone, so the same second step —
--    the predecessor re-holding order A onto the dismissed row — restores the identity equality and
--    replaces the note check 4 keys on. Check 4 rests on the same last-mutation assumption as check
--    5, and this covers it. (It is also why the DISMISS of a MISCLASSIFIED hold is counted here as
--    well as by check 4: the payload is hold-shaped from the moment of the dismissal. Two checks
--    naming one incident is a duplicate report, never a false one.)
--
--    AND IT CANNOT ACCUSE A GENUINE PARK, WHATEVER THE STORE PUT IN THE REFUND BODY (the r11/r12
--    lesson, and the reason this is safe to run fenced). The discriminator is the same structural
--    asymmetry checks 4 and 5 use: `payload->'id' IS NULL`. `WcRefund.id` is REQUIRED and a park
--    stores the store's refund body WHOLE, so every genuine park has one — decorated with an
--    `accountingPayload`, a `metaKey` and any `reason` an operator typed or not. Spelled on `->` so
--    that a body carrying `"id": null` is excluded too. A legitimately recovered park therefore
--    cannot reach either arm of the disjunction, and a false positive here would be a cutover
--    outage.
--
--    NO STATUS CLAUSE AND NO IDENTITY CLAUSE, deliberately: the identity equality is the very thing
--    the second write RESTORES, so a check that required it to be broken would be blind again.
SELECT 'shopping_sync_logs recovered refund park now shaped or stamped as a held sales invoice' AS check_name,
       count(*)                                                                                 AS violations
  FROM "shopping_sync_logs"
 WHERE connector = 'woocommerce'
   AND direction = 'FROM_CONNECTOR'
   AND "entityType" = 'SalesOrder'
   AND jsonb_typeof(payload) = 'object'
   AND payload->'id' IS NULL
   AND EXISTS (
         SELECT 1
           FROM "activity_logs"
          WHERE "activity_logs".action = 'wc_refund_park_recovered'
            AND "activity_logs".metadata->>'shoppingSyncLogId' = "shopping_sync_logs".id
       )
   AND (
            "recordKind" = 'WC_HELD_SALES_INVOICE'
         OR (
                  payload->>'reason' = 'missing_wc_invoice_number'
              AND jsonb_typeof(payload->'accountingPayload') = 'object'
              AND payload->>'metaKey' IS NOT NULL
            )
       );
