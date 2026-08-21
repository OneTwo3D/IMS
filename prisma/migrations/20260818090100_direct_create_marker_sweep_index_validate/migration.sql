-- Post-build validity check for activity_logs_direct_create_marker_idx (o3d-z82a, Codex r4).
--
-- 20260818090000 builds that index with CONCURRENTLY, which is the only way to add it without
-- blocking every write to activity_logs. The price of a concurrent build is that an interrupted
-- one does not disappear: Postgres leaves the index behind marked INVALID, and an invalid index is
-- the worst of both worlds — the planner will not use it, so the marker sweep silently goes back
-- to scanning 30-90 days of activity_logs four times an hour, while every INSERT into that table
-- still pays to maintain it. Nothing about that state is visible from the application: the sweep
-- keeps working, just slowly and expensively, which is the failure mode this whole pair of
-- migrations exists to remove.
--
-- So it is asserted here rather than hoped for. This check fails the deploy if the index is
-- missing or invalid, and names the remediation.
--
-- A SEPARATE migration file because the build itself cannot share a file with anything: Postgres
-- wraps a multi-statement simple-query string in an implicit transaction and CREATE INDEX
-- CONCURRENTLY cannot run in one. This DO block is an ordinary transaction-safe statement — it
-- reads pg_index and modifies nothing — so it is fine on its own here.
--
-- Not represented in schema.prisma because there is nothing to represent: this migration creates
-- no object at all, and the index it checks is a partial index Prisma cannot model.
-- prisma-schema-scope-ok: db-native index validity assertion | reason: Prisma schema cannot express a partial index, nor a deploy-time assertion over pg_index that a concurrent build completed

DO $$
DECLARE
  v_oid   oid;
  v_valid boolean;
BEGIN
  SELECT c.oid, i.indisvalid
    INTO v_oid, v_valid
  FROM pg_class c
  JOIN pg_index i ON i.indexrelid = c.oid
  WHERE c.relname = 'activity_logs_direct_create_marker_idx'
    AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema());

  IF v_oid IS NULL THEN
    RAISE EXCEPTION
      'activity_logs_direct_create_marker_idx does not exist. The concurrent build in 20260818090000 did not complete. Remediate per that migration and rerun the deploy.';
  END IF;

  IF NOT v_valid THEN
    RAISE EXCEPTION
      'activity_logs_direct_create_marker_idx exists but is INVALID: the concurrent build in 20260818090000 was interrupted. The planner ignores it while every activity_logs write still maintains it. Drop it and rebuild: DROP INDEX CONCURRENTLY IF EXISTS "activity_logs_direct_create_marker_idx";';
  END IF;
END $$;
