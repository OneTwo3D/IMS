-- o3d-wf86 — record HOW a bill acquired its accounting invoice id.
--
-- THE PROBLEM THIS DOES NOT SOLVE, and says so up front. o3d-9kek made
-- purchase_invoices.accounting_invoice_id globally unique and made the PO-keyed repair REFUSE
-- rather than overwrite an id another bill already holds. That is the right refusal, but it is
-- permanent: nothing records whether the holder's link came from the authoritative bill-keyed sync
-- or from the old newest-unlinked-bill guess, so a conflict cannot be adjudicated from IMS data at
-- all and the sweep can only ever warn EXTERNAL_ID_LINKED_ELSEWHERE and stop.
--
-- Provenance is HALF of what an automatic resolution needs. The other half is connector-side
-- confirmation — GET the remote bill and compare its reference, total and lines against the two
-- local candidates — which does not exist. So NOTHING here changes what the sweep does: it still
-- refuses, and it still names a manual action. What changes is that the refusal can now TELL the
-- operator which kind of link is in its way, which is the difference between "resolve this by hand"
-- and "resolve this by hand; the id is held by a bill that was only ever GUESSED".
--
-- NULLABLE, AND NOT BACKFILLED. Every existing bill answers "unknown", which is the truth: the two
-- writers were indistinguishable, so the value cannot be reconstructed. Backfilling them all as
-- BILL_KEYED_SYNC would manufacture exactly the confidence this column exists to stop being assumed,
-- and it would do so on the legacy rows least entitled to it. An unknown provenance is treated as
-- unproven everywhere it is read.
--
-- ADDITIVE AND NON-BLOCKING: a new enum type plus a nullable column with no default, so the ALTER is
-- a catalogue-only change that takes no table rewrite and no long lock. No index is created — the
-- column is only ever read alongside a row already located by its id or its external id, both of
-- which are already indexed, and an index on a three-value column would earn nothing.

CREATE TYPE "AccountingLinkSource" AS ENUM ('BILL_KEYED_SYNC', 'PO_KEYED_REPAIR', 'MANUAL');

ALTER TABLE "purchase_invoices" ADD COLUMN "accounting_invoice_id_source" "AccountingLinkSource";
