-- Additive: per-line estimated delivery on purchase orders. NULL means the line inherits the order's expectedDelivery,
-- so every existing line keeps behaving exactly as before.
ALTER TABLE "purchase_order_lines" ADD COLUMN "expectedDelivery" TIMESTAMP(3);
