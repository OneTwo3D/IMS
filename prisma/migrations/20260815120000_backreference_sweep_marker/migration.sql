-- o3d-9kek: give the back-reference repair sweep a per-row reconciliation marker.
--
-- The sweep selected the OLDEST 200 eligible rows every run. A row it probed and found
-- already linked was skipped but stayed ELIGIBLE — nothing recorded that it had been
-- looked at — so once 200 ordinary historical rows existed, every cron cycle re-selected
-- and re-probed exactly those 200 and a newly-broken back-reference beyond the boundary
-- was never examined at all, until retention deleted its sync log. The sweep exists to
-- protect precisely that window.
--
-- backReferenceCheckedAt records when the sweep reached a VERDICT on a row: its document is
-- linked and its follow-ups are done, or the row is structurally incapable of carrying a
-- back-reference at all. Those rows leave the candidate set permanently.
--
-- A transient outcome — probe threw, repair threw, follow-up enqueue deferred — deliberately
-- does NOT stamp, so the row stays eligible. Neither does an AMBIGUOUS legacy
-- PurchaseOrder-keyed row: both inputs to that ambiguity are mutable (a competing sibling can
-- be cancelled or post; several unlinked bills shrink to one as their own bill-keyed syncs
-- finish; a human links a bill by hand, which is what the warning asks for), so stamping it
-- would permanently exclude a row that has since become repairable — the starvation this
-- column exists to fix, by a second route.
--
-- backReferenceAmbiguousLoggedAt is what makes leaving those rows eligible affordable. It
-- DEFERS a row for one recheck interval rather than retiring it: the candidate query takes
-- rows whose value is NULL or older than the cutoff, so an unattributable legacy row is
-- re-probed (and re-warned about, carrying the previous timestamp) once a day instead of on
-- every cron cycle. Without it a backlog of such rows would re-fill the head of the scan on
-- every run and starve everything newer — the same starvation this migration exists to fix,
-- one column over.
--
-- Nullable, no default, no backfill: every existing row starts NULL, i.e. "never
-- examined", which is exactly true. Adding a nullable column without a default is
-- metadata-only on Postgres — no table rewrite.
ALTER TABLE "accounting_sync_logs" ADD COLUMN "backReferenceCheckedAt" TIMESTAMP(3);
ALTER TABLE "accounting_sync_logs" ADD COLUMN "backReferenceAmbiguousLoggedAt" TIMESTAMP(3);

-- The sweep's candidate scan: one connector, never-checked rows, oldest first (it
-- keyset-paginates on ("createdAt", "id") across the whole population rather than
-- re-reading its head).
CREATE INDEX "accounting_sync_logs_backref_sweep_idx"
  ON "accounting_sync_logs" ("connector", "backReferenceCheckedAt", "createdAt");
