-- o3d-iup: a QUARANTINED status for a connector refund the sync deliberately parked because it cannot
-- be posted safely (a monetary-only refund on a non-uniformly-taxed order). Distinct from FAILED so the
-- refund sweep dedup skips it (no per-sweep re-refusal loop) and error dashboards don't treat it as a
-- transient failure. Postgres enum value add — additive, must run outside a txn block if batched, but a
-- lone ADD VALUE is fine.
ALTER TYPE "ShoppingSyncStatus" ADD VALUE IF NOT EXISTS 'QUARANTINED';
