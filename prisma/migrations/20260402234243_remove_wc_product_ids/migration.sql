/*
  Warnings:

  - You are about to drop the column `wcProductId` on the `products` table. All the data in the column will be lost.
  - You are about to drop the column `wcVariantId` on the `products` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "products_wcProductId_idx";

-- DropIndex
DROP INDEX "products_wcVariantId_idx";

-- AlterTable
ALTER TABLE "products" DROP COLUMN "wcProductId",
DROP COLUMN "wcVariantId";
