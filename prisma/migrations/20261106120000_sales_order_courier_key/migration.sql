-- Language-independent courier key mirrored from the storefront's first shipping line. ADDITIVE ONLY: one nullable column, no default, nothing reads it but the warehouse push, which falls back to the shipping label when it is null.

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN "courier_key" TEXT;
