-- o3d-9kek: give the back-reference repair sweep a per-row reconciliation marker.
--
-- The sweep selected the OLDEST 200 eligible rows every run. A row it probed and found
-- already linked was skipped but stayed ELIGIBLE — nothing recorded that it had been
-- looked at — so once 200 ordinary historical rows existed, every cron cycle re-selected
-- and re-probed exactly those 200 and a newly-broken back-reference beyond the boundary
-- was never examined at all, until retention deleted its sync log. The sweep exists to
-- protect precisely that window.
--
-- backReferenceCheckedAt records when the sweep reached a VERDICT on a row: its document
-- is linked (nothing to do), or the row is a legacy PurchaseOrder-keyed one whose bill
-- cannot be attributed automatically (logged once for manual attribution). Those rows
-- leave the candidate set permanently. A transient outcome — probe threw, repair threw,
-- follow-up enqueue deferred — deliberately does NOT stamp, so the row stays eligible.
--
-- Nullable, no default, no backfill: every existing row starts NULL, i.e. "never
-- examined", which is exactly true. Adding a nullable column without a default is
-- metadata-only on Postgres — no table rewrite.
ALTER TABLE "accounting_sync_logs" ADD COLUMN "backReferenceCheckedAt" TIMESTAMP(3);

-- The sweep's candidate scan: one connector, never-checked rows, oldest first (it
-- keyset-paginates on ("createdAt", "id") across the whole population rather than
-- re-reading its head).
CREATE INDEX "accounting_sync_logs_backref_sweep_idx"
  ON "accounting_sync_logs" ("connector", "backReferenceCheckedAt", "createdAt");
