-- Additive: a new table of products whose storefront / warehouse sync is owed after a bulk CSV edit, so the sync is drained by a paced cron instead of being pushed from the request. No existing table or column is touched.
CREATE TABLE "product_sync_marks" (
    "productId" TEXT NOT NULL,
    "storefrontPending" BOOLEAN NOT NULL DEFAULT true,
    "warehousePending" BOOLEAN NOT NULL DEFAULT true,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_sync_marks_pkey" PRIMARY KEY ("productId")
);

CREATE INDEX "product_sync_marks_createdAt_idx" ON "product_sync_marks"("createdAt");

ALTER TABLE "product_sync_marks" ADD CONSTRAINT "product_sync_marks_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
