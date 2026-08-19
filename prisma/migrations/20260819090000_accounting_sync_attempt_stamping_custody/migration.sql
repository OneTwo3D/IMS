-- o3d-0m56 round 10 (Codex HIGH x3): make "this row's unset attempt stamp is evidence" a fact the
-- ROW carries, instead of a global instant recorded once in `settings`.
--
-- THE PREMISE. `authoriseMoneyPost` stamps `remoteAttemptedAt` immediately before every remote
-- money call, so an unstamped money row is proof that no call ever left it — and the revival
-- planner overwrites such a row's payload on that basis. The proof only holds for a row that every
-- binary which created or claimed it stamps.
--
-- ROUND 9 ESTABLISHED THAT WITH AN EPOCH, AND AN EPOCH CANNOT CARRY IT:
--
--   * it compared a row's `createdAt` (this database's clock) with a value built in the app
--     process (that machine's clock), so a skew put rows on the wrong side of the boundary;
--   * its documented recovery — deleting the settings key — was invisible to a process that had
--     already cached the epoch, so the runbook did not do what it said;
--   * it was established ONCE, so rolling the binary BACK produced unstamped rows after it, which
--     the rule read as never-attempted. A rollback is a sequential deploy, so the "no overlap"
--     deploy order that round 9 leaned on was satisfied while the property still broke.
--
-- THIS COLUMN IS THE CARRIER. `attemptStampingCustodyAt` is written by binaries that stamp, at
-- CREATE and at every CLAIM, and is taken away by the trigger below from any row claimed by a
-- binary that does not write it — which a binary that has never heard of the column cannot do.
-- After this, the two populations are exactly:
--
--   attemptStampingCustodyAt IS NOT NULL -> only stamping binaries have handled it; NULL stamp is proof.
--   attemptStampingCustodyAt IS NULL     -> something else handled it; the NULL stamp proves nothing.
--
-- ONE TRANSACTION. Prisma's runner does not wrap a migration file, and the three statements below
-- are only sound together: granting custody (step 3) is safe ONLY because step 2 has already
-- stamped every money row that could still be hiding an attempt. Interrupted between them, this
-- would hand custody to rows nothing has vouched for — which is the exact hole it closes.
BEGIN;

-- 1. The carrier. NULLABLE with no default, so a binary that does not know about it writes NULL by
--    omission — the untrusted value. That default is the whole rollback story: it needs no
--    cooperation from the binary being rolled back to.
ALTER TABLE "accounting_sync_logs" ADD COLUMN "attemptStampingCustodyAt" TIMESTAMP(3);

-- 2. RE-RUN THE CONSERVATIVE MONEY BACKFILL. 20260818090000 stamped the money rows that existed
--    when IT ran; everything a non-stamping binary has created since (every deploy has a window in
--    which the old binary is still serving) is unstamped and unaccounted for. Those rows may
--    already be in the ledger, so they are stamped now — with the best lower bound the row itself
--    carries, never now(), which would claim an attempt happened at migration time.
--
--    Being wrong costs one extra ledger GET before that row's next post. Being wrong the other way
--    costs a duplicate payment.
UPDATE "accounting_sync_logs"
   SET "remoteAttemptedAt" = COALESCE("syncedAt", "processingStartedAt", "createdAt")
 WHERE "remoteAttemptedAt" IS NULL
   AND "type" IN ('INVOICE_PAYMENT', 'BILL_PAYMENT', 'PURCHASE_CREDIT_NOTE_ALLOCATION');

-- 3. GRANT CUSTODY TO EVERY ROW THAT EXISTS NOW — safe, and necessary.
--
--    Safe: after step 2 no money row has a NULL stamp, so custody cannot make any unstamped money
--    row look trustworthy. Necessary: without it every historical PDF, e-mail and attachment
--    follow-up would be permanently un-recyclable (their `remoteAttemptedAt` is NULL for ever, and
--    correctly so — a duplicate PDF is not a settlement), and the repair's partial index would
--    carry every sync row this system has ever written instead of being empty.
--
--    The value is `createdAt` rather than now(): custody dates from when the row was written, and
--    a row's own timestamp is the only honest answer available here.
UPDATE "accounting_sync_logs" SET "attemptStampingCustodyAt" = "createdAt";

-- 4. THE FORFEIT. A claim by a binary that does not maintain custody must LOSE it, or a rolled-back
--    binary could post from a row this one created and leave it still looking trustworthy.
--
--    The rule: an UPDATE that starts a claim — moves `processingStartedAt` to a new non-null value,
--    or moves the row into PROCESSING — and does NOT re-assert custody in the same statement,
--    forfeits it. Re-asserting means writing custody EQUAL TO THE CLAIM INSTANT, which is exactly
--    the pair `stampingCustodyOnClaim` returns and exactly what a binary without the column cannot
--    write.
--
--    Deliberately not "custody changed in this statement". That test passes only if the new value
--    differs from the old one, so two writes landing on the same millisecond would forfeit custody
--    for no reason. Equality with `processingStartedAt` is a property of the STATEMENT rather than
--    of the row's history, so it is decided the same way every time.
--
--    Enforced HERE rather than in application code because the binary it defends against is one
--    that runs its own application code. The condition lives in the WHEN clause so the vast
--    majority of updates never enter plpgsql at all.
--
--    A release (`processingStartedAt` set back to NULL) is deliberately not a forfeit: it starts no
--    claim, and a row already outside custody stays outside it — custody is only ever restored by a
--    stamping binary's own claim, and by then `repairMoneyAttemptsOutsideStampingCustody` has
--    already made the forfeit permanent as a `remoteAttemptedAt` stamp.
CREATE OR REPLACE FUNCTION accounting_sync_logs_forfeit_stamping_custody()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."attemptStampingCustodyAt" := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounting_sync_logs_forfeit_stamping_custody ON "accounting_sync_logs";
CREATE TRIGGER accounting_sync_logs_forfeit_stamping_custody
BEFORE UPDATE ON "accounting_sync_logs"
FOR EACH ROW
WHEN (
  NEW."attemptStampingCustodyAt" IS NOT NULL
  AND NEW."attemptStampingCustodyAt" IS DISTINCT FROM NEW."processingStartedAt"
  AND (
    (NEW."processingStartedAt" IS NOT NULL
     AND NEW."processingStartedAt" IS DISTINCT FROM OLD."processingStartedAt")
    OR (NEW."status" = 'PROCESSING' AND OLD."status" IS DISTINCT FROM NEW."status")
  )
)
EXECUTE FUNCTION accounting_sync_logs_forfeit_stamping_custody();

-- 5. The round-9 epoch is gone, and a database that recorded one must not keep a key nothing reads
--    and the runbook no longer mentions. Harmless where it was never written.
DELETE FROM "settings" WHERE "key" = 'accounting.money-attempt-stamping-since';

COMMIT;
