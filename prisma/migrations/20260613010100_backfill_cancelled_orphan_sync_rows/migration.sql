-- audit-46ry: reclassify historical orphan-cancelled rows (previously marked
-- FAILED with the H4 'Cancelled: orphaned...' reason) to the new CANCELLED status
-- so they too drop out of FAILED-scanning reconciliation/backfill sweeps and
-- error dashboards. Separate migration from the ADD VALUE because Postgres cannot
-- use a newly-added enum value in the same transaction that adds it.
UPDATE "accounting_sync_logs"
SET "status" = 'CANCELLED'
WHERE "status" = 'FAILED'
  AND "errorMessage" LIKE 'Cancelled: orphaned accounting sync row%';
