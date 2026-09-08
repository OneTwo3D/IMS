-- o3d-11rf r3 — REPAIR THE VOIDS THE PREDECESSOR COLUMN COULD NOT DESCRIBE.
--
-- WHAT THE PREVIOUS MIGRATION LEFT BEHIND (Codex r2, HIGH). Adding `voidBasis` NULL-with-no-default
-- made every row that already existed non-revivable, which is safe against WRONGFUL revival and is
-- why it was right. Its cost is that every row ALREADY broken by o3d-11rf stays broken for good: an
-- operator who settled a sync row NOT_POSTED under the predecessor binary, then re-queued the
-- document, has a live PENDING sync row against a VOID mirror, and nothing will ever take that
-- mirror back. The forward fix abandoned its own existing victims. This repairs the ones that can be
-- PROVED, and the rest are surfaced to an operator by the accounting reconciliation report's
-- `void_mirror_basis_unknown_with_live_sync_row` finding rather than left silent.
--
-- ================================================================================================
-- WHY A HISTORICAL NOT_POSTED SETTLEMENT IS PROVABLE, AND FROM WHAT.
-- ================================================================================================
--
-- EXACTLY TWO WRITERS CAN LEAVE AN accounting_events ROW `VOID`, and this was established by
-- enumeration over the whole source tree, not by recollection:
--
--   1. `voidMirroredAccountingEventsForOrder` (lib/domain/accounting/accounting-event-mirror.ts).
--      The order was CANCELLED, so the DOCUMENT is retired. Never revivable.
--   2. `updateMirroredAccountingEventStatus` with `status: 'VOID'`. Its only VOID-passing caller is
--      the settlement action (app/actions/accounting-settlement.ts), because the status comes from
--      `settlementMirrorStatus`, whose only caller that is; both connectors' own mirror helpers are
--      typed `status: 'POSTED' | 'FAILED'` and can never reach VOID. This retires ONE ATTEMPT.
--
-- lib/domain/accounting/posted-order-discount.ts says the same thing independently: "VOID has two
-- writers and BOTH are positive statements".
--
-- THE CANCELLATION WRITER ALWAYS LEAVES A NAMED WITNESS, IN THE SAME TRANSACTION. It voids under a
-- compare-and-swap, re-reads exactly the rows that ended VOID, and `createMany`s one
-- `voided_source_cancelled` log entry per row — all three statements inside one transaction, so the
-- entry cannot be missing from a row that writer voided. The action string was introduced by the
-- same commit as the function (24a7c596, o3d-5rs) and has never been renamed, so this holds for the
-- whole history of the table, not only for recent rows.
--
-- THEREFORE: `status = 'VOID'` AND no `voided_source_cancelled` entry PROVES writer 2 did it, i.e.
-- an operator NOT_POSTED settlement. And it proves it BY SET MEMBERSHIP, not by ordering — which is
-- the trap this branch has already been caught in once. `accounting_event_logs.createdAt` defaults
-- to `CURRENT_TIMESTAMP`, which PostgreSQL evaluates at TRANSACTION START, so two entries written in
-- one transaction are indistinguishable and one written in a long transaction can predate an earlier
-- one (the o3d-cvj9 trap, and the reason round 2 refused to derive the basis from these rows at
-- all). NOTHING BELOW READS `createdAt`, ORDERS BY IT, OR TAKES A "LATEST" ENTRY. It asks only
-- whether an entry of a given action EXISTS, which no clock can distort.
--
-- ================================================================================================
-- AND IT STILL DEMANDS POSITIVE EVIDENCE, because "provable by elimination" is only as good as the
-- enumeration it rests on.
-- ================================================================================================
--
-- The absence argument above is complete AS AN ARGUMENT ABOUT THE CODE. It says nothing about a row
-- an administrator VOIDed by hand in psql, a row that arrived in a restore, or a writer on a branch
-- that never landed — and a production table two years old is exactly where those live. So the
-- repair also requires the settlement to have left its own trace, on two rows that were written by
-- different statements:
--
--   • the mirror write's own audit entry, `failed_from_sync_log`, whose metadata names the SYNC ROW
--     the write was made for. That entry is written by the same function call that set VOID.
--   • that sync row itself, carrying the shape a NOT_POSTED settlement leaves and nothing else does:
--       status = 'CANCELLED'                  (buildSettlementData's NOT_POSTED branch)
--       settlement_basis = 'OPERATOR_ASSERTION' (o3d-nf9i's machine-readable basis)
--       externalTransactionId IS NULL         (the NOT_POSTED branch never writes one, and
--                                              refuseSettlement established the row carried none)
--     The last clause is what excludes `buildCancelledSaleSettlementData`, which also writes
--     CANCELLED + OPERATOR_ASSERTION but DOES carry a document id — a POSTED assertion on a
--     cancelled sale, which is not this and must not be revived.
--
-- Requiring BOTH is deliberately stricter than either. A cancellation-void is refused by the first
-- clause (its witness exists) AND by the second (no NOT_POSTED-settled sync row names it), so
-- misclassifying one as an attempt-void requires both independent lines of evidence to be wrong
-- about the same row at the same time.
--
-- ================================================================================================
-- WHAT IS DELIBERATELY LEFT NULL, and it is not a small set.
-- ================================================================================================
--
--   • Every void that carries a `voided_source_cancelled` witness. The intended case.
--   • Every void where BOTH witnesses are present — a cancellation entry and a settled sync row.
--     These are genuinely AMBIGUOUS: only `createdAt` could order them and `createdAt` cannot be
--     trusted to. Guessing here is precisely the failure this migration must not commit, so they
--     stay NULL and are REPORTED instead.
--   • Every row settled before `accounting_sync_logs.settlement_basis` existed (o3d-nf9i, f45ff3eb).
--     Those rows carry NULL there, so the positive clause refuses them. They are real victims and
--     they are not repaired here, because the evidence that would repair them is not on the row.
--     They are reported.
--   • Every void with no surviving sync row at all, and every void an administrator wrote by hand.
--
-- A NULL that a live sync row still contradicts is not silently abandoned: it is what the
-- reconciliation finding lists, with both ids, so a person can settle the one case with the
-- knowledge this migration does not have.
--
-- IDEMPOTENT AND NARROWING: it writes only where `voidBasis IS NULL`, so re-running it changes
-- nothing, and it can never overwrite a basis a real writer recorded.
UPDATE "accounting_events" AS e
SET "voidBasis" = 'attempt_settled_not_posted'
WHERE e."status" = 'VOID'
  AND e."voidBasis" IS NULL
  -- Clause 1: the cancellation writer left no witness on this row, and it always leaves one.
  AND NOT EXISTS (
    SELECT 1
    FROM "accounting_event_logs" AS cancelled
    WHERE cancelled."accountingEventId" = e."id"
      AND cancelled."action" = 'voided_source_cancelled'
  )
  -- Clause 2: a settlement mirror write names a sync row that carries an operator NOT_POSTED
  -- settlement on its own row.
  AND EXISTS (
    SELECT 1
    FROM "accounting_event_logs" AS settled
    JOIN "accounting_sync_logs" AS settled_row
      ON settled_row."id" = settled."metadata" ->> 'syncLogId'
    WHERE settled."accountingEventId" = e."id"
      AND settled."action" = 'failed_from_sync_log'
      AND settled_row."status" = 'CANCELLED'
      AND settled_row."settlement_basis" = 'OPERATOR_ASSERTION'
      AND settled_row."externalTransactionId" IS NULL
  );
