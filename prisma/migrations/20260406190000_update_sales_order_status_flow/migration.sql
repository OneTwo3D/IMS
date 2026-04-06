-- Add new enum values
ALTER TYPE "SalesOrderStatus" ADD VALUE IF NOT EXISTS 'DRAFT';
ALTER TYPE "SalesOrderStatus" ADD VALUE IF NOT EXISTS 'PENDING_PAYMENT';
ALTER TYPE "SalesOrderStatus" ADD VALUE IF NOT EXISTS 'PACKING';
ALTER TYPE "SalesOrderStatus" ADD VALUE IF NOT EXISTS 'DELIVERED';

-- Migrate existing records
UPDATE "sales_orders" SET "status" = 'DRAFT' WHERE "status" = 'PENDING';
UPDATE "sales_orders" SET "status" = 'PACKING' WHERE "status" = 'PACKED';

-- Now recreate the enum without the old values
-- PostgreSQL doesn't support DROP VALUE, so we rename via a new type
ALTER TYPE "SalesOrderStatus" RENAME TO "SalesOrderStatus_old";

CREATE TYPE "SalesOrderStatus" AS ENUM ('DRAFT', 'PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING', 'SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED');

ALTER TABLE "sales_orders" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "sales_orders" ALTER COLUMN "status" TYPE "SalesOrderStatus" USING ("status"::text::"SalesOrderStatus");
ALTER TABLE "sales_orders" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

DROP TYPE "SalesOrderStatus_old";
