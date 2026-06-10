-- Product lifecycle now distinguishes draft, active, end-of-life sell-off, and archived.
-- Existing NOT_FOR_SALE rows migrate to EOL by default; true drafts can be reclassified by operators.
ALTER TYPE "ProductLifecycleStatus" RENAME TO "ProductLifecycleStatus_old";
CREATE TYPE "ProductLifecycleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'EOL', 'ARCHIVED');

ALTER TABLE "products"
  ALTER COLUMN "lifecycleStatus" DROP DEFAULT;

ALTER TABLE "products"
  ALTER COLUMN "lifecycleStatus" TYPE "ProductLifecycleStatus"
  USING (
    CASE "lifecycleStatus"::text
      WHEN 'ACTIVE' THEN 'ACTIVE'
      WHEN 'NOT_FOR_SALE' THEN 'EOL'
      WHEN 'ARCHIVED' THEN 'ARCHIVED'
      ELSE 'EOL'
    END
  )::"ProductLifecycleStatus";

ALTER TABLE "products"
  ALTER COLUMN "lifecycleStatus" SET DEFAULT 'ACTIVE';

DROP TYPE "ProductLifecycleStatus_old";

ALTER TABLE "products"
  ADD COLUMN "preferredSupplierId" TEXT,
  ADD COLUMN "preferredSupplierLocked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "preferredSupplierUpdatedAt" TIMESTAMP(3);

ALTER TABLE "purchase_orders"
  ADD COLUMN "skipPreferredSupplierUpdate" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "purchase_order_lines"
  ADD COLUMN "reorderEvidence" JSONB;

-- Backfill preferred supplier from the latest placed PO line. If a product has
-- supplier catalog rows but no PO history, use the most recently updated catalog row.
WITH latest_po_supplier AS (
  SELECT DISTINCT ON (pol."productId")
    pol."productId",
    po."supplierId",
    COALESCE(po."poSentAt", po."updatedAt", po."createdAt") AS "updatedAt"
  FROM "purchase_order_lines" pol
  INNER JOIN "purchase_orders" po ON po.id = pol."poId"
  WHERE po.status IN ('PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'INVOICED', 'PARTIALLY_RETURNED', 'RETURNED')
    AND po.type = 'GOODS'
  ORDER BY pol."productId", COALESCE(po."poSentAt", po."updatedAt", po."createdAt") DESC, po.id DESC
),
latest_supplier_product AS (
  SELECT DISTINCT ON ("productId")
    "productId",
    "supplierId",
    "updatedAt"
  FROM "supplier_products"
  ORDER BY "productId", "updatedAt" DESC, "supplierId" ASC
)
UPDATE "products" p
SET
  "preferredSupplierId" = COALESCE(lps."supplierId", lsp."supplierId"),
  "preferredSupplierUpdatedAt" = COALESCE(lps."updatedAt", lsp."updatedAt")
FROM latest_supplier_product lsp
FULL OUTER JOIN latest_po_supplier lps
  ON lps."productId" = lsp."productId"
WHERE p.id = COALESCE(lps."productId", lsp."productId")
  AND COALESCE(lps."supplierId", lsp."supplierId") IS NOT NULL;

ALTER TABLE "products"
  ADD CONSTRAINT "products_preferredSupplierId_fkey"
  FOREIGN KEY ("preferredSupplierId") REFERENCES "suppliers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "products_preferredSupplierId_idx" ON "products"("preferredSupplierId");
