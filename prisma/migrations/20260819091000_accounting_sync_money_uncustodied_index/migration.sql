-- o3d-0m56 round 10: serve `repairMoneyAttemptsOutsideStampingCustody`, which runs at the top of
-- every sync run — before anything is claimed — and stamps money rows that a binary outside
-- stamping custody may have posted from.
--
-- PARTIAL, on exactly the repair's own predicate, and that is what makes it free. In steady state
-- every row is created inside custody, so the indexed set is EMPTY: the repair's UPDATE finds
-- nothing without touching the table. It only fills after a deploy window, an overlap or a
-- rollback — precisely the rows the repair exists to find — and empties again as it stamps them.
--
-- The type arm is deliberately NOT in the predicate. The repair passes the money types as a bound
-- text array (`"type"::text = ANY($1::text[])`, so the constant in the code cannot drift from the
-- SQL), and the planner cannot prove such a filter implies an enum IN-list predicate — an index it
-- could then never use. The other two conjuncts are matched literally and are what narrow the set.
--
-- CONCURRENTLY, in its own migration file, because `accounting_sync_logs` grows with daily
-- operations (docs/migration-conventions.md) and a plain CREATE INDEX would block writes to it for
-- the build. CONCURRENTLY cannot run inside a transaction, which is why this is not folded into
-- 20260819090000.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "accounting_sync_logs_money_attempt_uncustodied_idx"
ON "accounting_sync_logs" ("type")
WHERE "remoteAttemptedAt" IS NULL AND "attemptStampingCustodyAt" IS NULL;
