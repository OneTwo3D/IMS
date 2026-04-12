-- Add new PO statuses and tracking fields
ALTER TYPE "PurchaseOrderStatus" ADD VALUE IF NOT EXISTS 'QUOTE_RECEIVED';
ALTER TYPE "PurchaseOrderStatus" ADD VALUE IF NOT EXISTS 'SHIPPED';
ALTER TYPE "PurchaseOrderStatus" ADD VALUE IF NOT EXISTS 'CLOSED';

-- Add tracking fields to purchase orders
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "trackingNumber" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "shippingProvider" TEXT;

-- Fix FK constraint (from diff)
ALTER TABLE "purchase_invoice_lines" DROP CONSTRAINT IF EXISTS "purchase_invoice_lines_poLineId_fkey";
ALTER TABLE "purchase_invoice_lines" ADD CONSTRAINT "purchase_invoice_lines_poLineId_fkey" FOREIGN KEY ("poLineId") REFERENCES "purchase_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
