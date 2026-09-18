-- o3d-j625 r6 (review H4; owner decision 2026-09-18, "Mark as handled").
--
-- A refused posting whose only remedy is a manual posting can never be cleared by IMS queueing it, because
-- nothing in IMS raises that posting again. Such rows are marked handled by a person, and the row records
-- which site refused (`kind`, which decides whether marking is allowed), how it was resolved
-- (`queued` | `handled_manually`), who resolved it, and an optional note. All four are nullable text with
-- no default, exactly as schema.prisma declares them: a row written before this migration has no kind and
-- is therefore never markable, which is the fail-closed direction.
ALTER TABLE "accounting_posting_refusals" ADD COLUMN "kind" TEXT;
ALTER TABLE "accounting_posting_refusals" ADD COLUMN "resolution" TEXT;
ALTER TABLE "accounting_posting_refusals" ADD COLUMN "resolvedBy" TEXT;
ALTER TABLE "accounting_posting_refusals" ADD COLUMN "resolutionNote" TEXT;
