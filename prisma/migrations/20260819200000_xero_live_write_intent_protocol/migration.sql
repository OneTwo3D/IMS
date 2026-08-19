-- o3d-t74p Codex r11 finding 1: a NEW write with no exclusion verdict was indistinguishable from a
-- LEGACY row, so the one lenient predicate in the fence was reachable by the case it was scoped to
-- exclude.
--
-- 20260819160000_xero_live_write_intent_exclusion added `heldThrough` and decided — deliberately,
-- and it is still the right decision — that a NULL there must not be read as "not confirmed":
-- reading it that way would put every write recorded before the column existed back on the recovery
-- fence in one instant, during an incident in which a trustworthy fence is the only thing that lets
-- an operator move at all. That leniency was justified on the grounds that only a pre-migration row
-- could carry a NULL.
--
-- IT IS NOT ONLY A PRE-MIGRATION ROW. Every one of these leaves the same NULL, today:
--
--   * an OLDER BUILD of scripts/remove-xero-live-e2e-footprint.ts, still deployed on another host,
--     settling with the three-column UPDATE it knows about. The lock excludes a concurrent APPLY;
--     it does not stop an older build from being the thing that settles a row afterwards;
--   * an operator's recovery UPDATE that sets "state" and forgets "heldThrough" — which is exactly
--     the shape the printed recovery for a lost outcome has, and a partially applied recovery is a
--     normal event in an incident;
--   * a settlement that reached the row through any route this tooling does not own: a restored
--     dump, a COPY, a repair script.
--
-- In all three the write went out and NOBODY ASKED whether the ledger was held across it — and the
-- fence read the silence as ancient history and let the row go. That is fail-open, in the one place
-- in the file where absence reads as fine.
--
-- THE FIX IS NOT TO READ NULL AS A NO. It is to stop asking the ABSENCE of a value to carry a
-- distinction it cannot carry. The row now says which ERA recorded it, positively:
--
--   * a row with a stamp was inserted by something that lives in the world where verdicts are
--     recorded, so a missing verdict beside it is a MISSING VERDICT and holds the fence;
--   * a row with no stamp can only have existed before this column did, and goes on reading exactly
--     as it did — which is the whole property the r10 leniency exists to preserve.
--
-- TWO SEPARATE ALTERs, AND THE ORDER IS THE POINT. `ADD COLUMN "exclusionProtocol" TEXT` with no
-- default leaves every existing row NULL — that is what makes them recognisable as pre-migration
-- rows, and PostgreSQL 11+ would have BACKFILLED them had the default been attached in the same
-- statement, marking every historical row as belonging to this era and putting the entire table on
-- the fence. The default is therefore attached in a SECOND statement, where it applies only to rows
-- inserted from now on.
--
-- AND THAT DEFAULT IS WHAT CATCHES THE OLD BUILD. scripts/lib/xero-live-safety.ts writes the stamp
-- as a literal in its own INSERT, which covers every row this version records. An INSERT from an
-- older build names nine columns and not the tenth, so PostgreSQL fills it — with 'unstamped',
-- which is non-NULL and therefore era-bearing. An old build's dispatched write is thus held to the
-- new rule rather than passing as pre-migration, without that build knowing anything about it.
--
-- NO CHECK CONSTRAINT, deliberately, and it is the opposite decision from the one
-- 20260819090000_xero_live_write_intents made about `state`. There the vocabulary is CLOSED because
-- a value nobody can interpret is a claim nobody can interpret. Here the only question ever asked
-- of the column is whether it is NULL: any non-NULL value — this version's, a later version's, a
-- human's note — means the same thing, so there is nothing for a constraint to protect and a
-- constraint would only refuse a future version's stamp.
--
-- THE COLUMN IS NULLABLE, which is what makes this safe to apply to a table that already has rows:
-- nothing is back-filled and no existing row changes meaning.
--
-- ONE EXPLICIT TRANSACTION, for the reason 20260721150000_refund_park_unique_index documents:
-- Prisma does NOT auto-wrap a migration file.
BEGIN;

ALTER TABLE "xero_live_write_intents"
    ADD COLUMN "exclusionProtocol" TEXT;

ALTER TABLE "xero_live_write_intents"
    ALTER COLUMN "exclusionProtocol" SET DEFAULT 'unstamped';

COMMIT;
