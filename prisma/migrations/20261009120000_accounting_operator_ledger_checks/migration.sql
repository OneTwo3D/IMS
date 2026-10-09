-- OPERATOR LEDGER CHECKS (owner decision C4; the remedy for the permanent hold an unmeasurable ledger
-- settlement puts on later receipts).
--
-- One row = one operator's assertion: "I opened these payment records (ledgerRecordIds) on this ledger
-- document in this Xero organisation, and none of them is the payment attempt syncLogId made, nor a
-- hand-entered payment for receipt paymentId." The rule that decides what such a row may lift is in
-- lib/domain/accounting/operator-ledger-check.ts; this migration only makes the record durable and
-- tamper-evident.
--
-- A NEW TABLE, NOT A COLUMN ON accounting_sync_logs. That table's triggers (20260819090000,
-- 20260821090000, 20260822090000, ...) make post-time writes delicate, and a check is not a fact about
-- the row anyway: it never changes the attempt's status, document id, settlementBasis or ledger
-- standing.
--
-- NO FOREIGN KEYS, deliberately. Retention and the admin reset delete sync rows and receipts; a cascade
-- into an insert-only table would make those deletes fail, and RESTRICT would block them. A check whose
-- attempt or receipt is gone can never match again (cuid ids are never reused), so it is inert.
--
-- NO BACKFILL: there is nothing to backfill. No check exists until a person records one, and an absent
-- check is the withholding answer.
--
-- WHY THIS MIGRATION NEEDS NO prisma/migrations/verification-required.txt ENTRY. Its safety argument is
-- not about WHICH BINARY was serving: a predecessor binary never reads or writes this table, so across
-- the deploy window every hold simply stays held (the pre-existing behaviour). Nothing a predecessor
-- can do makes a check exist.

CREATE TABLE "accounting_operator_ledger_checks" (
    "id" TEXT NOT NULL,
    "syncLogId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "ledgerDocumentId" TEXT NOT NULL,
    "ledgerRecordIds" TEXT[],
    "tenantId" TEXT NOT NULL,
    "connectionGeneration" TEXT NOT NULL,
    "basis" TEXT NOT NULL DEFAULT 'OPERATOR_ASSERTION',
    "checkedByUserId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "accounting_operator_ledger_checks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "accounting_operator_ledger_checks_syncLogId_paymentId_idx" ON "accounting_operator_ledger_checks"("syncLogId", "paymentId");

-- THE SHAPE A CHECK MUST HAVE, enforced where writers outside this repository (psql, a repair script)
-- cannot skip it. Each one is a property the rule relies on: a check that names no record, or names a
-- blank one, would be a check of nothing; a blank tenant or generation would match a probe that could
-- not say which connection served it; and a basis other than OPERATOR_ASSERTION would let the row be
-- read as something other than a person's word.
--
-- prisma-schema-scope-ok: db-native check constraints and an insert-only trigger | reason: Prisma cannot represent CHECK constraints or triggers
ALTER TABLE "accounting_operator_ledger_checks"
  ADD CONSTRAINT "accounting_operator_ledger_checks_records_named"
  CHECK (
    "ledgerRecordIds" IS NOT NULL
    AND cardinality("ledgerRecordIds") > 0
    AND array_position("ledgerRecordIds", NULL) IS NULL
    AND NOT ('' = ANY ("ledgerRecordIds"))
  ),
  ADD CONSTRAINT "accounting_operator_ledger_checks_identity_named"
  CHECK (
    btrim("syncLogId") <> '' AND btrim("paymentId") <> '' AND btrim("connector") <> ''
    AND btrim("ledgerDocumentId") <> '' AND btrim("tenantId") <> ''
    AND btrim("connectionGeneration") <> '' AND btrim("checkedByUserId") <> ''
  ),
  ADD CONSTRAINT "accounting_operator_ledger_checks_basis_is_assertion"
  CHECK ("basis" = 'OPERATOR_ASSERTION');

-- INSERT-ONLY. Every UPDATE, DELETE and TRUNCATE is refused, whoever issues it. A check is evidence of
-- what a named person asserted at a named time; letting it be edited would let a later hand widen what
-- an earlier one said (add a record id, move it to another generation), which is exactly the
-- stretching the rule exists to prevent. A wrong check is answered by NOT relying on it — any reconnect
-- voids it — never by editing it.
CREATE OR REPLACE FUNCTION accounting_operator_ledger_checks_insert_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'accounting_operator_ledger_checks is insert-only: % refused', TG_OP
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS accounting_operator_ledger_checks_insert_only ON "accounting_operator_ledger_checks";

CREATE TRIGGER accounting_operator_ledger_checks_insert_only
BEFORE UPDATE OR DELETE ON "accounting_operator_ledger_checks"
FOR EACH ROW
EXECUTE FUNCTION accounting_operator_ledger_checks_insert_only();

-- TRUNCATE fires no ROW trigger, so a role allowed to TRUNCATE would otherwise erase every check in one
-- statement. A STATEMENT-level BEFORE TRUNCATE trigger closes that, with the same function (it raises
-- before returning, so the missing NEW/OLD of a statement trigger is never reached).
--
-- No REVOKE: this repository has no other insert-only table and no migration that manages privileges
-- (none REVOKEs or GRANTs; the application role is created by scripts/install.sh, not by a migration), so
-- there is no convention to mirror and no role name a migration could name portably. The trigger binds
-- every role that can write the table.
--
-- THE LIMIT, STATED. Nothing in-database binds the table's OWNER or a SUPERUSER absolutely: either can
-- `ALTER TABLE ... DISABLE TRIGGER`, and a superuser can `SET session_replication_role = replica`, under
-- which ordinary triggers do not fire, or DROP the table. Those are deliberate administrative acts outside
-- what the application can do; the trigger protects the record against the application, repair scripts
-- and ordinary writers, which is the threat the rule needs (a check that can be widened or erased by
-- accident is the stretching the rule exists to prevent).
DROP TRIGGER IF EXISTS accounting_operator_ledger_checks_no_truncate ON "accounting_operator_ledger_checks";

CREATE TRIGGER accounting_operator_ledger_checks_no_truncate
BEFORE TRUNCATE ON "accounting_operator_ledger_checks"
FOR EACH STATEMENT
EXECUTE FUNCTION accounting_operator_ledger_checks_insert_only();
