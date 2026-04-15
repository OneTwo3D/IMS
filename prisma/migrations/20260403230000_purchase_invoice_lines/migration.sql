-- Add new fields to purchase_invoices
ALTER TABLE "purchase_invoices" ADD COLUMN "subtotalForeign" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "purchase_invoices" ADD COLUMN "subtotalBase" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "purchase_invoices" ADD COLUMN "taxForeign" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "purchase_invoices" ADD COLUMN "taxBase" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "purchase_invoices" ADD COLUMN "supplierInvoiceUrl" TEXT;

-- Purchase invoice lines table
CREATE TABLE "purchase_invoice_lines" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "poLineId" TEXT NOT NULL,
    "qtyBilled" DECIMAL(12,4) NOT NULL,
    "unitCostForeign" DECIMAL(18,6) NOT NULL,
    "totalForeign" DECIMAL(18,4) NOT NULL,
    "totalBase" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "purchase_invoice_lines_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "purchase_invoice_lines" ADD CONSTRAINT "purchase_invoice_lines_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "purchase_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_invoice_lines" ADD CONSTRAINT "purchase_invoice_lines_poLineId_fkey" FOREIGN KEY ("poLineId") REFERENCES "purchase_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
