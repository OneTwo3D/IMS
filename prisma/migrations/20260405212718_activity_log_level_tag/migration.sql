/*
  Warnings:

  - You are about to drop the column `ipAddress` on the `activity_logs` table. All the data in the column will be lost.
  - Added the required column `tag` to the `activity_logs` table without a default value. This is not possible if the table is not empty.
  - Made the column `description` on table `activity_logs` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "ActivityLogLevel" AS ENUM ('INFO', 'WARNING', 'ERROR');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityEntityType" ADD VALUE 'CUSTOMER';
ALTER TYPE "ActivityEntityType" ADD VALUE 'STOCK_ADJUSTMENT';
ALTER TYPE "ActivityEntityType" ADD VALUE 'SYNC';
ALTER TYPE "ActivityEntityType" ADD VALUE 'CURRENCY';
ALTER TYPE "ActivityEntityType" ADD VALUE 'SYSTEM';

-- AlterTable
ALTER TABLE "activity_logs" DROP COLUMN "ipAddress",
ADD COLUMN     "level" "ActivityLogLevel" NOT NULL DEFAULT 'INFO',
ADD COLUMN     "tag" TEXT NOT NULL,
ALTER COLUMN "description" SET NOT NULL;

-- CreateIndex
CREATE INDEX "activity_logs_tag_idx" ON "activity_logs"("tag");

-- CreateIndex
CREATE INDEX "activity_logs_level_idx" ON "activity_logs"("level");
