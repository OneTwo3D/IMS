-- Add per-line discount to purchase order lines (mirrors sales_order_lines).
ALTER TABLE "purchase_order_lines"
  ADD COLUMN "discountStr" TEXT,
  ADD COLUMN "discountAmount" DECIMAL(18, 4) NOT NULL DEFAULT 0;
