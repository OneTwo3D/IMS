-- The warehouse's own line ids for each pushed order, so IMS can remove exactly one order's lines from a merged warehouse order.
--
-- ADDITIVE ONLY: one new table that nothing deployed before this migration reads or writes. Safe to apply to a populated database
-- while the previous build is still serving. NO BACKFILL: an order pushed before this migration has no rows, and the merged-order
-- removal then falls back to the operator notice, as it did before.
--
-- NOTHING IN THIS MIGRATION TURNS ANYTHING ON: the rows are written by the order push (a read-back after the create) and read only
-- by the cancel pass, whose warehouse writes sit behind the producer-side hold and the outbound write grant.
-- The link foreign key CASCADEs: the snapshot is not a record of its own and goes with its link.

-- CreateTable
CREATE TABLE "wms_order_push_items" (
    "id" TEXT NOT NULL,
    "link_id" TEXT NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "external_item_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wms_order_push_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wms_order_push_items_link_id_idx" ON "wms_order_push_items"("link_id");

-- CreateIndex
CREATE UNIQUE INDEX "wms_order_push_items_link_id_external_item_id_key" ON "wms_order_push_items"("link_id", "external_item_id");

-- AddForeignKey
ALTER TABLE "wms_order_push_items" ADD CONSTRAINT "wms_order_push_items_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "wms_order_push_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;
