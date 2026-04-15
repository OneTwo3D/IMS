-- AlterEnum
ALTER TYPE "AccountingSyncType" ADD VALUE 'INVENTORY_ADJUSTMENT';

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "imageUrl" TEXT;
