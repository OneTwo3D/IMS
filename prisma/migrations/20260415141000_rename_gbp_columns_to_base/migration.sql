DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'salesPriceGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'salesPriceBase'
  ) THEN
    ALTER TABLE "products" RENAME COLUMN "salesPriceGbp" TO "salesPriceBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'salePriceGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'salePriceBase'
  ) THEN
    ALTER TABLE "products" RENAME COLUMN "salePriceGbp" TO "salePriceBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cost_layers' AND column_name = 'unitCostGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cost_layers' AND column_name = 'unitCostBase'
  ) THEN
    ALTER TABLE "cost_layers" RENAME COLUMN "unitCostGbp" TO "unitCostBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cogs_entries' AND column_name = 'unitCostGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cogs_entries' AND column_name = 'unitCostBase'
  ) THEN
    ALTER TABLE "cogs_entries" RENAME COLUMN "unitCostGbp" TO "unitCostBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cogs_entries' AND column_name = 'totalCostGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cogs_entries' AND column_name = 'totalCostBase'
  ) THEN
    ALTER TABLE "cogs_entries" RENAME COLUMN "totalCostGbp" TO "totalCostBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND column_name = 'fxRateToGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND column_name = 'fxRateToBase'
  ) THEN
    ALTER TABLE "purchase_orders" RENAME COLUMN "fxRateToGbp" TO "fxRateToBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND column_name = 'subtotalGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND column_name = 'subtotalBase'
  ) THEN
    ALTER TABLE "purchase_orders" RENAME COLUMN "subtotalGbp" TO "subtotalBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND column_name = 'taxGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND column_name = 'taxBase'
  ) THEN
    ALTER TABLE "purchase_orders" RENAME COLUMN "taxGbp" TO "taxBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND column_name = 'totalGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND column_name = 'totalBase'
  ) THEN
    ALTER TABLE "purchase_orders" RENAME COLUMN "totalGbp" TO "totalBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND column_name = 'directFreightGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND column_name = 'directFreightBase'
  ) THEN
    ALTER TABLE "purchase_orders" RENAME COLUMN "directFreightGbp" TO "directFreightBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_order_lines' AND column_name = 'unitCostGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_order_lines' AND column_name = 'unitCostBase'
  ) THEN
    ALTER TABLE "purchase_order_lines" RENAME COLUMN "unitCostGbp" TO "unitCostBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_order_lines' AND column_name = 'taxGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_order_lines' AND column_name = 'taxBase'
  ) THEN
    ALTER TABLE "purchase_order_lines" RENAME COLUMN "taxGbp" TO "taxBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_order_lines' AND column_name = 'totalGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_order_lines' AND column_name = 'totalBase'
  ) THEN
    ALTER TABLE "purchase_order_lines" RENAME COLUMN "totalGbp" TO "totalBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_order_lines' AND column_name = 'landedUnitCostGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_order_lines' AND column_name = 'landedUnitCostBase'
  ) THEN
    ALTER TABLE "purchase_order_lines" RENAME COLUMN "landedUnitCostGbp" TO "landedUnitCostBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'freight_cost_lines' AND column_name = 'amountGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'freight_cost_lines' AND column_name = 'amountBase'
  ) THEN
    ALTER TABLE "freight_cost_lines" RENAME COLUMN "amountGbp" TO "amountBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_invoices' AND column_name = 'fxRateToGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_invoices' AND column_name = 'fxRateToBase'
  ) THEN
    ALTER TABLE "purchase_invoices" RENAME COLUMN "fxRateToGbp" TO "fxRateToBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_invoices' AND column_name = 'subtotalGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_invoices' AND column_name = 'subtotalBase'
  ) THEN
    ALTER TABLE "purchase_invoices" RENAME COLUMN "subtotalGbp" TO "subtotalBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_invoices' AND column_name = 'taxGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_invoices' AND column_name = 'taxBase'
  ) THEN
    ALTER TABLE "purchase_invoices" RENAME COLUMN "taxGbp" TO "taxBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_invoices' AND column_name = 'totalGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_invoices' AND column_name = 'totalBase'
  ) THEN
    ALTER TABLE "purchase_invoices" RENAME COLUMN "totalGbp" TO "totalBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_invoice_lines' AND column_name = 'totalGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_invoice_lines' AND column_name = 'totalBase'
  ) THEN
    ALTER TABLE "purchase_invoice_lines" RENAME COLUMN "totalGbp" TO "totalBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'fxRateToGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'fxRateToBase'
  ) THEN
    ALTER TABLE "sales_orders" RENAME COLUMN "fxRateToGbp" TO "fxRateToBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'subtotalGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'subtotalBase'
  ) THEN
    ALTER TABLE "sales_orders" RENAME COLUMN "subtotalGbp" TO "subtotalBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'shippingGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'shippingBase'
  ) THEN
    ALTER TABLE "sales_orders" RENAME COLUMN "shippingGbp" TO "shippingBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'taxGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'taxBase'
  ) THEN
    ALTER TABLE "sales_orders" RENAME COLUMN "taxGbp" TO "taxBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'totalGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'totalBase'
  ) THEN
    ALTER TABLE "sales_orders" RENAME COLUMN "totalGbp" TO "totalBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_order_lines' AND column_name = 'unitPriceGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_order_lines' AND column_name = 'unitPriceBase'
  ) THEN
    ALTER TABLE "sales_order_lines" RENAME COLUMN "unitPriceGbp" TO "unitPriceBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_order_lines' AND column_name = 'taxGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_order_lines' AND column_name = 'taxBase'
  ) THEN
    ALTER TABLE "sales_order_lines" RENAME COLUMN "taxGbp" TO "taxBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_order_lines' AND column_name = 'totalGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_order_lines' AND column_name = 'totalBase'
  ) THEN
    ALTER TABLE "sales_order_lines" RENAME COLUMN "totalGbp" TO "totalBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_order_lines' AND column_name = 'cogsGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_order_lines' AND column_name = 'cogsBase'
  ) THEN
    ALTER TABLE "sales_order_lines" RENAME COLUMN "cogsGbp" TO "cogsBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_order_refunds' AND column_name = 'totalGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_order_refunds' AND column_name = 'totalBase'
  ) THEN
    ALTER TABLE "sales_order_refunds" RENAME COLUMN "totalGbp" TO "totalBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_order_refund_lines' AND column_name = 'unitPriceGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_order_refund_lines' AND column_name = 'unitPriceBase'
  ) THEN
    ALTER TABLE "sales_order_refund_lines" RENAME COLUMN "unitPriceGbp" TO "unitPriceBase";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_order_refund_lines' AND column_name = 'totalGbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_order_refund_lines' AND column_name = 'totalBase'
  ) THEN
    ALTER TABLE "sales_order_refund_lines" RENAME COLUMN "totalGbp" TO "totalBase";
  END IF;
END $$;
