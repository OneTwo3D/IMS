ALTER TABLE "sales_orders" ADD COLUMN "invoiceNumber" TEXT;
ALTER TABLE "sales_orders" ADD COLUMN "invoicedAt" TIMESTAMP(3);
ALTER TABLE "sales_orders" ADD COLUMN "paidAt" TIMESTAMP(3);
