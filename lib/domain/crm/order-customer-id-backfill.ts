/**
 * BACKFILL of sales_orders.external_customer_id from the WooCommerce order deliveries ALREADY STORED in shopping_webhook_events (CRM foundation).
 *
 * NO WOOCOMMERCE CALL: only payloads IMS already holds are read. For each order that has a storefront order link and no stored customer id, the id comes from the
 * NEWEST stored order delivery for that storefront order whose `customer_id` is a positive integer. Never written: to an erased order (the id names the person's
 * storefront account), over an id already stored, or from a payload with `customer_id` 0 or missing (a guest order or an anonymised delivery).
 *
 * It is raw SQL on purpose: `updatedAt` is NOT touched, because the warehouse push sweep and the storefront mirror treat a raised updatedAt as "the order changed",
 * and this is bookkeeping that must not look like a change. It writes one column on rows it selects by primary key; the migration itself backfills nothing.
 */
import { Prisma } from '@/app/generated/prisma/client'

type Client = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>

const CANDIDATES = Prisma.sql`
  SELECT DISTINCT ON (l."orderId") l."orderId" AS "orderId", (w."payloadJson"->>'customer_id')::int AS "customerId"
  FROM "shopping_webhook_events" w
  JOIN "shopping_order_links" l ON l."connector" = 'woocommerce' AND l."externalOrderId" = (w."payloadJson"->>'id')
  JOIN "sales_orders" o ON o."id" = l."orderId" AND o."external_customer_id" IS NULL AND o."erasedAt" IS NULL
  WHERE w."connector" = 'woocommerce' AND w."resource" = 'orders'
    AND jsonb_typeof(w."payloadJson"->'customer_id') = 'number'
    AND (w."payloadJson"->>'customer_id') ~ '^[1-9][0-9]{0,8}$'
  ORDER BY l."orderId", w."receivedAt" DESC, w."id" DESC`

export interface BackfillCounts {
  /** Orders that would receive (or did receive) a customer id. */
  orders: number
}

export async function countBackfillableOrders(db: Client): Promise<BackfillCounts> {
  const rows = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM (${CANDIDATES}) c`
  return { orders: Number(rows[0]?.n ?? 0) }
}

export async function applyOrderCustomerIdBackfill(db: Client): Promise<BackfillCounts> {
  const orders = await db.$executeRaw`
    UPDATE "sales_orders" o SET "external_customer_id" = c."customerId"
    FROM (${CANDIDATES}) c
    WHERE o."id" = c."orderId" AND o."external_customer_id" IS NULL AND o."erasedAt" IS NULL`
  return { orders }
}
