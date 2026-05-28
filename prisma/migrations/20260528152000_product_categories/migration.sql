-- Product reporting categories. Existing products remain uncategorised.

CREATE TABLE "product_categories" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "name_normalized" VARCHAR(100) NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "product_categories_no_self_parent" CHECK ("parentId" IS NULL OR "parentId" <> "id")
);

CREATE UNIQUE INDEX "product_categories_name_normalized_key" ON "product_categories"("name_normalized");
CREATE INDEX "product_categories_parentId_idx" ON "product_categories"("parentId");

ALTER TABLE "product_categories"
  ADD CONSTRAINT "product_categories_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "product_categories"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "products" ADD COLUMN "categoryId" TEXT;
CREATE INDEX "products_categoryId_idx" ON "products"("categoryId");

ALTER TABLE "products"
  ADD CONSTRAINT "products_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "product_categories"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
