-- The customer-facing invoice / credit note PDFs IMS fetches from the ledger and keeps (read side).
--
-- ADDITIVE ONLY: two new tables and two new enums that nothing deployed before this migration reads or writes. Safe
-- to apply to a populated database while the previous build is still serving.
--
-- NOTHING IN THIS MIGRATION TURNS ANYTHING ON: the sweep that fills these tables is a scheduled job that is OFF by
-- default and does nothing until a floor date is configured.
--
-- sales_order_invoice_documents is a statutory record (six years): no code deletes from it, and the order foreign
-- key is RESTRICT so an order with a stored document cannot be deleted from under it.

-- CreateEnum
CREATE TYPE "InvoiceDocumentKind" AS ENUM ('INVOICE', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "InvoiceDocumentFetchStatus" AS ENUM ('PENDING', 'NEEDS_ATTENTION', 'DONE');

-- CreateTable
CREATE TABLE "sales_order_invoice_documents" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "refund_id" TEXT,
    "kind" "InvoiceDocumentKind" NOT NULL,
    "connector" TEXT NOT NULL,
    "external_document_id" TEXT NOT NULL,
    "document_number" TEXT NOT NULL,
    "external_status" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "stored_path" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded_at" TIMESTAMP(3),

    CONSTRAINT "sales_order_invoice_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_document_fetch_states" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "refund_id" TEXT,
    "kind" "InvoiceDocumentKind" NOT NULL,
    "subject_key" TEXT NOT NULL,
    "status" "InvoiceDocumentFetchStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "rechecks" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMP(3),
    "lease_holder" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_document_fetch_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_invoice_documents_connector_external_document_i_key" ON "sales_order_invoice_documents"("connector", "external_document_id", "sha256");

-- CreateIndex
CREATE INDEX "sales_order_invoice_documents_order_id_kind_idx" ON "sales_order_invoice_documents"("order_id", "kind");

-- CreateIndex
CREATE INDEX "sales_order_invoice_documents_refund_id_idx" ON "sales_order_invoice_documents"("refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_document_fetch_states_subject_key_key" ON "invoice_document_fetch_states"("subject_key");

-- CreateIndex
CREATE INDEX "invoice_document_fetch_states_status_next_attempt_at_idx" ON "invoice_document_fetch_states"("status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "sales_order_invoice_documents" ADD CONSTRAINT "sales_order_invoice_documents_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_invoice_documents" ADD CONSTRAINT "sales_order_invoice_documents_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "sales_order_refunds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_document_fetch_states" ADD CONSTRAINT "invoice_document_fetch_states_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_document_fetch_states" ADD CONSTRAINT "invoice_document_fetch_states_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "sales_order_refunds"("id") ON DELETE SET NULL ON UPDATE CASCADE;
