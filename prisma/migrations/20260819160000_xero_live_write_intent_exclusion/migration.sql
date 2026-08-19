-- o3d-t74p Codex r10 finding 1: a write's account was HALF an account.
--
-- 20260819090000_xero_live_write_intents recorded, for every write this tooling dispatches against
-- the live Xero ledger, an intent before it goes and a settlement after it comes back. That answers
-- one question — what became of the object — and the fence was built on the assumption that it
-- answered a second one along with it: that the write went out while this run held the ledger's
-- advisory lock, so no other run could have been writing to the same organisation at the same time.
--
-- IT DOES NOT ANSWER THAT, AND CANNOT. The lock is re-established immediately before the intent is
-- INSERTed, and the request is dispatched after. Those are two moments, and nothing can make a call
-- to PostgreSQL atomic with respect to a call to Xero: a session reaped, a coordinator restarted or
-- a connection pooler that starts routing statements elsewhere in between leaves a request going
-- out over a ledger nothing was excluding. Moving the check closer to the call shrinks the window
-- and never closes it.
--
-- So the residual is made DETECTABLE AND RECOVERABLE instead, which is the same answer round 5
-- reached about the verdict/post pair one layer up:
--
--   * THE ASSERT THAT COVERS AN ACT COMES AFTER IT. Every dispatch is now bracketed — the fence is
--     established before the request leaves AND asked again once it has settled.
--   * A PASS IS RETROACTIVE. A PostgreSQL SESSION advisory lock cannot be released and silently
--     re-acquired: the only ways to stop holding one are the session ending (which destroys the
--     session GUC and the pg_temp relation this run planted, so the check cannot answer yes), an
--     explicit pg_advisory_unlock from that same session (which the script issues only at release),
--     or a statement landing on a backend that never held it (which answers with a different pid, a
--     NULL nonce and tempPresent = false). "Held, by this backend, carrying this run's marks" on
--     BOTH sides therefore means held throughout, not merely held again.
--   * A FAILURE IS RECORDED, BECAUSE IT CANNOT BE UNDONE. The request has already gone. These two
--     columns are where that is written down.
--
-- WHY A COLUMN AND NOT A STATE. The outcome and the exclusion are orthogonal facts about one write:
-- a write can be perfectly well accounted for as 'committed' and still have been dispatched into a
-- window in which a second --apply could have been running. Folding it into `state` would have meant
-- either destroying the established outcome to make the row stick — the outcome is the scarcest
-- thing the run produces and is never withheld — or inventing a state that means two things at once.
--
-- WHY NULL IS NOT READ AS "NOT CONFIRMED", which is the one place this file departs from its own
-- fail-closed reflex, deliberately. The fence's STATE predicate is stated as the complement of the
-- resolved vocabulary because there an unrecognised value is a claim somebody made that nobody can
-- interpret. A NULL here is not a claim: it is a row written before this column existed, or settled
-- by a version of the script that never asked. Reading it as a no would put every historical write
-- back on the fence in the same instant, during an incident in which a trustworthy fence is the only
-- thing that lets an operator move at all. Only `heldThrough = false` — a positive record, written
-- by a run that asked and was told no — holds a row. From this migration forward every settlement
-- writes true or false in the SAME statement as the state, so a NULL beside a settled row can only
-- be a pre-migration row.
--
-- NOTHING CLEARS THESE ROWS ON A TIMER, exactly as before. Clearing one is a human establishing that
-- no other run was writing in that window — from this table's own rows for the same tenant, from the
-- other hosts' logs, and from the object's history in Xero — and recording who established it.
--
-- BOTH COLUMNS ARE NULLABLE, which is what makes this safe to apply to a table that already has
-- rows: no default is back-filled and no existing row changes meaning. There is nothing to back-fill
-- and nothing that could be: before this migration no run asked the question, so no answer exists to
-- reconstruct. From here forward the window is recorded; before it, it is not.
--
-- ONE EXPLICIT TRANSACTION, for the reason 20260721150000_refund_park_unique_index documents:
-- Prisma does NOT auto-wrap a migration file.
BEGIN;

ALTER TABLE "xero_live_write_intents"
    ADD COLUMN "heldThrough" BOOLEAN,
    ADD COLUMN "heldThroughReason" TEXT;

COMMIT;
