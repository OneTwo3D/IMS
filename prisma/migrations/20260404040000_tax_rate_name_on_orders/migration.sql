ALTER TABLE "purchase_orders" ADD COLUMN "taxRateName" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN "taxRatePercent" DECIMAL(5,4);
ALTER TABLE "sales_orders" ADD COLUMN "taxRateName" TEXT;
ALTER TABLE "sales_orders" ADD COLUMN "taxRatePercent" DECIMAL(5,4);
