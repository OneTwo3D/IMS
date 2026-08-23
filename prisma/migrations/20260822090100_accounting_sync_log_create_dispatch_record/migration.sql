-- o3d-jit6 — A CREATE THAT LEFT, RECORDED BEFORE IT LEFT.
--
-- THE DEFECT. `persistPostedXeroDocument` settles the row with the id Xero has just returned. That
-- transaction can fail AT COMMIT — a deadlock victim, a serialization failure, a connection dropped
-- while committing. The write rolls back, the row returns to PENDING with `externalTransactionId`
-- null, and `syncResult.externalId` — a REAL, FRESHLY CREATED document in a live ledger — is
-- discarded with it, because it existed only in the memory of a process that is now handling an
-- ordinary error. The ordinary retry then posts again. For a manual journal, whose create has no
-- natural key of any kind, that is a second journal in the accounts.
--
-- WHY THE EXISTING MACHINERY DOES NOT COVER IT. o3d-550x's conflict evidence applies where the row
-- will NEVER name this document, because another worker's id already occupies it; it detects a
-- DISPLACEMENT and preserves the displaced identifier. Here nothing is displaced — the row will
-- eventually name a document, just not this one — so there is no conflict to observe, and re-driving
-- the record does not help either, because the write is what failed. Every existing pre-post record
-- is scoped to somebody else's problem: `remoteAttemptedAt` to the three money types,
-- `attemptedInvoiceNumber` to SALES_INVOICE, `isFirstPurchaseCreditNoteAttempt` to
-- PURCHASE_CREDIT_NOTE. The eighteen ManualJournal types have nothing.
--
-- THE ONLY EVIDENCE THAT SURVIVES A ROLLBACK IS EVIDENCE THAT COMMITTED FIRST. A record written in
-- the transaction that later rolls back is not evidence of anything, so this pair is written and
-- COMMITTED in its own statement, BEFORE the request leaves — the same rule and the same reason as
-- `attemptedInvoiceNumber` (o3d-k26m.5): a create whose local record cannot be written is a create
-- whose OUTCOME cannot be recorded either, so a failure to write it REFUSES the post.
--
--   create_dispatched_at             when a create for this row was first put on the wire, from the
--                                    DATABASE's clock (`clock_timestamp()`), never an application
--                                    host's. The window below is an age, and an age measured across
--                                    two clocks is not one (o3d-clxw).
--   create_dispatch_idempotency_key  the exact `Idempotency-Key` that went out with it. Xero keeps a
--                                    key for SIX MINUTES; inside that window a re-post carrying the
--                                    SAME key returns the original document instead of creating a
--                                    second, so a replay is provably safe. Storing the key rather
--                                    than a bare flag is what makes it PROVABLE: the retry compares
--                                    the key it is about to send against the one that was actually
--                                    sent, and a row whose payload has changed under it cannot be
--                                    described with an attempt taken for a different request.
--
-- WHAT THIS DOES NOT SOLVE, STATED PLAINLY. Past six minutes there is no remedy in the database and
-- none on the wire: `POST /ManualJournals` has no natural key, `Reference` and `Narration` are free
-- text Xero does not deduplicate on, and no lookup this repository can perform will say whether the
-- earlier create landed. So the guard does not guess. It REFUSES, nothing is sent, and the refusal
-- names the instant of the earlier dispatch and an action an operator can take (look in Xero for that
-- journal; then either record its id through the per-row settlement action, or cancel the row). A
-- refusal with a remedy is worth more than a coin-flip that duplicates the accounts half the time.
--
-- NULLABLE, NO DEFAULT, NOT BACKFILLED, and here the reason is sharper than usual: a backfill would
-- have to invent a dispatch instant for rows whose dispatch nobody observed, and every one of them
-- would then be OUTSIDE the window and refuse for ever. Existing rows answer "no dispatch on record",
-- which is what the code knew about them yesterday and behaves exactly as it did yesterday.
--
-- ADDITIVE AND NON-BLOCKING: two nullable columns, no defaults, catalogue-only on Postgres 11+. No
-- index — both are read only on a row already located by its primary key.
ALTER TABLE "accounting_sync_logs" ADD COLUMN "create_dispatched_at" TIMESTAMP(3);

ALTER TABLE "accounting_sync_logs" ADD COLUMN "create_dispatch_idempotency_key" TEXT;

-- ---------------------------------------------------------------------------------------------
-- THE RECORD IS WRITE-ONCE, AND THE DATABASE IS WHAT MAKES IT SO.
-- ---------------------------------------------------------------------------------------------
--
-- `remoteAttemptedAt` documents itself as "set once and NEVER cleared", and that promise is kept by
-- every writer remembering to keep it. This branch exists because a promise like that is broken by
-- the writer who has not heard of it — the previous release still deployed during a rollout, a repair
-- script resetting a stuck row, an operator in `psql` "clearing the flags" so a job will run again.
-- Every one of those turns "a create for this row is already in Xero" into "this row has never
-- posted", which is the exact belief that produces the duplicate.
--
-- No reader can defend against that: a cleared column is byte-identical to one that was never set. So
-- the rule runs at write time, the way 20260819210000 and 20260821090000 put their rules there.
--
-- THE RULE. Once `create_dispatched_at` is set, an UPDATE may not clear it, move it, or change the
-- key beside it: both columns are restored to the values the dispatch minted, TOGETHER, so the key
-- can never end up describing a different dispatch than the instant it sits next to.
--
-- IT ONLY EVER NARROWS — and note that "narrow" points the OTHER WAY here from the completion-stamp
-- trigger this is modelled on, because the two markers do opposite jobs. A completion stamp is a
-- permission, so the safe move is to CLEAR it. This record is a PROHIBITION: while it stands, a
-- create past the idempotency window is refused. The safe move is therefore to PRESERVE it, and the
-- worst this trigger can do is withhold a post that a cleared record would have let through — which
-- is the outcome being asked for. Reversing the two would be the mistake, and it is worth naming: a
-- trigger that "clears on tampering" here would hand the tamperer exactly what they wanted.
--
-- ON INSERT the record is refused. Nothing creates an already-dispatched row — the enqueue happens
-- long before any wire — so a record arriving with an INSERT came from a copy, a seed or a restore,
-- none of which is this database watching a request leave. Refusing it means such a row is treated as
-- never dispatched, which is the same thing every pre-migration row is treated as.
--
-- The residual is a row whose dispatch record is genuinely stale because the work was legitimately
-- re-queued: that is a NEW row with a new id, minted by `queueXeroSync`, and it carries no record.
-- The prohibition is scoped to the row that made the call, deliberately, exactly as
-- `attemptedInvoiceNumber` is.
--
-- prisma-schema-scope-ok: db-native trigger | reason: Prisma cannot represent triggers, and the rule has to bind writers outside this repository
CREATE OR REPLACE FUNCTION accounting_sync_log_hold_create_dispatch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."create_dispatched_at" := NULL;
    NEW."create_dispatch_idempotency_key" := NULL;
    RETURN NEW;
  END IF;
  NEW."create_dispatched_at" := OLD."create_dispatched_at";
  NEW."create_dispatch_idempotency_key" := OLD."create_dispatch_idempotency_key";
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounting_sync_log_create_dispatch_insert ON "accounting_sync_logs";

CREATE TRIGGER accounting_sync_log_create_dispatch_insert
BEFORE INSERT ON "accounting_sync_logs"
FOR EACH ROW
WHEN (NEW."create_dispatched_at" IS NOT NULL OR NEW."create_dispatch_idempotency_key" IS NOT NULL)
EXECUTE FUNCTION accounting_sync_log_hold_create_dispatch();

DROP TRIGGER IF EXISTS accounting_sync_log_create_dispatch_update ON "accounting_sync_logs";

-- The WHEN clause is what lets the DISPATCH ITSELF through: it writes the pair onto a row where
-- `OLD."create_dispatched_at"` is NULL, so the trigger does not fire and the record is minted. Every
-- later statement meets a non-null OLD and can only leave the pair alone. An ordinary write that
-- names neither column also never fires — this is a hot table and it pays two IS DISTINCT FROM tests.
CREATE TRIGGER accounting_sync_log_create_dispatch_update
BEFORE UPDATE ON "accounting_sync_logs"
FOR EACH ROW
WHEN (
  OLD."create_dispatched_at" IS NOT NULL
  AND (
    NEW."create_dispatched_at" IS DISTINCT FROM OLD."create_dispatched_at"
    OR NEW."create_dispatch_idempotency_key" IS DISTINCT FROM OLD."create_dispatch_idempotency_key"
  )
)
EXECUTE FUNCTION accounting_sync_log_hold_create_dispatch();
