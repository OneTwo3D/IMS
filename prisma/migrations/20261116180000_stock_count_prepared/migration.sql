-- Additive: prepared stocktakes. `prepared` is true for a count whose product list the operator chose before counting
-- started (false for every existing count, which snapshots the whole warehouse). The unique index makes "a product is
-- in a count at most once" a database fact: creation and the add-lines action already refuse duplicates, and no earlier
-- code path could write one.
ALTER TABLE "stock_counts" ADD COLUMN "prepared" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "stock_count_lines_countId_productId_key" ON "stock_count_lines"("countId", "productId");
