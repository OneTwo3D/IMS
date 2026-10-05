import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

import { assertScratchDatabaseBeforeAnyWrite } from './scratch-database-guard'
import { INTEGRATION_PLUGIN_SETTING_KEYS } from '../../lib/integration-plugin-keys.ts'

/**
 * o3d-c08y — A REVALUATION THAT WOULD TAKE AN ALREADY-JOURNALED SHIPMENT BELOW ZERO IS REFUSED, AND
 * THE REFUSAL LEAVES THE DATABASE EXACTLY AS IT WAS. Needs real Postgres: the property is a ROLLBACK.
 *
 * THE DEFECT, reproduced first on a scratch database against development 3c350bfb: one unit at 4.00,
 * shipped and journaled; a linked freight PO with one CREDIT line of -10.00; the real
 * `recalculateLandedCosts` drove the layer to -6.00 and queued exactly ONE COGS_REVERSAL (DR 630 /
 * CR 500 4.00, "Reverse old shipment COGS"). The -6.00 repost leg did not exist, the recalc's own
 * COGS journal was empty because the whole -10.00 had been claimed as shipment-owned, and the COGS
 * subledger recorded -10.00. 6.00 posted nowhere and nothing said so.
 *
 * WHAT CHANGED (the landed-cost sign change, o3d-gj68 / o3d-ab13). A credit freight line is now APPLIED
 * and a unit is FLOORED at zero, so a landed-cost recalculation can no longer drive a layer to -6.00:
 * the same fixture now revalues the shipment to 0.00 and warns about the 6.00 it could not absorb. The
 * refusal this file was written for is therefore UNREACHABLE FROM LANDED COST for a purchase order's own layers and is kept as a backstop
 * for any other source of a negative cost. So the refusal arms below REACH it by INJECTING the negative
 * directly — the layer's cost and the shipment snapshots are written negative inside a real transaction
 * and `refreshShipmentCogsForCostLayerChange` is driven exactly as the recalculation drives it — and each
 * prints "refusal reached" so an arm that never gets there cannot pass for a refusal. A NEW arm proves the
 * credit fixture floors instead of refusing, with a 2-line COGS_REVERSAL of 4.00.
 *
 * WHAT IS ASSERTED for a refusal, for the linked-freight shape, the direct-cost shape and the freight-PO
 * edit action, after it: the layer's cost, the shipment snapshot, `cogsBatchAmount`, the PO line's landed
 * cost and (for the action) the freight line itself are unchanged; no accounting sync row, COGS subledger
 * row or revaluation-run row was written; one ERROR activity entry exists and names the credit line. A
 * POSITIVE CONTROL runs the real recalculation with a credit that leaves the basis positive, so a fixture
 * that never reaches the revaluation cannot pass for a refusal.
 *
 * No network: fetch and the connector transport throw, and nothing here reaches Xero, QuickBooks,
 * Mintsoft or WooCommerce. No email is sent.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'
const TX = { timeout: 60_000, maxWait: 10_000 }

const NO_NETWORK = 'o3d-c08y test: an outbound network call was attempted.'
globalThis.fetch = (async () => { throw new Error(NO_NETWORK) }) as typeof fetch
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async () => { throw new Error(NO_NETWORK) },
    DEFAULT_CONNECTOR_FETCH_TIMEOUT_MS: 30_000,
    DEFAULT_CONNECTOR_FETCH_MAX_RESPONSE_BYTES: 10 * 1024 * 1024,
    isAllAddressesLookup: () => false,
  },
})
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    freshAuthFailureResult: () => null,
    requireApiFreshAdmin: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/fulfillment/backorder-allocator', {
  namedExports: { allocateBackordersForProducts: async () => ({}) },
})
mock.module('@/lib/fulfillment/overallocation-rebalancer', {
  namedExports: { releaseOverallocations: async () => ({}) },
})

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
}

type Fixture = Awaited<ReturnType<typeof seed>>

/**
 * Every order this file seeded. They are deleted when the file ends, with their shipments: a journaled
 * shipment with no mirrored accounting event is exactly what the reconciliation reports, and the
 * database-backed tier that runs after this one on the same scratch database counts those findings.
 */
const seededOrderIds: string[] = []

async function deleteSeededOrders() {
  if (seededOrderIds.length === 0) return
  const { db } = await import('@/lib/db')
  const shipments = await db.shipment.findMany({ where: { orderId: { in: seededOrderIds } }, select: { id: true } })
  const shipmentIds = shipments.map((shipment) => shipment.id)
  await db.shipmentLine.deleteMany({ where: { shipmentId: { in: shipmentIds } } })
  await db.shipment.deleteMany({ where: { id: { in: shipmentIds } } })
  await db.salesOrderLine.deleteMany({ where: { orderId: { in: seededOrderIds } } })
  const deleted = await db.salesOrder.deleteMany({ where: { id: { in: seededOrderIds } } })
  assert.equal(deleted.count, seededOrderIds.length, 'the seeded orders were not all removed')
}

/**
 * One unit bought at 4.00, shipped AND journaled (Group B posted COGS 4.00), and a credit cost line
 * of `credit` — on a linked freight PO (`where: 'freight'`) or on the goods PO itself (`'direct'`).
 * Nothing is recalculated here.
 */
async function seed(label: string, where: 'freight' | 'direct', credit: number) {
  const { db } = await import('@/lib/db')
  const tag = `C08Y-${label}-${process.pid}-${Date.now()}`
  const now = new Date()
  const warehouse = await db.warehouse.create({ data: { code: tag, name: tag, availableForSale: true, active: true } })
  const supplier = await db.supplier.create({ data: { name: `supplier ${tag}`, currency: 'GBP', active: true } })
  const customer = await db.customer.create({ data: { firstName: 'C08Y', lastName: tag, email: `${tag.toLowerCase()}@example.invalid`, active: true } })
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
      ...(where === 'direct'
        ? { freightCostLines: { create: [{ description: 'Direct credit', amountForeign: credit, amountBase: credit, vatable: false, distributionMethod: 'BY_VALUE', sortOrder: 0 }] } }
        : {}),
    },
    include: { lines: true, freightCostLines: true },
  })
  const layer = await db.costLayer.create({ data: {
    productId: product.id, warehouseId: warehouse.id, receivedQty: 1, remainingQty: 0, unitCostBase: 4,
    receivedAt: new Date(now.getTime() - 60_000), poLineId: goods.lines[0].id, isOpeningStock: false,
  } })
  const freight = where === 'freight'
    ? await db.purchaseOrder.create({
      data: {
        reference: `PO-F-${tag}`, type: 'FREIGHT', supplierId: supplier.id, status: 'RECEIVED', currency: 'GBP', fxRateToBase: 1,
        subtotalForeign: credit, subtotalBase: credit, taxForeign: 0, taxBase: 0, totalForeign: credit, totalBase: credit, receivedAt: now,
        freightCostLines: { create: [{ description: 'Freight credit', amountForeign: credit, amountBase: credit, vatable: false, distributionMethod: 'BY_VALUE', sortOrder: 0 }] },
        asFreightFor: { create: [{ primaryPoId: goods.id, method: 'BY_VALUE', allocated: true }] },
      },
      include: { freightCostLines: true },
    })
    : null
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `SO-${tag}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: 1, customerId: customer.id,
      customerName: 'C08Y', customerEmail: customer.email, billingAddress: { country: 'GB' } as never, shippingAddress: { country: 'GB' } as never,
      subtotalForeign: 10, shippingForeign: 0, taxForeign: 0, pricesIncludeVat: false, totalForeign: 10,
      subtotalBase: 10, shippingBase: 0, taxBase: 0, totalBase: 10, shipFromWarehouseId: warehouse.id, shippedAt: now,
      revenueDeferredDate: new Date(now.getTime() - 10_000), unearnedRevenueAmount: 10, accountingInvoiceId: `INV-${tag}`,
      lines: { create: [{ productId: product.id, sku: product.sku, description: product.name, qty: 1, unitPriceForeign: 10, unitPriceBase: 10, totalForeign: 10, totalBase: 10, cogsBase: 4 }] },
    },
    include: { lines: true },
  })
  seededOrderIds.push(order.id)
  const shipment = await db.shipment.create({
    data: {
      orderId: order.id, warehouseId: warehouse.id, status: 'SHIPPED', shippedAt: now,
      shipmentJournalDate: new Date(now.getTime() - 5_000), cogsBatchAmount: 4, revenueRecognizedAmount: 10,
      allocatedReliefAmount: 4, shipmentJournalBatchRef: `B-${tag}`,
      lines: { create: [{ lineId: order.lines[0].id, productId: product.id, qty: 1, costLayerSnapshot: [{ costLayerId: layer.id, qty: '1.000000', unitCostBase: '4.000000' }] as never }] },
    },
  })
  return { tag, goods, layer, freight, shipment, creditLineId: (freight?.freightCostLines[0] ?? goods.freightCostLines[0]).id }
}

async function state(fixture: Fixture) {
  const { db } = await import('@/lib/db')
  const layer = await db.costLayer.findUniqueOrThrow({ where: { id: fixture.layer.id }, select: { unitCostBase: true } })
  const shipment = await db.shipment.findUniqueOrThrow({
    where: { id: fixture.shipment.id },
    select: { cogsBatchAmount: true, lines: { select: { costLayerSnapshot: true } } },
  })
  const poLine = await db.purchaseOrderLine.findUniqueOrThrow({ where: { id: fixture.goods.lines[0].id }, select: { landedUnitCostBase: true } })
  const syncRows = await db.accountingSyncLog.count({ where: { referenceId: fixture.shipment.id } })
  const subledger = await db.cogsSubledgerMovement.count({ where: { sourceRef: fixture.shipment.id } })
  const runs = await db.landedCostRevaluationRun.count({ where: { primaryPoId: fixture.goods.id } })
  const creditLine = await db.freightCostLine.findUnique({ where: { id: fixture.creditLineId }, select: { amountBase: true } })
  const errors = await db.activityLog.findMany({
    where: { action: 'landed_cost_revaluation_refused_journaled_shipment', entityId: fixture.shipment.id },
    select: { level: true, description: true },
  })
  return {
    layerUnitCost: Number(layer.unitCostBase),
    cogsBatchAmount: Number(shipment.cogsBatchAmount),
    snapshotUnitCost: String((shipment.lines[0].costLayerSnapshot as Array<{ unitCostBase: string }>)[0].unitCostBase),
    poLineLanded: Number(poLine.landedUnitCostBase),
    syncRows,
    subledger,
    runs,
    creditLineAmount: creditLine ? Number(creditLine.amountBase) : null,
    errors,
  }
}

function assertUntouched(after: Awaited<ReturnType<typeof state>>, what: string) {
  assert.equal(after.layerUnitCost, 4, `${what}: the cost layer kept the refused revaluation`)
  assert.equal(after.snapshotUnitCost, '4.000000', `${what}: the shipment snapshot kept the refused revaluation`)
  assert.equal(after.cogsBatchAmount, 4, `${what}: the shipment COGS kept the refused revaluation`)
  assert.equal(after.poLineLanded, 4, `${what}: the PO line kept the refused landed cost`)
  assert.equal(after.syncRows, 0, `${what}: an accounting sync row was queued for the shipment (the half-reversal)`)
  assert.equal(after.subledger, 0, `${what}: the COGS subledger recorded a movement the ledger never got`)
  assert.equal(after.runs, 0, `${what}: a COMPLETED revaluation run was recorded for a refused revaluation`)
}

function assertReported(after: Awaited<ReturnType<typeof state>>, fixture: Fixture, what: string) {
  assert.equal(after.errors.length, 1, `${what}: expected exactly one ERROR activity entry for the refusal`)
  assert.equal(after.errors[0].level, 'ERROR')
  assert.match(after.errors[0].description, /COGS 4\.00 -> -6\.00/)
  assert.ok(after.errors[0].description.includes(fixture.creditLineId), `${what}: the ERROR entry does not name the credit line`)
}

const recalcLinked = async (fixture: Fixture) => {
  const { db } = await import('@/lib/db')
  const { recalculateLandedCosts } = await import('@/lib/domain/purchasing/landed-cost-service')
  return db.$transaction((tx) => recalculateLandedCosts(tx, fixture.freight!.id, undefined, {
    triggeredById: null, reason: 'freight_purchase_order_costs_updated', scheduleAdjustmentJournals: true,
  }), TX)
}

/**
 * REACH THE REFUSAL BY INJECTING THE NEGATIVE (landed cost can no longer produce it). Inside one real
 * transaction: the layer's cost is written to `negativeUnitCost`, the shipment snapshots are patched to
 * it exactly as the recalculation patches them, and `refreshShipmentCogsForCostLayerChange` is driven with
 * the context the recalculation would have supplied. The caller decides what to do with the refusal.
 */
async function driveNegativeRevaluation(
  fixture: Fixture,
  source: 'landed_cost_recalc' | 'direct_landed_cost_recalc',
  negativeUnitCost: number,
  swallow = false,
): Promise<{ refusal: unknown }> {
  const { db } = await import('@/lib/db')
  const { refreshShipmentCogsForCostLayerChange, updateSnapshotsForCostLayerChange } = await import('@/lib/cost-layers')
  const holder: { refusal: unknown } = { refusal: null }
  await db.$transaction(async (tx) => {
    await tx.costLayer.update({ where: { id: fixture.layer.id }, data: { unitCostBase: negativeUnitCost } })
    await updateSnapshotsForCostLayerChange(tx, fixture.layer.id, negativeUnitCost)
    const revaluationContext = {
      source,
      operation: 'save' as const,
      primaryPoId: fixture.goods.id,
      primaryPoReference: fixture.goods.reference,
      ...(fixture.freight ? { freightPoId: fixture.freight.id } : {}),
      creditCostLines: [{
        freightCostLineId: fixture.creditLineId,
        purchaseOrderId: fixture.freight?.id ?? fixture.goods.id,
        purchaseOrderReference: fixture.freight?.reference ?? fixture.goods.reference,
        amountBase: '-10.00',
      }],
    }
    try {
      await refreshShipmentCogsForCostLayerChange(tx, fixture.layer.id, { recalcRunId: 'injected-run', revaluationContext })
    } catch (error) {
      holder.refusal = error
      if (!swallow) throw error
    }
  }, TX).catch((error) => { if (!swallow) throw error })
  return holder
}

test('o3d-c08y: a revaluation that would take a journaled shipment below zero is refused, and leaves nothing behind', { skip }, async (t) => {
  loadEnv()
  await assertScratchDatabaseBeforeAnyWrite()
  const { JournaledShipmentRevaluationRefusedError } = await import('@/lib/cost-layers')
  t.after(deleteSeededOrders)

  await t.test('POSITIVE CONTROL: a credit that leaves the basis positive revalues the journaled shipment', async () => {
    const fixture = await seed('ctl', 'freight', -2)
    await recalcLinked(fixture)
    const after = await state(fixture)
    assert.equal(after.layerUnitCost, 2, 'the fixture never reached the revaluation, so a refusal below would prove nothing')
    assert.equal(after.cogsBatchAmount, 2)
    assert.equal(after.snapshotUnitCost, '2.000000')
    assert.equal(after.errors.length, 0)
  })

  await t.test('SCEN=J, a negative reaching a journaled shipment: refused, nothing written, one ERROR naming the credit line', async () => {
    const fixture = await seed('linked', 'freight', -10)
    const reached = await driveNegativeRevaluation(fixture, 'landed_cost_recalc', -6, true)
    console.log(`SCEN=J PRECONDITION: refusal reached: ${reached.refusal instanceof JournaledShipmentRevaluationRefusedError ? 1 : 0}`)
    assert.ok(reached.refusal instanceof JournaledShipmentRevaluationRefusedError, 'PRECONDITION: the refusal was not reached')
    const after = await state(fixture)
    assertUntouched(after, 'linked recalc')
    assertReported(after, fixture, 'linked recalc')
  })

  await t.test('a caller that CATCHES the refusal cannot commit the revaluation it had already written', async () => {
    const fixture = await seed('swallow', 'freight', -10)
    // The helper swallows the refusal INSIDE the transaction and lets the caller go on to commit.
    const reached = await driveNegativeRevaluation(fixture, 'landed_cost_recalc', -6, true)
    console.log(`swallow PRECONDITION: refusal reached: ${reached.refusal instanceof JournaledShipmentRevaluationRefusedError ? 1 : 0}`)
    assert.ok(reached.refusal instanceof JournaledShipmentRevaluationRefusedError, 'PRECONDITION: the refusal was not reached')
    assertUntouched(await state(fixture), 'swallowed refusal')
  })

  await t.test('the direct-cost revaluation (a credit on the goods PO itself) is refused the same way', async () => {
    const fixture = await seed('direct', 'direct', -10)
    const reached = await driveNegativeRevaluation(fixture, 'direct_landed_cost_recalc', -6, true)
    console.log(`direct PRECONDITION: refusal reached: ${reached.refusal instanceof JournaledShipmentRevaluationRefusedError ? 1 : 0}`)
    assert.ok(reached.refusal instanceof JournaledShipmentRevaluationRefusedError, 'PRECONDITION: the refusal was not reached')
    const after = await state(fixture)
    assertUntouched(after, 'direct recalc')
    assertReported(after, fixture, 'direct recalc')
  })

  await t.test('the freight-PO edit action: a NET credit is refused at the boundary with the supplier-credit-note reason, and nothing is saved', async () => {
    const fixture = await seed('action', 'freight', 0)
    const { updateFreightPoCosts } = await import('@/app/actions/purchase-orders')
    const outcome = await updateFreightPoCosts(fixture.freight!.id, [
      { description: 'Freight credit', amountForeign: -10, vatable: false, distributionMethod: 'BY_VALUE' },
    ])
    console.log(`action PRECONDITION: outcome=${JSON.stringify(outcome)}`)
    assert.equal(outcome.success, false)
    assert.match(String(outcome.error), /supplier credit note/)
    const { db } = await import('@/lib/db')
    const lines = await db.freightCostLine.findMany({ where: { poId: fixture.freight!.id }, select: { id: true, amountBase: true } })
    assert.deepEqual(lines.map((line) => [line.id, Number(line.amountBase)]), [[fixture.creditLineId, 0]], 'the refused credit line was saved')
    assertUntouched(await state(fixture), 'freight-PO edit')
  })

  await t.test('THE SAME CREDIT FIXTURE NOW FLOORS: layer 0.00, one 2-line COGS_REVERSAL of 4.00, the 6.00 it could not absorb is warned, no refusal', async () => {
    const { db } = await import('@/lib/db')
    const keys: Array<[string, string]> = [
      [INTEGRATION_PLUGIN_SETTING_KEYS.xero, 'true'],
      ['xero_sync_enabled', 'true'],
      ['xero_sync_cogs_reversal', 'submitted'],
      ['xero_inventory_account', '630'],
      ['xero_cogs_account', '500'],
    ]
    const previous = new Map<string, string | null>()
    for (const [key, value] of keys) {
      previous.set(key, (await db.setting.findUnique({ where: { key }, select: { value: true } }))?.value ?? null)
      await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
    }
    try {
      const fixture = await seed('floor', 'freight', -10)
      const { recalculateLandedCosts, logLandedCostCreditFloorActivities } = await import('@/lib/domain/purchasing/landed-cost-service')
      const result = await db.$transaction((tx) => recalculateLandedCosts(tx, fixture.freight!.id, undefined, {
        triggeredById: null, reason: 'freight_purchase_order_costs_updated', scheduleAdjustmentJournals: true,
      }), TX)
      const after = await state(fixture)
      const reversals = await db.accountingSyncLog.findMany({ where: { type: 'COGS_REVERSAL', referenceId: fixture.shipment.id }, select: { payload: true } })
      const reversalLines = (reversals[0]?.payload as { lines?: Array<{ debit?: number; credit?: number }> } | null)?.lines ?? []
      const run = await db.landedCostRevaluationRun.findFirstOrThrow({ where: { primaryPoId: fixture.goods.id }, select: { warningsJson: true, afterJson: true } })
      const warnings = run.warningsJson as Array<{ code: string; message: string }>
      const layerAudit = (run.afterJson as { lines: Array<{ costLayers: Array<{ unabsorbedBase?: string; unflooredGrossUnitCostBase?: string }> }> }).lines[0].costLayers[0]
      console.log(`FLOOR PRECONDITION: layer=${after.layerUnitCost}, snapshot=${after.snapshotUnitCost}, cogsBatchAmount=${after.cogsBatchAmount}, COGS_REVERSAL rows=${reversals.length} with ${reversalLines.length} lines, refusal entries=${after.errors.length}, warning codes=${JSON.stringify(warnings.map((w) => w.code))}, unabsorbedBase=${layerAudit.unabsorbedBase}`)
      assert.equal(after.layerUnitCost, 0, 'the layer is floored at zero, not -6')
      assert.equal(after.poLineLanded, 0)
      assert.equal(Number(after.snapshotUnitCost), 0)
      assert.equal(after.cogsBatchAmount, 0, 'the shipment is revalued down to 0.00')
      assert.equal(after.errors.length, 0, 'no refusal entry: the credit is absorbed down to zero, not refused')
      assert.equal(reversals.length, 1, 'exactly one COGS_REVERSAL')
      assert.equal(reversalLines.length, 2, 'the reversal leg only: the new side is zero, so no repost legs')
      assert.deepEqual(reversalLines.map((line) => line.debit ?? line.credit), [4, 4], 'of 4.00')
      assert.deepEqual(warnings.map((w) => w.code), ['landed_cost_credit_floored'])
      assert.match(warnings[0].message, /could not absorb 6\.00 of it into stock/)
      assert.equal(layerAudit.unabsorbedBase, '6')
      assert.equal(layerAudit.unflooredGrossUnitCostBase, '-6')

      // The durable WARNING is written by the caller AFTER the commit: drive that half too.
      await logLandedCostCreditFloorActivities(result)
      const activity = await db.activityLog.findMany({ where: { entityType: 'PURCHASE_ORDER', entityId: fixture.goods.id, action: 'landed_cost_credit_floored' }, select: { level: true } })
      assert.deepEqual(activity.map((row) => row.level), ['WARNING'])
    } finally {
      for (const [key] of keys) {
        const before = previous.get(key) ?? null
        if (before === null) await db.setting.deleteMany({ where: { key } })
        else await db.setting.update({ where: { key }, data: { value: before } })
      }
    }
  })
})
