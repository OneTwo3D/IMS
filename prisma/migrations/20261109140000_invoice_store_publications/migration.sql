-- What IMS has already written to the storefront order about its customer invoice (publish side).
--
-- ADDITIVE ONLY: one new table that nothing deployed before this migration reads or writes. Safe to apply to a populated database
-- while the previous build is still serving.
--
-- NOTHING IN THIS MIGRATION TURNS ANYTHING ON: the writers that fill this table are behind a setting that is OFF by default and
-- behind the producer-side hold. The table only remembers writes that already landed, so a retry does not repeat them.
-- The order foreign key CASCADEs: the marker is not a statutory record and goes with its order.

-- CreateTable
CREATE TABLE "invoice_store_publications" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "note_invoice_id" TEXT,
    "note_written_at" TIMESTAMP(3),
    "note_store_id" TEXT,
    "flag_document_id" TEXT,
    "flag_written_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_store_publications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoice_store_publications_order_id_key" ON "invoice_store_publications"("order_id");

-- AddForeignKey
ALTER TABLE "invoice_store_publications" ADD CONSTRAINT "invoice_store_publications_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
