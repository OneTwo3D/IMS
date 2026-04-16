-- Add missing indexes on foreign key columns for query performance

-- Auth tables
CREATE INDEX IF NOT EXISTS "passkeys_userId_idx" ON "passkeys"("userId");
CREATE INDEX IF NOT EXISTS "sessions_userId_idx" ON "sessions"("userId");

-- Purchase order lines
CREATE INDEX IF NOT EXISTS "purchase_order_lines_poId_idx" ON "purchase_order_lines"("poId");
CREATE INDEX IF NOT EXISTS "purchase_order_lines_productId_idx" ON "purchase_order_lines"("productId");

-- Purchase receipt lines
CREATE INDEX IF NOT EXISTS "purchase_receipt_lines_receiptId_idx" ON "purchase_receipt_lines"("receiptId");
CREATE INDEX IF NOT EXISTS "purchase_receipt_lines_poLineId_idx" ON "purchase_receipt_lines"("poLineId");

-- Purchase invoices
CREATE INDEX IF NOT EXISTS "purchase_invoices_poId_idx" ON "purchase_invoices"("poId");

-- Purchase invoice lines
CREATE INDEX IF NOT EXISTS "purchase_invoice_lines_invoiceId_idx" ON "purchase_invoice_lines"("invoiceId");
CREATE INDEX IF NOT EXISTS "purchase_invoice_lines_poLineId_idx" ON "purchase_invoice_lines"("poLineId");

-- Purchase return lines
CREATE INDEX IF NOT EXISTS "purchase_return_lines_returnId_idx" ON "purchase_return_lines"("returnId");
CREATE INDEX IF NOT EXISTS "purchase_return_lines_poLineId_idx" ON "purchase_return_lines"("poLineId");

-- Sales order lines
CREATE INDEX IF NOT EXISTS "sales_order_lines_orderId_idx" ON "sales_order_lines"("orderId");
CREATE INDEX IF NOT EXISTS "sales_order_lines_productId_idx" ON "sales_order_lines"("productId");

-- Sales order refunds
CREATE INDEX IF NOT EXISTS "sales_order_refunds_orderId_idx" ON "sales_order_refunds"("orderId");

-- Sales order refund lines
CREATE INDEX IF NOT EXISTS "sales_order_refund_lines_refundId_idx" ON "sales_order_refund_lines"("refundId");
CREATE INDEX IF NOT EXISTS "sales_order_refund_lines_productId_idx" ON "sales_order_refund_lines"("productId");

-- Payments
CREATE INDEX IF NOT EXISTS "payments_orderId_idx" ON "payments"("orderId");
CREATE INDEX IF NOT EXISTS "payments_refundId_idx" ON "payments"("refundId");

-- Stock transfers
CREATE INDEX IF NOT EXISTS "stock_transfers_fromWarehouseId_idx" ON "stock_transfers"("fromWarehouseId");
CREATE INDEX IF NOT EXISTS "stock_transfers_toWarehouseId_idx" ON "stock_transfers"("toWarehouseId");

-- Stock transfer lines
CREATE INDEX IF NOT EXISTS "stock_transfer_lines_transferId_idx" ON "stock_transfer_lines"("transferId");

-- Stock counts
CREATE INDEX IF NOT EXISTS "stock_counts_warehouseId_idx" ON "stock_counts"("warehouseId");

-- Stock count lines
CREATE INDEX IF NOT EXISTS "stock_count_lines_countId_idx" ON "stock_count_lines"("countId");
CREATE INDEX IF NOT EXISTS "stock_count_lines_productId_idx" ON "stock_count_lines"("productId");

-- BOM items
CREATE INDEX IF NOT EXISTS "bom_items_bomId_idx" ON "bom_items"("bomId");
CREATE INDEX IF NOT EXISTS "bom_items_parentProductId_idx" ON "bom_items"("parentProductId");
CREATE INDEX IF NOT EXISTS "bom_items_componentProductId_idx" ON "bom_items"("componentProductId");

-- Kit items
CREATE INDEX IF NOT EXISTS "kit_items_kitId_idx" ON "kit_items"("kitId");
CREATE INDEX IF NOT EXISTS "kit_items_parentProductId_idx" ON "kit_items"("parentProductId");
CREATE INDEX IF NOT EXISTS "kit_items_componentProductId_idx" ON "kit_items"("componentProductId");
