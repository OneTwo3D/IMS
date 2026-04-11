-- Add pricesIncludeVat flag to sales_orders so the UI can render gross
-- vs net consistently and the accounting connector can post inclusive
-- line amounts without re-inferring from line totals.
ALTER TABLE "sales_orders"
  ADD COLUMN "pricesIncludeVat" BOOLEAN NOT NULL DEFAULT false;
