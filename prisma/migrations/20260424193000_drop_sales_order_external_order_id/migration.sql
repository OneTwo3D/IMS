-- Migrate any post-groundwork WooCommerce provenance into the connector-scoped
-- order link table before removing the legacy global sales_orders column.
INSERT INTO "shopping_order_links" (
  "id",
  "orderId",
  "connector",
  "externalOrderId",
  "externalOrderNumber",
  "createdAt",
  "updatedAt"
)
SELECT
  'sol_' || md5(so."id" || ':woocommerce'),
  so."id",
  'woocommerce',
  so."externalOrderId"::text,
  so."externalOrderNumber",
  now(),
  now()
FROM "sales_orders" so
WHERE so."externalOrderId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "shopping_order_links" existing
    WHERE existing."connector" = 'woocommerce'
      AND (
        existing."orderId" = so."id"
        OR existing."externalOrderId" = so."externalOrderId"::text
      )
  )
ON CONFLICT ("connector", "externalOrderId") DO NOTHING;

DROP INDEX IF EXISTS "sales_orders_externalOrderId_idx";
DROP INDEX IF EXISTS "sales_orders_externalOrderId_key";

ALTER TABLE "sales_orders"
  DROP COLUMN IF EXISTS "externalOrderId";
