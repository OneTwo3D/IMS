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

-- Collapse any pre-existing duplicate undelivered rows, or the index build fails. Keep the
-- OLDEST row per key (it is the one already in flight, and the one whose delivery an
-- operator is waiting on) and settle the rest to FAILED with an explanatory lastError.
-- Settled, not DELETED: the row is the only evidence that a second copy was ever queued, and
-- FAILED is a terminal status this table already understands. The kept row still delivers,
-- so no email is lost.
UPDATE "email_outbox" a
SET status = 'FAILED',
    "lastError" = 'Superseded duplicate: another undelivered email_outbox row already exists for this (kind, referenceType, referenceId). Collapsed by migration 20260910120000_email_outbox_claim_fence (o3d-alnk).',
    "processingStartedAt" = NULL,
    "updatedAt" = now()
FROM "email_outbox" b
WHERE a.status IN ('PENDING', 'PROCESSING')
  AND a."referenceType" IS NOT NULL
  AND a."referenceId" IS NOT NULL
  AND b.status IN ('PENDING', 'PROCESSING')
  AND b."referenceType" IS NOT NULL
  AND b."referenceId" IS NOT NULL
  AND b.kind = a.kind
  AND b."referenceType" = a."referenceType"
  AND b."referenceId" = a."referenceId"
  AND (b."createdAt" < a."createdAt" OR (b."createdAt" = a."createdAt" AND b.id < a.id));

CREATE UNIQUE INDEX "email_outbox_undelivered_reference_uq"
ON "email_outbox" (kind, "referenceType", "referenceId")
WHERE status IN ('PENDING', 'PROCESSING')
  AND "referenceType" IS NOT NULL
  AND "referenceId" IS NOT NULL;

COMMIT;
