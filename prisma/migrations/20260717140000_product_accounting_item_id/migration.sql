-- o3d-3nc: persist the accounting connector's item id per product.
--
-- Without it, posting an invoice re-asks the accounting system "does an item with this code exist?"
-- once per distinct SKU, per invoice, forever — ~75% of the cost of posting a 3-line invoice, and
-- Xero's cap is 1,000 calls per org per rolling 24h. Mirrors the existing
-- Customer/Supplier.accountingContactId and Product.externalProductId columns: resolved once, then
-- persisted.
--
-- Nullable + additive: existing rows re-resolve on next use and backfill themselves.
ALTER TABLE "products" ADD COLUMN "accountingItemId" TEXT;

-- One accounting item maps to at most one product. Both connectors clear the column on disconnect,
-- so this cannot collide across connectors.
CREATE UNIQUE INDEX "products_accountingItemId_key" ON "products"("accountingItemId");
