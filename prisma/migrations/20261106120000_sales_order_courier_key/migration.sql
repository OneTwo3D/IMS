-- Language-independent courier key and the shipping method id, mirrored from the storefront's first shipping line. ADDITIVE ONLY: two nullable columns, no default, nothing reads them but the warehouse push, which falls back to the shipping label when they are null.

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN "courier_key" TEXT,
ADD COLUMN "shipping_method_id" TEXT;

-- AlterTable
ALTER TABLE "wms_order_push_links" ADD COLUMN "courierForm" TEXT,
ADD COLUMN "courierFormName" TEXT;
