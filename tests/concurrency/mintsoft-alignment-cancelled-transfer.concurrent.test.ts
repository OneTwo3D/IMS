import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * 6oyu.19 / Codex round-7 HIGH-1 — THE CANCELLED-PARENT ROUTE.
 *
 * THE SEQUENCE: a dispatched transfer has its dispatch CANCELLED, which restores the
 * full line and a replacement cost layer to the SOURCE — and leaves the transfer's
 * ASN OPEN, because nothing closes it. A later automatic align-up then finds that
 * still-open ASN line, brings the units into stock at the DESTINATION and lays a
 * second replacement layer linked back to the same source layer. One landed-cost
 * change afterwards reaches BOTH live layers and posts the inventory
 * reclassification twice for one dispatch.
 *
 * PRE-EXISTING, NOT INTRODUCED HERE. The alignment path has never validated the
 * parent transfer's status — see the merge-base version of
 * lib/connectors/mintsoft/sync/stock-sync.ts, whose `getAlignmentCandidateLines`
 * selects on the ASN alone. It is closed on this branch anyway: the branch exists to
 * stop transit units being counted twice, and shipping it with a known open
 * double-count route would undercut its own claim. Production prevalence is tracked
 * on o3d-1mga.
 *
 * THE FIX has two halves, and this file proves both:
 *   · the candidate query refuses an ASN whose parent transfer is not IN_TRANSIT or
 *     RECEIVED — the same predicate the WMS webhook book-in has always applied; and
 *   · alignment now takes the `stock_transfers` lock that cancellation takes, so the
 *     status it reads is a fact the lock covers and the two cannot interleave.
 *
 * Needs a real PostgreSQL: the propagation walks `cost_layer_source_lines` in SQL,
 * and the locking half is only meaningful against a real transaction manager.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const TX = { timeout: 20000, maxWait: 10000 }

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/domain/wms/mutation-audit', {
  namedExports: { recordWmsMutationEvent: async () => {} },
})
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
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
 * A dispatched (IN_TRANSIT) transfer with a frozen cost-layer snapshot and an OPEN
 * ASN at the destination — the state a WMS-fulfilled transfer sits in between
 * dispatch and book-in. NOTHING has landed.
 */
async function seedDispatchedTransferWithOpenAsn(label: string) {
  const { db } = await import('@/lib/db')

  // A short, collision-free warehouse code: `code` is UNIQUE and the fixture rows
  // outlive the run, so a truncated prefix of the tag would collide on a re-run.
  const uid = `${Date.now().toString(36)}${Math.floor(Math.random() * 1_679_616).toString(36).padStart(4, '0')}`.toUpperCase()
  const tag = `R7CX-${label}-${process.pid}-${uid}`
  const product = await db.product.create({
    data: { sku: tag, name: `r7 cancelled-parent ${label}`, type: 'SIMPLE', countryOfOrigin: 'CN' },
    select: { id: true },
  })
  const source = await db.warehouse.create({
    data: { code: `R7${uid}S`, name: `${tag} source`, type: 'STANDARD' },
    select: { id: true, code: true, name: true },
  })
  const destination = await db.warehouse.create({
    data: { code: `R7${uid}D`, name: `${tag} dest`, type: 'STANDARD' },
    select: { id: true, code: true, name: true },
  })

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
          productName: `r7 cancelled-parent ${label}`,
          qty: `${LINE_QTY}.0000`,
          qtyReceived: '0.0000',
          costLayerSnapshot: snapshot,
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const transferLineId = transfer.lines[0]!.id

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

  const binding = {
    id: `binding-${tag}`,
    connector: 'mintsoft', // wms-connector-boundary-ok: 6oyu.19: a test fixture value, not a core flow branch
    active: true,
    externalWarehouseId: '1',
    stockSyncMode: 'ALIGN_TO_WMS' as const,
    syncFrequencyMinutes: 60,
    discrepancyThresholds: null,
    reportRecipients: [],
    alignmentConfirmedAt: new Date(),
    alignDownReasonId: null,
    warehouseId: destination.id,
    lastStockSyncAt: null,
    connection: { active: true },
    warehouse: destination,
  }

  return {
    db,
    product,
    source,
    destination,
    sourceLayer,
    transfer,
    transferLineId,
    asnLineMapId: asn.lines[0]!.id,
    externalAsnId: tag,
    binding,
    tag,
  }
}

async function alignUp(binding: unknown, productId: string, sku: string) {
  const { applyMintsoftAlignmentForProduct } =
    await import('@/lib/connectors/mintsoft/sync/stock-sync')
  return applyMintsoftAlignmentForProduct({
    binding: binding as never,
    jobId: `r7-proof-${Date.now()}`,
    productId,
    sku,
    delta: LINE_QTY,
    dryRun: false,
  })
}

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

async function applyLandedCostChange(sourceCostLayerId: string) {
  const { db } = await import('@/lib/db')
  const { Prisma } = await import('@/app/generated/prisma/client')
  const { propagateLandedCostToOutputs } = await import('@/lib/domain/purchasing/landed-cost-service')
  const deps = await landedCostDeps()

  const posted: Array<{ outputCostLayerId: string; inventoryDelta: string }> = []
  await db.$transaction(async (tx) => {
    await propagateLandedCostToOutputs(
      tx,
      deps as never,
      sourceCostLayerId,
      new Prisma.Decimal(LANDED_COST_DELTA_PER_UNIT),
      (_cogsDelta, inventoryDelta, audit) => {
        posted.push({ outputCostLayerId: audit.outputCostLayerId, inventoryDelta: inventoryDelta.toFixed(2) })
      },
      new Set<string>(),
      0,
      `r7-proof-${Date.now()}`,
      new Date(),
    )
  }, TX)

  return { posted, totalInventory: posted.reduce((sum, row) => sum + Number(row.inventoryDelta), 0) }
}

test(
  'THE PRECONDITION: cancelling a dispatch leaves the ASN OPEN and still pointing at the line (Codex r7 HIGH-1)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // If cancellation closed the ASN there would be no route at all, and the guard
    // below would be guarding nothing. Read off the real rows.
    loadEnv()
    const { db, transfer, asnLineMapId, source } = await seedDispatchedTransferWithOpenAsn('precondition')
    const { cancelDispatchedTransfer } = await import('@/app/actions/transfers')

    const result = await cancelDispatchedTransfer(transfer.id)
    assert.equal(result.success, true, `nothing landed, so the cancel must succeed: ${JSON.stringify(result)}`)

    const cancelled = await db.stockTransfer.findUniqueOrThrow({
      where: { id: transfer.id },
      select: { status: true },
    })
    assert.equal(cancelled.status, 'CANCELLED')
    assert.equal(
      await db.costLayer.count({ where: { warehouseId: source.id, remainingQty: { gt: 0 } } }),
      1,
      'the full line came back to source in a replacement layer',
    )

    const asnLine = await db.wmsAsnLineMap.findUniqueOrThrow({
      where: { id: asnLineMapId },
      select: { asn: { select: { closedAt: true, status: true } } },
    })
    assert.equal(asnLine.asn.closedAt, null, 'and its ASN is STILL OPEN — this is the route')
    assert.equal(asnLine.asn.status, 'OPEN')
  },
)

test(
  'cancel dispatch → align-up must NOT create a second layer; the reclassification posts ONCE (Codex r7 HIGH-1)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db, transfer, sourceLayer, destination, product, binding, tag } =
      await seedDispatchedTransferWithOpenAsn('sequential')
    const { cancelDispatchedTransfer } = await import('@/app/actions/transfers')

    const cancel = await cancelDispatchedTransfer(transfer.id)
    assert.equal(cancel.success, true, `cancel must succeed: ${JSON.stringify(cancel)}`)

    // THE ALIGN-UP, against the still-open ASN of a CANCELLED transfer.
    const aligned = await alignUp(binding, product.id, tag)

    assert.equal(aligned.applied, false, `alignment must refuse a cancelled parent, got ${JSON.stringify(aligned)}`)
    assert.match(
      aligned.reason,
      /CANCELLED/,
      `the refusal must name the reason an operator can act on, got: ${aligned.reason}`,
    )

    assert.equal(
      await db.costLayer.count({ where: { warehouseId: destination.id } }),
      0,
      'no destination layer may exist — the units are back at source',
    )
    assert.equal(
      await db.stockLevel.count({ where: { warehouseId: destination.id, quantity: { gt: 0 } } }),
      0,
      'and no destination stock was booked in',
    )
    assert.equal(
      await db.costLayerSourceLine.count({ where: { sourceCostLayerId: sourceLayer.id } }),
      1,
      'exactly ONE live layer descends from the source layer',
    )

    // THE ASSERTION IS THE AMOUNT.
    const { posted, totalInventory } = await applyLandedCostChange(sourceLayer.id)
    assert.equal(
      posted.length,
      1,
      `the reclassification must reach exactly one layer, reached ${posted.length}: ${JSON.stringify(posted)}`,
    )
    assert.equal(
      totalInventory.toFixed(2),
      (LANDED_COST_DELTA_PER_UNIT * LINE_QTY).toFixed(2),
      `£${LANDED_COST_DELTA_PER_UNIT}/unit on ${LINE_QTY} units must post ` +
      `£${(LANDED_COST_DELTA_PER_UNIT * LINE_QTY).toFixed(2)}, not £${totalInventory.toFixed(2)} ` +
      `(${JSON.stringify(posted)})`,
    )
  },
)

test(
  'an IN_TRANSIT parent still aligns — the refusal discriminates (Codex r7 — not vacuous)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // Without this, changing the candidate query to "refuse everything" would satisfy
    // every assertion above.
    loadEnv()
    const { db, sourceLayer, destination, product, binding, tag, asnLineMapId } =
      await seedDispatchedTransferWithOpenAsn('positive')

    const aligned = await alignUp(binding, product.id, tag)
    assert.equal(aligned.applied, true, `an IN_TRANSIT parent must align, got ${JSON.stringify(aligned)}`)
    assert.equal(aligned.correctedQty, LINE_QTY)

    assert.equal(
      await db.costLayer.count({ where: { warehouseId: destination.id, remainingQty: { gt: 0 } } }),
      1,
      'the aligned units land in exactly one destination layer',
    )
    const asnRow = await db.wmsAsnLineMap.findUniqueOrThrow({
      where: { id: asnLineMapId },
      select: { qtyAccountedViaSnapshot: true },
    })
    assert.equal(Number(asnRow.qtyAccountedViaSnapshot), LINE_QTY, 'and the ASN credit was recorded')

    const { posted, totalInventory } = await applyLandedCostChange(sourceLayer.id)
    assert.equal(posted.length, 1)
    assert.equal(totalInventory.toFixed(2), (LANDED_COST_DELTA_PER_UNIT * LINE_QTY).toFixed(2))
  },
)

test(
  'a follow-up ASN absorbs its whole remainder after an earlier ASN closed (Codex r7 HIGH-2, end to end)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // The round-6 regression, driven through the real alignment against real rows: a
    // ten-unit line, three units absorbed on a first ASN which is then CLOSED, and a
    // follow-up ASN raised for the remaining seven. Round 6 charged the line-wide
    // three against the follow-up ASN's own seven, exposed four, and rejected the
    // seven-unit delta outright — leaving IMS seven units short.
    loadEnv()
    const { db, sourceLayer, destination, product, binding, tag, transferLineId, asnLineMapId } =
      await seedDispatchedTransferWithOpenAsn('multi-asn')

    // First ASN: expect three, absorb three, then close it.
    await db.wmsAsnLineMap.update({
      where: { id: asnLineMapId },
      data: { expectedQty: '3.0000', qtyAccountedViaSnapshot: '3.0000' },
    })
    const firstAsn = await db.wmsAsnLineMap.findUniqueOrThrow({
      where: { id: asnLineMapId },
      select: { asnMapId: true },
    })
    await db.wmsAsnMap.update({
      where: { id: firstAsn.asnMapId },
      data: { status: 'BOOKED_IN', closedAt: new Date() },
    })
    // The three units really are on the shelf at the destination.
    const { recreateTransferCostLayersFromSnapshotSlice } =
      await import('@/lib/domain/inventory/transfer-cost-layer-recreation')
    await db.$transaction(async (tx) => {
      await tx.stockLevel.create({
        data: { productId: product.id, warehouseId: destination.id, quantity: '3', reservedQty: '0' },
      })
      await recreateTransferCostLayersFromSnapshotSlice(
        tx,
        {
          productId: product.id,
          warehouseId: destination.id,
          transferLineId,
          contextLabel: `transfer line ${transferLineId} WMS stock-sync alignment`,
        },
        [{ costLayerId: sourceLayer.id, qty: '3.000000', unitCostBase: `${UNIT_COST}.000000` }],
      )
    }, TX)

    // The follow-up ASN, raised for the remaining seven.
    await db.wmsAsnMap.create({
      data: {
        connector: 'mintsoft', // wms-connector-boundary-ok: 6oyu.19: a test fixture row, not a core flow branch
        externalAsnId: `${tag}-2`,
        sourceType: 'STOCK_TRANSFER',
        sourceId: (await db.stockTransferLine.findUniqueOrThrow({
          where: { id: transferLineId }, select: { transferId: true },
        })).transferId,
        warehouseId: destination.id,
        status: 'OPEN',
        lines: {
          create: [{
            externalAsnLineId: `${tag}-2-1`,
            sourceType: 'STOCK_TRANSFER_LINE',
            sourceLineId: transferLineId,
            productId: product.id,
            sku: tag,
            expectedQty: '7.0000',
          }],
        },
      },
    })

    const { applyMintsoftAlignmentForProduct } =
      await import('@/lib/connectors/mintsoft/sync/stock-sync')
    const aligned = await applyMintsoftAlignmentForProduct({
      binding: binding as never,
      jobId: `r7-h2-${Date.now()}`,
      productId: product.id,
      sku: tag,
      delta: 7,
      dryRun: false,
    })

    assert.equal(
      aligned.applied,
      true,
      `all seven remaining units must allocate, got ${JSON.stringify(aligned)} ` +
      '(round 6 rejected this with three unallocated)',
    )
    assert.equal(aligned.correctedQty, 7)

    const stock = await db.stockLevel.findFirstOrThrow({
      where: { productId: product.id, warehouseId: destination.id },
      select: { quantity: true },
    })
    assert.equal(Number(stock.quantity), LINE_QTY, 'IMS destination stock is the full ten, not three')
  },
)

test(
  'a cancellation racing an alignment cannot produce a second layer either (Codex r7 HIGH-1, concurrent)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // Cancellation locks the transfer; alignment used to lock ASN rows only, so the
    // two could interleave and both commit. Alignment now takes the SAME transfer
    // lock, so whichever wins, the loser sees the winner's committed state:
    //   · cancel first  → alignment's post-lock re-read sees CANCELLED and refuses;
    //   · align first   → cancellation's landed guard sees ten landed and refuses.
    // Either way exactly one live layer descends from the source layer.
    loadEnv()
    const { db, transfer, sourceLayer, product, binding, tag } =
      await seedDispatchedTransferWithOpenAsn('race')
    const { cancelDispatchedTransfer } = await import('@/app/actions/transfers')

    const [cancelResult, alignResult] = await Promise.all([
      cancelDispatchedTransfer(transfer.id),
      alignUp(binding, product.id, tag),
    ])

    assert.equal(
      cancelResult.success === true && alignResult.applied === true,
      false,
      `the cancellation and the alignment must not BOTH succeed: ` +
      `${JSON.stringify({ cancelResult, alignResult })}`,
    )
    assert.equal(
      cancelResult.success === true || alignResult.applied === true,
      true,
      `one of them must succeed — a deadlock or a double refusal would strand the units: ` +
      `${JSON.stringify({ cancelResult, alignResult })}`,
    )

    assert.equal(
      await db.costLayerSourceLine.count({ where: { sourceCostLayerId: sourceLayer.id } }),
      1,
      `exactly ONE live layer may descend from the source layer, whichever won ` +
      `(${JSON.stringify({ cancelResult, alignResult })})`,
    )

    const { posted, totalInventory } = await applyLandedCostChange(sourceLayer.id)
    assert.equal(posted.length, 1, `reached ${posted.length} layers: ${JSON.stringify(posted)}`)
    assert.equal(
      totalInventory.toFixed(2),
      (LANDED_COST_DELTA_PER_UNIT * LINE_QTY).toFixed(2),
      `the reclassification must post once (${JSON.stringify(posted)})`,
    )
  },
)
