-- A refund that adopts an already-restocked returns-inbox arrival records it per refund, inbox row and quantity (o3d-iil0b). ADDITIVE ONLY: one new table; existing refunds adopt nothing.
CREATE TABLE "sales_order_refund_inbox_adoptions" (
    "id" TEXT NOT NULL,
    "refund_id" TEXT NOT NULL,
    "inbox_id" TEXT NOT NULL,
    "qty" DECIMAL(14,6) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_order_refund_inbox_adoptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_order_refund_inbox_adoptions_refund_id_inbox_id_key" ON "sales_order_refund_inbox_adoptions"("refund_id", "inbox_id");
CREATE INDEX "sales_order_refund_inbox_adoptions_inbox_id_idx" ON "sales_order_refund_inbox_adoptions"("inbox_id");

ALTER TABLE "sales_order_refund_inbox_adoptions" ADD CONSTRAINT "sales_order_refund_inbox_adoptions_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "sales_order_refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_order_refund_inbox_adoptions" ADD CONSTRAINT "sales_order_refund_inbox_adoptions_inbox_id_fkey" FOREIGN KEY ("inbox_id") REFERENCES "wms_returns_inbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
