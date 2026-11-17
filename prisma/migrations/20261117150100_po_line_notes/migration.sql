-- Additive: one nullable internal remark per purchase order line. Existing rows stay NULL.
ALTER TABLE "purchase_order_lines" ADD COLUMN "notes" TEXT;
