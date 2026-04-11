-- Add order-level discount fields to purchase orders
ALTER TABLE "purchase_orders" ADD COLUMN "discountStr" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN "discountAmount" DECIMAL(18,4) NOT NULL DEFAULT 0;
