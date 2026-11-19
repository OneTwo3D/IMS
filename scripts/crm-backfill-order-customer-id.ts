/**
 * Fill sales_orders.external_customer_id from the WooCommerce order deliveries already stored in IMS (CRM foundation). DRY RUN by default: it only COUNTS.
 * Pass `--apply` to write. It never calls WooCommerce, never touches an erased order, never overwrites a stored id, and does not raise `updatedAt`.
 * Prints counts only.
 *
 *   runuser -u ims -- env HOME=/tmp npx tsx scripts/crm-backfill-order-customer-id.ts [--apply]
 */
import { db } from '@/lib/db'
import { applyOrderCustomerIdBackfill, countBackfillableOrders } from '@/lib/domain/crm/order-customer-id-backfill'

async function main() {
  const apply = process.argv.includes('--apply')
  const counts = await db.$transaction(async (tx) => (apply ? applyOrderCustomerIdBackfill(tx) : countBackfillableOrders(tx)), { timeout: 600_000, maxWait: 20_000 })
  console.log(`${apply ? 'Backfilled' : 'Would backfill'} the storefront customer id on ${counts.orders} order(s) from stored deliveries.${apply ? '' : ' Nothing was written (pass --apply).'}`)
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : 'backfill failed')
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
