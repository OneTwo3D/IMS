import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * 6oyu.19, Codex round 8 HIGH-1 — A BOOKING LARGER THAN THE SNAPSHOT CAN COST.
 *
 * `recreateTransferCostLayersFromSnapshotSlice` guarantees that the layers it lays
 * down cover the stock its caller has already incremented. Until this round it
 * measured that against the SLICE it was handed, and the slice is only as long as
 * the dispatch snapshot allows. A ten-unit booking against a snapshot with six
 * unconsumed units produced a six-unit slice, six layers, and a postcondition
 * comparing six with six — which passed, while stock went up by ten.
 *
 * Both live paths that increment stock without a balancing step of their own are
 * proved here, END TO END against a real PostgreSQL, because the defect is in the
 * relationship between a stock_levels row and a set of cost_layers rows and neither
 * can be faked:
 *
 *   · the WMS STOCK-SYNC ALIGNMENT must not book what it cannot cost. Its plan is
 *     capped by `remainingCostableSnapshotQty`, so the delta comes back only partly
 *     explained and — because a partly explained delta is refused outright — NO
 *     stock moves at all.
 *   · the WMS WEBHOOK BOOK-IN must book all ten, because Mintsoft has physically
 *     received them, and back every one: six costed from the snapshot and four in a
 *     £0 balancing layer, with a WARNING recorded.
 *
 * THE ASSERTION THAT FAILS WITHOUT THE FIX, on both paths: Σ cost_layers.receivedQty
 * at the destination equals the stock_levels quantity there.
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
const COSTED_QTY = 6
const UNCOSTED_QTY = LINE_QTY - COSTED_QTY
const UNIT_COST = 5

/**
 * A dispatched transfer whose dispatch snapshot UNDER-RECORDS the units it shipped:
 * ten units left the source, only six of them had a cost layer behind them.
 *
 * This is not a contrived state. It is cogs-audit scjz.5 — a source warehouse
 * holding legacy stock with no FIFO layer — and the manual receipt path has carried
 * a £0 balancing layer for it since that audit. The other three paths did not.
 */
async function seedUnderCostedDispatch(label: string, snapshotQty = COSTED_QTY) {
  const { db } = await import('@/lib/db')

  const uid = `${Date.now().toString(36)}${Math.floor(Math.random() * 1_679_616).toString(36).padStart(4, '0')}`.toUpperCase()
  const tag = `R8SF-${label}-${process.pid}-${uid}`
  const product = await db.product.create({
    data: { sku: tag, name: `r8 snapshot shortfall ${label}`, type: 'SIMPLE', countryOfOrigin: 'CN' },
    select: { id: true },
  })
  const source = await db.warehouse.create({
    data: { code: `R8${uid}S`, name: `${tag} source`, type: 'STANDARD' },
    select: { id: true, code: true, name: true },
  })
  const destination = await db.warehouse.create({
    data: { code: `R8${uid}D`, name: `${tag} dest`, type: 'STANDARD' },
    select: { id: true, code: true, name: true },
  })

  const sourceLayer = await db.costLayer.create({
    data: {
      productId: product.id,
      warehouseId: source.id,
      receivedQty: `${snapshotQty}.000000`,
      remainingQty: '0.000000',
      unitCostBase: UNIT_COST,
    },
    select: { id: true },
  })
  // TEN units dispatched; the snapshot records only `snapshotQty` of them.
  const snapshot = [{ costLayerId: sourceLayer.id, qty: `${snapshotQty}.000000`, unitCostBase: `${UNIT_COST}.000000` }]

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
          productName: `r8 snapshot shortfall ${label}`,
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
    select: { id: true, lines: { select: { id: true, externalAsnLineId: true } } },
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

  return { db, tag, product, source, destination, sourceLayer, transfer, transferLineId, asn, binding }
}

/** Σ receivedQty over every cost layer at a warehouse, and the stock level there. */
async function stockVersusLayers(db: {
  costLayer: { findMany: (args: unknown) => Promise<Array<{ receivedQty: unknown; unitCostBase: unknown }>> }
  stockLevel: { findUnique: (args: unknown) => Promise<{ quantity: unknown } | null> }
}, productId: string, warehouseId: string) {
  const layers = await db.costLayer.findMany({
    where: { productId, warehouseId },
    select: { receivedQty: true, unitCostBase: true },
  })
  const level = await db.stockLevel.findUnique({
    where: { productId_warehouseId: { productId, warehouseId } },
    select: { quantity: true },
  })
  return {
    layerQty: layers.reduce((sum, layer) => sum + Number(layer.receivedQty), 0),
    stockQty: Number(level?.quantity ?? 0),
    zeroCostLayerQty: layers
      .filter((layer) => Number(layer.unitCostBase) === 0)
      .reduce((sum, layer) => sum + Number(layer.receivedQty), 0),
    layerCount: layers.length,
  }
}

// ---------------------------------------------------------------------------
// Path 1 — the WMS stock-sync ALIGNMENT
// ---------------------------------------------------------------------------

test(
  'ALIGNMENT: a delta larger than the snapshot can cost books NOTHING (Codex r8 HIGH-1)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db, tag, product, destination, binding } = await seedUnderCostedDispatch('align')
    const { applyMintsoftAlignmentForProduct } =
      await import('@/lib/connectors/mintsoft/sync/stock-sync')

    // Mintsoft reports TEN more units than IMS has. The ASN expects ten and the
    // transfer line has ten outstanding, so before this round the plan allocated all
    // ten — and the six-unit slice satisfied the slice-scoped postcondition.
    const result = await applyMintsoftAlignmentForProduct({
      binding: binding as never,
      jobId: `r8-align-${Date.now()}`,
      productId: product.id,
      sku: tag,
      delta: LINE_QTY,
      dryRun: false,
    })

    assert.equal(result.applied, false, `the alignment must refuse: ${JSON.stringify(result)}`)
    assert.equal(result.correctedQty, 0)
    // Only six of the ten are explicable, and a partly explained delta is refused
    // whole — so the operator sees the discrepancy instead of six invented units.
    assert.match(result.reason, new RegExp(`only explain ${COSTED_QTY}`))
    assert.match(result.reason, /dispatch snapshot can only cost/)

    const after = await stockVersusLayers(db as never, product.id, destination.id)
    assert.equal(after.stockQty, 0, 'no stock may be booked at the destination')
    assert.equal(after.layerQty, 0, 'and no cost layer may be created')
    // THE IDENTITY. Without the fix this reads stockQty 10 against layerQty 6.
    assert.equal(after.stockQty, after.layerQty, 'stock on hand must equal Σ layer quantity')
  },
)

test(
  'ALIGNMENT: the same delta over a FULL snapshot still applies — the cap is not vacuous (Codex r8)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // If the cap simply refused every transfer-backed candidate, the test above would
    // pass for the wrong reason and alignment would be dead. Same shape, snapshot
    // covering all ten.
    loadEnv()
    const { db, tag, product, destination, binding } = await seedUnderCostedDispatch('alignfull', LINE_QTY)
    const { applyMintsoftAlignmentForProduct } =
      await import('@/lib/connectors/mintsoft/sync/stock-sync')

    const result = await applyMintsoftAlignmentForProduct({
      binding: binding as never,
      jobId: `r8-alignfull-${Date.now()}`,
      productId: product.id,
      sku: tag,
      delta: LINE_QTY,
      dryRun: false,
    })

    assert.equal(result.applied, true, `the alignment must still apply: ${JSON.stringify(result)}`)
    assert.equal(result.correctedQty, LINE_QTY)

    const after = await stockVersusLayers(db as never, product.id, destination.id)
    assert.equal(after.stockQty, LINE_QTY)
    assert.equal(after.layerQty, LINE_QTY)
    assert.equal(after.zeroCostLayerQty, 0, 'a fully costed snapshot must need no balancing layer')
  },
)

// ---------------------------------------------------------------------------
// Path 2 — the WMS WEBHOOK book-in
// ---------------------------------------------------------------------------

test(
  'WEBHOOK: ten units booked in over a six-unit snapshot are ALL backed by a layer (Codex r8 HIGH-1)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db, tag, product, destination, asn, transferLineId } = await seedUnderCostedDispatch('webhook')
    const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')

    const event = await db.wmsInboundReceiptEvent.create({
      data: {
        connector: 'mintsoft', // wms-connector-boundary-ok: 6oyu.19: a test fixture row, not a core flow branch
        externalEventId: `${tag}-evt`,
        externalAsnId: tag,
        payload: { asnId: tag },
      },
      select: { id: true },
    })

    // Mintsoft says all ten were booked in. It is not wrong — the goods are on the
    // shelf. The snapshot simply cannot cost four of them.
    const outcome = await processBookedInEvent(event.id, {
      fetchRemoteAsn: async () => ({
        externalAsnId: tag,
        status: 'RECEIVED',
        lines: [{
          externalLineId: asn.lines[0]!.externalAsnLineId,
          sourceLineId: transferLineId,
          externalProductId: null,
          sku: tag,
          quantity: LINE_QTY,
          raw: null,
        }],
        raw: null,
      }),
    })

    assert.equal(outcome.status, 'processed', `the book-in must not fail: ${JSON.stringify(outcome)}`)

    const after = await stockVersusLayers(db as never, product.id, destination.id)
    assert.equal(after.stockQty, LINE_QTY, 'all ten physically received units must be booked')
    // THE IDENTITY. Without the fix this reads layerQty 6 against stockQty 10.
    assert.equal(
      after.layerQty,
      LINE_QTY,
      `Σ layer quantity must equal the booked stock, got ${JSON.stringify(after)}`,
    )
    assert.equal(after.stockQty, after.layerQty, 'stock on hand must equal Σ layer quantity')
    // And the four uncosted units are visibly uncosted, not smeared over the six.
    assert.equal(after.zeroCostLayerQty, UNCOSTED_QTY, 'the shortfall must sit in a £0 layer of its own')
    assert.equal(after.layerCount, 2, 'one costed layer of six, one balancing layer of four')

    const warning = await db.activityLog.findFirst({
      where: { action: 'transfer_uncosted_balancing_layer', entityId: transferLineId },
      select: { level: true, description: true },
    })
    assert.ok(warning, 'the £0 balancing layer must be reportable, not silent')
    assert.equal(warning!.level, 'WARNING')
    assert.match(String(warning!.description), new RegExp(`${UNCOSTED_QTY}\\.000000-unit shortfall`))
  },
)

test(
  'WEBHOOK: a FULL snapshot books ten and creates no balancing layer (Codex r8 — not vacuous)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // The balancing branch must be reached because of the shortfall, not on every
    // book-in.
    loadEnv()
    const { db, tag, product, destination, asn, transferLineId } =
      await seedUnderCostedDispatch('webhookfull', LINE_QTY)
    const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')

    const event = await db.wmsInboundReceiptEvent.create({
      data: {
        connector: 'mintsoft', // wms-connector-boundary-ok: 6oyu.19: a test fixture row, not a core flow branch
        externalEventId: `${tag}-evt`,
        externalAsnId: tag,
        payload: { asnId: tag },
      },
      select: { id: true },
    })

    const outcome = await processBookedInEvent(event.id, {
      fetchRemoteAsn: async () => ({
        externalAsnId: tag,
        status: 'RECEIVED',
        lines: [{
          externalLineId: asn.lines[0]!.externalAsnLineId,
          sourceLineId: transferLineId,
          externalProductId: null,
          sku: tag,
          quantity: LINE_QTY,
          raw: null,
        }],
        raw: null,
      }),
    })

    assert.equal(outcome.status, 'processed', JSON.stringify(outcome))
    const after = await stockVersusLayers(db as never, product.id, destination.id)
    assert.equal(after.stockQty, LINE_QTY)
    assert.equal(after.layerQty, LINE_QTY)
    assert.equal(after.zeroCostLayerQty, 0)
    assert.equal(after.layerCount, 1)
  },
)

// ---------------------------------------------------------------------------
// Path 3 — the DISPATCH CANCELLATION, the fourth call site (Codex round-9 LOW-1)
// ---------------------------------------------------------------------------

test(
  'CANCELLATION: ten units restored over a six-unit snapshot are ALL backed by a layer (Codex r9 LOW-1)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // THE GAP THIS CLOSES. Three of the four call sites had a behavioural
    // short-snapshot regression and this one — cancellation — did not. It passes
    // `bookedQty: restoreQty`, the FULL outstanding line quantity, and the snapshot
    // can cover less than that. Change that argument to a slice-derived quantity
    // (`snapshotSlice.reduce(...qty)`, the shape the other three sites had before
    // round 8) and the helper's coverage check compares six with six and passes,
    // while the restore above it has already put ten units back at the source. That
    // is the unlayered-stock defect exactly, and until this test nothing behavioural
    // would have gone red.
    //
    // It restores to the SOURCE, so the identity is measured as a DELTA: the source
    // already carries the dispatch layer these units were consumed from.
    loadEnv()
    const { db, tag, product, source, transfer } = await seedUnderCostedDispatch('cancel')
    const { cancelDispatchedTransfer } = await import('@/app/actions/transfers')

    const before = await stockVersusLayers(db as never, product.id, source.id)
    assert.equal(before.stockQty, 0, 'fixture: the dispatch left no stock at the source')
    assert.equal(before.layerQty, COSTED_QTY, 'fixture: only the six-unit dispatch layer is there')

    const result = await cancelDispatchedTransfer(transfer.id)
    assert.equal(result.success, true, `the cancellation must succeed: ${JSON.stringify(result)}`)

    const after = await stockVersusLayers(db as never, product.id, source.id)
    // TEN units came back, so TEN units of new layer must have come back with them.
    assert.equal(after.stockQty - before.stockQty, LINE_QTY, 'the full outstanding line is restored')
    assert.equal(
      after.layerQty - before.layerQty,
      LINE_QTY,
      'every restored unit must be backed by a layer — six costed from the snapshot, four balanced at £0',
    )
    // THE IDENTITY. Without the fix this reads a stock delta of 10 against a layer
    // delta of 6.
    assert.equal(after.stockQty - before.stockQty, after.layerQty - before.layerQty)
    assert.equal(
      after.zeroCostLayerQty,
      UNCOSTED_QTY,
      'the four units the snapshot could not cost must be conserved in a £0 balancing layer',
    )

    // And the record of that policy is DURABLE — same transaction as the layer it
    // describes (Codex round-9 MEDIUM-2). Before this round it went through
    // `logActivity` on a separate connection, which swallows its own failures.
    const warning = await db.activityLog.findFirst({
      where: { action: 'transfer_uncosted_balancing_layer', entityId: transfer.lines[0]!.id },
      select: { level: true, description: true },
    })
    assert.ok(warning, 'the £0 balancing layer must leave a durable WARNING behind')
    assert.equal(warning.level, 'WARNING')
    assert.match(String(warning.description), new RegExp(`${UNCOSTED_QTY}\\.000000-unit shortfall`))
  },
)

test(
  'CANCELLATION: a FULL snapshot restores ten and creates no balancing layer (Codex r9 — not vacuous)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // The same guard against the test above passing for the wrong reason: if the
    // balancing branch fired on every cancellation, the £0 assertion would hold no
    // matter what the snapshot covered.
    loadEnv()
    const { db, tag, product, source, transfer } = await seedUnderCostedDispatch('cancelfull', LINE_QTY)
    const { cancelDispatchedTransfer } = await import('@/app/actions/transfers')

    const before = await stockVersusLayers(db as never, product.id, source.id)
    const result = await cancelDispatchedTransfer(transfer.id)
    assert.equal(result.success, true, `the cancellation must succeed: ${JSON.stringify(result)}`)

    const after = await stockVersusLayers(db as never, product.id, source.id)
    assert.equal(after.stockQty - before.stockQty, LINE_QTY)
    assert.equal(after.layerQty - before.layerQty, LINE_QTY)
    assert.equal(after.zeroCostLayerQty, 0, 'a fully costed snapshot must need no balancing layer')
    const warning = await db.activityLog.findFirst({
      where: { action: 'transfer_uncosted_balancing_layer', entityId: transfer.lines[0]!.id },
      select: { id: true },
    })
    assert.equal(warning, null, 'and must leave no shortfall warning behind')
    void tag
  },
)

void TX
