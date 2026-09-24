-- o3d-hpeg — A HARD BOUND ON HOW MANY TIMES ONE EMAIL ROW CAN ENTER THE SENDER.
--
-- THE DEFECT. The email outbox drain reclaims a PROCESSING row on elapsed time alone
-- (processingStartedAt < now - 15 minutes), and a reclaim resets that instant, so the reclaimer is
-- itself reclaimable one window later: A, B and C can all enter the sender for one row, and nothing
-- capped the chain. The o3d-alnk fence stopped the losers overwriting the winner's settlement; it did
-- not bound the sends.
--
-- THE BOUND. "staleReclaimCount" counts the elapsed-time RECLAIMS a row has had, over its whole life.
-- The drain increments it in the SAME conditional UPDATE that takes the reclaim, and that UPDATE only
-- matches while the count is below the cap (lib/email-outbox.ts, EMAIL_MAX_STALE_RECLAIMS = 1), so two
-- reclaimers cannot both pass at the cap. A first claim of a PENDING row does not touch it. A stale
-- PROCESSING row at the cap is not reclaimed again: it is moved to PARKED_SEND_CAP, which the drain
-- never selects, for an operator to release or cancel (scripts/email-outbox-parked.ts).
--
-- NOT NULL DEFAULT 0 because every existing row has had no counted reclaim; that is the truthful
-- starting value, and it matches `staleReclaimCount Int @default(0)` in prisma/schema.prisma.
--
-- The new enum value is added HERE and first USED by the next migration, because PostgreSQL refuses to
-- use an enum value in the transaction that added it.
ALTER TYPE "EmailOutboxStatus" ADD VALUE 'PARKED_SEND_CAP';

ALTER TABLE "email_outbox" ADD COLUMN "staleReclaimCount" INTEGER NOT NULL DEFAULT 0;
