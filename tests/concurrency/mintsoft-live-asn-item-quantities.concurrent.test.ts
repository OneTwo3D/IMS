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
 * TRANSFER-BACKED. When these tests were written, a webhook book-in of a PURCHASE-backed ASN that
 * actually added stock was rejected outright by the `stock_movements_reporting_evidence_guard`
 * constraint trigger — the service wrote its PURCHASE_RECEIPT movement with
 * `referenceType: 'WmsAsnMap'` and the trigger accepts only `'PurchaseOrder'`. That was o3d-gles, and
 * o3d-btiw was MASKING it: with every received quantity reading zero, the receipt insert was never
 * reached. o3d-gles has since landed (#703), and the LAST test in this file now proves the
 * purchase-backed credit and the evidence the guard demands. The transfer path is kept as the primary
 * end-to-end proof because TRANSFER_IN is not subject to that guard at all, so it isolates the
 * quantity question from the evidence question.
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
  'NOT VACUOUS: a readable zero is a MEASUREMENT, not a refusal, and processes cleanly',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    /**
     * WHY THIS TEST EXISTS. If every live-shaped ASN refused, the tests above would pass for the wrong
     * reason and the booked-in path would simply be dead. A readable `QuantityBooked: 0` is a
     * MEASUREMENT — the warehouse booked nothing in — and it must NOT come back as
     * `remote_quantity_unreadable`.
     *
     * FLIPPED FOR o3d-h66s, as this test's previous body instructed. It used to assert
     * `requires_review` whose only warning was `missing_local_line`, because `localLineExists` was
     * computed from a read restricted to ACTIONABLE lines and a line with no delta therefore reported
     * its own healthy IMS line as missing. o3d-h66s widened that read to every CANDIDATE line, so a
     * readable zero now processes cleanly — which is a STRICTLY STRONGER statement of the property
     * o3d-btiw owns: a refusal of any kind would come back `requires_review`, so `processed` proves
     * no refusal was raised at all, and the zero was read as a quantity.
     *
     * NON-VACUITY, restated for the new shape: `processed` alone could in principle be reached without
     * the line being looked at, so the ASN line's `lastCallbackAt` (written only by the
     * no-actionable-lines branch) and the ASN header's `PARTIALLY_BOOKED_IN` status are asserted too.
     * Together they say the run reached this line, measured zero, and closed nothing.
     */
    loadEnv()
    const seeded = await seedMappedAsn('zero')
    const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')

    const outcome = await processBookedInEvent(seeded.event.id, {
      fetchRemoteAsn: async () => remoteAsnFromLiveBody({
        tag: seeded.tag, sourceLineId: seeded.sourceLineId, sku: seeded.tag, booked: 0, received: 0,
      }),
    })
    assert.equal(outcome.status, 'processed', JSON.stringify(outcome))
    const event = await seeded.db.wmsInboundReceiptEvent.findUniqueOrThrow({
      where: { id: seeded.event.id },
      select: { processingStatus: true, lastError: true, reviewDetails: true, processedAt: true },
    })
    assert.equal(event.processingStatus, 'PROCESSED')
    // THE o3d-btiw PROPERTY: a readable zero raises NO refusal and NO review of any kind.
    assert.equal(event.lastError, null, JSON.stringify(event))
    assert.equal(event.reviewDetails, null, JSON.stringify(event))
    assert.ok(event.processedAt)
    // AND IT CREDITS NOTHING: zero booked means zero units of stock.
    const after = await stockAndLayers(seeded.db, seeded.product.id, seeded.warehouse.id)
    assert.deepEqual(after, { stockQty: 0, layerQty: 0 })
    const asnLine = await seeded.db.wmsAsnLineMap.findUniqueOrThrow({
      where: { id: seeded.asnLineMapId },
      select: { lastProcessedReceivedQty: true, lastCallbackAt: true },
    })
    assert.equal(Number(asnLine.lastProcessedReceivedQty), 0)
    assert.ok(asnLine.lastCallbackAt, 'the run must have reached this line and recorded the callback')
    const asnMap = await seeded.db.wmsAsnMap.findUniqueOrThrow({
      where: { id: seeded.asn.id },
      select: { status: true, closedAt: true },
    })
    assert.equal(asnMap.status, 'PARTIALLY_BOOKED_IN', 'nothing booked in must not close the ASN')
    assert.equal(asnMap.closedAt, null)
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
// THE PURCHASE-BACKED PATH, NOW THAT o3d-gles HAS LANDED
// ---------------------------------------------------------------------------

/**
 * THE GUARD'S OWN EVIDENCE SUBQUERY, run as a read, so the success arm proves the evidence EXISTS
 * rather than proving only that nothing threw. Copied from the guard, and from o3d-gles's own test
 * (tests/concurrency/wms-purchase-receipt-evidence.concurrent.test.ts), which is the authority on
 * what the trigger looks for.
 *
 * `referenceTypeUnderTest` is a parameter for one reason: the control below runs the SAME join with
 * `'WmsAsnMap'`, the value booked-in-service wrote before o3d-gles, and requires 0. Without that, a
 * count of 1 would only say "this query matches something", not "it matches because the movement
 * names the purchase order".
 */
async function countGuardEvidenceForMovement(movementId: string, referenceTypeUnderTest: string): Promise<number> {
  const { db } = await import('@/lib/db')
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n
      FROM "stock_movements" sm
      JOIN "cost_layers" cl
        ON cl."productId" = sm."productId"
       AND cl."warehouseId" = sm."toWarehouseId"
       AND ABS(cl."receivedQty" - sm.qty) <= 0.0001
     WHERE sm.id = ${movementId}
       AND sm.type = 'PURCHASE_RECEIPT'
       AND sm."referenceType" = ${referenceTypeUnderTest}
       AND sm."referenceId" IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM "purchase_order_lines" pol
          WHERE pol.id = cl."poLineId"
            AND pol."poId" = sm."referenceId"
       )`
  return Number(rows[0]!.n)
}

/** The guard must be ON, DEFERRABLE and INITIALLY DEFERRED, or a green arm proves nothing at all. */
async function assertGuardIsArmed() {
  const { db } = await import('@/lib/db')
  const rows = await db.$queryRaw<{ tgenabled: string; tgdeferrable: boolean; tginitdeferred: boolean }[]>`
    SELECT t.tgenabled::text AS tgenabled, t.tgdeferrable, t.tginitdeferred
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'stock_movements'
       AND t.tgname = 'stock_movements_reporting_evidence_guard'`
  assert.equal(rows.length, 1, 'the o3d-gles evidence guard must exist on stock_movements')
  console.log(`[po] guard armed: ${JSON.stringify(rows[0])}`)
  assert.equal(rows[0]!.tgenabled, 'O', 'the guard must be ENABLED, or this test measures nothing')
  assert.equal(rows[0]!.tgdeferrable, true, 'the guard must be DEFERRABLE')
  assert.equal(rows[0]!.tginitdeferred, true, 'the guard must be INITIALLY DEFERRED, or it would not fire at COMMIT')
}

test(
  'a PURCHASE-backed book-in CREDITS the stock, and the evidence the o3d-gles guard demands is really present',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    /**
     * o3d-btiw WAS MASKING o3d-gles, AND BOTH ARE NOW FIXED — this is the hand-off, asserted.
     *
     * `stock_movements_reporting_evidence_guard` (a DEFERRED constraint trigger) accepts a
     * PURCHASE_RECEIPT movement only when it NAMES THE PURCHASE ORDER that vouches for the units —
     * `referenceType: 'PurchaseOrder'`, `referenceId` = the PO — and only when a cost layer for the
     * same product, warehouse and quantity hangs off a line of that same PO. `booked-in-service.ts`
     * used to write `referenceType: 'WmsAsnMap'`, so a purchase-backed book-in that added stock could
     * not commit; o3d-gles (#703) is what fixed that. Until o3d-btiw, the collision was INVISIBLE from
     * the booked-in path: every live ASN item normalized to a received quantity of zero, so
     * `stockQtyToAdd` was always zero and the receipt insert was never reached. Reading
     * `QuantityBooked` makes the path reach it on the first real callback.
     *
     * This test therefore asserts the CREDIT — and, because "nothing threw" is not the same claim as
     * "the evidence the guard wants exists", it re-runs the guard's own join as a read and requires it
     * to match, with a control that requires 0 for the pre-gles reference type.
     */
    loadEnv()
    const { db } = await import('@/lib/db')
    const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')

    await assertGuardIsArmed()

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

    const outcome = await processBookedInEvent(event.id, {
      fetchRemoteAsn: async () => remoteAsnFromLiveBody({
        tag, sourceLineId: po.lines[0]!.id, sku: tag, booked: EXPECTED_QTY,
      }),
    })

    assert.equal(outcome.status, 'processed', JSON.stringify(outcome))

    // THE GOODS ARE CREDITED.
    const level = await db.stockLevel.findUnique({
      where: { productId_warehouseId: { productId: product.id, warehouseId: warehouse.id } },
      select: { quantity: true },
    })
    assert.equal(Number(level?.quantity ?? 0), EXPECTED_QTY, 'the booked quantity must be in stock')
    const poLine = await db.purchaseOrderLine.findUniqueOrThrow({
      where: { id: po.lines[0]!.id },
      select: { qtyReceived: true },
    })
    assert.equal(Number(poLine.qtyReceived), EXPECTED_QTY, 'the purchase order line must be receipted')

    // EXACTLY ONE INBOUND MOVEMENT, AND IT NAMES THE PURCHASE ORDER (o3d-gles).
    const movements = await db.stockMovement.findMany({
      where: { productId: product.id, toWarehouseId: warehouse.id },
      select: { id: true, type: true, qty: true, referenceType: true, referenceId: true, idempotencyKey: true },
      orderBy: { createdAt: 'asc' },
    })
    console.log(`[po] examined ${movements.length} committed stock_movements row(s): ${JSON.stringify(movements)}`)
    assert.equal(movements.length, 1, 'exactly one movement must have committed for this receipt')
    const movement = movements[0]!
    assert.equal(movement.type, 'PURCHASE_RECEIPT')
    // DERIVED, never typed: the expected reference is the seeded purchase order's own id.
    assert.equal(movement.referenceType, 'PurchaseOrder')
    assert.equal(movement.referenceId, po.id, 'the movement must name the purchase order that vouches for the units')
    assert.equal(Number(movement.qty), EXPECTED_QTY)

    // THE COST LAYER THE GUARD JOINS TO IS REALLY THERE, AND HANGS OFF THIS PO'S LINE.
    const layers = await db.costLayer.findMany({
      where: { productId: product.id, warehouseId: warehouse.id },
      select: { poLineId: true, receivedQty: true, unitCostBase: true },
    })
    console.log(`[po] examined ${layers.length} cost_layers row(s): ${JSON.stringify(layers)}`)
    assert.equal(layers.length, 1, 'one receipt lays one cost layer')
    assert.equal(layers[0]!.poLineId, po.lines[0]!.id, 'the layer must hang off the purchase order line that was received')
    assert.equal(Number(layers[0]!.receivedQty), EXPECTED_QTY)

    // AND THE GUARD'S OWN JOIN FINDS IT — with a control that proves the join discriminates on the
    // very field o3d-gles changed, rather than matching anything at all.
    const evidence = await countGuardEvidenceForMovement(movement.id, 'PurchaseOrder')
    const preGlesEvidence = await countGuardEvidenceForMovement(movement.id, 'WmsAsnMap')
    console.log(`[po] the guard's own evidence join matched ${evidence} row(s) as 'PurchaseOrder' and ${preGlesEvidence} as 'WmsAsnMap'`)
    assert.equal(evidence, 1, "the guard's own evidence join must find the cost layer — a pass with 0 would mean the guard was bypassed, not satisfied")
    assert.equal(preGlesEvidence, 0, 'CONTROL: the same join finds nothing for the reference type booked-in wrote before o3d-gles')

    // THE ASN LINE IS STILL WHAT MAKES THE RECEIPT IDEMPOTENT — line-granular, in the key.
    const { wmsPurchaseReceiptMovementKey } = await import('@/lib/domain/inventory/stock-movement-idempotency')
    assert.equal(
      movement.idempotencyKey,
      wmsPurchaseReceiptMovementKey({ asnLineMapId: asn.lines[0]!.id, receiptEventId: event.id }),
      'the ASN line map id must still be carried by the idempotency key',
    )
  },
)
