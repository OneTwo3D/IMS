-- AlterTable: Add archived flag to sales_orders
ALTER TABLE "sales_orders" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: Add archived flag to purchase_orders
ALTER TABLE "purchase_orders" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: Add archived flag and gdprAnonymisedAt to customers
ALTER TABLE "customers" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "customers" ADD COLUMN "gdprAnonymisedAt" TIMESTAMP(3);
