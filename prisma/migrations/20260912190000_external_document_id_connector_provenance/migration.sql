-- o3d-j625 r3 (Codex HIGH 2 / HIGH 3) — RECORD WHICH CONNECTOR A RETAINED EXTERNAL DOCUMENT ID BELONGS TO.
--
-- accounting_invoice_id / accounting_credit_note_id are primary keys in Xero's or QuickBooks'
-- database, and they deliberately SURVIVE a connector switch. Until now nothing recorded which
-- connector minted them, so a payment built for the ACTIVE connector could be queued carrying the
-- OTHER connector's invoice id — a failed payment, or a payment applied to an unrelated document.
--
-- NULLABLE AND DELIBERATELY NOT BACKFILLED. A guess about which ledger holds a document is the
-- mistake being corrected; NULL means "provenance was never recorded", and the enqueue guard refuses
-- on NULL rather than assuming the active connector.
ALTER TABLE "sales_orders" ADD COLUMN "accounting_invoice_connector" TEXT;
ALTER TABLE "purchase_invoices" ADD COLUMN "accounting_invoice_connector" TEXT;
ALTER TABLE "sales_order_refunds" ADD COLUMN "accounting_credit_note_connector" TEXT;
ALTER TABLE "supplier_credit_notes" ADD COLUMN "accounting_credit_note_connector" TEXT;
