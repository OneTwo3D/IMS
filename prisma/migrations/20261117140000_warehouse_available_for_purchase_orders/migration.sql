-- Additive: one boolean on warehouses, default true, so every existing warehouse stays selectable for purchase orders and receipts.
ALTER TABLE "warehouses" ADD COLUMN "availableForPurchaseOrders" BOOLEAN NOT NULL DEFAULT true;
