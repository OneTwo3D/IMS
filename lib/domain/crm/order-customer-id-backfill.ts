/**
 * BACKFILL of sales_orders.external_customer_id from the WooCommerce order deliveries ALREADY STORED in shopping_webhook_events (CRM foundation).
 *
 * NO WOOCOMMERCE CALL: only payloads IMS already holds are read. For each order that has a storefront order link and no stored customer id, the id comes from the
 * NEWEST stored order delivery for that storefront order whose `customer_id` is a positive integer. Never written: to an erased order (the id names the person's
 * storefront account), over an id already stored, or from a payload with `customer_id` 0 or missing (a guest order or an anonymised delivery).
 *
 * It is raw SQL on purpose: `updatedAt` is NOT touched, because the warehouse push sweep and the storefront mirror treat a raised updatedAt as "the order changed",
 * and this is bookkeeping that must not look like a change. It writes one column on rows it selects by primary key, in batches (one short statement each); the migration itself backfills nothing. The caller records the run in the activity log (scripts/crm-backfill-order-customer-id.ts).
 */
import { Prisma } from '@/app/generated/prisma/client'

type Client = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>

const candidates = (limit?: number) => Prisma.sql`
  SELECT DISTINCT ON (l."orderId") l."orderId" AS "orderId", (w."payloadJson"->>'customer_id')::int AS "customerId"
  FROM "shopping_webhook_events" w
  JOIN "shopping_order_links" l ON l."connector" = 'woocommerce' AND l."externalOrderId" = (w."payloadJson"->>'id')
  JOIN "sales_orders" o ON o."id" = l."orderId" AND o."external_customer_id" IS NULL AND o."erasedAt" IS NULL
  WHERE w."connector" = 'woocommerce' AND w."resource" = 'orders'
    AND jsonb_typeof(w."payloadJson"->'customer_id') = 'number'
    AND (w."payloadJson"->>'customer_id') ~ '^[1-9][0-9]{0,8}$'
  ORDER BY l."orderId", w."receivedAt" DESC, w."id" DESC${limit === undefined ? Prisma.empty : Prisma.sql` LIMIT ${limit}`}`

/** Rows written per statement: each batch is its own short transaction, so the backfill never holds row locks on sales_orders for long. */
export const BACKFILL_BATCH_SIZE = 1000

export interface BackfillCounts {
  /** Orders that would receive (or did receive) a customer id. */
  orders: number
  /** Batches written (0 for a dry run). */
  batches: number
  /**
   * COVERAGE GAP: live orders with a storefront order link and no stored customer id that NO stored delivery can fill (the delivery was pruned, or it never carried
   * a customer id). They stay empty until the order is next imported; nothing can fill them without a WooCommerce call, which this never makes.
   */
  unfillable: number
}

async function countUnfillable(db: Client): Promise<number> {
  const rows = await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*)::bigint AS n FROM "sales_orders" o
    WHERE o."external_customer_id" IS NULL AND o."erasedAt" IS NULL
      AND EXISTS (SELECT 1 FROM "shopping_order_links" l WHERE l."orderId" = o."id" AND l."connector" = 'woocommerce')
      AND NOT EXISTS (
        SELECT 1 FROM "shopping_order_links" l JOIN "shopping_webhook_events" w ON w."connector" = 'woocommerce' AND w."resource" = 'orders' AND (w."payloadJson"->>'id') = l."externalOrderId"
        WHERE l."orderId" = o."id" AND l."connector" = 'woocommerce' AND jsonb_typeof(w."payloadJson"->'customer_id') = 'number' AND (w."payloadJson"->>'customer_id') ~ '^[1-9][0-9]{0,8}$')`
  return Number(rows[0]?.n ?? 0)
}

export async function countBackfillableOrders(db: Client): Promise<BackfillCounts> {
  const rows = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM (${candidates()}) c`
  return { orders: Number(rows[0]?.n ?? 0), batches: 0, unfillable: await countUnfillable(db) }
}

/**
 * Write the ids in batches of BACKFILL_BATCH_SIZE. The caller passes the plain client, NOT one transaction: each statement commits on its own. A batch is selected
 * by the same predicate as the dry run (an order that has received its id drops out of it), so the loop ends when nothing is left, and a re-run after an
 * interruption continues where it stopped.
 */
export async function applyOrderCustomerIdBackfill(db: Client, options: { batchSize?: number } = {}): Promise<BackfillCounts> {
  const batchSize = options.batchSize ?? BACKFILL_BATCH_SIZE
  let orders = 0
  let batches = 0
  for (;;) {
    const written = await db.$executeRaw`
      UPDATE "sales_orders" o SET "external_customer_id" = c."customerId"
      FROM (${candidates(batchSize)}) c
      WHERE o."id" = c."orderId" AND o."external_customer_id" IS NULL AND o."erasedAt" IS NULL`
    if (written === 0) break
    orders += written
    batches += 1
  }
  return { orders, batches, unfillable: await countUnfillable(db) }
}
