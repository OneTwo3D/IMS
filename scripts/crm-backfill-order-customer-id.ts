/**
 * Fill sales_orders.external_customer_id from the WooCommerce order deliveries already stored in IMS (CRM foundation). DRY RUN by default: it only COUNTS.
 * Pass `--apply` to write. It never calls WooCommerce, never touches an erased order, never overwrites a stored id, and does not raise `updatedAt`.
 * Prints counts only.
 *
 *   runuser -u ims -- env HOME=/tmp npx tsx scripts/crm-backfill-order-customer-id.ts [--apply]
 */
import { db } from '@/lib/db'
import { logActivityInTransaction } from '@/lib/activity-log'
import { applyOrderCustomerIdBackfill, countBackfillableOrders } from '@/lib/domain/crm/order-customer-id-backfill'

async function main() {
  const apply = process.argv.includes('--apply')
  // The dry run is one read-only count; the apply writes in batches on the plain client (each batch commits by itself) and then writes ONE audit entry (counts only).
  const counts = apply ? await applyOrderCustomerIdBackfill(db) : await countBackfillableOrders(db)
  if (apply) {
    await logActivityInTransaction(db, {
      entityType: 'SYSTEM',
      tag: 'sales',
      action: 'crm_order_customer_id_backfilled',
      description: 'Storefront customer id backfilled onto orders from stored deliveries',
      metadata: { orders: counts.orders, batches: counts.batches, unfillable: counts.unfillable },
      userId: null,
    })
  }
  console.log(`${apply ? 'Backfilled' : 'Would backfill'} the storefront customer id on ${counts.orders} order(s) from stored deliveries${apply ? ` in ${counts.batches} batch(es)` : ''}.${apply ? '' : ' Nothing was written (pass --apply).'}`)
  console.log(`${counts.unfillable} live order(s) with a storefront link have no stored delivery that carries a customer id: they stay empty until next imported (this script never calls WooCommerce).`)
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : 'backfill failed')
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
