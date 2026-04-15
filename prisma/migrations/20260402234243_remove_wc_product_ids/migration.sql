/*
  Warnings:

  - You are about to drop the column `externalProductId` on the `products` table. All the data in the column will be lost.
  - You are about to drop the column `wcVariantId` on the `products` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "products_externalProductId_idx";

-- DropIndex
DROP INDEX "products_wcVariantId_idx";

-- AlterTable
ALTER TABLE "products" DROP COLUMN "externalProductId",
DROP COLUMN "wcVariantId";
