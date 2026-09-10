-- o3d-alnk — give the email outbox a HOLDER IDENTITY and make a duplicate undelivered
-- row impossible at the database level.
--
-- PART 1 — the claim fence (schema-visible; see model EmailOutbox).
--
-- processPendingEmailOutbox reclaimed a PROCESSING row on ELAPSED TIME ALONE
-- (processingStartedAt < now - 15min) and then settled it with
-- update({ where: { id } }) — keyed on the id and nothing else. A worker paused on a
-- stalled SMTP socket therefore came back and wrote over the reclaimer's outcome; when
-- its send had failed retryably it wrote status PENDING + a fresh availableAt OVER the
-- winner's SENT, RE-ARMING the row for a third delivery. `lockedBy` carries a per-claim
-- random token so every terminal write can compare-and-set on (id, PROCESSING, lockedBy,
-- processingStartedAt) and the loser's UPDATE matches zero rows.
ALTER TABLE "email_outbox" ADD COLUMN "lockedBy" TEXT;

-- PART 2 — the enqueue guard.
--
-- prisma-schema-scope-ok: db-native partial UNIQUE index — Prisma's schema language cannot
-- express a filtered unique (a WHERE predicate on an index), so this constraint cannot live
-- in schema.prisma and is declared here instead.
--
-- At most ONE UNDELIVERED row may exist per (kind, referenceType, referenceId). The claim
-- fence above stops one row being SETTLED twice; it cannot stop two ROWS being created for
-- the same logical email, and there was no uniqueness of any kind on this table. The
-- concrete reachable case is o3d-8td2's: xero/accounting.post multiplexes every
-- AccountingSyncType and INVOICE_EMAIL's whole effect is queueEmail -> a bare
-- emailOutbox.create, so a replayed outbox row simply inserted a second invoice email.
-- queueDispatchEmailIfEligible's findFirst-then-create is the same shape, guarded today
-- only by the sales-order row lock.
--
-- SCOPED TO UNDELIVERED STATUSES ON PURPOSE. A lifetime unique on the triple would forbid a
-- deliberate later re-send (an operator re-sending an invoice after correcting an address),
-- which is a supported action in app/actions/email.ts. PENDING/PROCESSING is exactly the
-- window in which a second row is a duplicate rather than a decision. Rows with a NULL
-- reference are unconstrained: they carry no identity to deduplicate on.
--
-- NOTE ON WHAT THIS DOES AND DOES NOT MAKE IMPOSSIBLE: it makes a duplicate undelivered ROW
-- impossible. It cannot make a duplicate SMTP SEND impossible — that effect is outside the
-- database and no local write can retract it.

-- Hold SHARE ROW EXCLUSIVE across the dedup and the index build in one explicit transaction,
-- so a concurrent enqueue cannot insert a duplicate between the UPDATE's snapshot and
-- CREATE UNIQUE INDEX and abort the deploy with the very race this index exists to prevent.
-- Prisma's runner does not auto-wrap a migration, so BEGIN/COMMIT is explicit.
BEGIN;

LOCK TABLE "email_outbox" IN SHARE ROW EXCLUSIVE MODE;

-- ---------------------------------------------------------------------------------------
-- THE COLLAPSE, AND WHY ITS RETENTION RULE IS ABOUT STATUS AND NOT ABOUT AGE (o3d-alnk r4).
--
-- Pre-existing duplicate undelivered rows have to go, or CREATE UNIQUE INDEX below fails and
-- the deploy stops. WHICH of them survives is not a bookkeeping detail — it decides whether a
-- customer is mailed once or twice, and the first version of this migration got it wrong.
--
-- THE DEFECT THAT WAS HERE. The rule was "keep the OLDEST row per key". A PENDING row and a
-- PROCESSING row are both undelivered, and a PROCESSING row is one a worker has CLAIMED and
-- may at this moment be on the SMTP socket for. If the oldest was the PENDING one, this
-- migration marked the PROCESSING row FAILED — which stops no send, because the send is
-- already outside the database and no local write retracts it — and retained a PENDING row
-- that then delivers a SECOND copy on the next drain. The table lock guards writes; it does
-- not reach the wire.
--
-- THE RULE. Two properties, in this order:
--
--   (1) A ROW THAT MAY ALREADY BE ON THE WIRE IS NEVER THE ONE DISCARDED. PROCESSING is
--       exactly that row, so PROCESSING outranks PENDING and the UPDATE below additionally
--       refuses to touch anything that is not PENDING. That is structural, not a comment:
--       `AND a.status = 'PENDING'` means no statement in this migration can demote a claimed
--       row, whatever the ranking does.
--
--   (2) THE ROW RETAINED MUST NOT BE ONE THAT CAN NO LONGER SEND. Among PENDING siblings —
--       and only among them, since (1) already settles any mixed group — the row with the
--       FEWEST attempts is kept: it has the most retries left, and retaining an attempt-
--       exhausted row while failing a fresh one loses the email silently. `createdAt` then
--       `id` break the remaining ties, so the oldest row (the one an operator is waiting on)
--       still wins whenever the rows are otherwise equal, which is the ordinary case.
--
-- EVERY COMBINATION, EXPLICITLY. Only PENDING and PROCESSING are in scope: SENT and FAILED are
-- terminal, sit outside the partial index, and are never read or written here.
--
--   all PENDING (2+)      -> nothing is on the wire; keep fewest-attempts/oldest, FAIL the
--                            rest. Exactly one row delivers.
--   1 PROCESSING + PENDING-> keep the PROCESSING row, FAIL the PENDING ones. The only row
--                            that may have sent is retained, and the retained row's future
--                            sends are exactly what they would have been with no duplicate at
--                            all (one reclaim after the stale window, fenced by PART 1).
--   1 PROCESSING alone    -> not a duplicate; untouched.
--   2+ PROCESSING         -> REFUSED. See the guard immediately below.
--   any + SENT/FAILED     -> the SENT/FAILED rows are invisible to this statement and to the
--                            index; they are the evidence of what already happened.
--   NULL reference        -> no identity to deduplicate on; untouched, and unconstrained by
--                            the index.
--
-- WHY 2+ PROCESSING REFUSES INSTEAD OF PICKING. Two claimed rows for one logical email means
-- two workers may each be mid-send, or one may have sent and the other have died before
-- sending, and NOTHING IN THE DATABASE DISTINGUISHES THOSE. Keep the wrong one and its
-- reclaim mails a second copy on top of a send that already went out. There is no ranking
-- that is safe here and no way to find out from inside a migration, so it stops with an
-- actionable message rather than guessing. The window is small and self-clearing: the drain
-- settles a claimed row within its stale window, so re-running after a few minutes is the
-- whole remedy.
-- ---------------------------------------------------------------------------------------

-- o3d-alnk-sql-block: refuse-ambiguous-processing
DO $$
DECLARE
  ambiguous text;
BEGIN
  SELECT string_agg(format('%s/%s/%s (%s rows)', kind, "referenceType", "referenceId", n), ', ')
    INTO ambiguous
    FROM (
      SELECT kind, "referenceType", "referenceId", count(*) AS n
        FROM "email_outbox"
       WHERE status = 'PROCESSING'
         AND "referenceType" IS NOT NULL
         AND "referenceId" IS NOT NULL
       GROUP BY kind, "referenceType", "referenceId"
      HAVING count(*) > 1
    ) ambiguous_groups;

  IF ambiguous IS NOT NULL THEN
    RAISE EXCEPTION 'email_outbox: refusing to collapse duplicates for %', ambiguous
      USING DETAIL = 'More than one PROCESSING row exists for the same (kind, referenceType, referenceId). A worker may already be on the SMTP socket for either of them, and nothing in this table says which; discarding one and retaining the other can mail the customer a second copy on top of a send that already went out. Migration 20260910120000_email_outbox_claim_fence (o3d-alnk) refuses rather than guess.',
            HINT = 'Let the drain settle these claims (it does so within its stale window) or settle the losers to FAILED by hand once you know their sends are finished. This whole migration is one transaction, so nothing was applied: mark it rolled back (prisma migrate resolve --rolled-back 20260910120000_email_outbox_claim_fence) and deploy again.';
  END IF;
END
$$;
-- o3d-alnk-sql-block-end

-- Settled, not DELETED: the row is the only evidence that a second copy was ever queued, and
-- FAILED is a terminal status this table already understands. The retained row still
-- delivers, so no email is lost.
-- o3d-alnk-sql-block: collapse-duplicate-undelivered
WITH ranked AS (
  SELECT id,
         first_value(id) OVER duplicate_group AS keeper_id,
         row_number()    OVER duplicate_group AS rank_in_group
    FROM "email_outbox"
   WHERE status IN ('PENDING', 'PROCESSING')
     AND "referenceType" IS NOT NULL
     AND "referenceId" IS NOT NULL
  WINDOW duplicate_group AS (
    PARTITION BY kind, "referenceType", "referenceId"
        ORDER BY (status = 'PROCESSING') DESC, attempts ASC, "createdAt" ASC, id ASC
  )
)
UPDATE "email_outbox" a
   SET status = 'FAILED',
       "lastError" = 'Superseded duplicate: email_outbox row ' || ranked.keeper_id
         || ' is the undelivered row retained for this (kind, referenceType, referenceId). Collapsed by migration 20260910120000_email_outbox_claim_fence (o3d-alnk).',
       "processingStartedAt" = NULL,
       "lockedBy" = NULL,
       "updatedAt" = now()
  FROM ranked
 WHERE ranked.id = a.id
   AND ranked.rank_in_group > 1
   AND a.status = 'PENDING';
-- o3d-alnk-sql-block-end

-- THE BACKSTOP. If a duplicate somehow survived the collapse — a PROCESSING row the guard
-- above did not see, a ranking that did not do what it says — this fails the migration
-- rather than shipping a table the fence cannot protect. It is the reason the UPDATE is
-- allowed to be conservative (`a.status = 'PENDING'`) instead of clever.
-- o3d-alnk-sql-block: undelivered-unique-index
CREATE UNIQUE INDEX "email_outbox_undelivered_reference_uq"
ON "email_outbox" (kind, "referenceType", "referenceId")
WHERE status IN ('PENDING', 'PROCESSING')
  AND "referenceType" IS NOT NULL
  AND "referenceId" IS NOT NULL;
-- o3d-alnk-sql-block-end

COMMIT;
