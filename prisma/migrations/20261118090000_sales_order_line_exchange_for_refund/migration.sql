-- Additive: the refund a replacement line stands in for (an exchange recorded during a return). Nullable, no default, no backfill: every existing line is an ordinary sale line.
ALTER TABLE "sales_order_lines" ADD COLUMN "exchange_for_refund_id" TEXT;

-- CreateIndex
CREATE INDEX "sales_order_lines_exchange_for_refund_id_idx" ON "sales_order_lines"("exchange_for_refund_id");

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_exchange_for_refund_id_fkey" FOREIGN KEY ("exchange_for_refund_id") REFERENCES "sales_order_refunds"("id") ON DELETE SET NULL ON UPDATE CASCADE;
