-- Additive: which customs fields of a variation were inherited from its parent at the last WooCommerce import (empty for every existing row, so nothing is treated as inherited until the next import says so).
ALTER TABLE "products" ADD COLUMN "customsInherited" TEXT[] DEFAULT ARRAY[]::TEXT[];
