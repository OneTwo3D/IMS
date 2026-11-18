-- A tag on a purchase-order cost line: SHIPPING marks the buyer's own shipping estimate, which a supplier-quoted shipping replaces
-- (setting supplier_quote_shipping_landed_enabled). ADDITIVE ONLY: a new enum and a nullable column with no default and no backfill
-- (every existing line stays untagged and is never replaced).
CREATE TYPE "FreightCostKind" AS ENUM ('SHIPPING');
ALTER TABLE "freight_cost_lines" ADD COLUMN "kind" "FreightCostKind";
