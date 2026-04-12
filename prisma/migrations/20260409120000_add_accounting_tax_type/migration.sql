-- Rename camelCase Xero columns to snake_case to match @map() in schema
-- Use DO blocks to handle cases where columns may not exist yet (init migration
-- may have created them with snake_case already via @map).

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='adjustment_reasons' AND column_name='xeroAccountCode') THEN
    ALTER TABLE "adjustment_reasons" RENAME COLUMN "xeroAccountCode" TO "xero_account_code";
  ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='adjustment_reasons' AND column_name='xero_account_code') THEN
    ALTER TABLE "adjustment_reasons" ADD COLUMN "xero_account_code" TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='purchase_invoices' AND column_name='xeroInvoiceId') THEN
    ALTER TABLE "purchase_invoices" RENAME COLUMN "xeroInvoiceId" TO "xero_invoice_id";
  ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='purchase_invoices' AND column_name='xero_invoice_id') THEN
    ALTER TABLE "purchase_invoices" ADD COLUMN "xero_invoice_id" TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_order_refunds' AND column_name='xeroCreditNoteId') THEN
    ALTER TABLE "sales_order_refunds" RENAME COLUMN "xeroCreditNoteId" TO "xero_credit_note_id";
  ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_order_refunds' AND column_name='xero_credit_note_id') THEN
    ALTER TABLE "sales_order_refunds" ADD COLUMN "xero_credit_note_id" TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_orders' AND column_name='xeroInvoiceId') THEN
    ALTER TABLE "sales_orders" RENAME COLUMN "xeroInvoiceId" TO "xero_invoice_id";
  ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_orders' AND column_name='xero_invoice_id') THEN
    ALTER TABLE "sales_orders" ADD COLUMN "xero_invoice_id" TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_orders' AND column_name='xeroAllocationBatchAmount') THEN
    ALTER TABLE "sales_orders" RENAME COLUMN "xeroAllocationBatchAmount" TO "xero_allocation_batch_amount";
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_orders' AND column_name='xeroInventoryAllocatedDate') THEN
    ALTER TABLE "sales_orders" RENAME COLUMN "xeroInventoryAllocatedDate" TO "xero_inventory_allocated_date";
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_orders' AND column_name='xeroRevenueDeferredDate') THEN
    ALTER TABLE "sales_orders" RENAME COLUMN "xeroRevenueDeferredDate" TO "xero_revenue_deferred_date";
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_orders' AND column_name='xeroUnearnedRevenueAmount') THEN
    ALTER TABLE "sales_orders" RENAME COLUMN "xeroUnearnedRevenueAmount" TO "xero_unearned_revenue_amount";
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='shipments' AND column_name='xeroCogsBatchAmount') THEN
    ALTER TABLE "shipments" RENAME COLUMN "xeroCogsBatchAmount" TO "xero_cogs_batch_amount";
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='shipments' AND column_name='xeroRevenueRecognizedAmount') THEN
    ALTER TABLE "shipments" RENAME COLUMN "xeroRevenueRecognizedAmount" TO "xero_revenue_recognized_amount";
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='shipments' AND column_name='xeroShipmentJournalDate') THEN
    ALTER TABLE "shipments" RENAME COLUMN "xeroShipmentJournalDate" TO "xero_shipment_journal_date";
  END IF;
END $$;

ALTER TABLE "tax_rates" ADD COLUMN IF NOT EXISTS "xero_tax_type" TEXT;
ALTER TABLE "tax_rates" DROP COLUMN IF EXISTS "xeroTaxType";
