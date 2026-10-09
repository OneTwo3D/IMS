-- Product content hub (WooCommerce -> IMS -> Mintsoft).
--
-- "product_contents" holds the descriptions and picture REFERENCES authored in WooCommerce, one row per
-- product, with a per-field changed-at stamp so a change is detected field by field. It is a new table:
-- no existing row, reader or writer is affected.
--
-- "wms_product_links"."contentSyncState" is nullable with no default: NULL means "nothing about this
-- product's content has been pushed or shadowed yet", which is exactly the state of every existing row.
--
-- The new "WmsSyncLogAction" value is added HERE and first USED by application code deployed with it;
-- PostgreSQL refuses to use an enum value in the transaction that added it, and nothing in this file uses it.
ALTER TYPE "WmsSyncLogAction" ADD VALUE IF NOT EXISTS 'shadow';

ALTER TABLE "wms_product_links" ADD COLUMN "contentSyncState" JSONB;

CREATE TABLE "product_contents" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "shortDescription" TEXT,
    "longDescription" TEXT,
    "images" JSONB NOT NULL DEFAULT '[]',
    "sourceSystem" TEXT NOT NULL DEFAULT 'woocommerce',
    "sourceModifiedAt" TIMESTAMP(3),
    "shortDescriptionChangedAt" TIMESTAMP(3),
    "longDescriptionChangedAt" TIMESTAMP(3),
    "imagesChangedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_contents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_contents_productId_key" ON "product_contents"("productId");

ALTER TABLE "product_contents" ADD CONSTRAINT "product_contents_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
