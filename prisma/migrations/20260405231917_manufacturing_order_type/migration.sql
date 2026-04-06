-- CreateEnum
CREATE TYPE "ProductionOrderType" AS ENUM ('ASSEMBLY', 'DISASSEMBLY');

-- AlterTable
ALTER TABLE "production_orders" ADD COLUMN     "manufacturerId" TEXT,
ADD COLUMN     "orderType" "ProductionOrderType" NOT NULL DEFAULT 'ASSEMBLY';

-- CreateIndex
CREATE INDEX "production_orders_status_idx" ON "production_orders"("status");

-- CreateIndex
CREATE INDEX "production_orders_createdAt_idx" ON "production_orders"("createdAt");

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_manufacturerId_fkey" FOREIGN KEY ("manufacturerId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
