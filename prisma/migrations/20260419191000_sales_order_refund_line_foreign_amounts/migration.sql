ALTER TABLE "sales_order_refund_lines"
ADD COLUMN "unitPriceForeign" DECIMAL(18, 6) NOT NULL DEFAULT 0,
ADD COLUMN "totalForeign" DECIMAL(18, 4) NOT NULL DEFAULT 0;

UPDATE "sales_order_refund_lines"
SET
  "unitPriceForeign" = "unitPriceBase",
  "totalForeign" = "totalBase"
WHERE "unitPriceForeign" = 0
  AND "totalForeign" = 0;
