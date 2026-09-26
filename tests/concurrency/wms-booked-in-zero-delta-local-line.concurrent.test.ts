import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

import { normalizeMintsoftAsnFetchByIdResult } from '@/lib/connectors/mintsoft/api/client'
import { liveAsnBody, liveAsnItem } from '@/tests/fixtures/mintsoft-live-asn-bodies'
import { WMS_INBOUND_EVENT_PROCESSING_STATUS } from '@/lib/domain/wms/inbound-event-status'

/**
 * o3d-h66s — A LINE WITH NOTHING LEFT TO DO IS NOT A MISSING LINE.
 *
 * THE DEFECT. `booked-in-service` read the IMS purchase-order / stock-transfer line rows only for the
 * ACTIONABLE lines (`currentReceivedQty > lastProcessedReceivedQty`) and then fed that map to
 * `localLineExists` for EVERY candidate line. A line with no delta was therefore never looked up, its
 * `localLineExists` came back `false`, and `buildBookedInDryRun` recorded `missing_local_line` — which
 * is in `APPROVAL_BLOCKED_WARNING_CODES` and renders to the operator as "IMS line missing" — about a
 * line IMS knows perfectly well.
 *
 * WHY THAT IS A P1 AND NOT A COSMETIC MISNOMER. `missing_local_line` reaches the event through the
 * AGGREGATE `dryRun.warnings`, so ONE zero-delta line sends the WHOLE receipt event to an
 * approval-blocked review and its other lines — the ones with real units to credit — apply NOTHING.
 * After o3d-btiw (#704) made the live quantities readable that is the ordinary case, not an edge one:
 * every partially-booked ASN, every recheck of a settled ASN, and any ASN whose `QuantityBooked` is a
 * readable 0 beside a non-zero `QuantityReceieved`.
 *
 * THE FIX, and what these tests must NOT let it become: the read is widened to every CANDIDATE line,
 * so `localLineExists` is computed from the lines IMS HAS rather than from the subset it is about to
 * act on. It is emphatically NOT "suppress the warning when there is no delta" — the last three tests
 * here exist to fail if it ever becomes that, because a dangling `sourceLineId` with no delta is
 * exactly the case such a shortcut would wave through.
 *
 * NOTHING HERE TALKS TO MINTSOFT. The wire bodies come from tests/fixtures/mintsoft-live-asn-bodies.ts,
 * whose provenance (read-only GETs on ClientId 89) is recorded in that file and on bd o3d-vcw8.
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

/** Every quantity below is an INPUT of this test, never a value read back out of the machine. */
const EXPECTED_QTY = 12
const UNIT_COST = 4
/** The partial book-in: line 1 has a real delta, line 2 has none. */
const BOOKED_ON_LINE_1 = 7
/** The remote ASN item ids the two local ASN lines are keyed on. */
const REMOTE_ITEM_ID_1 = 57449
const REMOTE_ITEM_ID_2 = 57450

type SeedOptions = {
  /** 1 or 2 ASN lines. */
  lines?: 1 | 2
  /**
   * Point the LAST ASN line's `sourceLineId` at an id no `stock_transfer_lines` row has. There is no
   * foreign key on `wms_asn_line_maps.sourceLineId` (prisma/schema.prisma), so this is the GENUINE
   * `missing_local_line`: a local ASN line naming something IMS does not have.
   */
  danglingLastLine?: boolean
}

async function seedAsn(label: string, options: SeedOptions = {}) {
  const lineCount = options.lines ?? 2
  const { db } = await import('@/lib/db')
  const uid = `${Date.now().toString(36)}${Math.floor(Math.random() * 1_679_616).toString(36).padStart(4, '0')}`.toUpperCase()
  const tag = `H66S-${label}-${process.pid}-${uid}`

  const source = await db.warehouse.create({
    data: { code: `HS${uid}`.slice(0, 12), name: `${tag} source`, type: 'STANDARD' },
    select: { id: true },
  })
  const warehouse = await db.warehouse.create({
    data: { code: `HD${uid}`.slice(0, 12), name: `${tag} dest`, type: 'STANDARD' },
    select: { id: true },
  })

  const products: { id: string; sku: string }[] = []
  for (let index = 0; index < lineCount; index += 1) {
    const product = await db.product.create({
      data: { sku: `${tag}-P${index + 1}`, name: `o3d-h66s ${label} ${index + 1}`, type: 'SIMPLE', countryOfOrigin: 'CN' },
      select: { id: true, sku: true },
    })
    products.push(product)
  }

  const snapshots: unknown[] = []
  for (const product of products) {
    const layer = await db.costLayer.create({
      data: {
        productId: product.id,
        warehouseId: source.id,
        receivedQty: `${EXPECTED_QTY}.000000`,
        remainingQty: '0.000000',
        unitCostBase: UNIT_COST,
      },
      select: { id: true },
    })
    snapshots.push([{ costLayerId: layer.id, qty: `${EXPECTED_QTY}.000000`, unitCostBase: `${UNIT_COST}.000000` }])
  }

  const transfer = await db.stockTransfer.create({
    data: {
      reference: tag,
      fromWarehouseId: source.id,
      toWarehouseId: warehouse.id,
      status: 'IN_TRANSIT',
      dispatchedAt: new Date(),
      lines: {
        create: products.map((product, index) => ({
          productId: product.id,
          sku: product.sku,
          productName: `o3d-h66s ${label} ${index + 1}`,
          qty: `${EXPECTED_QTY}.0000`,
          qtyReceived: '0.0000',
          costLayerSnapshot: snapshots[index] as never,
        })),
      },
    },
    select: { id: true, lines: { select: { id: true, sku: true }, orderBy: { sku: 'asc' } } },
  })
  assert.equal(transfer.lines.length, lineCount, 'PRECONDITION: the transfer must have one line per ASN line')

  /**
   * `sourceLineId` per ASN line. DERIVED from the transfer's own line ids, matched on the SKU this
   * test wrote, so nothing here depends on the order the database returned rows in.
   */
  const transferLineIdBySku = new Map(transfer.lines.map((line) => [line.sku, line.id]))
  const danglingSourceLineId = `h66s-no-such-transfer-line-${uid}`
  const remoteItemIds = [REMOTE_ITEM_ID_1, REMOTE_ITEM_ID_2]
  const asnLineInputs = products.map((product, index) => {
    const realLineId = transferLineIdBySku.get(product.sku)
    assert.ok(realLineId, `PRECONDITION: a transfer line for ${product.sku}`)
    const isLast = index === products.length - 1
    return {
      externalAsnLineId: String(remoteItemIds[index]),
      remoteItemId: remoteItemIds[index]!,
      sourceLineId: options.danglingLastLine && isLast ? danglingSourceLineId : realLineId!,
      realTransferLineId: realLineId!,
      productId: product.id,
      sku: product.sku,
      dangling: Boolean(options.danglingLastLine && isLast),
    }
  })

  const asn = await db.wmsAsnMap.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-h66s: a test fixture row, not a core flow branch
      externalAsnId: tag,
      sourceType: 'STOCK_TRANSFER',
      sourceId: transfer.id,
      warehouseId: warehouse.id,
      status: 'OPEN',
      lines: {
        create: asnLineInputs.map((line) => ({
          externalAsnLineId: line.externalAsnLineId,
          sourceType: 'STOCK_TRANSFER_LINE',
          sourceLineId: line.sourceLineId,
          productId: line.productId,
          sku: line.sku,
          expectedQty: `${EXPECTED_QTY}.0000`,
        })),
      },
    },
    select: { id: true, lines: { select: { id: true, externalAsnLineId: true } } },
  })
  const asnLineMapIdByExternalId = new Map(asn.lines.map((line) => [line.externalAsnLineId, line.id]))

  const event = await db.wmsInboundReceiptEvent.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-h66s: a test fixture row, not a core flow branch
      externalEventId: `${tag}-evt`,
      externalAsnId: tag,
      payload: { asnId: tag },
    },
    select: { id: true },
  })

  return {
    db,
    tag,
    warehouse,
    transfer,
    asn,
    event,
    products,
    asnLines: asnLineInputs.map((line) => ({
      ...line,
      asnLineMapId: asnLineMapIdByExternalId.get(line.externalAsnLineId)!,
    })),
  }
}

/** The connector's OWN by-id read, over a live-shaped body carrying one item per ASN line. */
function remoteAsn(
  seeded: Awaited<ReturnType<typeof seedAsn>>,
  quantities: readonly { booked: number; received?: number }[],
) {
  assert.equal(quantities.length, seeded.asnLines.length, 'PRECONDITION: one remote item per ASN line')
  const body = liveAsnBody({
    poReference: seeded.tag,
    items: seeded.asnLines.map((line, index) => liveAsnItem({
      id: line.remoteItemId,
      sourceLineId: line.sourceLineId,
      sku: line.sku,
      expected: EXPECTED_QTY,
      booked: quantities[index]!.booked,
      received: quantities[index]!.received ?? quantities[index]!.booked,
    })),
  })
  const normalized = normalizeMintsoftAsnFetchByIdResult(seeded.tag, { status: 200, data: body })
  assert.ok(normalized, 'PRECONDITION: the live-shaped ASN body must normalize')
  assert.equal(
    normalized.lines.length,
    seeded.asnLines.length,
    `PRECONDITION: every item must normalize to a line: ${JSON.stringify(normalized.lines)}`,
  )
  return normalized
}

async function stockAndLayers(
  db: Awaited<ReturnType<typeof seedAsn>>['db'],
  productId: string,
  warehouseId: string,
) {
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

async function eventRow(db: Awaited<ReturnType<typeof seedAsn>>['db'], eventId: string) {
  return db.wmsInboundReceiptEvent.findUniqueOrThrow({
    where: { id: eventId },
    select: { processingStatus: true, processedAt: true, lastError: true, reviewDetails: true },
  })
}

function reviewLineWarnings(reviewDetails: unknown): Map<string, string[]> {
  const lines = (reviewDetails as { lines?: Array<{ asnLineMapId?: string; warnings?: string[] }> } | null)?.lines
  assert.ok(Array.isArray(lines), `reviewDetails must carry lines: ${JSON.stringify(reviewDetails)}`)
  return new Map(lines.map((line) => [String(line.asnLineMapId), line.warnings ?? []]))
}

async function newEventFor(seeded: Awaited<ReturnType<typeof seedAsn>>, suffix: string) {
  return seeded.db.wmsInboundReceiptEvent.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-h66s: a test fixture row, not a core flow branch
      externalEventId: `${seeded.tag}-evt-${suffix}`,
      externalAsnId: seeded.tag,
      payload: { asnId: seeded.tag },
    },
    select: { id: true },
  })
}

// ---------------------------------------------------------------------------
// (a) THE PARTIALLY-BOOKED ASN
// ---------------------------------------------------------------------------

test(
  'o3d-h66s (a): a PARTIALLY booked ASN credits the line that has a delta instead of blocking on the one that does not',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const seeded = await seedAsn('partial')
    const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')
    const [lineOne, lineTwo] = seeded.asnLines
    assert.ok(lineOne && lineTwo)

    const before = await stockAndLayers(seeded.db, lineOne.productId, seeded.warehouse.id)
    assert.deepEqual(before, { stockQty: 0, layerQty: 0 }, 'PRECONDITION: nothing booked in yet')

    const outcome = await processBookedInEvent(seeded.event.id, {
      // CONSTRUCTED: 7 of 12 booked on line 1, nothing at all on line 2.
      fetchRemoteAsn: async () => remoteAsn(seeded, [{ booked: BOOKED_ON_LINE_1 }, { booked: 0 }]),
    })

    // BEFORE THE FIX: `requires_review` with an approval-blocked `missing_local_line` raised by line 2,
    // and line 1's seven units NEVER CREDITED.
    assert.equal(outcome.status, 'processed', JSON.stringify(outcome))
    const lineOneStock = await stockAndLayers(seeded.db, lineOne.productId, seeded.warehouse.id)
    assert.equal(lineOneStock.stockQty, BOOKED_ON_LINE_1, `line 1 must be credited: ${JSON.stringify(lineOneStock)}`)
    assert.equal(lineOneStock.layerQty, BOOKED_ON_LINE_1, 'and every credited unit must be backed by a cost layer')

    // Line 2 had nothing to do, so nothing was done for it — that is the whole point.
    const lineTwoStock = await stockAndLayers(seeded.db, lineTwo.productId, seeded.warehouse.id)
    assert.deepEqual(lineTwoStock, { stockQty: 0, layerQty: 0 }, 'a zero-delta line must move no stock either')

    const transferLineOne = await seeded.db.stockTransferLine.findUniqueOrThrow({
      where: { id: lineOne.realTransferLineId },
      select: { qtyReceived: true },
    })
    assert.equal(Number(transferLineOne.qtyReceived), BOOKED_ON_LINE_1)
    const asnLineOne = await seeded.db.wmsAsnLineMap.findUniqueOrThrow({
      where: { id: lineOne.asnLineMapId },
      select: { lastProcessedReceivedQty: true },
    })
    assert.equal(Number(asnLineOne.lastProcessedReceivedQty), BOOKED_ON_LINE_1)
    const asnLineTwo = await seeded.db.wmsAsnLineMap.findUniqueOrThrow({
      where: { id: lineTwo.asnLineMapId },
      select: { lastProcessedReceivedQty: true },
    })
    assert.equal(Number(asnLineTwo.lastProcessedReceivedQty), 0)

    const row = await eventRow(seeded.db, seeded.event.id)
    assert.equal(row.processingStatus, WMS_INBOUND_EVENT_PROCESSING_STATUS.processed)
    assert.equal(row.reviewDetails, null, 'a healthy partial book-in must leave no review behind')
    const asnMap = await seeded.db.wmsAsnMap.findUniqueOrThrow({
      where: { id: seeded.asn.id },
      select: { status: true, closedAt: true },
    })
    assert.equal(asnMap.status, 'PARTIALLY_BOOKED_IN')
    assert.equal(asnMap.closedAt, null)
  },
)

// ---------------------------------------------------------------------------
// (b) THE RECHECK OF A SETTLED ASN
// ---------------------------------------------------------------------------

test(
  'o3d-h66s (b): a recheck of a FULLY SETTLED ASN is a clean no-op, not an unapprovable review',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const seeded = await seedAsn('settled')
    const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')
    const fetchRemoteAsn = async () => remoteAsn(seeded, [{ booked: EXPECTED_QTY }, { booked: EXPECTED_QTY }])

    const first = await processBookedInEvent(seeded.event.id, { fetchRemoteAsn })
    assert.equal(first.status, 'processed', JSON.stringify(first))
    const settled = await Promise.all(
      seeded.asnLines.map((line) => stockAndLayers(seeded.db, line.productId, seeded.warehouse.id)),
    )
    for (const [index, state] of settled.entries()) {
      assert.equal(state.stockQty, EXPECTED_QTY, `PRECONDITION: line ${index + 1} fully booked in`)
    }
    const callbacksBefore = await seeded.db.wmsAsnLineMap.findMany({
      where: { asnMapId: seeded.asn.id },
      select: { id: true, lastCallbackAt: true, lastProcessedReceivedQty: true },
      orderBy: { externalAsnLineId: 'asc' },
    })

    // The recheck o3d-bhvu's recovery sweep enqueues: the same ASN, the same quantities, nothing new.
    const second = await newEventFor(seeded, '2')
    const outcome = await processBookedInEvent(second.id, { fetchRemoteAsn })

    // BEFORE THE FIX: `requires_review`, `missing_local_line` on BOTH lines, and an operator who
    // cannot approve it because the warning is approval-blocked.
    assert.equal(outcome.status, 'processed', JSON.stringify(outcome))
    const row = await eventRow(seeded.db, second.id)
    assert.equal(row.processingStatus, WMS_INBOUND_EVENT_PROCESSING_STATUS.processed)
    assert.equal(row.lastError, null)
    assert.equal(row.reviewDetails, null)

    // A no-op is a no-op: DERIVED from the state read before the recheck, not from typed numbers.
    const after = await Promise.all(
      seeded.asnLines.map((line) => stockAndLayers(seeded.db, line.productId, seeded.warehouse.id)),
    )
    assert.deepEqual(after, settled, 'a recheck with nothing new must change no stock and lay no layer')
    const callbacksAfter = await seeded.db.wmsAsnLineMap.findMany({
      where: { asnMapId: seeded.asn.id },
      select: { id: true, lastCallbackAt: true, lastProcessedReceivedQty: true },
      orderBy: { externalAsnLineId: 'asc' },
    })
    assert.deepEqual(
      callbacksAfter.map((line) => [line.id, Number(line.lastProcessedReceivedQty)]),
      callbacksBefore.map((line) => [line.id, Number(line.lastProcessedReceivedQty)]),
      'and must not advance what has been processed',
    )
    // The no-actionable-lines branch records that the warehouse was heard from.
    for (const [index, line] of callbacksAfter.entries()) {
      const previous = callbacksBefore[index]!.lastCallbackAt
      assert.ok(line.lastCallbackAt, 'the recheck must record a callback timestamp')
      assert.ok(
        previous == null || line.lastCallbackAt.getTime() >= previous.getTime(),
        'the callback timestamp must not go backwards',
      )
    }
    const asnMap = await seeded.db.wmsAsnMap.findUniqueOrThrow({
      where: { id: seeded.asn.id },
      select: { status: true },
    })
    assert.equal(asnMap.status, 'BOOKED_IN')
  },
)

// ---------------------------------------------------------------------------
// (c) A READABLE REMOTE ZERO IS A MEASUREMENT
// ---------------------------------------------------------------------------

test(
  'o3d-h66s (c): a readable QuantityBooked of 0 beside a non-zero QuantityReceieved is a MEASUREMENT, not a missing line',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    /**
     * THE CASE o3d-btiw's close note called out: if Mintsoft populates `QuantityReceieved` and leaves
     * `QuantityBooked` at a readable 0, the callback reads a measured zero — and before this fix it
     * landed in the same unwaivable `missing_local_line` review, so NO WMS callback would credit stock.
     */
    loadEnv()
    const seeded = await seedAsn('measuredzero', { lines: 1 })
    const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')
    const line = seeded.asnLines[0]!

    const outcome = await processBookedInEvent(seeded.event.id, {
      // CONSTRUCTED: all twelve have ARRIVED, none has been BOOKED INTO STOCK.
      fetchRemoteAsn: async () => remoteAsn(seeded, [{ booked: 0, received: EXPECTED_QTY }]),
    })

    // BEFORE THE FIX: `requires_review`, whose only warning was `missing_local_line`.
    assert.equal(outcome.status, 'processed', JSON.stringify(outcome))
    const row = await eventRow(seeded.db, seeded.event.id)
    assert.equal(row.processingStatus, WMS_INBOUND_EVENT_PROCESSING_STATUS.processed)
    assert.equal(row.reviewDetails, null, 'a measured zero is not a defect to review')
    assert.deepEqual(
      await stockAndLayers(seeded.db, line.productId, seeded.warehouse.id),
      { stockQty: 0, layerQty: 0 },
      'and a measured zero still credits nothing',
    )

    // AND THE GAP IS STILL REPORTED — the one number Mintsoft did serve reaches the operator.
    const log = await seeded.db.activityLog.findFirst({
      where: { action: 'mintsoft_booked_in_processed', entityId: seeded.event.id },
      select: { level: true, metadata: true },
    })
    assert.ok(log, 'the processed event must be logged')
    const gap = (log!.metadata as { arrivedNotYetBookedIn?: Array<Record<string, unknown>> }).arrivedNotYetBookedIn
    assert.equal(gap?.length, 1, `the arrived-not-booked gap must be recorded: ${JSON.stringify(log!.metadata)}`)
    assert.equal(gap![0]!.arrivedAtWarehouseQty, EXPECTED_QTY)
    assert.equal(gap![0]!.bookedIntoStockQty, 0)
    assert.equal(log!.level, 'WARNING')
  },
)

// ---------------------------------------------------------------------------
// THE GUARD IS STILL A GUARD
// ---------------------------------------------------------------------------

test(
  'o3d-h66s: a local ASN line naming a transfer line IMS DOES NOT HAVE still blocks, with a delta',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const seeded = await seedAsn('dangling-delta', { lines: 1, danglingLastLine: true })
    const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')
    const line = seeded.asnLines[0]!
    assert.ok(line.dangling, 'PRECONDITION: this ASN line must name a non-existent transfer line')
    assert.equal(
      await seeded.db.stockTransferLine.count({ where: { id: line.sourceLineId } }),
      0,
      'PRECONDITION: the named transfer line must really not exist',
    )

    const fetchRemoteAsn = async () => remoteAsn(seeded, [{ booked: EXPECTED_QTY }])
    const outcome = await processBookedInEvent(seeded.event.id, { fetchRemoteAsn })
    assert.equal(outcome.status, 'requires_review', JSON.stringify(outcome))
    assert.ok(outcome.status === 'requires_review')
    // `cost_layer_snapshot_missing` rides along HONESTLY and is asserted rather than tolerated: a line
    // whose transfer line does not exist has no dispatch snapshot to slice either, and it has a delta,
    // so that warning is a true statement about this line. Asserted as an EXACT set so a warning
    // appearing or disappearing later cannot pass unnoticed.
    assert.deepEqual(
      outcome.dryRun.warnings,
      ['cost_layer_snapshot_missing', 'missing_local_line'],
      JSON.stringify(outcome.dryRun),
    )

    // AND APPROVAL CANNOT WAVE IT THROUGH.
    const approved = await processBookedInEvent(seeded.event.id, { fetchRemoteAsn, approveReview: true })
    assert.equal(approved.status, 'requires_review', JSON.stringify(approved))
    const row = await eventRow(seeded.db, seeded.event.id)
    assert.equal(row.processedAt, null)
    assert.match(String(row.lastError), /missing_local_line/)
    assert.deepEqual(
      await stockAndLayers(seeded.db, line.productId, seeded.warehouse.id),
      { stockQty: 0, layerQty: 0 },
    )
  },
)

test(
  'o3d-h66s: a local ASN line naming a transfer line IMS DOES NOT HAVE still blocks WITH NO DELTA — the fix did not mute the warning',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    /**
     * THE TEST THAT SEPARATES THE FIX FROM ITS CHEAP IMPOSTOR. "Do not raise `missing_local_line` when
     * the line has no delta" makes (a), (b) and (c) pass and DELETES the guard: this line has no delta
     * and IMS genuinely does not have it. The real fix — compute existence from the lines IMS HAS —
     * keeps it blocking.
     */
    loadEnv()
    const seeded = await seedAsn('dangling-zero', { lines: 1, danglingLastLine: true })
    const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')
    const line = seeded.asnLines[0]!
    assert.equal(
      await seeded.db.stockTransferLine.count({ where: { id: line.sourceLineId } }),
      0,
      'PRECONDITION: the named transfer line must really not exist',
    )
    const asnLine = await seeded.db.wmsAsnLineMap.findUniqueOrThrow({
      where: { id: line.asnLineMapId },
      select: { lastProcessedReceivedQty: true },
    })
    assert.equal(Number(asnLine.lastProcessedReceivedQty), 0, 'PRECONDITION: nothing processed yet')

    const fetchRemoteAsn = async () => remoteAsn(seeded, [{ booked: 0 }])
    const outcome = await processBookedInEvent(seeded.event.id, { fetchRemoteAsn })
    // PRECONDITION OF THE CASE, asserted rather than assumed: the delta really is zero.
    assert.equal(outcome.status, 'requires_review', JSON.stringify(outcome))
    assert.ok(outcome.status === 'requires_review')
    const dryRunLine = outcome.dryRun.lines[0]!
    assert.equal(dryRunLine.currentRemoteReceivedQty, 0, 'the remote quantity must be a readable zero')
    assert.equal(dryRunLine.remoteQuantityRefusal, null, 'and a measurement, not a refusal')
    assert.equal(dryRunLine.qtyReceived, 0, 'so there is NO delta to apply')
    assert.deepEqual(outcome.dryRun.warnings, ['missing_local_line'], JSON.stringify(outcome.dryRun))

    const approved = await processBookedInEvent(seeded.event.id, { fetchRemoteAsn, approveReview: true })
    assert.equal(approved.status, 'requires_review', JSON.stringify(approved))
    const row = await eventRow(seeded.db, seeded.event.id)
    assert.equal(row.processedAt, null)
    assert.match(String(row.lastError), /missing_local_line/)
  },
)

test(
  'o3d-h66s: the warning stays AGGREGATE by decision — one unknown line holds the whole event, and the review names it',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    /**
     * THE DECISION THIS PINS (o3d-h66s, deliberate, filed as a follow-up rather than changed here).
     * `dryRun.warnings` is the union over the lines, so one structurally broken line holds the WHOLE
     * receipt event — including a healthy sibling line with units to credit. That is kept, because
     * `wms_inbound_receipt_events.processingStatus` is one enum for one event and has no
     * "partly applied, partly held" value: applying the healthy line while holding the broken one
     * would mean stock moves under a row that reads REQUIRES_REVIEW, and the `reviewDetails` an
     * operator later approves would no longer describe the state it was captured from.
     *
     * WHAT MAKES IT ACCEPTABLE is that the operator is told WHICH line: the persisted `reviewDetails`
     * carries the warnings per `asnLineMapId`, and the healthy line's list is EMPTY. A genuinely
     * unknown line therefore cannot be silently skipped — it is the reason the event is held.
     *
     * If this is ever made per-line, this test goes red, which is the intended signal.
     */
    loadEnv()
    const seeded = await seedAsn('aggregate', { lines: 2, danglingLastLine: true })
    const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')
    const [healthy, dangling] = seeded.asnLines
    assert.ok(healthy && dangling)
    assert.equal(healthy.dangling, false, 'PRECONDITION: line 1 is healthy')
    assert.equal(dangling.dangling, true, 'PRECONDITION: line 2 names nothing IMS has')

    // Line 1 has a real delta; line 2 is the GENUINE unknown line AND has no delta, so
    // `missing_local_line` is the only warning in play and nothing else can be doing the blocking.
    const fetchRemoteAsn = async () => remoteAsn(seeded, [{ booked: BOOKED_ON_LINE_1 }, { booked: 0 }])
    const outcome = await processBookedInEvent(seeded.event.id, { fetchRemoteAsn })
    assert.equal(outcome.status, 'requires_review', JSON.stringify(outcome))
    assert.ok(outcome.status === 'requires_review')
    assert.deepEqual(outcome.dryRun.warnings, ['missing_local_line'], JSON.stringify(outcome.dryRun))
    // PRECONDITION OF THE CASE: line 1 really did have units to apply, so "nothing applied" below is
    // the aggregate warning's doing and not an absence of work.
    const healthyDryRunLine = outcome.dryRun.lines.find((entry) => entry.asnLineMapId === healthy.asnLineMapId)
    assert.ok(healthyDryRunLine, JSON.stringify(outcome.dryRun))
    assert.equal(healthyDryRunLine.qtyReceived, BOOKED_ON_LINE_1)
    assert.equal(healthyDryRunLine.wouldCreateCostLayer, true)

    // AGGREGATE: the healthy line's units are NOT applied while the event is held.
    assert.deepEqual(
      await stockAndLayers(seeded.db, healthy.productId, seeded.warehouse.id),
      { stockQty: 0, layerQty: 0 },
      'the aggregate warning holds the healthy line too',
    )

    // AND THE REVIEW NAMES THE LINE: per-line warnings, with the healthy line's list empty.
    const row = await eventRow(seeded.db, seeded.event.id)
    const perLine = reviewLineWarnings(row.reviewDetails)
    assert.equal(perLine.size, 2, `both lines must appear in the review: ${JSON.stringify(row.reviewDetails)}`)
    assert.deepEqual(perLine.get(dangling.asnLineMapId), ['missing_local_line'])
    assert.deepEqual(perLine.get(healthy.asnLineMapId), [], 'the healthy line must carry NO warning of its own')

    // The operator-facing activity log carries the same per-line attribution.
    const log = await seeded.db.activityLog.findFirst({
      where: { action: 'mintsoft_booked_in_review_required', entityId: seeded.event.id },
      select: { metadata: true },
    })
    assert.ok(log, 'the review must be logged')
    const lineWarnings = (log!.metadata as { lineWarnings?: Array<{ asnLineMapId?: string; warnings?: string[] }> }).lineWarnings
    assert.deepEqual(
      lineWarnings?.map((entry) => entry.asnLineMapId),
      [dangling.asnLineMapId],
      `only the broken line may be named: ${JSON.stringify(log!.metadata)}`,
    )

    const approved = await processBookedInEvent(seeded.event.id, { fetchRemoteAsn, approveReview: true })
    assert.equal(approved.status, 'requires_review', JSON.stringify(approved))
    assert.deepEqual(
      await stockAndLayers(seeded.db, healthy.productId, seeded.warehouse.id),
      { stockQty: 0, layerQty: 0 },
      'and approval cannot wave an unknown line through',
    )
  },
)
