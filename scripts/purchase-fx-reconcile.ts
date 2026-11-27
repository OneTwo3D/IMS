/**
 * Per-event FX rates for purchasing: the operator's tools for the supplier-bill exchange-rate difference (lib/domain/purchasing/purchase-bill-fx.ts).
 *
 * Usage:
 *   tsx scripts/purchase-fx-reconcile.ts --in-flight            list the foreign orders billed at the PO rate for goods not received yet (read-only;
 *                                                               the check before turning purchase_event_fx_rates_enabled on)
 *   tsx scripts/purchase-fx-reconcile.ts [--po <id>]            show which orders the reconciliation covers (read-only)
 *   tsx scripts/purchase-fx-reconcile.ts [--po <id>] --apply    run the reconciliation now, under each order's row lock: it queues only the
 *                                                               exchange-rate difference that is still owed (idempotent; a second run queues nothing)
 *
 * The journals it queues go through the normal accounting queue (and so to Xero only while Xero sync is on). Never key the same journal into the
 * ledger by hand as well: it would be booked twice.
 */
import { config } from 'dotenv'

// .env MUST load before lib/db is imported: that module builds its pg Pool from process.env.DATABASE_URL at IMPORT time.
config({ path: '.env.local', quiet: true })
config({ quiet: true })

function valueOf(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const { db } = await import('../lib/db')
  const fx = await import('../lib/domain/purchasing/purchase-bill-fx')
  if (process.argv.includes('--in-flight')) {
    const orders = await fx.listPurchaseFxInFlightOrders(db)
    console.log(`${orders.length} foreign order(s) billed at the PO rate for goods not received yet:`)
    for (const order of orders) {
      console.log(`  ${order.reference} (${order.currency}, ${order.status}): ${order.lines.map((l) => `line ${l.poLineId} billed ${l.billedQty}, received ${l.receivedQty}`).join('; ')}`)
    }
    return
  }
  const only = valueOf('po')
  const ids = only ? [only] : await fx.purchaseFxOrdersToReconcile(db)
  const apply = process.argv.includes('--apply')
  console.log(`${apply ? '' : 'DRY RUN (pass --apply to queue). '}${ids.length} order(s) covered.`)
  for (const poId of ids) {
    if (!apply) { console.log(`  ${poId}`); continue }
    const result = await fx.rerunPurchaseBillFx(poId)
    console.log(`  ${poId}: ${result.journals.length} journal(s) queued${result.journals.map((j) => ` [bill ${j.invoiceId}: transit ${j.transitDelta}]`).join('')}${result.notQueued.length ? `; ${result.notQueued.length} declined (reported)` : ''}`)
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exit(1) },
)
