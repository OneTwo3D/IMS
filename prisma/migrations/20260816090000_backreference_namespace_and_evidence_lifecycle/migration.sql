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
ALTER TABLE "purchase_invoices"
  ADD COLUMN "accounting_invoice_provenance" TEXT NOT NULL DEFAULT '';

DROP INDEX "purchase_invoices_accounting_invoice_id_key";

-- Named explicitly: Prisma's generated name for this pair is 73 characters, past Postgres's
-- 63-character identifier limit.
--
-- A duplicate present at migration time is the corruption this index exists to forbid, and the
-- statement will fail loudly — which is correct: which of two local bills owns a ledger document
-- cannot be inferred from IMS data. To find them first:
--   SELECT accounting_invoice_id, accounting_invoice_provenance, count(*), array_agg(id)
--     FROM purchase_invoices WHERE accounting_invoice_id IS NOT NULL
--    GROUP BY 1, 2 HAVING count(*) > 1;
CREATE UNIQUE INDEX "purchase_invoices_accounting_invoice_id_provenance_key"
  ON "purchase_invoices"("accounting_invoice_id", "accounting_invoice_provenance");

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
-- inbox tombstones, only the newly-eligible slice is rewritten — and it removes the row from the
-- sweep's candidate set, because without a payload its follow-ups can no longer be rebuilt.
ALTER TABLE "accounting_sync_logs" ADD COLUMN "backReferenceEvidenceCompactedAt" TIMESTAMP(3);

-- The sweep's candidate scan is now scoped to one connection's namespace.
DROP INDEX "accounting_sync_logs_backref_sweep_idx";
CREATE INDEX "accounting_sync_logs_backref_sweep_idx"
  ON "accounting_sync_logs" ("connector", "provenance", "backReferenceCheckedAt", "createdAt");
