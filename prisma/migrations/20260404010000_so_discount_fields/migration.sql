ALTER TABLE "sales_order_lines" ADD COLUMN "discountStr" TEXT;
ALTER TABLE "sales_order_lines" ADD COLUMN "discountAmount" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "sales_orders" ADD COLUMN "discountStr" TEXT;
ALTER TABLE "sales_orders" ADD COLUMN "discountAmount" DECIMAL(18,4) NOT NULL DEFAULT 0;
