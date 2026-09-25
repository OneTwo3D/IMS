import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

import { normalizeMintsoftAsnFetchByIdResult } from '@/lib/connectors/mintsoft/api/client'
import { LIVE_ASN_SOURCE_LINE_ID, liveAsnBody, liveAsnItem } from '@/tests/fixtures/mintsoft-live-asn-bodies'

/**
 * o3d-btiw — THE BOOKED-IN PATH, END TO END OVER THE RECORDED LIVE MINTSOFT ASN SHAPE.
 *
 * WHY THIS TIER. The defect is in the relationship between what Mintsoft's wire says and what lands in
 * `stock_levels`, `cost_layers` and `purchase_order_lines.qtyReceived`. The five tests that already
 * drove `processBookedInEvent` all HAND-BUILT the normalized ASN line, so each was a faithful answer
 * to the wrong question: they asserted the service's arithmetic over a field the wire does not carry.
 * These start from a `GET /api/ASN/{id}` BODY in the recorded live shape, run the real
 * `normalizeMintsoftAsnFetchByIdResult` over it, and then check the database.
 *
 * NOTHING HERE TALKS TO MINTSOFT. The body comes from tests/fixtures/mintsoft-live-asn-bodies.ts,
 * whose provenance (read-only GETs on ClientId 89, 2026-09-18 and 2026-09-24, recorded on bd o3d-vcw8
 * and o3d-btiw) is written down in that file. The one thing in it that is not a live observation is a
 * NON-ZERO `QuantityReceieved`/`QuantityBooked`: no live ASN in a booked-in state was readable, and a
 * live book-in moves stock, so it was never authorised.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { recordWmsMutationEvent: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  }
}

const EXPECTED_QTY = 12
const UNIT_COST = 4

/**
 * A DISPATCHED STOCK TRANSFER with its own OPEN ASN at the destination, and an unprocessed booked-in
 * event for it.
 *
 * TRANSFER-BACKED, NOT PURCHASE-BACKED, and the reason is a finding of its own: a webhook book-in of
 * a PURCHASE-backed ASN that actually adds stock is rejected outright by the
 * `stock_movements_reporting_evidence_guard` constraint trigger — the service writes its
 * PURCHASE_RECEIPT movement with `referenceType: 'WmsAsnMap'` and the trigger accepts only
 * `'PurchaseOrder'`. That is o3d-gles, filed separately and NOT fixed here; the last test in this file
 * pins the collision, because o3d-btiw was MASKING it (with every received quantity reading zero, the
 * receipt insert was never reached). The transfer book-in writes TRANSFER_IN, which the trigger does
 * not cover, so it is the path on which "the goods are credited" can actually be proven end to end.
 */
async function seedMappedAsn(label: string) {
  const { db } = await import('@/lib/db')
  const uid = `${Date.now().toString(36)}${Math.floor(Math.random() * 1_679_616).toString(36).padStart(4, '0')}`.toUpperCase()
  const tag = `BTIW-${label}-${process.pid}-${uid}`

  const product = await db.product.create({
    data: { sku: tag, name: `o3d-btiw ${label}`, type: 'SIMPLE', countryOfOrigin: 'CN' },
    select: { id: true },
  })
  const source = await db.warehouse.create({
    data: { code: `BS${uid}`.slice(0, 12), name: `${tag} source`, type: 'STANDARD' },
    select: { id: true },
  })
  const warehouse = await db.warehouse.create({
    data: { code: `BD${uid}`.slice(0, 12), name: `${tag} dest`, type: 'STANDARD' },
    select: { id: true },
  })
  const sourceLayer = await db.costLayer.create({
    data: {
      productId: product.id,
      warehouseId: source.id,
      receivedQty: `${EXPECTED_QTY}.000000`,
      remainingQty: '0.000000',
      unitCostBase: UNIT_COST,
    },
    select: { id: true },
  })
  const transfer = await db.stockTransfer.create({
    data: {
      reference: tag,
      fromWarehouseId: source.id,
      toWarehouseId: warehouse.id,
      status: 'IN_TRANSIT',
      dispatchedAt: new Date(),
      lines: {
        create: [{
          productId: product.id,
          sku: tag,
          productName: `o3d-btiw ${label}`,
          qty: `${EXPECTED_QTY}.0000`,
          qtyReceived: '0.0000',
          costLayerSnapshot: [{
            costLayerId: sourceLayer.id,
            qty: `${EXPECTED_QTY}.000000`,
            unitCostBase: `${UNIT_COST}.000000`,
          }],
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const sourceLineId = transfer.lines[0]!.id

  const asn = await db.wmsAsnMap.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-btiw: a test fixture row, not a core flow branch
      externalAsnId: tag,
      sourceType: 'STOCK_TRANSFER',
      sourceId: transfer.id,
      warehouseId: warehouse.id,
      status: 'OPEN',
      lines: {
        create: [{
          externalAsnLineId: '57449',
          sourceType: 'STOCK_TRANSFER_LINE',
          sourceLineId,
          productId: product.id,
          sku: tag,
          expectedQty: `${EXPECTED_QTY}.0000`,
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })

  const event = await db.wmsInboundReceiptEvent.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-btiw: a test fixture row, not a core flow branch
      externalEventId: `${tag}-evt`,
      externalAsnId: tag,
      payload: { asnId: tag },
    },
    select: { id: true },
  })

  return { db, tag, product, warehouse, transfer, sourceLineId, asn, asnLineMapId: asn.lines[0]!.id, event }
}

/**
 * The connector's OWN by-id read, over a live-shaped body. `SourceLineId` is the IMS line id, exactly
 * as ASN 6117 proved it round-trips verbatim; `ID` is the ASN item id.
 */
function remoteAsnFromLiveBody(input: {
  tag: string
  sourceLineId: string
  sku: string
  expected?: number
  booked: number
  received?: number
  itemOverrides?: Parameters<typeof liveAsnItem>[0]
}) {
  const body = liveAsnBody({
    poReference: input.tag,
    items: [liveAsnItem({
      id: 57449,
      sourceLineId: input.sourceLineId,
      sku: input.sku,
      expected: input.expected ?? EXPECTED_QTY,
      booked: input.booked,
      received: input.received ?? input.booked,
      ...input.itemOverrides,
    })],
  })
  const normalized = normalizeMintsoftAsnFetchByIdResult(input.tag, { status: 200, data: body })
  assert.ok(normalized, 'PRECONDITION: the live-shaped ASN body must normalize')
  return normalized
}

async function stockAndLayers(db: Awaited<ReturnType<typeof seedMappedAsn>>['db'], productId: string, warehouseId: string) {
  const layers = await db.costLayer.findMany({ where: { productId, warehouseId }, select: { receivedQty: true } })
  const level = await db.stockLevel.findUnique({
    where: { productId_warehouseId: { productId, warehouseId } },
    select: { quantity: true },
  })
  return {
    stockQty: Number(level?.quantity ?? 0),
    layerQty: layers.reduce((sum, layer) => sum + Number(layer.receivedQty), 0),
  }
}

test(
  'THE REPRO: a live-shaped booked-in ASN credits QuantityBooked units of stock (o3d-btiw)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const seeded = await seedMappedAsn('credit')
    const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')

    const before = await stockAndLayers(seeded.db, seeded.product.id, seeded.warehouse.id)
    assert.deepEqual(before, { stockQty: 0, layerQty: 0 }, 'PRECONDITION: nothing booked in yet')

    const outcome = await processBookedInEvent(seeded.event.id, {
      // CONSTRUCTED VALUE: 12 booked. Every KEY it travels on is recorded live fact.
      fetchRemoteAsn: async () => remoteAsnFromLiveBody({
        tag: seeded.tag, sourceLineId: seeded.sourceLineId, sku: seeded.tag, booked: EXPECTED_QTY,
      }),
    })

    // BEFORE THE FIX: `processed` with stockQty 0 — a confident success and no stock movement.
    assert.equal(outcome.status, 'processed', JSON.stringify(outcome))
    const after = await stockAndLayers(seeded.db, seeded.product.id, seeded.warehouse.id)
    assert.equal(after.stockQty, EXPECTED_QTY, `stock must rise by ${EXPECTED_QTY}, got ${JSON.stringify(after)}`)
    assert.equal(after.layerQty, EXPECTED_QTY, 'and every unit must be backed by a cost layer')

    const transferLine = await seeded.db.stockTransferLine.findUniqueOrThrow({
      where: { id: seeded.sourceLineId },
      select: { qtyReceived: true },
    })
    assert.equal(Number(transferLine.qtyReceived), EXPECTED_QTY)
    const asnLine = await seeded.db.wmsAsnLineMap.findUniqueOrThrow({
      where: { id: seeded.asnLineMapId },
      select: { lastProcessedReceivedQty: true },
    })
    assert.equal(Number(asnLine.lastProcessedReceivedQty), EXPECTED_QTY)
    const asnMap = await seeded.db.wmsAsnMap.findUniqueOrThrow({
      where: { id: seeded.asn.id },
      select: { status: true, closedAt: true },
    })
    assert.equal(asnMap.status, 'BOOKED_IN')
    assert.ok(asnMap.closedAt)
  },
)

test(
  'RECEIVED vs BOOKED: only the QuantityBooked units are credited, and the arrived gap is reported',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const seeded = await seedMappedAsn('gap')
    const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')

    // CONSTRUCTED: all 12 have ARRIVED at the warehouse, only 5 have been BOOKED INTO ITS STOCK.
    const outcome = await processBookedInEvent(seeded.event.id, {
      fetchRemoteAsn: async () => remoteAsnFromLiveBody({
        tag: seeded.tag, sourceLineId: seeded.sourceLineId, sku: seeded.tag, booked: 5, received: EXPECTED_QTY,
      }),
    })
    assert.equal(outcome.status, 'processed', JSON.stringify(outcome))

    const after = await stockAndLayers(seeded.db, seeded.product.id, seeded.warehouse.id)
    assert.equal(after.stockQty, 5, 'the dock count must NOT become stock')
    assert.equal(after.layerQty, 5)

    // THE OTHER NUMBER IS NOT DISCARDED: it is on the processed-event activity log, as a WARNING.
    const log = await seeded.db.activityLog.findFirst({
      where: { action: 'mintsoft_booked_in_processed', entityId: seeded.event.id },
      select: { level: true, description: true, metadata: true },
    })
    assert.ok(log, 'the processed event must be logged')
    assert.equal(log!.level, 'WARNING')
    const gap = (log!.metadata as { arrivedNotYetBookedIn?: Array<Record<string, unknown>> }).arrivedNotYetBookedIn
    assert.equal(gap?.length, 1, `the gap must be recorded: ${JSON.stringify(log!.metadata)}`)
    assert.equal(gap![0]!.arrivedAtWarehouseQty, EXPECTED_QTY)
    assert.equal(gap![0]!.bookedIntoStockQty, 5)
    assert.match(String(log!.description), /arrived at the warehouse but are not yet booked/)
  },
)

test(
  'UNKNOWN IS NOT ZERO: an unreadable QuantityBooked refuses, writes nothing, and cannot be approved',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const seeded = await seedMappedAsn('unknown')
    const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')

    const fetchRemoteAsn = async () => remoteAsnFromLiveBody({
      tag: seeded.tag,
      sourceLineId: seeded.sourceLineId,
      sku: seeded.tag,
      booked: 0,
      received: EXPECTED_QTY,
      // SHAPE DRIFT: the booked quantity is gone. The arrived one is still there and says 12, so a
      // fallback or a `Math.max` would have booked 12 units off a dock count.
      itemOverrides: { omit: ['QuantityBooked'] },
    })

    const outcome = await processBookedInEvent(seeded.event.id, { fetchRemoteAsn })
    assert.equal(outcome.status, 'requires_review', JSON.stringify(outcome))
    assert.ok(
      outcome.status === 'requires_review' && outcome.dryRun.warnings.includes('remote_quantity_unreadable'),
      JSON.stringify(outcome),
    )

    const after = await stockAndLayers(seeded.db, seeded.product.id, seeded.warehouse.id)
    assert.deepEqual(after, { stockQty: 0, layerQty: 0 }, 'an unknown quantity must move no stock')
    const asnLine = await seeded.db.wmsAsnLineMap.findUniqueOrThrow({
      where: { id: seeded.asnLineMapId },
      select: { lastProcessedReceivedQty: true },
    })
    assert.equal(Number(asnLine.lastProcessedReceivedQty), 0)

    // AND APPROVAL CANNOT WAVE IT THROUGH: an operator cannot supply a number the warehouse withheld.
    const approved = await processBookedInEvent(seeded.event.id, { fetchRemoteAsn, approveReview: true })
    assert.equal(approved.status, 'requires_review', JSON.stringify(approved))
    const stillEmpty = await stockAndLayers(seeded.db, seeded.product.id, seeded.warehouse.id)
    assert.deepEqual(stillEmpty, { stockQty: 0, layerQty: 0 }, 'approval must not book an unknown quantity')
    const event = await seeded.db.wmsInboundReceiptEvent.findUniqueOrThrow({
      where: { id: seeded.event.id },
      select: { processingStatus: true, lastError: true, processedAt: true },
    })
    assert.equal(event.processedAt, null)
    assert.match(String(event.lastError), /remote_quantity_unreadable/)
  },
)

test(
  'NOT VACUOUS: a readable zero is a MEASUREMENT, not a refusal (and o3d-h66s is what it hits next)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    /**
     * WHY THIS TEST EXISTS. If every live-shaped ASN refused, the tests above would pass for the wrong
     * reason and the booked-in path would simply be dead. A readable `QuantityBooked: 0` is a
     * MEASUREMENT — the warehouse booked nothing in — and it must NOT come back as
     * `remote_quantity_unreadable`.
     *
     * WHY IT ASSERTS `requires_review` RATHER THAN `processed`, WHICH IS NOT o3d-btiw's DOING:
     * `localLineExists` is computed from a read restricted to ACTIONABLE lines, so a line with no
     * delta reports its IMS line as MISSING and the event is held with an approval-blocked
     * `missing_local_line` about a line that exists. That is o3d-h66s — a separate, pre-existing
     * defect, filed and deliberately NOT fixed here under the 2026-09-25 scope rule. It moves no stock
     * and corrupts no figure.
     *
     * WHEN o3d-h66s LANDS THIS TEST MUST BE FLIPPED to expect `processed` with no warnings at all; a
     * red here is the signal that it has. What the assertions below pin either way is the property
     * o3d-btiw owns: the ONLY warning is `missing_local_line`, so the zero was read as a quantity and
     * no refusal was raised.
     */
    loadEnv()
    const seeded = await seedMappedAsn('zero')
    const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')

    const outcome = await processBookedInEvent(seeded.event.id, {
      fetchRemoteAsn: async () => remoteAsnFromLiveBody({
        tag: seeded.tag, sourceLineId: seeded.sourceLineId, sku: seeded.tag, booked: 0, received: 0,
      }),
    })
    assert.equal(outcome.status, 'requires_review', JSON.stringify(outcome))
    assert.ok(outcome.status === 'requires_review')
    // THE o3d-btiw PROPERTY: a readable zero raises NO refusal. Asserted as an exact set so a refusal
    // appearing later cannot hide behind `missing_local_line`.
    assert.deepEqual(outcome.dryRun.warnings, ['missing_local_line'])
    const line = outcome.dryRun.lines[0]!
    assert.equal(line.remoteQuantityRefusal, null, 'zero booked is a measurement, not a refusal')
    assert.equal(line.currentRemoteReceivedQty, 0)
    assert.equal(line.remoteArrivedQty, 0)
    const after = await stockAndLayers(seeded.db, seeded.product.id, seeded.warehouse.id)
    assert.deepEqual(after, { stockQty: 0, layerQty: 0 })
  },
)

test(
  'DELTA: a recheck after 6 units were processed applies the remaining 6 and claims no regression',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const seeded = await seedMappedAsn('delta')
    const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')

    const first = await processBookedInEvent(seeded.event.id, {
      fetchRemoteAsn: async () => remoteAsnFromLiveBody({
        tag: seeded.tag, sourceLineId: seeded.sourceLineId, sku: seeded.tag, booked: 6,
      }),
    })
    assert.equal(first.status, 'processed', JSON.stringify(first))
    assert.equal((await stockAndLayers(seeded.db, seeded.product.id, seeded.warehouse.id)).stockQty, 6)

    const second = await seeded.db.wmsInboundReceiptEvent.create({
      data: {
        connector: 'mintsoft', // wms-connector-boundary-ok: o3d-btiw: a test fixture row, not a core flow branch
        externalEventId: `${seeded.tag}-evt-2`,
        externalAsnId: seeded.tag,
        payload: { asnId: seeded.tag },
      },
      select: { id: true },
    })
    const outcome = await processBookedInEvent(second.id, {
      fetchRemoteAsn: async () => remoteAsnFromLiveBody({
        tag: seeded.tag, sourceLineId: seeded.sourceLineId, sku: seeded.tag, booked: EXPECTED_QTY,
      }),
    })
    // BEFORE THE FIX the second read came back as 0 against 6 processed, so this was
    // `requires_review` with `remote_regression` — "Mintsoft quantity decreased".
    assert.equal(outcome.status, 'processed', JSON.stringify(outcome))
    const after = await stockAndLayers(seeded.db, seeded.product.id, seeded.warehouse.id)
    assert.equal(after.stockQty, EXPECTED_QTY)
    assert.equal(after.layerQty, EXPECTED_QTY)
  },
)

test(
  'UNKNOWN AFTER A PARTIAL BOOK-IN reports what is accounted, never a zero Mintsoft did not say',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    /**
     * WHAT THIS PINS THAT THE TEST ABOVE DOES NOT. There, nothing had been processed yet, so pinning an
     * unknown line to `lastProcessedReceivedQty` and fabricating a 0 both produce "no delta" and the
     * outcomes are indistinguishable. Here SIX units are already accounted for, and the difference is
     * the NUMBER THE OPERATOR IS SHOWN: `wms_inbound_receipt_events.reviewDetails` either says Mintsoft
     * reports 6 booked (true: it is what IMS has accounted, and IMS knows nothing newer) or says it
     * reports 0 — a statement about a warehouse that said nothing at all, and the same false claim the
     * pre-fix code made on every live callback.
     */
    loadEnv()
    const seeded = await seedMappedAsn('unknowndelta')
    const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')

    const first = await processBookedInEvent(seeded.event.id, {
      fetchRemoteAsn: async () => remoteAsnFromLiveBody({
        tag: seeded.tag, sourceLineId: seeded.sourceLineId, sku: seeded.tag, booked: 6,
      }),
    })
    assert.equal(first.status, 'processed', JSON.stringify(first))

    const second = await seeded.db.wmsInboundReceiptEvent.create({
      data: {
        connector: 'mintsoft', // wms-connector-boundary-ok: o3d-btiw: a test fixture row, not a core flow branch
        externalEventId: `${seeded.tag}-evt-2`,
        externalAsnId: seeded.tag,
        payload: { asnId: seeded.tag },
      },
      select: { id: true },
    })
    const outcome = await processBookedInEvent(second.id, {
      fetchRemoteAsn: async () => remoteAsnFromLiveBody({
        tag: seeded.tag,
        sourceLineId: seeded.sourceLineId,
        sku: seeded.tag,
        booked: 0,
        received: EXPECTED_QTY,
        itemOverrides: { omit: ['QuantityBooked'] },
      }),
    })
    assert.equal(outcome.status, 'requires_review', JSON.stringify(outcome))

    const persisted = await seeded.db.wmsInboundReceiptEvent.findUniqueOrThrow({
      where: { id: second.id },
      select: { reviewDetails: true },
    })
    const line = (persisted.reviewDetails as { lines: Array<Record<string, unknown>> }).lines[0]!
    assert.equal(line.lastProcessedReceivedQty, 6, 'PRECONDITION: six units must already be accounted')
    assert.equal(
      line.currentRemoteReceivedQty,
      6,
      `an unknown remote quantity must report what is accounted, not 0: ${JSON.stringify(line)}`,
    )
    assert.equal((line.remoteQuantityRefusal as { code: string }).code, 'remote_quantity_unreadable')
    // And the arrived count is still carried, so the reviewer sees the one number Mintsoft DID serve.
    assert.equal(line.remoteArrivedQty, EXPECTED_QTY)
    // Six units of stock from the first pass, and not one more.
    assert.equal((await stockAndLayers(seeded.db, seeded.product.id, seeded.warehouse.id)).stockQty, 6)
  },
)

test(
  'a local ASN line the remote ASN has no item for refuses rather than reading zero',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const seeded = await seedMappedAsn('noitem')
    const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')

    const outcome = await processBookedInEvent(seeded.event.id, {
      fetchRemoteAsn: async () => remoteAsnFromLiveBody({
        tag: seeded.tag,
        sourceLineId: LIVE_ASN_SOURCE_LINE_ID, // another integration's line, not ours
        sku: 'SOMEONE-ELSE',
        booked: EXPECTED_QTY,
        itemOverrides: { id: 99999 },
      }),
    })
    assert.equal(outcome.status, 'requires_review', JSON.stringify(outcome))
    assert.ok(
      outcome.status === 'requires_review' && outcome.dryRun.warnings.includes('missing_remote_line'),
      JSON.stringify(outcome),
    )
    const after = await stockAndLayers(seeded.db, seeded.product.id, seeded.warehouse.id)
    assert.deepEqual(after, { stockQty: 0, layerQty: 0 })
  },
)

// ---------------------------------------------------------------------------
// WHAT FIXING o3d-btiw UNMASKS — o3d-gles
// ---------------------------------------------------------------------------

test(
  'a PURCHASE-backed book-in now REACHES the receipt insert, and is refused by the o3d-gles guard',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    /**
     * o3d-btiw WAS MASKING o3d-gles, and this pins the hand-off.
     *
     * `stock_movements_reporting_evidence_guard` (a DEFERRED constraint trigger) accepts a
     * PURCHASE_RECEIPT movement only when its `referenceType` is `'PurchaseOrder'`.
     * `booked-in-service.ts` writes `'WmsAsnMap'`, so a purchase-backed book-in that adds stock cannot
     * commit — o3d-gles. Until this branch that was INVISIBLE from the booked-in path: every live ASN
     * item normalized to a received quantity of zero, so `stockQtyToAdd` was always zero and the
     * movement was never inserted. Reading `QuantityBooked` makes the path reach it on the first real
     * callback.
     *
     * THIS TEST ASSERTS THE PRESENT, WRONG BEHAVIOUR ON PURPOSE, so the change ships with the
     * consequence written down and measured rather than discovered in production. WHEN o3d-gles IS
     * FIXED THIS TEST MUST BE REPLACED by the credit assertions the transfer test above makes — a red
     * here is the signal that it has been.
     */
    loadEnv()
    const { db } = await import('@/lib/db')
    const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')

    const uid = `${Date.now().toString(36)}${Math.floor(Math.random() * 1_679_616).toString(36).padStart(4, '0')}`.toUpperCase()
    const tag = `BTIWPO-${process.pid}-${uid}`
    const product = await db.product.create({
      data: { sku: tag, name: `o3d-btiw po ${uid}`, type: 'SIMPLE', countryOfOrigin: 'CN' },
      select: { id: true },
    })
    const warehouse = await db.warehouse.create({
      data: { code: `BP${uid}`.slice(0, 12), name: `${tag} wh`, type: 'STANDARD' },
      select: { id: true },
    })
    const supplier = await db.supplier.create({ data: { name: `${tag} supplier` }, select: { id: true } })
    const total = `${EXPECTED_QTY * UNIT_COST}.0000`
    const po = await db.purchaseOrder.create({
      data: {
        reference: tag,
        supplierId: supplier.id,
        status: 'PO_SENT',
        currency: 'GBP',
        fxRateToBase: '1',
        subtotalForeign: total,
        subtotalBase: total,
        totalForeign: total,
        totalBase: total,
        destinationWarehouseId: warehouse.id,
        lines: {
          create: [{
            productId: product.id,
            qty: `${EXPECTED_QTY}.0000`,
            qtyReceived: '0.0000',
            unitCostForeign: `${UNIT_COST}.000000`,
            unitCostBase: `${UNIT_COST}.000000`,
            landedUnitCostBase: `${UNIT_COST}.000000`,
            totalForeign: total,
            totalBase: total,
          }],
        },
      },
      select: { id: true, lines: { select: { id: true } } },
    })
    const asn = await db.wmsAsnMap.create({
      data: {
        connector: 'mintsoft', // wms-connector-boundary-ok: o3d-btiw: a test fixture row, not a core flow branch
        externalAsnId: tag,
        sourceType: 'PURCHASE_ORDER',
        sourceId: po.id,
        warehouseId: warehouse.id,
        status: 'OPEN',
        lines: {
          create: [{
            externalAsnLineId: '57449',
            sourceType: 'PURCHASE_ORDER_LINE',
            sourceLineId: po.lines[0]!.id,
            productId: product.id,
            sku: tag,
            expectedQty: `${EXPECTED_QTY}.0000`,
          }],
        },
      },
      select: { id: true },
    })
    const event = await db.wmsInboundReceiptEvent.create({
      data: {
        connector: 'mintsoft', // wms-connector-boundary-ok: o3d-btiw: a test fixture row, not a core flow branch
        externalEventId: `${tag}-evt`,
        externalAsnId: tag,
        payload: { asnId: tag },
      },
      select: { id: true },
    })
    void asn

    const outcome = await processBookedInEvent(event.id, {
      fetchRemoteAsn: async () => remoteAsnFromLiveBody({
        tag, sourceLineId: po.lines[0]!.id, sku: tag, booked: EXPECTED_QTY,
      }),
    })

    // PRE-o3d-btiw this was `requires_review` with `missing_local_line` and no movement attempt at
    // all. It now gets as far as inserting the PURCHASE_RECEIPT, which is the proof that the quantity
    // IS being read — and then o3d-gles rejects it at COMMIT.
    assert.equal(outcome.status, 'failed', JSON.stringify(outcome))
    assert.match(
      outcome.status === 'failed' ? outcome.error : '',
      /PURCHASE_RECEIPT\) requires matching cost-layer evidence/,
      'the failure must be o3d-gles and nothing else',
    )
    // NOTHING PARTIAL SURVIVES: the transaction rolled back whole.
    const level = await db.stockLevel.findUnique({
      where: { productId_warehouseId: { productId: product.id, warehouseId: warehouse.id } },
      select: { quantity: true },
    })
    assert.equal(Number(level?.quantity ?? 0), 0)
    const poLine = await db.purchaseOrderLine.findUniqueOrThrow({
      where: { id: po.lines[0]!.id },
      select: { qtyReceived: true },
    })
    assert.equal(Number(poLine.qtyReceived), 0)
  },
)
