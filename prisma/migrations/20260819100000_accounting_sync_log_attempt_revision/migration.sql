-- o3d-e2mz: a per-attempt revision on accounting_sync_logs.
--
-- An operator decision recorded against "the current state" of a sync row could not be fenced to
-- the attempt it was made about. Status cannot do it: every path returns a row to a status it
-- already held (retryFailedXeroSync drives FAILED -> PENDING -> FAILED, the stale-claim reclaim
-- drives PROCESSING -> PROCESSING), so a compare-and-swap on (id, status) can match a LATER
-- attempt than the one that was judged. retryCount cannot do it either — retryFailedXeroSync
-- resets it to 0, so it is not monotonic.
--
-- The processor bumps this on every claim and compare-and-swaps its writeback on the value it
-- claimed, so a decision taken between the read and the writeback is detected by BOTH sides rather
-- than one silently overwriting the other.
--
-- Every existing row starts at 0, which reads as "never claimed under the fence" — the conservative
-- value: settlement refuses such a row instead of assuming an attempt identity it cannot know.
-- Adding a NOT NULL column WITH a constant default is metadata-only on Postgres 11+ (no rewrite).
ALTER TABLE "accounting_sync_logs"
  ADD COLUMN "attempt_revision" INTEGER NOT NULL DEFAULT 0;
