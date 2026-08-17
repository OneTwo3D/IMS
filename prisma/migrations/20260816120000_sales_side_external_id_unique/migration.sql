-- o3d-9kek r6 finding 3: extend "one external document ↔ one local document" to the SALES side.
--
-- 20260815140000 made purchase_invoices.accounting_invoice_id globally unique and argued the case
-- in full. That argument was never bill-specific — it is about what a stored external id is USED
-- FOR — but only the bill got the constraint, so three columns holding exactly the same kind of
-- value were left protected by nothing at all:
--
--   * sales_orders.accounting_invoice_id           (Xero InvoiceID / QBO Invoice.Id)
--   * sales_order_refunds.accounting_credit_note_id (Xero ACCRECCREDIT CreditNoteID / QBO CreditMemo.Id)
--   * supplier_credit_notes.accounting_credit_note_id (Xero ACCPAYCREDIT CreditNoteID)
--
-- WHAT A DUPLICATE COSTS ON THE SALES SIDE. Payment polling selects EVERY local row carrying a
-- matching external id and acts on all of them: lib/connectors/quickbooks/payment-poller.ts and
-- lib/connectors/xero/payment-poller.ts mark each one paid, advance its lifecycle and can
-- auto-allocate it. Two orders sharing one InvoiceID means one customer payment settles two orders,
-- and SALES_INVOICE_UPDATE then posts every later correction to whichever document the pair
-- resolves to. That is the same class of silent, self-confirming corruption the bill index exists to
-- prevent, and it is just as cheap to make impossible.
--
-- WHY THIS IS SAFE — i.e. no legitimate duplicate exists to break. Audited before writing this:
--
--   * ONE external document per local row, by construction. Every write of these three columns goes
--     through applyBackReference (lib/domain/accounting/back-reference.ts); there is no raw SQL, no
--     seed, no backfill, no import and no "link an existing accounting document" UI that writes them.
--   * No consolidated or grouped invoicing: one SALES_INVOICE sync row per SalesOrder. Re-invoicing
--     an order that is already linked goes to SALES_INVOICE_UPDATE, which does not write the column.
--   * No split refund shares a credit note: each SalesOrderRefund mints its own sequential
--     creditNoteNumber and gets its own CREDIT_NOTE sync row. The external-refund and chargeback
--     replay paths RETURN the existing refund row rather than creating a second one.
--   * No void-and-replace path re-uses an id, and cloneSalesOrder deliberately does not copy
--     accountingInvoiceId.
--   * Supplier credit notes are Xero-only (QuickBooks has no VendorCredit support), one per
--     SupplierCreditNote row.
--
-- Postgres does not treat NULLs as equal, so each of these is precisely a partial unique index over
-- the rows that HAVE an external id: any number of documents may be unlinked.
--
-- GLOBAL, ON THE VALUE ALONE, for the same reason as the bill index — and with more force here.
-- Namespacing the id per connector-tenant was implemented and reverted; these three models have no
-- provenance column to consult even in principle, so no reader-side rule could be written for them.
-- After a QuickBooks realm switch the accepted failure is therefore a BLOCKED WRITE with a loud
-- error, not a silent wrong document. o3d-gt8r carries that design; o3d-s36z is the realm-isolation
-- work it waits on.
--
-- WHAT THIS WILL SURFACE, deliberately. Xero's POST /CreditNotes is create-or-update on
-- CreditNoteNumber (the o3d-6l3 ACCPAY defect, one document type over), and
-- buildSupplierCreditNotePayload falls back to the PURCHASE ORDER REFERENCE when an operator leaves
-- the credit-note number blank. Two manual supplier credit notes on one PO with blank numbers
-- therefore post the same CreditNoteNumber and can come back with the SAME CreditNoteID — the second
-- having overwritten the first in the ledger. That is corruption, not a legitimate duplicate: today
-- it is silent, and after this migration it is a P2002 an operator can see and act on. The
-- underlying number-collision defect is o3d-tfri (switch the credit-note poster to PUT, and/or drop
-- the PO-reference fallback) — the index limits the blast radius, it does not fix the cause.
--
-- NOT CONCURRENTLY, and that is a considered deviation from docs/migration-conventions.md (which
-- names sales_orders as a table that should usually use CREATE INDEX CONCURRENTLY). A UNIQUE index
-- built concurrently that meets a duplicate is left behind INVALID and has to be dropped by hand
-- before the migration can be retried, which is the worst possible outcome for a constraint whose
-- entire purpose is to fail loudly and resolvably. IMS is not in productive use, these tables are
-- small, and a brief write lock is the cheaper failure. The same choice, for the same reason, as
-- 20260815140000.
--
-- No backfill. A duplicate present at migration time IS the corruption described above, and this
-- will fail loudly naming it — which is correct, because which of the two documents is real cannot
-- be inferred from IMS data alone. To find them before migrating:
--   SELECT accounting_invoice_id, count(*), array_agg(id)
--     FROM sales_orders WHERE accounting_invoice_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
--   SELECT accounting_credit_note_id, count(*), array_agg(id)
--     FROM sales_order_refunds WHERE accounting_credit_note_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
--   SELECT accounting_credit_note_id, count(*), array_agg(id)
--     FROM supplier_credit_notes WHERE accounting_credit_note_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
--
-- ONE EXPLICIT TRANSACTION: Prisma 7.8's runner does not wrap a migration file, so three statements
-- would otherwise be able to apply partially and leave two of the three invariants enforced.
BEGIN;

CREATE UNIQUE INDEX "sales_orders_accounting_invoice_id_key"
  ON "sales_orders"("accounting_invoice_id");

CREATE UNIQUE INDEX "sales_order_refunds_accounting_credit_note_id_key"
  ON "sales_order_refunds"("accounting_credit_note_id");

CREATE UNIQUE INDEX "supplier_credit_notes_accounting_credit_note_id_key"
  ON "supplier_credit_notes"("accounting_credit_note_id");

COMMIT;
