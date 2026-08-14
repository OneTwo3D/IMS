-- o3d-nepa: retention must key on WHEN A ROW RESOLVED, not on when it was created.
--
-- purgeExpiredData hard-deleted accounting_sync_logs by createdAt alone. Terminalisation never
-- refreshes createdAt, so a row that was still unresolved (PENDING/PROCESSING) — or that had only
-- just terminalised — was deleted by the very next cleanup. That destroyed the order-delete guard's
-- only evidence that a document may exist in the ledger (o3d-ju8t: FAILED does not prove nothing
-- posted; o3d-0g2n: QuickBooks' updateBackReference swallows its failure and has no repair sweep,
-- so the sync row can be the ONLY record that an invoice exists).
--
-- Both columns are ADDITIVE and NULLABLE, so this is metadata-only on a modern Postgres: no table
-- rewrite, no lock beyond a brief ACCESS EXCLUSIVE for the catalog update.

-- When the row reached a TERMINAL state (SYNCED / FAILED / CANCELLED). Written in the SAME update
-- as every terminal transition, and cleared back to NULL wherever a row is de-terminalised
-- (FAILED -> PENDING retry / follow-up revival), so the clock only runs while the row is resolved.
--
-- DELIBERATELY NOT BACKFILLED. Every pre-migration row reads NULL, which must mean neither
-- "expired long ago" (that would delete/compact the entire history on the first run) nor "never
-- expires" (nothing would ever be cleaned). lib/data-retention.ts resolves it explicitly: NULL
-- falls back to createdAt, which is sound ONLY because the two branches that consume it cannot
-- destroy guard evidence — the delete branch is restricted to rows the guard cannot see at all
-- (CANCELLED with no externalTransactionId), and the compact branch KEEPS every field the guard
-- reads. Non-terminal rows are excluded by status, so the fallback never reaches them.
ALTER TABLE "accounting_sync_logs" ADD COLUMN "resolvedAt" TIMESTAMP(3);

-- When retention reduced this row to a tombstone. NOT NULL means "already compacted": a
-- SQL-expressible idempotence guard so each daily run only touches newly-eligible rows rather than
-- rewriting the whole retained tombstone set, and an honest marker for anyone later reading a
-- payload that is missing detail.
ALTER TABLE "accounting_sync_logs" ADD COLUMN "compactedAt" TIMESTAMP(3);

-- Retention's expiry scan for both branches: status filter + resolvedAt cutoff. Not
-- connector-scoped — retention sweeps every connector in one pass, unlike the sync processors.
CREATE INDEX IF NOT EXISTS "accounting_sync_logs_status_resolvedAt_idx"
  ON "accounting_sync_logs" ("status", "resolvedAt");

-- PARTIAL index for the compact branch specifically. It is declared here rather than in
-- schema.prisma because Prisma cannot express a partial index (same reason as
-- accounting_sync_logs_idempotency_key_uq, 20260424214500). Its whole value is that it SHRINKS as
-- rows are compacted, so the scan for "terminal, expired, not yet compacted" stays cheap forever
-- instead of degrading once most expired rows already carry a compactedAt.
CREATE INDEX IF NOT EXISTS "accounting_sync_logs_retention_compact_idx"
  ON "accounting_sync_logs" ("resolvedAt", "createdAt")
  WHERE "compactedAt" IS NULL;
