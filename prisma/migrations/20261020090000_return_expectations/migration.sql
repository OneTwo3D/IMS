-- Refund in transit, slice 1: the return-expectation document.
--
-- ADDITIVE ONLY. One new column with a constant default (no table rewrite, no backfill: every existing refund
-- reads false, which is exactly how every build before this one treated it), one enum and two new tables that
-- nothing deployed before this migration reads or writes. Safe to apply to a populated database while the
-- previous build is still serving: that build omits the new column on INSERT and gets the default (false, the
-- legacy restock-at-refund behaviour), and never touches the new tables.
--
-- NOTHING IN THIS MIGRATION TURNS THE FEATURE ON. A refund is routed in transit only while the setting
-- `refund_returns_in_transit_enabled` reads exactly 'true', and no row for it exists.
--
-- The CHECKs below are the document's invariants held by the database rather than by the writers: a quantity
-- can be received or written off at most once in total, and a ledger link is both-or-neither.

-- CreateEnum
CREATE TYPE "ReturnExpectationStatus" AS ENUM ('IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'WRITTEN_OFF', 'PARTIALLY_WRITTEN_OFF');

-- AlterTable
ALTER TABLE "sales_order_refunds" ADD COLUMN     "return_in_transit" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "return_expectations" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "refund_id" TEXT NOT NULL,
    "status" "ReturnExpectationStatus" NOT NULL DEFAULT 'IN_TRANSIT',
    "expected_warehouse_id" TEXT,
    "transit_journal_key" TEXT,
    "transit_debit_base" DECIMAL(18,6),
    "valued_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "return_expectations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_expectation_lines" (
    "id" TEXT NOT NULL,
    "expectation_id" TEXT NOT NULL,
    "refund_line_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "qty" DECIMAL(14,6) NOT NULL,
    "qty_received" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "qty_written_off" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "cost_snapshot" JSONB NOT NULL,
    "transit_value_base" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "return_expectation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "return_expectations_reference_key" ON "return_expectations"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "return_expectations_refund_id_key" ON "return_expectations"("refund_id");

-- CreateIndex
CREATE INDEX "return_expectations_order_id_idx" ON "return_expectations"("order_id");

-- CreateIndex
CREATE INDEX "return_expectations_status_idx" ON "return_expectations"("status");

-- CreateIndex
CREATE INDEX "return_expectation_lines_expectation_id_idx" ON "return_expectation_lines"("expectation_id");

-- CreateIndex
CREATE INDEX "return_expectation_lines_product_id_idx" ON "return_expectation_lines"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "return_expectation_lines_refund_line_id_product_id_key" ON "return_expectation_lines"("refund_line_id", "product_id");

-- AddForeignKey
ALTER TABLE "return_expectations" ADD CONSTRAINT "return_expectations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_expectations" ADD CONSTRAINT "return_expectations_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "sales_order_refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_expectations" ADD CONSTRAINT "return_expectations_expected_warehouse_id_fkey" FOREIGN KEY ("expected_warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_expectation_lines" ADD CONSTRAINT "return_expectation_lines_expectation_id_fkey" FOREIGN KEY ("expectation_id") REFERENCES "return_expectations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_expectation_lines" ADD CONSTRAINT "return_expectation_lines_refund_line_id_fkey" FOREIGN KEY ("refund_line_id") REFERENCES "sales_order_refund_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_expectation_lines" ADD CONSTRAINT "return_expectation_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Document invariants.
ALTER TABLE "return_expectation_lines"
  ADD CONSTRAINT "return_expectation_lines_qty_positive_check" CHECK ("qty" > 0),
  ADD CONSTRAINT "return_expectation_lines_qty_received_check" CHECK ("qty_received" >= 0),
  ADD CONSTRAINT "return_expectation_lines_qty_written_off_check" CHECK ("qty_written_off" >= 0),
  ADD CONSTRAINT "return_expectation_lines_qty_accounted_check" CHECK ("qty_received" + "qty_written_off" <= "qty"),
  ADD CONSTRAINT "return_expectation_lines_transit_value_check" CHECK ("transit_value_base" >= 0);

-- The journal key and the amount it debited are recorded together or not at all.
ALTER TABLE "return_expectations"
  ADD CONSTRAINT "return_expectations_transit_link_check" CHECK (
    ("transit_journal_key" IS NULL) = ("transit_debit_base" IS NULL)
  ),
  ADD CONSTRAINT "return_expectations_transit_debit_check" CHECK ("transit_debit_base" IS NULL OR "transit_debit_base" > 0);
