import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { loadEnv, uid } from './po-landed-fixtures'

/**
 * THE ORDER WRITERS LOCK THE ACTIVE RATE THEIR HEADER NAMES (SalesOrder.taxRateName), against a real database. The tax import's deactivateAbsent holds the rate FOR UPDATE while it re-counts
 * the orders naming it; a writer that did not lock the named rate could commit an order after that re-count. Here the deactivation's lock is played by a transaction holding the rate FOR UPDATE:
 *
 *   (The lines carry another rate, so only the header names the rate under test.)
 *   createSalesOrder   waits for it (does not complete while the rate is held); when the holder deactivates the rate and commits, the order is REFUSED (not saved naming a deactivated rate);
 *                      when the holder commits without deactivating, the order is saved.
 *   cloneSalesOrder    waits for it the same way, then clones the source order's header name.
 * Mutations: the lock removed from createSalesOrder (it completes while the rate is held: first arm red); the "found active before, gone now" refusal removed (the order is saved naming a deactivated
 * rate: second arm red); the lock removed from cloneSalesOrder (the clone arm is red).
 * (The WooCommerce order import's lock is pinned by the census in tests/tax/sales-order-tax-rate-name-writers-census.test.ts.)
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

test('createSalesOrder and cloneSalesOrder wait for a transaction holding the named rate; a deactivation that commits first refuses the order, a plain release lets it through', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { createSalesOrder, cloneSalesOrder } = await import('@/app/actions/sales')
  const tag = uid()
  const product = await db.product.create({ data: { sku: `NRL-${tag}`, name: 'named rate lock', type: 'SIMPLE' }, select: { id: true, sku: true } })
  const rateName = `ZQNRL${tag} rate`
  const rate = await db.taxRate.create({ data: { name: rateName, rate: '0.2', usedFor: 'SALES', active: true }, select: { id: true } })
  // The lines carry ANOTHER rate: only the header names the rate under test (the case the line-level share locks never covered).
  const lineRate = await db.taxRate.create({ data: { name: `ZQNRL${tag} line rate`, rate: '0.05', usedFor: 'SALES', active: true }, select: { id: true } })
  t.after(async () => {
    const orders = (await db.salesOrder.findMany({ where: { OR: [{ externalOrderNumber: { startsWith: `NRL${tag}` } }, { taxRateName: rateName }] }, select: { id: true } })).map((r) => r.id)
    await db.salesOrderLine.deleteMany({ where: { orderId: { in: orders } } })
    await db.salesOrder.deleteMany({ where: { id: { in: orders } } })
    await db.taxRate.deleteMany({ where: { id: { in: [rate.id, lineRate.id] } } })
    await db.product.deleteMany({ where: { id: product.id } })
  })
  const input = (key: string) => ({ externalOrderNumber: `NRL${tag}-${key}`, customerName: 'Named rate customer', currency: 'GBP', taxRateName: rateName, taxRateValue: 0.2, isDraft: true, lines: [{ productId: product.id, sku: product.sku, description: 'x', qty: 1, unitPriceForeign: 10, taxRateId: lineRate.id }] })

  /** A transaction that holds the rate FOR UPDATE (what deactivateAbsent's lock does) until released; `deactivate` switches it off in that same transaction. */
  const holdRate = async (deactivate: boolean) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let held!: () => void
    const heldFirst = new Promise<void>((resolve) => { held = resolve })
    const tx = db.$transaction(async (inner) => {
      await inner.$queryRaw`SELECT id FROM tax_rates WHERE id = ${rate.id} FOR UPDATE`
      held()
      await gate
      if (deactivate) await inner.$executeRaw`UPDATE tax_rates SET active = false WHERE id = ${rate.id}`
    })
    await heldFirst
    return { release, done: tx }
  }
  const waitingOn = async <T>(promise: Promise<T>): Promise<{ settled: () => boolean }> => {
    let settled = false
    void promise.then(() => { settled = true }, () => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    return { settled: () => settled }
  }

  // (1) Deactivation committed while the writer waited: the order is refused, nothing is saved naming the rate.
  const deactivating = await holdRate(true)
  const refused = createSalesOrder(input('deactivated') as never)
  const w1 = await waitingOn(refused)
  assert.equal(w1.settled(), false, 'createSalesOrder waits for the transaction that holds the named rate')
  deactivating.release()
  await deactivating.done
  const result = await refused
  assert.equal(result.success, false)
  assert.match(String(result.error), /deactivated/, 'refused, naming the cause')
  assert.equal(await db.salesOrder.count({ where: { externalOrderNumber: `NRL${tag}-deactivated` } }), 0, 'no order was saved naming a rate that was switched off')

  // (2) Control: the holder releases without deactivating, the order is saved with the name. (Reactivate the rate first.)
  await db.taxRate.update({ where: { id: rate.id }, data: { active: true } })
  const plain = await holdRate(false)
  const saved = createSalesOrder(input('plain') as never)
  const w2 = await waitingOn(saved)
  assert.equal(w2.settled(), false, 'createSalesOrder waits')
  plain.release()
  await plain.done
  const ok = await saved
  assert.equal(ok.success, true, String(ok.error))
  const order = await db.salesOrder.findFirstOrThrow({ where: { externalOrderNumber: `NRL${tag}-plain` }, select: { id: true, taxRateName: true } })
  assert.equal(order.taxRateName, rateName)

  // (3) The clone locks the rate its copied header names.
  const cloneHold = await holdRate(false)
  const cloned = cloneSalesOrder(order.id)
  const w3 = await waitingOn(cloned)
  assert.equal(w3.settled(), false, 'cloneSalesOrder waits for the transaction that holds the named rate')
  cloneHold.release()
  await cloneHold.done
  const clone = await cloned
  assert.equal(clone.success, true, String(clone.error))
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: clone.newId! } })).taxRateName, rateName)
})
