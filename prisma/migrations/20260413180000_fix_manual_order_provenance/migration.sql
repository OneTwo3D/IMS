-- Backfill: clear externalOrderNumber on manual orders that were incorrectly stamped.
-- Manual orders have no externalOrderId (null) but had externalOrderNumber set to the
-- generated reference. Copy externalOrderNumber → orderNumber where orderNumber is
-- still null, then clear externalOrderNumber so the allocator no longer treats them
-- as WooCommerce orders.

-- Step 1: Copy externalOrderNumber to orderNumber for manual orders that lack one
UPDATE sales_orders
SET    "orderNumber" = "externalOrderNumber"
WHERE  "externalOrderId" IS NULL
  AND  "externalOrderNumber" IS NOT NULL
  AND  "orderNumber" IS NULL;

-- Step 2: Clear externalOrderNumber on all manual orders
UPDATE sales_orders
SET    "externalOrderNumber" = NULL
WHERE  "externalOrderId" IS NULL
  AND  "externalOrderNumber" IS NOT NULL;

-- Step 3: Normalize default warehouse — only DEFAULT should be the default.
-- EAR2 was accidentally marked isDefault=true creating nondeterministic behaviour.
UPDATE warehouses
SET    "isDefault" = false
WHERE  code != 'DEFAULT'
  AND  "isDefault" = true;
