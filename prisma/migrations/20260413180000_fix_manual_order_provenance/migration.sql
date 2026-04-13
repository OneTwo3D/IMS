-- Backfill: clear wcOrderNumber on manual orders that were incorrectly stamped.
-- Manual orders have no wcOrderId (null) but had wcOrderNumber set to the
-- generated reference. Copy wcOrderNumber → orderNumber where orderNumber is
-- still null, then clear wcOrderNumber so the allocator no longer treats them
-- as WooCommerce orders.

-- Step 1: Copy wcOrderNumber to orderNumber for manual orders that lack one
UPDATE sales_orders
SET    "orderNumber" = "wcOrderNumber"
WHERE  "wcOrderId" IS NULL
  AND  "wcOrderNumber" IS NOT NULL
  AND  "orderNumber" IS NULL;

-- Step 2: Clear wcOrderNumber on all manual orders
UPDATE sales_orders
SET    "wcOrderNumber" = NULL
WHERE  "wcOrderId" IS NULL
  AND  "wcOrderNumber" IS NOT NULL;

-- Step 3: Normalize default warehouse — only DEFAULT should be the default.
-- EAR2 was accidentally marked isDefault=true creating nondeterministic behaviour.
UPDATE warehouses
SET    "isDefault" = false
WHERE  code != 'DEFAULT'
  AND  "isDefault" = true;
