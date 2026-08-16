-- o3d-9kek r3: an external bill id is TENANT-OWNED, so uniqueness must be enforced over the
-- connection that issued it — not globally — and unresolved back-reference evidence must have a
-- bounded lifecycle instead of an open-ended exemption from retention.
--
-- ---------------------------------------------------------------------------------------------
-- 1. THE NAMESPACE (r3 finding 1)
--
-- 20260815140000 made purchase_invoices.accounting_invoice_id globally unique. The justification
-- was that a Xero GUID cannot collide with a QuickBooks integer. That is true and irrelevant: the
-- collision that actually occurs is QuickBooks realm A against QuickBooks realm B, numeric on both
-- sides. Disconnecting clears the realm pin and the cached contact/item ids but DELIBERATELY keeps
-- historical bill ids — they are the only local record of which ledger document a bill became — so
-- after a reconnect to a different company, a new bill can post successfully to QuickBooks and then
-- fail its LOCAL back-reference write because a retired realm's bill already holds that integer.
-- The remote document exists, the local link does not, and the sweep's constraint handling reads
-- the P2002 as an attribution conflict and refuses forever.
--
-- The fix is to store the issuing connection beside the id and make the PAIR unique. Provenance is
-- "<connector>:<tenantId>", the same string and the same AccountingToken row as
-- products.accountingItemProvenance (o3d-6nd); QuickBooks keeps its realmId in the tenantId column.
--
-- NOT NULL with an empty-string sentinel rather than a nullable column, and that choice is load
-- bearing: Postgres does not treat NULLs as equal, so a nullable provenance would let any writer
-- that forgot to set it opt out of the unique constraint entirely — the invariant would evaporate
-- precisely where a bug put it, silently. With '' the worst such a writer gets is the OLD global
-- uniqueness (every sentinel row shares one namespace), which fails closed.
--
-- accounting_invoice_id stays nullable and NULLs still do not collide, so any number of bills may
-- be unlinked; no two may claim the same external id within one connection's namespace.
--
-- No backfill of existing links. IMS is not in productive use; a stored id whose issuer is unknown
-- keeps the '' sentinel, which is exactly what it means. The application treats a bill whose
-- provenance does not match the ACTIVE connection as unlinked-in-this-namespace: it is neither a
-- conflict for, nor a candidate of, the current connection.
-- ORDERING AND ATOMICITY (r4 finding 4). The first revision of this file dropped the old global
-- unique index and THEN created the compound one, with no BEGIN/COMMIT — and Prisma 7.8's runner
-- does not auto-wrap a migration (see 20260721150000_refund_park_unique_index, which documents the
-- same thing). An interrupted deploy, or a CREATE INDEX that fails on a pre-existing duplicate,
-- therefore left the database with NEITHER invariant while the application kept writing bill ids:
-- the window in which two local bills can claim one ledger document is exactly the corruption both
-- indexes exist to forbid.
--
-- Two changes fix it, and both are needed:
--
--   • ONE EXPLICIT TRANSACTION. ADD COLUMN, CREATE INDEX and DROP INDEX are all transactional in
--     Postgres (unlike CREATE INDEX CONCURRENTLY, which is why this is deliberately not
--     concurrent), so either every statement below lands or none of them does. A failed CREATE
--     rolls back to the OLD index, which is a correct — if stricter — invariant, never to none.
--   • CREATE BEFORE DROP. The old index is global on accounting_invoice_id, so for the population
--     this migration produces (every existing row backfilled to the same '' sentinel provenance)
--     it strictly IMPLIES pair uniqueness. Nothing requires dropping it first: the compound index
--     can always be built underneath it. Doing so means the moment of "no uniqueness at all" never
--     exists even inside the transaction.
--
-- LOCKING. The ALTER TABLE below already takes ACCESS EXCLUSIVE on purchase_invoices and holds it
-- to COMMIT, so concurrent writers are excluded for the whole block without a separate LOCK TABLE.
-- It is stated explicitly rather than relied on implicitly, because if a future edit removes the
-- ALTER, the CREATE INDEX's weaker SHARE lock would still block writes but the ADD COLUMN's
-- guarantee would have quietly gone with it.
BEGIN;

ALTER TABLE "purchase_invoices"
  ADD COLUMN "accounting_invoice_provenance" TEXT NOT NULL DEFAULT '';

-- Named explicitly: Prisma's generated name for this pair is 73 characters, past Postgres's
-- 63-character identifier limit.
--
-- A duplicate present at migration time is the corruption this index exists to forbid, and the
-- statement will fail loudly — which is correct: which of two local bills owns a ledger document
-- cannot be inferred from IMS data. Because this runs INSIDE the transaction and BEFORE the drop,
-- that failure now rolls the whole migration back to the old index rather than to nothing. To find
-- the duplicates first:
--   SELECT accounting_invoice_id, accounting_invoice_provenance, count(*), array_agg(id)
--     FROM purchase_invoices WHERE accounting_invoice_id IS NOT NULL
--    GROUP BY 1, 2 HAVING count(*) > 1;
CREATE UNIQUE INDEX "purchase_invoices_accounting_invoice_id_provenance_key"
  ON "purchase_invoices"("accounting_invoice_id", "accounting_invoice_provenance");

-- Only now, with the replacement already durable in this transaction, is the old guard removed.
DROP INDEX "purchase_invoices_accounting_invoice_id_key";

-- ---------------------------------------------------------------------------------------------
-- 2. THE SYNC ROW'S OWN NAMESPACE (r3 finding 1, the other half)
--
-- The bill index alone does not stop the repair sweep from attributing realm A's external id to a
-- realm B bill — under B that write is perfectly unique, and perfectly wrong. So the sync row
-- records the connection that ISSUED its externalTransactionId, and the sweep's candidate query
-- matches it against the active connection. Foreign-realm rows become structurally invisible to
-- the sweep rather than being excluded by a rule a future edit can drop.
--
-- NULL = issued before this column existed, or by a connection that can no longer be identified.
-- Such rows are never swept (an id whose namespace is unknown cannot be attributed safely) and are
-- counted as COMPETING claims by the PurchaseOrder resolver, which fails closed.
ALTER TABLE "accounting_sync_logs" ADD COLUMN "provenance" TEXT;

-- ---------------------------------------------------------------------------------------------
-- 3. THE EVIDENCE TOMBSTONE (r3 finding 3)
--
-- Retention exempted every UNRESOLVED back-reference row from deletion, on the argument that the
-- sweep stamps everything it settles so the exempt set drains. It does not drain: a permanently
-- ambiguous row is never stamped BY DESIGN, a disconnected connector's rows are never swept at
-- all, and (until this branch) no QuickBooks sweep ran, so every QuickBooks invoice/bill row stayed
-- unstamped forever. Full payload rows — customer names, emails, addresses, financial lines — could
-- therefore outlive a configured retention policy without limit. A retention policy that silently
-- fails to delete is worse than one that deletes too much.
--
-- The replacement keeps the ATTRIBUTION and drops the CONTENT. At the retention cutoff an
-- unresolved row is compacted, not deleted: payload and errorMessage are cleared, and the columns
-- that make the evidence meaningful — connector, provenance, type, referenceType, referenceId,
-- externalTransactionId, status — are kept. That is what stops the failure the exemption existed
-- for: deleting a COMPETING SIBLING converts an ambiguity the sweep was refusing to guess at into
-- an apparent certainty (one unlinked bill, one surviving claimant), which nothing downstream can
-- detect because the surviving state is genuinely indistinguishable from an unambiguous one.
--
-- The marker makes the compaction idempotent and the daily pass cheap — like o3d-ahk's webhook
-- inbox tombstones, only the newly-eligible slice is rewritten.
--
-- It does NOT remove the row from the sweep's candidate set (r4 finding 3). An earlier revision
-- said it did, and that permanently retired unresolved repair work: an ambiguity that clears after
-- the retention horizon would never be reconsidered, and a transiently failing back-reference would
-- never be repaired. A tombstone still carries everything the ID write needs — external id,
-- provenance, referenceType, referenceId — so it stays a candidate for exactly that. What is lost
-- with the payload is only the payload-dependent FOLLOW-UPS (PDF, payment, attachment), which the
-- sweep now discards under an explicit terminal policy and warns about, rather than silently
-- abandoning the whole row.
ALTER TABLE "accounting_sync_logs" ADD COLUMN "backReferenceEvidenceCompactedAt" TIMESTAMP(3);

-- The sweep's candidate scan is now scoped to one connection's namespace. Unlike the bill index
-- above this is a PERFORMANCE index, not an invariant — its name is reused, so it cannot be built
-- before the old one is dropped, and nothing is at risk in the gap. It is inside the same
-- transaction regardless, so a failure here rolls back the whole migration rather than leaving the
-- scan without an index.
DROP INDEX "accounting_sync_logs_backref_sweep_idx";
CREATE INDEX "accounting_sync_logs_backref_sweep_idx"
  ON "accounting_sync_logs" ("connector", "provenance", "backReferenceCheckedAt", "createdAt");

COMMIT;
