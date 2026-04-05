-- AlterEnum
ALTER TYPE "XeroSyncType" ADD VALUE 'INVENTORY_ADJUSTMENT';

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "imageUrl" TEXT;
