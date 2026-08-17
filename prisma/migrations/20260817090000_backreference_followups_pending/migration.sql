-- o3d-9kek Codex r9 finding 1: a TRANSIENT follow-up failure on a SYNCED repair was a PERMANENT
-- verdict.
--
-- The documented crash-after-post recovery path is a row marked SYNCED with an externalTransactionId
-- whose back-reference was never written — the process died between the two — so its follow-ups
-- (invoice PDF, payment registration, bill attachment) never ran either. The sweep repairs the link
-- and re-enqueues those follow-ups.
--
-- Whether the follow-ups were still OWED was inferred from `status = FAILED`, which is true only for
-- the Xero shape (the refusal propagates and the retries exhaust to FAILED). For the SYNCED row
-- above, an enqueue that failed transiently left nothing behind at all: the row stayed unstamped, so
-- the next sweep looked at it again, found the back-reference present and the status SYNCED, called
-- it reconciled and stamped backReferenceCheckedAt. The row left the candidate set for good and the
-- payment, PDF or attachment was lost silently. That is the deferred-not-retired property this whole
-- feature exists to hold, broken in a new place — the sweep's own comment even said "the row stays
-- FAILED so the next sweep retries them", which is exactly the half of the population that was not
-- covered.
--
-- backReferenceFollowUpsPendingAt is the durable record of that obligation. It is written BEFORE the
-- repair writes anything (an intent, not a report: a marker written only after a failure is lost if
-- the marker write is what fails) and cleared only when the enqueue has actually succeeded.
--
-- WHY NOT JUST FLIP THE ROW TO FAILED. queueXeroSync / queueQuickBooksSync dedupe new enqueues on
-- `status in (PENDING, PROCESSING, SYNCED)`. A row moved out of SYNCED stops suppressing its own
-- re-enqueue and the document posts to the ledger a SECOND time. A follow-up that has to be re-driven
-- by hand is bad; two posted documents are worse.
--
-- NO NEW INDEX, and no change to the candidate query: a row with follow-ups outstanding is unstamped
-- (backReferenceCheckedAt IS NULL) and is therefore already selected by
-- accounting_sync_logs_backref_sweep_idx. This column only widens the "back-reference already
-- applied, follow-ups still outstanding" pass, which used to be FAILED-only.
--
-- ONE EXPLICIT TRANSACTION, for the reason 20260721150000_refund_park_unique_index documents: Prisma
-- does NOT auto-wrap a migration file, so anything added here later inherits the guarantee instead of
-- quietly not having it.
--
-- Nullable, no default, no backfill: every existing row starts NULL, i.e. "no follow-ups known to be
-- outstanding", which is exactly what can be said about rows written before this column existed —
-- the FAILED-status inference below still covers those. Adding a nullable column without a default is
-- metadata-only on Postgres; no table rewrite.
BEGIN;

ALTER TABLE "accounting_sync_logs" ADD COLUMN "backReferenceFollowUpsPendingAt" TIMESTAMP(3);

COMMIT;
