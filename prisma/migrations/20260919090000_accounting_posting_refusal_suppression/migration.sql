-- o3d-j625 r7 (owner decision 2026-09-19, "Handled + stop retry").
--
-- Marking a refused posting handled asserts it was posted BY HAND, so IMS must never post that exact
-- posting itself afterwards — not from a retry, a sweep, an outbox drain or a follow-up. This column is
-- the suppression: set once by the mark, never cleared, read by the single function every accounting
-- sync row is created through. Nullable with no default, as schema.prisma declares it: every existing
-- row is not suppressed, which is true of all of them.
ALTER TABLE "accounting_posting_refusals" ADD COLUMN "suppressedAt" TIMESTAMP(3);
