-- o3d-cvj9 r4 (Codex r3 finding 3): a backfilled revision that HOLDS a document id carries no
-- external revision stamp, and there is no honest one to give it — a historical sync log never
-- recorded the connector response. Under r3 that made the row permanently unorderable: it is not
-- the document's CREATE, so the create rule could not order it, and it has no stamp, so the stamp
-- rule could not either. Every later live revision of that document was refused for ever, the sync
-- log retried to FAILED, and the ledger stayed frozen naming a historical edit as the document's
-- current state. Fail-closed, but permanent — and permanence is its own defect.
--
-- This column records the one thing that IS provable about such a row, as a category rather than a
-- timestamp:
--
--   'historical_backfill_repair' — the write this row mirrors had already been recorded complete on
--                                  its sync log when the backfill selected it.
--
-- o3d-cvj9 r5/r6: THAT IS THE WHOLE FACT, and it does NOT order this row against a later arrival.
-- Round 4 wrote a second half here — "and the backfill only selects sync logs for a document with NO
-- mirrored event of that revision type at all", from which it argued a causal ordering. Both halves
-- are withdrawn. The first was untrue of the candidate scan (r5). The second does not follow even
-- where it is (r6): a sync log is recorded when its transaction COMMITS, which can be long after the
-- connector call it reports, so what is happening when an arrival reaches the mirror is the
-- RECORDING of a write, not the write. The rule built on this marker therefore ASSUMES the order it
-- returns and is labelled as assuming it (`historical_repair_precedes_live_write`,
-- `established: false`); the administrative backfill declines to act on it and the live mirror acts
-- on it, records it under its own audit action, and the reconciliation report lists it for review.
-- No local clock is read here and none is compared with Xero's, which is the mistake r2 made and r3
-- removed — but that is a statement about what this column is NOT, not a licence to call it causal.
--
-- Deliberately a nullable text category with no default and no backfill:
--   * NULL is the correct value for every existing row and for every row the live mirror writes —
--     a live write records `externalRevisionAt` instead, and that is compared first.
--   * It is never parsed as a time, so it cannot be dragged back into a comparison key.
-- Adding a nullable column with no default is metadata-only on Postgres (no table rewrite).
ALTER TABLE "accounting_events"
  ADD COLUMN "revisionOrderBasis" TEXT;

-- ---------------------------------------------------------------------------------------------
-- o3d-cvj9 r7 (Codex r7, HIGH): make an identifier that moved on an ASSUMED order LISTABLE.
--
-- Extending this migration rather than adding another, because it is not applied anywhere yet and
-- the two changes belong to one statement: this column is what lets the mirror reach an assumed
-- verdict, and this index is what lets an operator find the documents it reached one about. The
-- accounting reconciliation report selects `accounting_event_logs` by ACTION over its lookback
-- window; the table's only other index is keyed by event id, which that query cannot use, so
-- without this it is a sequential scan of the largest audit table in the schema on every run.
-- ---------------------------------------------------------------------------------------------
CREATE INDEX "accounting_event_logs_action_createdAt_idx"
  ON "accounting_event_logs" ("action", "createdAt");
