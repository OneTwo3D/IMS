-- Erasure marker on sales orders: set when an order's personal data has been erased, and checked by the inbound importers so a later sync cannot write identity columns back.
--
-- ADDITIVE ONLY: one nullable column, no default, no backfill. A NULL reads as "not erased", which is every existing row's truth.

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN "erasedAt" TIMESTAMP(3);
