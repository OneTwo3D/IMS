-- o3d-zjsb5.9 — give a Bom a stable, unique owning product.
--
-- WHY: "the BOM for product X" was previously only answerable through BomItem.parentProductId,
-- which is not unique per product. createManufacturingOrder() takes the first match and
-- createReorderMOs() takes the most recently updated one, so the two disagree whenever more than
-- one Bom lists the same parent. A CSV importer that rewrites a recipe, and a consistency check
-- that compares it against product_components, both need ONE unambiguous target.
--
-- ADDITIVE AND BACKFILL-FREE: the column is nullable, so every existing row stays valid and
-- unclaimed. Nothing is backfilled here on purpose — adopting an existing Bom is a decision the
-- importer makes under the component-graph advisory lock (it must delete and rewrite that
-- parent's items in the same transaction), and a blind UPDATE ... FROM here would silently pick
-- a winner among duplicates with no operator visibility. The unique index below is what stops a
-- SECOND claimed recipe existing once a product's Bom has been claimed.
ALTER TABLE "boms" ADD COLUMN "productId" TEXT;

CREATE UNIQUE INDEX "boms_productId_key" ON "boms"("productId");

ALTER TABLE "boms"
  ADD CONSTRAINT "boms_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
