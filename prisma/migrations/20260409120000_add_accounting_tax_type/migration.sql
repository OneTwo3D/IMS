-- Rename camelCase Xero columns to snake_case to match @map() in schema

ALTER TABLE "adjustment_reasons" RENAME COLUMN "xeroAccountCode" TO "xero_account_code";
ALTER TABLE "purchase_invoices" RENAME COLUMN "xeroInvoiceId" TO "xero_invoice_id";
ALTER TABLE "sales_order_refunds" RENAME COLUMN "xeroCreditNoteId" TO "xero_credit_note_id";
ALTER TABLE "sales_orders" RENAME COLUMN "xeroInvoiceId" TO "xero_invoice_id";
ALTER TABLE "sales_orders" RENAME COLUMN "xeroAllocationBatchAmount" TO "xero_allocation_batch_amount";
ALTER TABLE "sales_orders" RENAME COLUMN "xeroInventoryAllocatedDate" TO "xero_inventory_allocated_date";
ALTER TABLE "sales_orders" RENAME COLUMN "xeroRevenueDeferredDate" TO "xero_revenue_deferred_date";
ALTER TABLE "sales_orders" RENAME COLUMN "xeroUnearnedRevenueAmount" TO "xero_unearned_revenue_amount";
ALTER TABLE "shipments" RENAME COLUMN "xeroCogsBatchAmount" TO "xero_cogs_batch_amount";
ALTER TABLE "shipments" RENAME COLUMN "xeroRevenueRecognizedAmount" TO "xero_revenue_recognized_amount";
ALTER TABLE "shipments" RENAME COLUMN "xeroShipmentJournalDate" TO "xero_shipment_journal_date";
ALTER TABLE "tax_rates" ADD COLUMN IF NOT EXISTS "xero_tax_type" TEXT;
ALTER TABLE "tax_rates" DROP COLUMN IF EXISTS "xeroTaxType";
