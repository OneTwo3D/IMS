-- Retire REFUNDED / PARTIALLY_REFUNDED from SalesOrderStatus — refund state is now the
-- orthogonal RefundDisposition (sales_orders.refundStatus). All sales_orders rows were
-- already migrated off these statuses (20260628001938); the one remaining reference is
-- a WC status mapping, repointed to PROCESSING (the refund itself flows through the
-- refund records → refundStatus). Postgres can't DROP an enum value, so the type is
-- recreated.
UPDATE "shopping_status_mappings"
SET "imsStatus" = 'PROCESSING'
WHERE "imsStatus" IN ('REFUNDED', 'PARTIALLY_REFUNDED');

ALTER TYPE "SalesOrderStatus" RENAME TO "SalesOrderStatus_old";
CREATE TYPE "SalesOrderStatus" AS ENUM (
  'DRAFT', 'PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED',
  'PICKING', 'PACKING', 'SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED'
);

ALTER TABLE "sales_orders" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "sales_orders"
  ALTER COLUMN "status" TYPE "SalesOrderStatus" USING "status"::text::"SalesOrderStatus";
ALTER TABLE "sales_orders" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

ALTER TABLE "shopping_status_mappings"
  ALTER COLUMN "imsStatus" TYPE "SalesOrderStatus" USING "imsStatus"::text::"SalesOrderStatus";

DROP TYPE "SalesOrderStatus_old";
