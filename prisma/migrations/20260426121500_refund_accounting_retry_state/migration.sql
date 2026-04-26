ALTER TABLE "sales_order_refunds"
  ADD COLUMN IF NOT EXISTS "accounting_retry_required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "accounting_warning" TEXT;

ALTER TABLE "sales_order_refund_lines"
  ADD COLUMN IF NOT EXISTS "sales_order_line_id" TEXT;

CREATE INDEX IF NOT EXISTS "sales_order_refund_lines_sales_order_line_id_idx"
  ON "sales_order_refund_lines"("sales_order_line_id");

DO $$
BEGIN
  ALTER TABLE "sales_order_refund_lines"
    ADD CONSTRAINT "sales_order_refund_lines_sales_order_line_id_fkey"
    FOREIGN KEY ("sales_order_line_id")
    REFERENCES "sales_order_lines"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
