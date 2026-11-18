-- Additive: one new table holding supporting documents (supplier quotes, proformas, packing lists, customer POs, emails) attached to a
-- purchase order or a sales order. Nothing existing is touched; no existing row is read or rewritten. Predecessor binaries never see the table.
-- Exactly one parent per row (the CHECK). Deleting an order removes its attachment rows (CASCADE); the application removes the files.
CREATE TABLE "order_attachments" (
    "id" TEXT NOT NULL,
    "purchase_order_id" TEXT,
    "sales_order_id" TEXT,
    "original_filename" TEXT NOT NULL,
    "stored_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploaded_by_user_id" TEXT NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "order_attachments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "order_attachments_one_parent" CHECK (("purchase_order_id" IS NULL) <> ("sales_order_id" IS NULL))
);

CREATE UNIQUE INDEX "order_attachments_stored_name_key" ON "order_attachments"("stored_name");
CREATE INDEX "order_attachments_purchase_order_id_deleted_at_idx" ON "order_attachments"("purchase_order_id", "deleted_at");
CREATE INDEX "order_attachments_sales_order_id_deleted_at_idx" ON "order_attachments"("sales_order_id", "deleted_at");

ALTER TABLE "order_attachments" ADD CONSTRAINT "order_attachments_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_attachments" ADD CONSTRAINT "order_attachments_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
