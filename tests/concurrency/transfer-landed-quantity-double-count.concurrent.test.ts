import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * 6oyu.19 / Codex round-6 HIGH-1 — THE MONEY PROOF.
 *
 * THE SEQUENCE: a WMS stock-sync ALIGNMENT lands an IN_TRANSIT transfer's units at
 * the destination and lays their cost layers; the dispatch is then CANCELLED; a
 * landed-cost change is then applied to the layer they came from.
 *
 * THE DEFECT. The alignment credits `wms_asn_line_maps.qtyAccountedViaSnapshot` and
 * never touches `stock_transfer_lines.qtyReceived`. `cancelDispatchedTransfer` asked
 * `qtyReceived > 0`, saw zero, concluded nothing had arrived, restored the FULL line
 * quantity to source and created a SECOND replacement cost layer linked back to the
 * same source layer. Both layers are then live and both are reachable by
 * `propagateLandedCostToOutputs`, so ONE dispatch of ten units posts the inventory
 * reclassification for TWENTY.
 *
 * This test asserts the POSTED AMOUNT, not the absence of a throw: it runs the real
 * `propagateLandedCostToOutputs` over the state the real `cancelDispatchedTransfer`
 * leaves behind, and sums what it accumulates. Restore the old guard
 * (`lines.some((line) => Number(line.qtyReceived ?? 0) > 0)`) and this test reports
 * 20 where it requires 10.
 *
 * It needs a real PostgreSQL — the propagation walks `cost_layer_source_lines` in
 * SQL and the exclusion queries are raw jsonb containment.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const TX = { timeout: 20000, maxWait: 10000 }

// The server action is gated on a session and revalidates Next's cache; neither is
// the subject here. Everything that touches stock, cost layers or the two counters
// is the REAL code.
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
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
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  }
}

const LINE_QTY = 10
const UNIT_COST = 5
const LANDED_COST_DELTA_PER_UNIT = 1

/**
 * Build the state the WMS stock-sync alignment leaves behind for a fully-aligned,
 * still-IN_TRANSIT transfer line.
 *
 * The destination layer is created by the REAL shared helper
 * (`recreateTransferCostLayersFromSnapshotSlice`) and the ASN counter is incremented
 * exactly as `applyMintsoftAlignmentForProduct` does — those two writes are the whole
 * of what the alignment leaves behind that matters here. The alignment itself cannot
 * be driven from a test: it is reached only through `runStockSyncForBinding`, which
 * calls the LIVE Mintsoft API.
 */
async function seedAlignedInTransitTransfer(label: string) {
  const { db } = await import('@/lib/db')
  const { recreateTransferCostLayersFromSnapshotSlice } =
    await import('@/lib/domain/inventory/transfer-cost-layer-recreation')

  const tag = `R6DC-${label}-${process.pid}-${Date.now()}`
  const product = await db.product.create({
    data: { sku: tag, name: `r6 double-count ${label}`, type: 'SIMPLE', countryOfOrigin: 'CN' },
    select: { id: true },
  })
  const source = await db.warehouse.create({
    data: { code: `${tag.slice(0, 16)}S`, name: `${tag} source`, type: 'STANDARD' },
    select: { id: true },
  })
  const destination = await db.warehouse.create({
    data: { code: `${tag.slice(0, 16)}D`, name: `${tag} dest`, type: 'STANDARD' },
    select: { id: true },
  })

  // The source layer, as dispatch left it: consumed (remainingQty 0), with the
  // dispatch snapshot frozen on the transfer line.
  const sourceLayer = await db.costLayer.create({
    data: {
      productId: product.id,
      warehouseId: source.id,
      receivedQty: `${LINE_QTY}.000000`,
      remainingQty: '0.000000',
      unitCostBase: UNIT_COST,
    },
    select: { id: true },
  })
  const snapshot = [{ costLayerId: sourceLayer.id, qty: `${LINE_QTY}.000000`, unitCostBase: `${UNIT_COST}.000000` }]

  const transfer = await db.stockTransfer.create({
    data: {
      reference: tag,
      fromWarehouseId: source.id,
      toWarehouseId: destination.id,
      status: 'IN_TRANSIT',
      dispatchedAt: new Date(),
      lines: {
        create: [{
          productId: product.id,
          sku: tag,
          productName: `r6 double-count ${label}`,
          qty: `${LINE_QTY}.0000`,
          qtyReceived: '0.0000',
          costLayerSnapshot: snapshot,
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const transferLineId = transfer.lines[0]!.id

  // The ASN the alignment credited against.
  const asn = await db.wmsAsnMap.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: 6oyu.19: a test fixture row, not a core flow branch
      externalAsnId: tag,
      sourceType: 'STOCK_TRANSFER',
      sourceId: transfer.id,
      warehouseId: destination.id,
      status: 'OPEN',
      lines: {
        create: [{
          externalAsnLineId: `${tag}-1`,
          sourceType: 'STOCK_TRANSFER_LINE',
          sourceLineId: transferLineId,
          productId: product.id,
          sku: tag,
          expectedQty: `${LINE_QTY}.0000`,
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const asnLineMapId = asn.lines[0]!.id

  // THE ALIGNMENT, as stock-sync.ts performs it: stock in at the destination, layers
  // rebuilt from the snapshot through the shared helper, and the credit recorded on
  // qtyAccountedViaSnapshot — with qtyReceived deliberately left alone, because the
  // alignment path never writes it. That omission is the finding.
  await db.$transaction(async (tx) => {
    await tx.stockLevel.create({
      data: { productId: product.id, warehouseId: destination.id, quantity: `${LINE_QTY}`, reservedQty: '0' },
    })
    await recreateTransferCostLayersFromSnapshotSlice(
      tx,
      {
        productId: product.id,
        warehouseId: destination.id,
        transferLineId,
        contextLabel: `transfer line ${transferLineId} WMS stock-sync alignment`,
      },
      snapshot,
    )
    await tx.wmsAsnLineMap.update({
      where: { id: asnLineMapId },
      data: { qtyAccountedViaSnapshot: { increment: LINE_QTY } },
    })
  }, TX)

  return { db, product, source, destination, sourceLayer, transfer, transferLineId, asnLineMapId, tag }
}

/** The real propagation deps, assembled from the same modules production uses. */
async function landedCostDeps() {
  const costLayers = await import('@/lib/cost-layers')
  return {
    getReturnedQtyForCostLayer: costLayers.getReturnedQtyForCostLayer,
    getSupplierReturnedQtyForCostLayer: costLayers.getSupplierReturnedQtyForCostLayer,
    getManufacturingConsumedQtyForCostLayer: costLayers.getManufacturingConsumedQtyForCostLayer,
    getReversalConsumedQtyForCostLayer: costLayers.getReversalConsumedQtyForCostLayer,
    getTransferConsumedQtyForCostLayer: costLayers.getTransferConsumedQtyForCostLayer,
    getDependentOutputSourceLines: costLayers.getDependentOutputSourceLines,
    updateSnapshotsForCostLayerChange: costLayers.updateSnapshotsForCostLayerChange,
    refreshShipmentCogsForCostLayerChange: costLayers.refreshShipmentCogsForCostLayerChange,
    refreshSalesOrderLineCogsForCostLayerChange: costLayers.refreshSalesOrderLineCogsForCostLayerChange,
    recordCostLayerRevaluation: costLayers.recordCostLayerRevaluation,
    warnWeightFallback: () => undefined,
    warnWeightZeroLines: () => undefined,
  }
}

/**
 * Apply a retrospective per-unit landed-cost change to `sourceCostLayerId` and return
 * what the reclassification would post, per reached output layer. This is the real
 * `propagateLandedCostToOutputs`; the accumulator is the same callback shape the
 * recalc paths pass it.
 */
async function applyLandedCostChange(sourceCostLayerId: string) {
  const { db } = await import('@/lib/db')
  const { Prisma } = await import('@/app/generated/prisma/client')
  const { propagateLandedCostToOutputs } = await import('@/lib/domain/purchasing/landed-cost-service')
  const deps = await landedCostDeps()

  const posted: Array<{ outputCostLayerId: string; inventoryDelta: string; cogsDelta: string }> = []
  await db.$transaction(async (tx) => {
    await propagateLandedCostToOutputs(
      tx,
      deps as never,
      sourceCostLayerId,
      new Prisma.Decimal(LANDED_COST_DELTA_PER_UNIT),
      (cogsDelta, inventoryDelta, audit) => {
        posted.push({
          outputCostLayerId: audit.outputCostLayerId,
          inventoryDelta: inventoryDelta.toFixed(2),
          cogsDelta: cogsDelta.toFixed(2),
        })
      },
      new Set<string>(),
      0,
      `r6-proof-${Date.now()}`,
      new Date(),
    )
  }, TX)

  const totalInventory = posted.reduce((sum, row) => sum + Number(row.inventoryDelta), 0)
  return { posted, totalInventory }
}

test(
  'THE DEFECT, measured: the pre-fix cancellation inputs say "nothing landed" while ten units have (Codex r6 HIGH-1)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // The precondition the whole finding rests on, read off the real row rather than
    // asserted in prose. If this ever stopped holding, the guard change below would
    // be guarding nothing.
    loadEnv()
    const { db, transferLineId, destination, sourceLayer } = await seedAlignedInTransitTransfer('inputs')
    const { loadTransferLineLandedQty, requireLandedQty } =
      await import('@/lib/domain/inventory/transfer-landed-quantity')

    const line = await db.stockTransferLine.findUniqueOrThrow({
      where: { id: transferLineId },
      select: { id: true, qty: true, qtyReceived: true },
    })

    // THE OLD READER, verbatim from the pre-fix cancellation.
    assert.equal(Number(line.qtyReceived ?? 0) > 0, false, 'the pre-fix guard sees nothing landed')
    assert.equal(Number(line.qty) - Number(line.qtyReceived), LINE_QTY, 'and would restore the WHOLE line')

    // THE NEW READER, on the same row.
    const landed = requireLandedQty(await loadTransferLineLandedQty(db, [line]), line.id)
    assert.equal(landed.qtyNumber, LINE_QTY, 'ten units have in fact landed')
    assert.equal(landed.fromQtyReceived.toNumber(), 0, 'none of them through qtyReceived')
    assert.equal(landed.fromUnabsorbedWmsSnapshot.toNumber(), LINE_QTY, 'all of them through the WMS snapshot credit')

    // And they are really on the shelf, in a real layer, linked to the source.
    assert.equal(
      await db.costLayer.count({ where: { warehouseId: destination.id, remainingQty: { gt: 0 } } }),
      1,
    )
    assert.equal(
      await db.costLayerSourceLine.count({ where: { sourceCostLayerId: sourceLayer.id } }),
      1,
      'exactly one live layer descends from the source layer at this point',
    )
  },
)

test(
  'align → cancel dispatch → landed-cost change posts the reclassification ONCE (Codex r6 HIGH-1)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db, transfer, sourceLayer, source } = await seedAlignedInTransitTransfer('money')
    const { cancelDispatchedTransfer } = await import('@/app/actions/transfers')

    // STEP 2: cancel the dispatch. The units have landed, so this must refuse —
    // restoring them to source would put the same ten units in two warehouses and,
    // worse, give them a second live cost layer.
    const result = await cancelDispatchedTransfer(transfer.id)
    assert.match(
      String(result.message),
      /already been partly received/,
      `cancelling an aligned dispatch must be refused, got ${JSON.stringify(result)}`,
    )
    assert.notEqual(result.success, true)

    // Nothing was restored to source.
    assert.equal(
      await db.costLayer.count({ where: { warehouseId: source.id, remainingQty: { gt: 0 } } }),
      0,
      'the cancellation must not have created a replacement layer at source',
    )
    assert.equal(
      await db.costLayerSourceLine.count({ where: { sourceCostLayerId: sourceLayer.id } }),
      1,
      'still exactly ONE layer descends from the source layer',
    )

    // STEP 3: the landed-cost change. THE ASSERTION IS THE AMOUNT.
    const { posted, totalInventory } = await applyLandedCostChange(sourceLayer.id)

    assert.equal(
      posted.length,
      1,
      `the reclassification must reach exactly one layer, reached ${posted.length}: ${JSON.stringify(posted)}`,
    )
    assert.equal(
      totalInventory.toFixed(2),
      (LANDED_COST_DELTA_PER_UNIT * LINE_QTY).toFixed(2),
      `£${LANDED_COST_DELTA_PER_UNIT}/unit on ${LINE_QTY} dispatched units must post ` +
      `£${(LANDED_COST_DELTA_PER_UNIT * LINE_QTY).toFixed(2)} of inventory reclassification, not ` +
      `£${totalInventory.toFixed(2)} — a second live layer means the same units were revalued twice ` +
      `(${JSON.stringify(posted)})`,
    )
  },
)

test(
  'a transfer with NOTHING landed can still have its dispatch cancelled (Codex r6 — not vacuous)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // The refusal above must discriminate. Without this, changing the guard to
    // "always refuse" would pass every assertion in this file.
    loadEnv()
    const { db, transfer, sourceLayer, source, asnLineMapId } = await seedAlignedInTransitTransfer('nothing')
    // Undo the alignment credit and its layer, leaving a plain dispatched transfer.
    await db.costLayerSourceLine.deleteMany({ where: { sourceCostLayerId: sourceLayer.id } })
    await db.costLayer.deleteMany({ where: { id: { not: sourceLayer.id }, poLineId: null, warehouseId: { not: source.id } } })
    await db.wmsAsnLineMap.update({ where: { id: asnLineMapId }, data: { qtyAccountedViaSnapshot: 0 } })

    const { cancelDispatchedTransfer } = await import('@/app/actions/transfers')
    const result = await cancelDispatchedTransfer(transfer.id)
    assert.equal(result.success, true, `an un-landed dispatch must still be cancellable, got ${JSON.stringify(result)}`)

    const cancelled = await db.stockTransfer.findUniqueOrThrow({
      where: { id: transfer.id },
      select: { status: true },
    })
    assert.equal(cancelled.status, 'CANCELLED')
    assert.equal(
      await db.costLayer.count({ where: { warehouseId: source.id, remainingQty: { gt: 0 } } }),
      1,
      'and the stranded units come back to source in exactly one replacement layer',
    )

    // The replacement layer is reachable, and the reclassification still posts once.
    const { posted, totalInventory } = await applyLandedCostChange(sourceLayer.id)
    assert.equal(posted.length, 1)
    assert.equal(totalInventory.toFixed(2), (LANDED_COST_DELTA_PER_UNIT * LINE_QTY).toFixed(2))
  },
)

test(
  'a MANUAL receipt after an alignment does not re-lay the aligned layers (Codex r6 HIGH-1, mirror)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // The same defect reached from the other side: the manual receipt path sliced the
    // dispatch snapshot from `qtyReceived`, which is zero for an aligned line, and so
    // re-created every layer the alignment had already laid down.
    loadEnv()
    const { db, transfer, sourceLayer, destination, transferLineId, asnLineMapId } =
      await seedAlignedInTransitTransfer('manual')
    const { receiveTransfer } = await import('@/app/actions/transfers')

    const result = await receiveTransfer(transfer.id)
    assert.equal(result.success, true, `receiving must succeed, got ${JSON.stringify(result)}`)

    assert.equal(
      await db.costLayer.count({ where: { warehouseId: destination.id } }),
      1,
      'the aligned units must NOT get a second destination layer',
    )
    assert.equal(
      await db.costLayerSourceLine.count({ where: { sourceCostLayerId: sourceLayer.id } }),
      1,
    )

    // And the landed total is still ten, not twenty: closing the line folded the
    // alignment credit into qtyReceived AND marked it absorbed, so the two counters
    // do not both claim the same units.
    const { loadTransferLineLandedQty, requireLandedQty } =
      await import('@/lib/domain/inventory/transfer-landed-quantity')
    const line = await db.stockTransferLine.findUniqueOrThrow({
      where: { id: transferLineId },
      select: { id: true, qtyReceived: true },
    })
    assert.equal(Number(line.qtyReceived), LINE_QTY, 'the line reads fully received')
    const asnRow = await db.wmsAsnLineMap.findUniqueOrThrow({
      where: { id: asnLineMapId },
      select: { qtyAccountedViaSnapshot: true, qtyAccountedViaReceipt: true },
    })
    assert.equal(Number(asnRow.qtyAccountedViaReceipt), LINE_QTY, 'and the WMS credit is marked absorbed')
    const landed = requireLandedQty(await loadTransferLineLandedQty(db, [line]), line.id)
    assert.equal(landed.qtyNumber, LINE_QTY, 'landed stays at ten — the counters do not double-count')

    const { posted, totalInventory } = await applyLandedCostChange(sourceLayer.id)
    assert.equal(posted.length, 1)
    assert.equal(totalInventory.toFixed(2), (LANDED_COST_DELTA_PER_UNIT * LINE_QTY).toFixed(2))
  },
)
