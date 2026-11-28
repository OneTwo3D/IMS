/**
 * Per-event FX rates for purchasing: the operator's tools for the supplier-bill exchange-rate difference (lib/domain/purchasing/purchase-bill-fx.ts).
 *
 * Usage:
 *   tsx scripts/purchase-fx-reconcile.ts --in-flight            list the foreign orders billed at the PO rate for goods not received yet (read-only;
 *                                                               the check before turning purchase_event_fx_rates_enabled on). Each order also names
 *                                                               the bills IMS did not post ("no journal: bill not posted by IMS")
 *   tsx scripts/purchase-fx-reconcile.ts [--po <id>]            DRY RUN: per order, the exchange-rate journals --apply would queue, computed inside a
 *                                                               transaction that is rolled back (writes nothing)
 *   tsx scripts/purchase-fx-reconcile.ts [--po <id>] --apply    run the reconciliation now, under each order's row lock: it queues only the
 *                                                               exchange-rate difference that is still owed (idempotent; a second run queues nothing)
 *   tsx scripts/purchase-fx-reconcile.ts --held [--apply]       only the orders with a held journal of a bill posted outside IMS (`held_since` set:
 *                                                               no Xero organisation was connected). Reconnecting Xero does NOT catch them up by
 *                                                               itself; after reconnecting the same organisation, `--held --apply` does, in one run.
 *                                                               Every dry run without --held starts with a banner listing these orders and what each
 *                                                               is still owed (or that a bill is held, already stale, or would go stale now).
 *                                                               --held --apply is refused while no Xero organisation is connected, and while the
 *                                                               connected one is not the one a held bill was confirmed on (a run would make it stale
 *                                                               for good) unless --accept-stale is also given.
 *
 * --po is refused for an order the switch never touched (it is not in the list the reconciliation covers), and together with --held.
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
      for (const bill of order.billsNotPostedByIms) {
        console.log(`    no journal: bill not posted by IMS - bill ${bill.invoiceNumber ?? bill.invoiceId} (its GR/IR is corrected; whether a journal is raised is an open owner decision)`)
      }
    }
    return
  }
  const only = valueOf('po')
  const heldOnly = process.argv.includes('--held')
  if (only && heldOnly) throw new Error('--po and --held cannot be combined: --held runs every order with a held journal.')
  const covered = await fx.purchaseFxOrdersToReconcile(db)
  if (only && !covered.includes(only)) throw new fx.PurchaseFxNotReconcilableError(only)
  const ids = only ? [only] : heldOnly ? await fx.purchaseFxHeldOrders(db) : covered
  const apply = process.argv.includes('--apply')
  if (heldOnly && apply) {
    // #1171 MED-1 / LOW-3: refused with no Xero connection, with an order that could not be checked, and (unless --accept-stale) while a run would
    // make a held confirmation stale through a tenant mismatch.
    const refusal = fx.purchaseFxHeldApplyRefusal(await fx.listPurchaseFxHeldCatchUps(), { acceptStale: process.argv.includes('--accept-stale') })
    if (refusal) throw new Error(`--held --apply refused, nothing was run: ${refusal}`)
  } else if (!apply && !heldOnly) {
    // #1169 LOW-3: orders still owed a held catch-up. Reconnecting Xero does not catch them up by itself. (#1171 LOW-2: not with --held, whose
    // dry run below lists the same orders.)
    const listing = await fx.listPurchaseFxHeldCatchUps()
    if (listing.entries.length > 0) {
      const mismatch = listing.entries.some((entry) => entry.wouldGoStaleTenant.length > 0)
      console.log(`HELD CATCH-UP OWED: ${listing.entries.length} order(s) have a journal of a bill posted outside IMS that was held while no Xero organisation was connected.`)
      console.log('  Reconnecting Xero does not catch them up by itself: the next receipt or return of the order, or another bill\'s change, does, or a reconcile run.')
      if (listing.connectedTenantId === null) console.log('  No Xero organisation is connected now: connect the one the bills were confirmed on, then run `npm run purchase-fx:reconcile -- --held --apply`.')
      else if (mismatch) {
        console.log(`  WARNING: the connected Xero organisation (${listing.connectedTenantId}) is not the one some of these bills were confirmed on (marked "would go stale now").`)
        console.log('  Reconnect the right organisation before any --apply: a run now makes those confirmations stale for good.')
      } else console.log('  Run `npm run purchase-fx:reconcile -- --held --apply` to catch them up (a bill already stale needs `npm run purchase-fx:non-ims-bills`).')
      for (const entry of listing.entries) {
        console.log(`  ${entry.poId}:${entry.owed.map((j) => ` [owed now, bill ${j.invoiceNumber ?? j.invoiceId}: transit ${j.transitDelta}]`).join('')}`
          + `${entry.stillHeld.map((id) => ` [bill ${id} still held: no Xero connection]`).join('')}`
          + `${entry.alreadyStale.map((id) => ` [bill ${id} already stale: confirm it again]`).join('')}`
          + `${entry.wouldGoStaleTenant.map((id) => ` [bill ${id} would go stale now: the connected organisation is not the one it was confirmed on; reconnect the right one before any --apply]`).join('')}`
          + `${entry.wouldGoStaleOther.map((id) => ` [bill ${id} would go stale on the next run: its basis changed; confirm it again]`).join('')}`)
      }
    }
    for (const entry of listing.incomplete) console.log(`  banner incomplete: ${entry.poId} ${entry.error}`)
  }
  console.log(`${apply ? '' : 'DRY RUN (pass --apply to queue; computed in a rolled-back transaction). '}${ids.length} order(s) ${heldOnly ? 'with a held journal' : 'covered'}.`)
  // #1157 LOW-3: one order's failure (an unmapped account, a lock timeout) is reported and the run goes on; the exit code says some failed.
  let failed = 0
  for (const poId of ids) {
    try {
      const result = await fx.rerunPurchaseBillFx(poId, { dryRun: !apply })
      const verb = apply ? 'queued' : 'would be queued'
      console.log(`  ${poId}: ${result.journals.length} journal(s) ${verb}${result.journals.map((j) => ` [bill ${j.invoiceNumber ?? j.invoiceId}: transit ${j.transitDelta}]`).join('')}`
        + `${result.notQueued.length ? `; ${result.notQueued.length} declined (reported)` : ''}${result.shadowed?.length ? `; ${result.shadowed.length} settled as a shadow` : ''}`)
      // #1167 MED-1: confirmations of bills posted outside IMS whose journal is held (after the same Xero organisation is connected again, a reconcile run
      // or the next order event catches it up; reconnecting alone does not)
      // or stale (it needs a new confirmation: npm run purchase-fx:non-ims-bills).
      for (const entry of result.stale ?? []) console.log(`    bill ${entry.invoiceId}: ${entry.held ? 'held: no Xero connection' : 'stale'}: ${entry.reason}`)
    } catch (error) {
      failed += 1
      console.error(`  ${poId}: FAILED: ${error instanceof Error ? error.message : String(error)}. The run may have committed before the error (it reports what the queue declined after committing): check the order with a dry run (--po ${poId}).`)
    }
  }
  if (failed > 0) throw new Error(`${failed} of ${ids.length} order(s) failed (listed above); the others ran.`)
}

main().then(
  () => process.exit(0),
  (error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exit(1) },
)
