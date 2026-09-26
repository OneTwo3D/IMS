import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

import { assertScratchDatabaseBeforeAnyWrite } from './scratch-database-guard'

/**
 * o3d-c08y round 2, Codex HIGH — THE COST-LAYER LOCK MUST ACTUALLY SERIALIZE THE BATCH AGAINST A REAL
 * LANDED-COST REVALUATION. Needs real Postgres: the property is a lock wait and what is visible after
 * it.
 *
 * THE DEFECT, measured end to end before the fix (probe kept outside the repository at
 * /var/tmp/ims-session-park-20260913/c08y2-probe/race.ts; own throwaway scratch database, network
 * trapped): with a revaluation held open, the real `runDailyBatchSync`
 * parked at `SELECT id FROM "cost_layers" … FOR UPDATE` — observed in `pg_stat_activity` — and then
 * posted DAILY_BATCH_GROUP_B COGS £4.00 from the window it had read BEFORE the lock, stamped
 * `shipmentJournalDate`, wrote `cogsBatchAmount` back to 4.00 over the committed -6.00 and recorded a
 * 4.00 DISPATCH subledger row, with `result.errors` empty. After the fix the same interleaving refuses
 * the order by name and stamps nothing.
 *
 * WHAT IS ASSERTED HERE, with the real `recalculateLandedCosts` on one connection and the real
 * `lockCostLayersForGroupBWindow` on another:
 *  1. the lock BLOCKS while the revaluation holds the layer (proved from `pg_stat_activity`, not from a
 *     sleep), and the read that follows it returns the COMMITTED NEGATIVE snapshot — never the positive
 *     one the probe saw;
 *  2. the other way round: a batch that takes the lock first and journals the shipment makes the
 *     revaluation block and then REFUSE (`JournaledShipmentRevaluationRefusedError`), leaving the layer
 *     and the snapshot as they were.
 * Together those are the two halves of "a revaluation and Group B can no longer disagree".
 *
 * The full `runDailyBatchSync` is deliberately NOT run here: this tier shares one scratch database and
 * runs its files in parallel, and a real batch run would journal other files' fixtures. The end-to-end
 * run is the probe above; what this file proves is the ordering property on real locks.
 *
 * No network: fetch and the connector transport throw. No email is sent.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'
const TX = { timeout: 60_000, maxWait: 10_000 }

const NO_NETWORK = 'o3d-c08y r2 test: an outbound network call was attempted.'
globalThis.fetch = (async () => { throw new Error(NO_NETWORK) }) as typeof fetch
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async () => { throw new Error(NO_NETWORK) },
    DEFAULT_CONNECTOR_FETCH_TIMEOUT_MS: 30_000,
    DEFAULT_CONNECTOR_FETCH_MAX_RESPONSE_BYTES: 10 * 1024 * 1024,
    isAllAddressesLookup: () => false,
  },
})

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

/** Every order this file seeded, deleted when the file ends (a journaled shipment with no mirrored event is a reconciliation finding). */
const seededOrderIds: string[] = []

async function deleteSeededOrders() {
  if (seededOrderIds.length === 0) return
  const { db } = await import('@/lib/db')
  const shipments = await db.shipment.findMany({ where: { orderId: { in: seededOrderIds } }, select: { id: true } })
  const shipmentIds = shipments.map((shipment) => shipment.id)
  await db.shipmentLine.deleteMany({ where: { shipmentId: { in: shipmentIds } } })
  await db.shipment.deleteMany({ where: { id: { in: shipmentIds } } })
  await db.orderAllocation.deleteMany({ where: { orderId: { in: seededOrderIds } } })
  await db.salesOrderLine.deleteMany({ where: { orderId: { in: seededOrderIds } } })
  const deleted = await db.salesOrder.deleteMany({ where: { id: { in: seededOrderIds } } })
  assert.equal(deleted.count, seededOrderIds.length, 'the seeded orders were not all removed')
}

/**
 * One unit bought at 4.00, shipped and NOT journaled — the case `refreshShipmentCogsForCostLayerChange`
 * deliberately hands to the daily batch — with a linked freight PO carrying a -10.00 credit line.
 */
async function seed(label: string) {
  const { db } = await import('@/lib/db')
  const tag = `C08Y2-${label}-${process.pid}-${Date.now()}`
  const now = new Date()
  const warehouse = await db.warehouse.create({ data: { code: tag, name: tag, availableForSale: true, active: true } })
  const supplier = await db.supplier.create({ data: { name: `supplier ${tag}`, currency: 'GBP', active: true } })
  const customer = await db.customer.create({ data: { firstName: 'C08Y2', lastName: tag, email: `${tag.toLowerCase()}@example.invalid`, active: true } })
  const product = await db.product.create({ data: {
    sku: tag, name: `product ${tag}`, type: 'SIMPLE', lifecycleStatus: 'ACTIVE', salesPriceBase: 10,
    salesPriceTaxInclusive: false, taxCategory: 'STANDARD', stockUnit: 'pcs', oversellAllowed: false, active: true,
  } })
  const goods = await db.purchaseOrder.create({
    data: {
      reference: `PO-${tag}`, type: 'GOODS', supplierId: supplier.id, status: 'RECEIVED', currency: 'GBP', fxRateToBase: 1,
      subtotalForeign: 4, subtotalBase: 4, taxForeign: 0, taxBase: 0, totalForeign: 4, totalBase: 4,
      destinationWarehouseId: warehouse.id, receivedAt: now,
      lines: { create: [{ productId: product.id, description: product.name, qty: 1, unitCostForeign: 4, unitCostBase: 4, totalForeign: 4, totalBase: 4, landedUnitCostBase: 4, qtyReceived: 1, qtyReturned: 0, sortOrder: 0 }] },
    },
    include: { lines: true },
  })
  const layer = await db.costLayer.create({ data: {
    productId: product.id, warehouseId: warehouse.id, receivedQty: 1, remainingQty: 0, unitCostBase: 4,
    receivedAt: new Date(now.getTime() - 60_000), poLineId: goods.lines[0].id, isOpeningStock: false,
  } })
  const freight = await db.purchaseOrder.create({
    data: {
      reference: `PO-F-${tag}`, type: 'FREIGHT', supplierId: supplier.id, status: 'RECEIVED', currency: 'GBP', fxRateToBase: 1,
      subtotalForeign: -10, subtotalBase: -10, taxForeign: 0, taxBase: 0, totalForeign: -10, totalBase: -10, receivedAt: now,
      freightCostLines: { create: [{ description: 'Freight credit', amountForeign: -10, amountBase: -10, vatable: false, distributionMethod: 'BY_VALUE', sortOrder: 0 }] },
      asFreightFor: { create: [{ primaryPoId: goods.id, method: 'BY_VALUE', allocated: true }] },
    },
    include: { freightCostLines: true },
  })
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `SO-${tag}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: 1, customerId: customer.id,
      customerName: 'C08Y2', customerEmail: customer.email, billingAddress: { country: 'GB' } as never, shippingAddress: { country: 'GB' } as never,
      subtotalForeign: 10, shippingForeign: 0, taxForeign: 0, pricesIncludeVat: false, totalForeign: 10,
      subtotalBase: 10, shippingBase: 0, taxBase: 0, totalBase: 10, shipFromWarehouseId: warehouse.id, shippedAt: now,
      revenueDeferredDate: new Date(now.getTime() - 10_000), inventoryAllocatedDate: new Date(now.getTime() - 9_000),
      unearnedRevenueAmount: 10, accountingInvoiceId: `INV-${tag}`,
      lines: { create: [{ productId: product.id, sku: product.sku, description: product.name, qty: 1, unitPriceForeign: 10, unitPriceBase: 10, totalForeign: 10, totalBase: 10, cogsBase: 4 }] },
    },
    include: { lines: true },
  })
  seededOrderIds.push(order.id)
  const snapshot = [{ costLayerId: layer.id, qty: '1.000000', unitCostBase: '4.000000' }]
  const shipment = await db.shipment.create({
    data: {
      orderId: order.id, warehouseId: warehouse.id, status: 'SHIPPED', shippedAt: now,
      shipmentJournalDate: null, cogsBatchAmount: 4,
      lines: { create: [{ lineId: order.lines[0].id, productId: product.id, qty: 1, costLayerSnapshot: snapshot as never }] },
    },
  })
  await db.orderAllocation.create({ data: {
    orderId: order.id, lineId: order.lines[0].id, productId: product.id, warehouseId: warehouse.id,
    qty: 1, costLayerSnapshot: snapshot as never,
  } })
  return { tag, goods, layer, freight, shipment, order, creditLineId: freight.freightCostLines[0].id }
}

/** Wait until some backend in this database is blocked on a lock. Returns the statement it is waiting in. */
/**
 * The statement THIS test's revaluation is blocked on.
 *
 * o3d-j625 r12 — SCOPED TO THE WAIT IT MEANS. `pg_stat_activity` is DATABASE-WIDE and the concurrency tier
 * runs its files CONCURRENTLY against one scratch database, so "the first backend waiting on a Lock" is
 * whatever any other file happens to be doing. Measured: this returned
 * `SELECT pg_advisory_xact_lock($1, $2)` from tests/concurrency/posting-refusal-record-race, which holds
 * posting keys for 500ms on purpose, and the assertion below then failed about the wrong transaction.
 *
 * `want` is the statement the caller is about to assert about, so the poll keeps going until the wait it
 * is looking for appears. It is NOT weaker than the original: if nothing ever blocks on that statement the
 * loop still exhausts and throws, so an ordering that was never exercised still fails — and it now fails
 * for its own reason rather than another file's.
 */
async function waitForLockWait(want: RegExp): Promise<string> {
  const { db } = await import('@/lib/db')
  const seen = new Set<string>()
  for (let attempt = 0; attempt < 600; attempt++) {
    const rows = await db.$queryRawUnsafe<Array<{ query: string }>>(
      `SELECT query FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`,
    )
    for (const row of rows) {
      seen.add(row.query)
      if (want.test(row.query)) return row.query
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(
    `PRECONDITION FAILED: nothing ever blocked on ${want}, so no ordering was exercised. Lock waits seen `
    + `in this database meanwhile: ${JSON.stringify([...seen])}`,
  )
}

const recalcLinked = async (tx: unknown, freightPoId: string) => {
  const { recalculateLandedCosts } = await import('@/lib/domain/purchasing/landed-cost-service')
  return recalculateLandedCosts(tx as never, freightPoId, undefined, {
    triggeredById: null, reason: 'freight_purchase_order_costs_updated', scheduleAdjustmentJournals: true,
  })
}

test('o3d-c08y r2: the Group B cost-layer lock serializes the batch against a landed-cost revaluation', { skip }, async (t) => {
  loadEnv()
  await assertScratchDatabaseBeforeAnyWrite()
  t.after(deleteSeededOrders)

  await t.test('the batch blocks on the lock and then reads the COMMITTED negative snapshot, not the probe\'s positive one', async () => {
    const fixture = await seed('blocks')
    const { db } = await import('@/lib/db')
    const {
      DAILY_BATCH_GROUP_B_SHIPMENT_WHERE,
      lockCostLayersForGroupBWindow,
      assertGroupBSnapshotsWereLocked,
    } = await import('@/lib/domain/accounting/daily-batch-group-b-lock')

    const revaluationWrote = deferred()
    const releaseRevaluation = deferred()
    let revaluationError: unknown = null
    const revaluation = db.$transaction(async (tx) => {
      await recalcLinked(tx, fixture.freight.id)
      revaluationWrote.resolve()
      await releaseRevaluation.promise
    }, TX).catch((error) => { revaluationError = error })
    await revaluationWrote.promise

    let probeUnitCost: string | null = null
    let readUnitCost: string | null = null
    let lockWaitStatement: string | null = null
    const batch = db.$transaction(async (tx) => {
      // PROBE — before the lock, so it still sees the positive basis the revaluation has not committed.
      const candidates = await tx.shipment.findMany({
        where: { ...DAILY_BATCH_GROUP_B_SHIPMENT_WHERE, id: fixture.shipment.id },
        select: { id: true, orderId: true, lines: { select: { costLayerSnapshot: true } } },
      })
      assert.equal(candidates.length, 1, 'PRECONDITION: the fixture is selectable by Group B')
      probeUnitCost = String((candidates[0].lines[0].costLayerSnapshot as Array<{ unitCostBase: string }>)[0].unitCostBase)

      // LOCK — this is where the real batch was observed to park.
      const locked = await lockCostLayersForGroupBWindow(tx, { candidates })
      assert.ok(locked.has(fixture.layer.id), 'PRECONDITION: the revalued layer is in the locked set')

      // READ — under the lock.
      const shipments = await tx.shipment.findMany({
        where: { ...DAILY_BATCH_GROUP_B_SHIPMENT_WHERE, id: { in: candidates.map((row) => row.id) } },
        select: { id: true, cogsBatchAmount: true, lines: { select: { costLayerSnapshot: true } } },
      })
      assert.equal(shipments.length, 1, 'the shipment still qualifies')
      readUnitCost = String((shipments[0].lines[0].costLayerSnapshot as Array<{ unitCostBase: string }>)[0].unitCostBase)
      assertGroupBSnapshotsWereLocked(locked, [
        { what: 'the shipment lines it would post', rows: shipments.flatMap((shipment) => shipment.lines) },
      ])
      return Number(shipments[0].cogsBatchAmount)
    }, TX)

    lockWaitStatement = await waitForLockWait(/cost_layers/)
    releaseRevaluation.resolve()
    const reloadedCogs = await batch
    await revaluation

    assert.equal(revaluationError, null, `PRECONDITION: the revaluation committed: ${String(revaluationError)}`)
    assert.match(
      lockWaitStatement, /cost_layers/,
      `PRECONDITION: what blocked was the cost-layer lock, so the ordering under test was exercised: ${lockWaitStatement}`,
    )
    assert.equal(probeUnitCost, '4.000000', 'PRECONDITION: the probe really did see the stale positive basis')
    assert.equal(readUnitCost, '-6.000000', 'the read under the lock returns the COMMITTED negative basis (o3d-c08y r2)')
    assert.equal(reloadedCogs, -6, 'and the cogsBatchAmount it would post with is the committed one')
  })

  await t.test('the other way round: the batch locks first, journals the shipment, and the revaluation is REFUSED', async () => {
    const fixture = await seed('reverse')
    const { db } = await import('@/lib/db')
    const { JournaledShipmentRevaluationRefusedError } = await import('@/lib/cost-layers')
    const {
      DAILY_BATCH_GROUP_B_SHIPMENT_WHERE,
      lockCostLayersForGroupBWindow,
    } = await import('@/lib/domain/accounting/daily-batch-group-b-lock')

    const batchHoldsLock = deferred()
    const releaseBatch = deferred()
    const batch = db.$transaction(async (tx) => {
      const candidates = await tx.shipment.findMany({
        where: { ...DAILY_BATCH_GROUP_B_SHIPMENT_WHERE, id: fixture.shipment.id },
        select: { id: true, orderId: true, lines: { select: { costLayerSnapshot: true } } },
      })
      await lockCostLayersForGroupBWindow(tx, { candidates })
      // What Group B does at the end of a successful window.
      await tx.shipment.update({
        where: { id: fixture.shipment.id },
        data: { shipmentJournalDate: new Date(), cogsBatchAmount: 4, allocatedReliefAmount: 4 },
      })
      batchHoldsLock.resolve()
      await releaseBatch.promise
    }, TX)
    await batchHoldsLock.promise

    let refusal: unknown = null
    const revaluation = db.$transaction((tx) => recalcLinked(tx, fixture.freight.id), TX)
      .catch((error) => { refusal = error })

    const lockWaitStatement = await waitForLockWait(/cost_layers|shipments/)
    releaseBatch.resolve()
    await batch
    await revaluation

    assert.match(lockWaitStatement, /cost_layers|shipments/, `PRECONDITION: the revaluation waited: ${lockWaitStatement}`)
    assert.ok(
      refusal instanceof JournaledShipmentRevaluationRefusedError,
      `the revaluation is refused once the shipment is journaled: ${String(refusal)}`,
    )
    const layer = await db.costLayer.findUniqueOrThrow({ where: { id: fixture.layer.id }, select: { unitCostBase: true } })
    assert.equal(Number(layer.unitCostBase), 4, 'and the refused revaluation left the layer as it was')
    const shipment = await db.shipment.findUniqueOrThrow({
      where: { id: fixture.shipment.id }, select: { cogsBatchAmount: true, lines: { select: { costLayerSnapshot: true } } },
    })
    assert.equal(Number(shipment.cogsBatchAmount), 4, 'and the journaled COGS as it was')
    assert.equal(
      String((shipment.lines[0].costLayerSnapshot as Array<{ unitCostBase: string }>)[0].unitCostBase), '4.000000',
      'and the snapshot as it was',
    )
  })
})
