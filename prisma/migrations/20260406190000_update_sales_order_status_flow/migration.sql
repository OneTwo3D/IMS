-- Recreate the enum with new values (rename PENDING→DRAFT, PACKED→PACKING, add new statuses)
ALTER TYPE "SalesOrderStatus" RENAME TO "SalesOrderStatus_old";

CREATE TYPE "SalesOrderStatus" AS ENUM ('DRAFT', 'PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING', 'SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED');

ALTER TABLE "sales_orders" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "sales_orders" ALTER COLUMN "status" TYPE "SalesOrderStatus"
  USING (
    CASE "status"::text
      WHEN 'PENDING' THEN 'DRAFT'
      WHEN 'PACKED'  THEN 'PACKING'
      ELSE "status"::text
    END
  )::"SalesOrderStatus";
ALTER TABLE "sales_orders" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

DROP TYPE "SalesOrderStatus_old";
