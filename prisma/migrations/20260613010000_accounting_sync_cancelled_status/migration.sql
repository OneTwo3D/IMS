-- audit-46ry: add a CANCELLED status to AccountingSyncStatus so deliberately
-- abandoned sync rows (cross-connector orphans cancelled on connector switch)
-- are distinguishable from genuine FAILED rows. Reconciliation / event-backfill
-- sweeps and FAILED dashboards scan explicit status lists that exclude CANCELLED,
-- so these rows stop being surfaced as unresolved failures or re-queued.
ALTER TYPE "AccountingSyncStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
