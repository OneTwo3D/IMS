import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'
import type { PreCutoverFence } from '@/lib/connectors/woocommerce/sync/pre-cutover-order-read'

/**
 * The storefront verification of a pre-cutover order is FENCED to the completion: the proof (the order's link, the store binding
 * generation, the IMS lines) is re-checked inside the transaction that ships the order, under the order lock. Against a real
 * Postgres: a binding change or an IMS line edit after the verification refuses the dispatch (nothing shipped, no stock moved), an
 * unchanged order ships exactly once, and two concurrent completions move stock once.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */
const SKIP = process.env.RUN_DB_CONCURRENCY_TESTS !== '1'

// revalidatePath needs a Next.js request context; outside one it throws AFTER the work is done, which would mask the result.
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } })

async function loadDeps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const [{ db }, shipments, reader, lock, external] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/domain/sales/shipment-service'),
    import('@/lib/connectors/woocommerce/sync/pre-cutover-order-read'),
    import('@/lib/connectors/woocommerce/sync-lock'),
    import('@/lib/fulfillment/external-fulfillment'),
  ])
  return { db, transition: shipments.transitionShipmentStatus, reconcile: shipments.reconcileOrderAfterShipment, apply: external.applyExternalFulfillmentUpdate, reader, versionKey: lock.WC_SETTINGS_VERSION_KEY }
}
type Deps = Awaited<ReturnType<typeof loadDeps>>

async function withFixture(body: (deps: Deps, f: { orderId: string; lineId: string; shipmentId: string; productId: string; suffix: string }, fence: () => Promise<PreCutoverFence>) => Promise<void>) {
  const deps = await loadDeps()
  const { db } = deps
  const suffix = randomUUID()
  const tag = `PCF-${suffix.slice(0, 8)}`
  const warehouse = await db.warehouse.create({ data: { code: tag, name: `fence ${suffix}`, active: true, availableForSale: true, syncToStore: false, isDefault: false }, select: { id: true } })
  const product = await db.product.create({ data: { sku: `${tag}-A`, name: `fence ${suffix}`, type: 'SIMPLE' }, select: { id: true } })
  await db.stockLevel.create({ data: { productId: product.id, warehouseId: warehouse.id, quantity: 5, reservedQty: 2 } })
  await db.costLayer.create({ data: { productId: product.id, warehouseId: warehouse.id, receivedQty: 5, remainingQty: 5, unitCostBase: 3 } })
  const order = await db.salesOrder.create({
    data: {
      orderNumber: tag, status: 'ALLOCATED', currency: 'GBP', subtotalForeign: 10, totalForeign: 10, subtotalBase: 10, totalBase: 10, shipFromWarehouseId: warehouse.id,
      lines: { create: [{ productId: product.id, description: 'fence line', sku: `${tag}-A`, qty: 2, unitPriceForeign: 5, unitPriceBase: 5, totalForeign: 10, totalBase: 10, externalLineItemId: 11 }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const lineId = order.lines[0]!.id
  await db.orderAllocation.create({ data: { orderId: order.id, lineId, productId: product.id, warehouseId: warehouse.id, qty: 2 } })
  await db.shoppingOrderLink.create({ data: { orderId: order.id, connector: 'woocommerce', externalOrderId: `X${tag}`, externalOrderNumber: tag } })
  await db.setting.upsert({ where: { key: deps.versionKey }, create: { key: deps.versionKey, value: '1' }, update: { value: '1' } })
  const shipment = await db.shipment.create({ data: { orderId: order.id, warehouseId: warehouse.id, status: 'PACKED', lines: { create: [{ lineId, productId: product.id, qty: 2 }] } }, select: { id: true } })
  // The fence exactly as a verification builds it: from what the database holds at verification time.
  const fence = async () => {
    const link = await db.shoppingOrderLink.findFirstOrThrow({ where: { orderId: order.id, connector: 'woocommerce' }, select: { externalOrderId: true } })
    const row = await db.setting.findUnique({ where: { key: deps.versionKey }, select: { key: true, value: true, updatedAt: true } })
    const lines = await db.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true, qty: true, wclcFeeKind: true, productId: true, externalLineItemId: true } })
    return deps.reader.buildPreCutoverFence(order.id, { externalOrderId: link.externalOrderId, binding: deps.reader.bindingStamp(row), lines: deps.reader.linesFingerprint(lines) }) 
  }
  try {
    await body(deps, { orderId: order.id, lineId, shipmentId: shipment.id, productId: product.id, suffix }, fence)
  } finally {
    const run = async (op: () => Promise<unknown>) => { try { await op() } catch (e) { console.warn(`pre-cutover fence cleanup: ${String(e)}`) } }
    await run(() => db.cogsEntry.deleteMany({ where: { movement: { productId: product.id } } }))
    await run(() => db.shipment.deleteMany({ where: { orderId: order.id } }))
    await run(() => db.stockMovement.deleteMany({ where: { productId: product.id } }))
    await run(() => db.orderAllocation.deleteMany({ where: { orderId: order.id } }))
    await run(() => db.salesOrderLine.deleteMany({ where: { orderId: order.id } }))
    await run(() => db.salesOrder.delete({ where: { id: order.id } }))
    await run(() => db.costLayer.deleteMany({ where: { productId: product.id } }))
    await run(() => db.stockLevel.deleteMany({ where: { productId: product.id } }))
    await run(() => db.product.delete({ where: { id: product.id } }))
    await run(() => db.warehouse.delete({ where: { id: warehouse.id } }))
  }
}

const movements = (deps: Deps, productId: string) => deps.db.stockMovement.count({ where: { productId, type: 'SALE_DISPATCH' } })
const status = async (deps: Deps, shipmentId: string) => (await deps.db.shipment.findUniqueOrThrow({ where: { id: shipmentId }, select: { status: true } })).status

test('FENCE: unchanged since verification: ships once, stock moves once', { skip: SKIP }, async () => {
  await withFixture(async (deps, f, fence) => {
    const result = await deps.transition(deps.db, { shipmentId: f.shipmentId, targetStatus: 'SHIPPED', fence: await fence() })
    assert.equal(result.success, true, JSON.stringify(result))
    assert.equal(await status(deps, f.shipmentId), 'SHIPPED')
    assert.equal(await movements(deps, f.productId), 1)
  })
})

test('FENCE: the store binding changed after the verification: refused, nothing shipped, no stock moved', { skip: SKIP }, async () => {
  await withFixture(async (deps, f, fence) => {
    const built = await fence()
    await deps.db.setting.update({ where: { key: deps.versionKey }, data: { value: '2' } })
    const result = await deps.transition(deps.db, { shipmentId: f.shipmentId, targetStatus: 'SHIPPED', fence: built })
    assert.equal(result.success, false)
    assert.match(String((result as { error?: string }).error), /changed since the storefront verification/)
    assert.equal(await status(deps, f.shipmentId), 'PACKED')
    assert.equal(await movements(deps, f.productId), 0)
  })
})

test('FENCE: an IMS line edited after the verification: refused, nothing shipped, no stock moved; the link changed likewise', { skip: SKIP }, async () => {
  await withFixture(async (deps, f, fence) => {
    const built = await fence()
    await deps.db.salesOrderLine.update({ where: { id: f.lineId }, data: { externalLineItemId: 12 } })
    const edited = await deps.transition(deps.db, { shipmentId: f.shipmentId, targetStatus: 'SHIPPED', fence: built })
    assert.equal(edited.success, false)
    assert.equal(await status(deps, f.shipmentId), 'PACKED')
    assert.equal(await movements(deps, f.productId), 0)
    // restored lines pass again; a different linked storefront order does not
    await deps.db.salesOrderLine.update({ where: { id: f.lineId }, data: { externalLineItemId: 11 } })
    await deps.db.shoppingOrderLink.updateMany({ where: { orderId: f.orderId }, data: { externalOrderId: `Y${f.suffix}` } })
    const relinked = await deps.transition(deps.db, { shipmentId: f.shipmentId, targetStatus: 'SHIPPED', fence: built })
    assert.equal(relinked.success, false)
    assert.equal(await movements(deps, f.productId), 0)
  })
})

test('FENCE: two concurrent completions on an unchanged order move stock once', { skip: SKIP }, async () => {
  await withFixture(async (deps, f, fence) => {
    const built = await fence()
    const results = await Promise.all([1, 2].map(() => deps.transition(deps.db, { shipmentId: f.shipmentId, targetStatus: 'SHIPPED', fence: built }).catch((e) => ({ success: false as const, error: String(e) }))))
    assert.equal(results.filter((r) => r.success && (r as { transitioned?: boolean }).transitioned === true).length, 1, JSON.stringify(results))
    assert.equal(await status(deps, f.shipmentId), 'SHIPPED')
    assert.equal(await movements(deps, f.productId), 1, 'no double stock movement')
  })
})

test('FENCE AT THE ORDER FLIP: a link or line change between the shipment commit and the order reconcile leaves the order unflipped under EXTERNAL authority; unchanged flips once', { skip: SKIP }, async () => {
  await withFixture(async (deps, f, fence) => {
    const built = await fence()
    const shipped = await deps.transition(deps.db, { shipmentId: f.shipmentId, targetStatus: 'SHIPPED', fence: built })
    assert.equal(shipped.success, true, JSON.stringify(shipped))
    const orderStatus = async () => (await deps.db.salesOrder.findUniqueOrThrow({ where: { id: f.orderId }, select: { status: true } })).status
    // the change lands AFTER the shipment transaction committed and BEFORE the order reconcile
    await deps.db.shoppingOrderLink.updateMany({ where: { orderId: f.orderId }, data: { externalOrderId: `Z${f.suffix}` } })
    const refused = await deps.reconcile(deps.db, { orderId: f.orderId }, undefined, { completionAuthority: 'EXTERNAL', storefrontCompletion: false, fence: built })
    assert.match(String(refused.fenceRefused), /changed since the storefront verification/)
    assert.equal(refused.orderReachedShipped, undefined)
    assert.equal(await orderStatus(), 'ALLOCATED', 'the order is not flipped')
    assert.equal(await status(deps, f.shipmentId), 'SHIPPED', 'the shipment stays shipped: the goods left')
    // a fresh verification (new fence over the current state) completes it, exactly once
    const fresh = await fence()
    const first = await deps.reconcile(deps.db, { orderId: f.orderId }, undefined, { completionAuthority: 'EXTERNAL', storefrontCompletion: false, fence: fresh })
    assert.equal(first.orderReachedShipped, true)
    assert.equal(await orderStatus(), 'SHIPPED')
    const again = await deps.reconcile(deps.db, { orderId: f.orderId }, undefined, { completionAuthority: 'EXTERNAL', storefrontCompletion: false, fence: fresh })
    assert.equal(again.orderReachedShipped, undefined, 'flips once')
    assert.equal(await movements(deps, f.productId), 1)
  })
})

test('END TO END through applyExternalFulfillmentUpdate: a fence refusal at the order flip is retried by the next call with a fresh fence; a stale fence is refused again; exactly one stock movement', { skip: SKIP }, async () => {
  await withFixture(async (deps, f, fence) => {
    const orderRow = () => deps.db.salesOrder.findUniqueOrThrow({ where: { id: f.orderId }, select: { status: true, shippedAt: true } })
    const stale = await fence()
    // First call: the shipment fence passes, then the link changes before the order flip (the fence refuses on its second use).
    let uses = 0
    const refusingAtFlip: PreCutoverFence = async (tx) => {
      uses += 1
      if (uses === 2) await deps.db.shoppingOrderLink.updateMany({ where: { orderId: f.orderId }, data: { externalOrderId: `W${f.suffix}` } })
      return stale(tx)
    }
    const request = (shipFence: PreCutoverFence) => deps.apply({ source: 'mintsoft', lookup: { orderId: f.orderId }, targetShipmentStatus: 'SHIPPED', storefrontAlreadyCompleted: true, shipFence })
    const first = await request(refusingAtFlip)
    assert.equal(first.success, false, JSON.stringify(first))
    assert.match(String((first as { error?: string }).error), /changed since the storefront verification/, 'refused by the fence, not by something else')
    assert.equal(uses, 2)
    assert.equal(await status(deps, f.shipmentId), 'SHIPPED')
    assert.equal((await orderRow()).status, 'ALLOCATED', 'the order is not flipped')
    assert.equal(await movements(deps, f.productId), 1)
    // Retry with the STALE fence (built before the link changed): refused again, and it is an apply error, not a success.
    const staleRetry = await request(stale)
    assert.equal(staleRetry.success, false, 'a stale fence is refused again')
    assert.match(String((staleRetry as { error?: string }).error), /changed since the storefront verification/)
    assert.equal((await orderRow()).status, 'ALLOCATED')
    // Retry with a FRESH fence over the current state: the order flips, no shipment transition, no second stock movement.
    const retry = await request(await fence())
    assert.equal(retry.success, true, JSON.stringify(retry))
    const flipped = await orderRow()
    assert.equal(flipped.status, 'SHIPPED')
    assert.equal(await movements(deps, f.productId), 1, 'exactly one stock movement in total')
    // A further call is a no-op success: the order is not flipped again.
    const again = await request(await fence())
    assert.equal(again.success, true)
    assert.equal((await orderRow()).shippedAt?.getTime(), flipped.shippedAt?.getTime())
    assert.equal(await movements(deps, f.productId), 1)
  })
})

test('RETRY: an order cancelled after selection is an apply failure naming its status, never a recorded success', { skip: SKIP }, async () => {
  await withFixture(async (deps, f, fence) => {
    const request = (shipFence: PreCutoverFence) => deps.apply({ source: 'mintsoft', lookup: { orderId: f.orderId }, targetShipmentStatus: 'SHIPPED', storefrontAlreadyCompleted: true, shipFence })
    const first = await deps.transition(deps.db, { shipmentId: f.shipmentId, targetStatus: 'SHIPPED' })
    assert.equal(first.success, true)
    await deps.db.salesOrder.update({ where: { id: f.orderId }, data: { status: 'CANCELLED' } })
    const result = await request(await fence())
    assert.equal(result.success, false)
    assert.match(String((result as { error?: string }).error), /CANCELLED/)
    assert.equal((await deps.db.salesOrder.findUniqueOrThrow({ where: { id: f.orderId }, select: { status: true } })).status, 'CANCELLED')
  })
})
