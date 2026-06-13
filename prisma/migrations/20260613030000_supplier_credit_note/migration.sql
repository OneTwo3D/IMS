-- CreateEnum
CREATE TYPE "SupplierCreditNoteStatus" AS ENUM ('DRAFT', 'POSTED');

-- CreateTable
CREATE TABLE "supplier_credit_notes" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "purchaseInvoiceId" TEXT,
    "supplierId" TEXT NOT NULL,
    "reference" TEXT,
    "creditNoteNumber" TEXT,
    "amountForeign" DECIMAL(18,4) NOT NULL,
    "amountBase" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "fxRateToBase" DECIMAL(18,8) NOT NULL,
    "reason" TEXT,
    "notes" TEXT,
    "status" "SupplierCreditNoteStatus" NOT NULL DEFAULT 'DRAFT',
    "accounting_credit_note_id" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_credit_notes_poId_idx" ON "supplier_credit_notes"("poId");

-- CreateIndex
CREATE INDEX "supplier_credit_notes_supplierId_idx" ON "supplier_credit_notes"("supplierId");

-- CreateIndex
CREATE INDEX "supplier_credit_notes_purchaseInvoiceId_idx" ON "supplier_credit_notes"("purchaseInvoiceId");

-- AddForeignKey
ALTER TABLE "supplier_credit_notes" ADD CONSTRAINT "supplier_credit_notes_poId_fkey" FOREIGN KEY ("poId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_credit_notes" ADD CONSTRAINT "supplier_credit_notes_purchaseInvoiceId_fkey" FOREIGN KEY ("purchaseInvoiceId") REFERENCES "purchase_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

