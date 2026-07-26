-- o3d-lx1: persist the VAT convention on a purchase order so a supplier requote (submitSupplierQuote)
-- can reapply the header discount in the SAME convention it was created in — a fixed inclusive-VAT
-- discount must not be re-grossed-up as if it were net. Existing rows default to false (net/ex-VAT), the
-- typical purchase-order convention; a store that entered inclusive-VAT prices re-saves the affected RFQ.
ALTER TABLE "purchase_orders" ADD COLUMN "pricesIncludeVat" BOOLEAN NOT NULL DEFAULT false;
