-- G6b (vn92.6): capture the customer-entered VAT/IOSS number from the storefront so
-- it can be sent to the WMS for customs declarations (plugin parity).
ALTER TABLE "sales_orders" ADD COLUMN "customerVatNumber" TEXT;
