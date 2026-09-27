-- o3d-j625 r16 (Codex round 15, HIGH 1) — SETTLING A REFUSED POSTING BY HAND IS AN ACT, NOT AN INSTRUCTION.
--
-- Until now the remedy for a refused posting was a sentence: "post it by hand and mark this row handled".
-- The operator's ledger write happens outside every transaction IMS holds, so between reading that sentence
-- and making the posting, any path can queue the same posting and the worker can send it. The mark's guard
-- fires when the operator comes BACK, which is after the duplicate exists. Round 14 narrowed that window by
-- classifying live rows at render time; round 15's finding is that a narrowed window is not prevention.
--
-- These two columns are the claim that closes it. Taking it cancels the provably-unsent rows for the posting
-- key and refuses if any row may already have been sent, in one transaction under the key's advisory lock;
-- while it is held, every creation of an accounting sync row for that key is refused, so nothing can queue
-- the posting behind the operator's back, and a second operator is refused the claim rather than racing for
-- it. It is releasable, and marking the posting handled clears it.
--
-- NULLABLE AND NOT BACKFILLED: NULL means unclaimed, which is what every existing row is.
ALTER TABLE "accounting_posting_refusals" ADD COLUMN "handPostClaimedAt" TIMESTAMP(3);
ALTER TABLE "accounting_posting_refusals" ADD COLUMN "handPostClaimedBy" TEXT;
