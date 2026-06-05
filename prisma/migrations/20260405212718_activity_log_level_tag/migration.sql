/*
  Warnings:

  - You are about to drop the column `ipAddress` on the `activity_logs` table. All the data in the column will be lost.
  - You are about to backfill NULL activity log descriptions to preserve the new NOT NULL invariant.

  Operational notes:

  - This historical migration was edited while IMS is not in live production use. Any database that already applied the
    previous file contents will have a stale Prisma checksum recorded in `_prisma_migrations`. Ephemeral dev databases
    should be dropped/recreated and migrated from scratch. Data-bearing dev/staging databases need an explicit checksum
    recovery plan after DBA review; do not silently deploy this edited migration over an already-applied checksum.
  - The legacy activity log backfill is intentionally unbatched, then followed by `ALTER COLUMN ... SET NOT NULL`.
    This is acceptable for not-live/small installs. For live or large `activity_logs` tables, use the online-safe
    backfill and NOT VALID/VALIDATE CHECK pattern documented in `docs/development.md` before setting NOT NULL.

*/
-- prisma-schema-scope-ok: db-native historical backfill/comment correction only; Prisma schema already models these columns
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
ADD COLUMN     "tag" TEXT;

UPDATE "activity_logs"
SET "tag" = CASE
  WHEN "entityType"::text = 'USER' THEN 'auth'
  WHEN "entityType"::text IN ('PRODUCT', 'WAREHOUSE') THEN 'inventory'
  WHEN "entityType"::text IN ('STOCK_TRANSFER', 'STOCK_COUNT', 'STOCK_ADJUSTMENT') THEN 'stock'
  WHEN "entityType"::text = 'PRODUCTION_ORDER' THEN 'manufacturing'
  WHEN "entityType"::text IN ('SUPPLIER', 'PURCHASE_ORDER') THEN 'purchase'
  WHEN "entityType"::text IN ('SALES_ORDER', 'CUSTOMER') THEN 'sales'
  WHEN "entityType"::text = 'SETTING' THEN 'settings'
  WHEN "entityType"::text = 'IMPORT' THEN 'import'
  WHEN "entityType"::text = 'SYNC' THEN 'sync'
  WHEN "entityType"::text = 'CURRENCY' THEN 'settings'
  ELSE 'system'
END
WHERE "tag" IS NULL;

UPDATE "activity_logs"
SET "description" = '(legacy entry, no description recorded)'
WHERE "description" IS NULL;

ALTER TABLE "activity_logs"
ALTER COLUMN "tag" SET NOT NULL,
ALTER COLUMN "description" SET NOT NULL;

-- CreateIndex
CREATE INDEX "activity_logs_tag_idx" ON "activity_logs"("tag");

-- CreateIndex
CREATE INDEX "activity_logs_level_idx" ON "activity_logs"("level");
