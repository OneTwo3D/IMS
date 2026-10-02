import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-nrl4 PR A — NO POOLED CLIENT INSIDE THE REVALUATION TRANSACTIONS (the o3d-5qad5 nested-pool lesson).
 *
 * `@/lib/db` is replaced by a Proxy over the real client. Outside a transaction it is transparent.
 * `db.$transaction(fn)` is wrapped so that, for the whole life of `fn`, ANY property access on the pooled
 * client is RECORDED and THROWS: inside an interactive transaction the only legitimate client is the `tx`
 * it was handed, so a `db.something` there would take a SECOND pooled connection while this one is held
 * (and under load, with every connection held by a waiting transaction, exhaust the pool).
 *
 * It is a separate file because a module mock of `@/lib/db` is process-wide; the other arms must not run
 * under it.
 *
 * Each of the three production callers is driven through its REAL entry point, so the trap covers
 * everything inside THEIR transaction (the scope lock, the recalculation, the outbox write), not a helper
 * in isolation:
 *   updateFreightPoCosts, createFreightPo, cancelPurchaseOrderService (a FREIGHT order).
 *
 * THE TRAP MUST BE ABLE TO FAIL (control arm): a pooled read made inside a `db.$transaction` callback is
 * recorded and throws, and the proof is printed.
 *
 * WHAT THIS DOES NOT COVER, listed: `refreshShipmentCogsForCostLayerChange` (lib/cost-layers.ts) resolves
 * the accounting chart with the pooled `getAccountingSettings()` when a revalued layer has a JOURNALED
 * shipment, and the cancellation transaction calls `deps.getAccountingSettings()` when a GOODS order's
 * reversal has value. Neither arises for the in-transit world seeded here; both are pre-existing and
 * filed rather than folded into a lock-only change.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'
const TX = { timeout: 60_000, maxWait: 10_000 }

type Hit = { prop: string; transaction: number; stack: string }
const trap = { armedDepth: 0, transactions: 0, currentTransaction: 0, hits: [] as Hit[] }

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
}

// The REAL module first (so its other exports survive), then the mock over it.
// A synchronous `require` (no top-level await in this file's CJS output): it loads the real module once, so
// every OTHER export of '@/lib/db' survives the mock below.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realDbModule = require('@/lib/db') as typeof import('@/lib/db')
const realDb = realDbModule.db as unknown as Record<string | symbol, unknown>
const trappedDb = new Proxy(realDb, {
  get(target, prop, receiver) {
    if (prop === '$transaction') {
      return (fn: unknown, ...rest: unknown[]) => {
        if (typeof fn !== 'function') return (target.$transaction as (...a: unknown[]) => unknown).call(target, fn, ...rest)
        trap.transactions += 1
        const index = trap.transactions
        const wrapped = async (tx: unknown) => {
          trap.armedDepth += 1
          const previous = trap.currentTransaction
          trap.currentTransaction = index
          try { return await (fn as (t: unknown) => Promise<unknown>)(tx) } finally {
            trap.armedDepth -= 1
            trap.currentTransaction = previous
          }
        }
        return (target.$transaction as (...a: unknown[]) => unknown).call(target, wrapped, ...rest)
      }
    }
    if (trap.armedDepth > 0 && typeof prop === 'string') {
      trap.hits.push({ prop, transaction: trap.currentTransaction, stack: new Error().stack?.split('\n').slice(2, 6).join(' | ') ?? '' })
      throw new Error(`POOLED CLIENT USED INSIDE A TRANSACTION: db.${prop} (transaction #${trap.currentTransaction})`)
    }
    return Reflect.get(target, prop, receiver)
  },
})
mock.module('@/lib/db', { namedExports: { ...realDbModule, db: trappedDb } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })

async function seedWorld(label: string) {
  const { db } = await import('@/lib/db')
  const tag = `NRL4T-${label}-${randomUUID().replace(/-/g, '').slice(0, 20)}`
  const now = new Date()
  const w1 = await db.warehouse.create({ data: { code: `${tag}-1`.slice(0, 40), name: `${tag} w1`, type: 'STANDARD' }, select: { id: true } })
  const w2 = await db.warehouse.create({ data: { code: `${tag}-2`.slice(0, 40), name: `${tag} w2`, type: 'STANDARD' }, select: { id: true } })
  const supplier = await db.supplier.create({ data: { name: `supplier ${tag}`, currency: 'GBP', active: true }, select: { id: true } })
  const product = await db.product.create({ data: { sku: tag, name: `product ${tag}`, type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true } })
  const goods = await db.purchaseOrder.create({
    data: {
      reference: `PO-${tag}`, type: 'GOODS', supplierId: supplier.id, status: 'RECEIVED', currency: 'GBP', fxRateToBase: 1,
      subtotalForeign: 50, subtotalBase: 50, taxForeign: 0, taxBase: 0, totalForeign: 50, totalBase: 50,
      destinationWarehouseId: w1.id, receivedAt: now,
      lines: { create: [{ productId: product.id, description: product.id, qty: 10, unitCostForeign: 5, unitCostBase: 5, totalForeign: 50, totalBase: 50, landedUnitCostBase: 5, qtyReceived: 10, qtyReturned: 0, sortOrder: 0 }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const layer = await db.costLayer.create({
    data: { productId: product.id, warehouseId: w1.id, receivedQty: 10, remainingQty: 6, unitCostBase: 5, receivedAt: new Date(now.getTime() - 60_000), poLineId: goods.lines[0]!.id },
    select: { id: true },
  })
  const freight = await db.purchaseOrder.create({
    data: {
      reference: `PO-F-${tag}`, type: 'FREIGHT', supplierId: supplier.id, status: 'PO_SENT', currency: 'GBP', fxRateToBase: 1,
      subtotalForeign: 20, subtotalBase: 20, taxForeign: 0, taxBase: 0, totalForeign: 20, totalBase: 20,
      freightCostLines: { create: [{ description: 'Freight', amountForeign: 20, amountBase: 20, vatable: false, distributionMethod: 'BY_VALUE', sortOrder: 0 }] },
      asFreightFor: { create: [{ primaryPoId: goods.id, method: 'BY_VALUE', allocated: false }] },
    },
    select: { id: true },
  })
  await db.stockTransfer.create({
    data: {
      reference: `T-${tag}`, fromWarehouseId: w1.id, toWarehouseId: w2.id, status: 'IN_TRANSIT', dispatchedAt: now,
      lines: { create: [{ productId: product.id, sku: tag, productName: tag, qty: '4.0000', qtyReceived: '0.0000', costLayerSnapshot: [{ costLayerId: layer.id, qty: '4.000000', unitCostBase: '5.000000' }] }] },
    },
  })
  return { tag, supplierId: supplier.id, goodsId: goods.id, layerId: layer.id, freightId: freight.id }
}

async function layerUnitCost(layerId: string): Promise<number> {
  const { db } = await import('@/lib/db')
  return Number((await db.costLayer.findUniqueOrThrow({ where: { id: layerId }, select: { unitCostBase: true } })).unitCostBase)
}

function resetTrap() {
  trap.hits = []
  trap.transactions = 0
  trap.currentTransaction = 0
}

test('o3d-nrl4 PR A: no pooled client inside the revaluation transactions', { skip }, async (t) => {
  loadEnv()
  const { assertScratchDatabaseBeforeAnyWrite } = await import('./scratch-database-guard')
  await assertScratchDatabaseBeforeAnyWrite()
  const { db } = await import('@/lib/db')

  await t.test('control: the trap CAN fail — a pooled read inside db.$transaction is recorded and throws', async () => {
    resetTrap()
    let caught: unknown = null
    await db.$transaction(async () => {
      try { await db.setting.findFirst() } catch (error) { caught = error }
    }, TX)
    console.log(`CONTROL PRECONDITION: hits=${trap.hits.length} (${trap.hits.map((h) => `${h.prop}@tx${h.transaction}`).join(',')}); thrown=${String(caught)}`)
    assert.ok(trap.hits.length >= 1, 'the pooled access was recorded')
    assert.match(String(caught), /POOLED CLIENT USED INSIDE A TRANSACTION/)
    resetTrap()
    await db.setting.findFirst() // outside a transaction the pooled client is untouched
    assert.equal(trap.hits.length, 0, 'outside a transaction nothing is trapped')
  })

  await t.test('updateFreightPoCosts: its transaction touches only tx', async () => {
    const { updateFreightPoCosts } = await import('@/app/actions/purchase-orders')
    const world = await seedWorld('upd')
    resetTrap()
    const result = await updateFreightPoCosts(world.freightId, [{ description: 'Freight', amountForeign: 30, vatable: false, distributionMethod: 'BY_VALUE' }])
    const own = trap.hits.filter((h) => h.transaction === 1)
    console.log(`TRAP updateFreightPoCosts: transactions entered=${trap.transactions} result=${JSON.stringify(result)} pooled hits in the action's own transaction=${own.length} ${own.map((h) => h.prop).join(',')}`)
    assert.ok(trap.transactions >= 1, 'PRECONDITION: the action opened a transaction under the trap')
    assert.deepEqual(result, { success: true })
    assert.equal(await layerUnitCost(world.layerId), 5 + 30 / 10, 'PRECONDITION: the revaluation really ran')
    assert.deepEqual(own, [], `pooled client used inside the transaction: ${JSON.stringify(own)}`)
  })

  await t.test('createFreightPo: its transaction touches only tx', async () => {
    const { createFreightPo } = await import('@/app/actions/purchase-orders')
    const world = await seedWorld('crt')
    const { db: pooled } = await import('@/lib/db')
    await pooled.landedCostLink.deleteMany({ where: { primaryPoId: world.goodsId } })
    resetTrap()
    const result = await createFreightPo({
      supplierId: world.supplierId, currency: 'GBP', fxRateToBase: 1, primaryPoIds: [world.goodsId],
      costLines: [{ description: 'Freight', amountForeign: 30, vatable: false, distributionMethod: 'BY_VALUE' }],
    })
    const own = trap.hits.filter((h) => h.transaction === 1)
    console.log(`TRAP createFreightPo: transactions entered=${trap.transactions} success=${result.success} pooled hits in the action's own transaction=${own.length} ${own.map((h) => h.prop).join(',')}`)
    assert.ok(trap.transactions >= 1, 'PRECONDITION: the action opened a transaction under the trap')
    assert.equal(result.success, true, String(result.error))
    assert.equal(await layerUnitCost(world.layerId), 5 + 30 / 10, 'PRECONDITION: the revaluation really ran')
    assert.deepEqual(own, [], `pooled client used inside the transaction: ${JSON.stringify(own)}`)
  })

  await t.test('cancelPurchaseOrderService (FREIGHT): its transaction touches only tx', async () => {
    const { cancelPurchaseOrderService } = await import('@/lib/domain/purchasing/cancellation-service')
    const { recalculateLandedCosts } = await import('@/lib/domain/purchasing/landed-cost-service')
    const world = await seedWorld('cnc')
    resetTrap()
    await db.$transaction((tx) => recalculateLandedCosts(tx, world.freightId, undefined, { triggeredById: null, reason: 'freight_purchase_order_costs_updated' }), TX)
    assert.equal(await layerUnitCost(world.layerId), 7, 'PRECONDITION: the freight was applied before it is cancelled')
    resetTrap()
    const result = await cancelPurchaseOrderService(world.freightId)
    const own = trap.hits.filter((h) => h.transaction === 1)
    console.log(`TRAP cancelPurchaseOrderService: transactions entered=${trap.transactions} success=${result.success} pooled hits in the cancellation's own transaction=${own.length} ${own.map((h) => h.prop).join(',')}`)
    assert.ok(trap.transactions >= 1, 'PRECONDITION: the service opened a transaction under the trap')
    assert.equal(result.success, true, String(result.error))
    assert.equal(await layerUnitCost(world.layerId), 5, 'PRECONDITION: the uplift was reverted')
    assert.deepEqual(own, [], `pooled client used inside the transaction: ${JSON.stringify(own)}`)
  })
})
