import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { randomUUID } from 'node:crypto'
import { liveMintsoftBookedInAsnRef } from '@/tests/helpers/live-mintsoft-asn-ref'
import * as fixtures from './po-landed-fixtures'
import type { SeededAsn, SeededLine, SeededPo } from './po-landed-fixtures'

/**
 * o3d-papk (6a follow-up, commit C1) — A BOOK-IN CHANGES WHAT HAS LANDED BY EXACTLY THE STOCK IT ADDS.
 *
 * `reconcileBookedInQuantities` used to read the LINE-WIDE `qtyReceived` as "manual receipts made against THIS
 * ASN" and applied that term BEFORE the snapshot cover. With a manual receipt on the line the book-in then
 * (a) folded fewer units into qtyReceived than it recorded on `qtyAccountedViaReceipt`, so the line's LANDED
 * quantity FELL, and (b) for an ASN sized after a manual receipt (o3d-67kw3) added too little stock.
 *
 *   H1 (Codex, 5f14d41c): PO line 10. Alignment credits 6. A manual receipt of 4 is accepted (PO RECEIVED).
 *      Mintsoft books the 6. qtyReceived rises by 2, viaReceipt by 6, landed falls 10 -> 6, the PO flips back to
 *      PARTIALLY_RECEIVED and the receipt guard accepts ANOTHER 4: stock 14 for 10 physical units.
 *
 * EVERY arm runs the real `applyMintsoftAlignmentForProduct`, `receivePurchaseOrder`/`receiveTransferPartial`
 * and `processBookedInEvent` over a real PostgreSQL. Mintsoft is never contacted. Fixture identity is
 * `randomUUID()` entropy first, never truncated (o3d-kx1uy): CI shares one database and these rows stay.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { recordWmsMutationEvent: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async () => {}, logActivityInTransaction: async () => {} },
})
mock.module('@/lib/fulfillment/backorder-allocator', { namedExports: { allocateBackordersForProducts: async () => ({}) } })
mock.module('@/lib/fulfillment/overallocation-rebalancer', { namedExports: { releaseOverallocations: async () => ({}) } })

const { loadEnv, enableStockReceiptPosting, uid, seedPo, addAsn, alignUp, receive, snapshotOf, UNIT_COST } = fixtures

test.before(async () => {
  if (!RUN) return
  loadEnv()
  await enableStockReceiptPosting()
})

/** Landed quantity of a PO line by the module's own definition. */
async function poLanded(line: SeededLine): Promise<number> {
  const { db } = await import('@/lib/db')
  const { loadPurchaseOrderLineLandedQty } = await import('@/lib/domain/inventory/po-line-landed-quantity')
  const row = await db.purchaseOrderLine.findUniqueOrThrow({ where: { id: line.poLineId }, select: { id: true, qtyReceived: true } })
  return (await loadPurchaseOrderLineLandedQty(db, [row])).get(line.poLineId)!.qtyNumber
}

/** A booked-in event whose result is handed back WITH its event id, so a review can be approved afterwards. */
async function openBookIn(asn: SeededAsn, line: SeededLine, expectedQty: number, bookedQty: number) {
  const { db } = await import('@/lib/db')
  const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')
  const event = await db.wmsInboundReceiptEvent.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-papk: a test fixture row, not a core flow branch
      externalEventId: `${uid()}-evt`,
      externalAsnId: asn.externalAsnId,
      payload: { asnId: asn.externalAsnId },
    },
    select: { id: true },
  })
  const remote = liveMintsoftBookedInAsnRef({
    externalAsnId: asn.externalAsnId,
    externalLineId: asn.externalAsnLineId,
    sourceLineId: line.poLineId,
    sku: line.sku,
    expectedQty,
    bookedQty,
  })
  const fetchRemoteAsn = async () => ({ ...remote, status: 'RECEIVED', raw: null })
  return {
    eventId: event.id,
    first: await processBookedInEvent(event.id, { fetchRemoteAsn }),
    approve: () => processBookedInEvent(event.id, { fetchRemoteAsn, approveReview: true }),
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// A-D1 — THE H1 SEQUENCE ON A PURCHASE ORDER
// ───────────────────────────────────────────────────────────────────────────────────────────────
test(
  'A-D1 H1: align 6, manual 4, Mintsoft books 6: stock stays 10, landed stays 10, PO RECEIVED, and a SECOND manual 4 is refused',
  SKIP,
  async () => {
    const po = await seedPo('ad1', [10])
    const line = po.lines[0]!
    const asn = await addAsn(po, line, { expectedQty: 10, status: 'OPEN' })

    const aligned = await alignUp(po, line, { delta: 6, imsQty: 0 })
    assert.equal(aligned.applied, true, `PRECONDITION: alignment applied: ${JSON.stringify(aligned)}`)
    const manual = await receive(po, line, 4)
    assert.equal(manual.success, true, `PRECONDITION: the manual 4 is accepted (6 landed, 4 outstanding): ${manual.error}`)
    const mid = await snapshotOf(po, line)
    assert.equal(mid.stock, 10, 'PRECONDITION: 6 aligned + 4 manual = 10 physical units in stock')
    assert.equal(mid.qtyReceived, 4, 'PRECONDITION: qtyReceived is the manual 4 only')
    assert.equal(mid.credits.get(asn.asnLineMapId)?.snapshot, 6, 'PRECONDITION: the ASN row carries the 6-unit credit')
    assert.equal(await poLanded(line), 10, 'PRECONDITION: landed is 10 before the book-in')

    const booked = await openBookIn(asn, line, 10, 6)
    assert.equal(booked.first.status, 'processed', `PRECONDITION: the book-in processed: ${JSON.stringify(booked.first)}`)

    const after = await snapshotOf(po, line)
    const landed = await poLanded(line)
    console.log(`# A-D1: after book-in stock=${after.stock} layers=${after.layerCount} journals=${after.journals} qtyReceived=${after.qtyReceived} landed=${landed} poStatus=${after.poStatus}`)
    assert.equal(after.stock, 10, 'the book-in covers units already in stock: it adds NONE')
    assert.equal(landed, 10, 'a book-in changes landed by exactly the stock it adds (0): landed must not fall')
    assert.equal(after.poStatus, 'RECEIVED', 'every unit landed, so the PO stays RECEIVED')
    assert.equal(after.layerQty, 10, 'cost layers total 10 units')
    assert.equal(after.layerCount, after.journals, 'one STOCK_RECEIPT journal per cost layer: 10 x cost in total')

    const second = await receive(po, line, 4)
    const final = await snapshotOf(po, line)
    assert.equal(second.success, false, `a SECOND manual 4 must be refused: nothing is outstanding (stock is ${final.stock} for 10 physical units)`)
    assert.equal(final.stock, 10)
    assert.equal(final.layerQty * UNIT_COST, 50, 'layers value 10 x unit cost')
    console.log('# A-D1: evaluated 1 sequence (align 6, manual 4, book 6, second manual 4 refused)')
  },
)

// ───────────────────────────────────────────────────────────────────────────────────────────────
// A-D2 — S5: TWO ASNs ON ONE LINE (the pool is the LINE's unreconciled manual receipts, not this row's)
// ───────────────────────────────────────────────────────────────────────────────────────────────
test(
  'A-D2 S5: ASN A booked 4 (closed), ASN B sized 6 and booked 6: all 6 land (stock 10, qtyReceived 10), no manual pool',
  SKIP,
  async () => {
    const po = await seedPo('ad2', [10])
    const line = po.lines[0]!
    const asnA = await addAsn(po, line, { expectedQty: 4, status: 'OPEN' })
    const a = await openBookIn(asnA, line, 4, 4)
    assert.equal(a.first.status, 'processed', `PRECONDITION: ASN A booked in: ${JSON.stringify(a.first)}`)
    const mid = await snapshotOf(po, line)
    assert.equal(mid.stock, 4, 'PRECONDITION: ASN A added its 4')
    assert.equal(mid.qtyReceived, 4, 'PRECONDITION: qtyReceived is 4 (all of it ASN A, none manual)')

    const asnB = await addAsn(po, line, { expectedQty: 6, status: 'OPEN' })
    const b = await openBookIn(asnB, line, 6, 6)
    assert.equal(b.first.status, 'processed', `PRECONDITION: ASN B booked in: ${JSON.stringify(b.first)}`)
    const after = await snapshotOf(po, line)
    console.log(`# A-D2: stock=${after.stock} qtyReceived=${after.qtyReceived} poStatus=${after.poStatus}`)
    assert.equal(after.stock, 10, 'ASN B adds all 6: ASN A\'s receipts are not manual receipts against B')
    assert.equal(after.qtyReceived, 10)
    assert.equal(after.poStatus, 'RECEIVED')
    console.log('# A-D2: evaluated 2 ASNs on one line')
  },
)

// ───────────────────────────────────────────────────────────────────────────────────────────────
// A-D4 — S3: THE SAME UNITS RECEIVED BY HAND AND BOOKED IN BY THE WMS (trunk semantics are kept)
// ───────────────────────────────────────────────────────────────────────────────────────────────
test(
  'A-D4 S3: a manual 4 made AFTER the ASN was sized, then the WMS books the same 4: stock stays 4 (no double entry)',
  SKIP,
  async () => {
    const po = await seedPo('ad4', [10])
    const line = po.lines[0]!
    const asn = await addAsn(po, line, { expectedQty: 10, status: 'OPEN' })
    const manual = await receive(po, line, 4)
    assert.equal(manual.success, true, `PRECONDITION: the manual 4 is accepted: ${manual.error}`)
    assert.equal((await snapshotOf(po, line)).stock, 4, 'PRECONDITION: the manual receipt put 4 in stock')

    const booked = await openBookIn(asn, line, 10, 4)
    assert.equal(booked.first.status, 'processed', `PRECONDITION: the book-in processed: ${JSON.stringify(booked.first)}`)
    const after = await snapshotOf(po, line)
    console.log(`# A-D4: stock=${after.stock} qtyReceived=${after.qtyReceived} layers=${after.layerCount}`)
    assert.equal(after.stock, 4, 'the 4 the WMS booked are the 4 the operator received: no second entry')
    assert.equal(after.qtyReceived, 4)
    assert.equal(after.layerCount, 1, 'no second cost layer')
    console.log('# A-D4: evaluated 1 double-entry sequence')
  },
)

// ───────────────────────────────────────────────────────────────────────────────────────────────
// A-D6 — THE DRY RUN AND THE APPLIED BOOK-IN USE THE SAME POOL
// ───────────────────────────────────────────────────────────────────────────────────────────────
test(
  'A-D6: the stockQtyToAdd the review shows is the stock the approved book-in adds',
  SKIP,
  async () => {
    const po = await seedPo('ad6', [10])
    const line = po.lines[0]!
    const asnA = await addAsn(po, line, { expectedQty: 4, status: 'OPEN' })
    assert.equal((await openBookIn(asnA, line, 4, 4)).first.status, 'processed', 'PRECONDITION: ASN A booked its 4')
    const asnB = await addAsn(po, line, { expectedQty: 6, status: 'OPEN' })
    const stockBefore = (await snapshotOf(po, line)).stock
    assert.equal(stockBefore, 4, 'PRECONDITION: 4 in stock before ASN B')

    // 7 booked against an expectation of 6 raises `received_over_expected`, which sends the event to REVIEW
    // and persists the dry run the operator reads.
    const booked = await openBookIn(asnB, line, 6, 7)
    assert.equal(booked.first.status, 'requires_review', `PRECONDITION: the over-receipt went to review: ${JSON.stringify(booked.first)}`)
    const review = booked.first.status === 'requires_review' ? booked.first.dryRun : null
    const shown = review!.lines[0]!.stockQtyToAdd
    const approved = await booked.approve()
    assert.equal(approved.status, 'processed', `PRECONDITION: the approved book-in processed: ${JSON.stringify(approved)}`)
    const applied = (await snapshotOf(po, line)).stock - stockBefore
    console.log(`# A-D6: dry run shows stockQtyToAdd=${shown}, approved book-in added ${applied}`)
    assert.equal(shown, applied, 'the review and the applied book-in must agree')
    assert.equal(applied, 6, 'ASN B adds all 6 of its expectation')
    console.log('# A-D6: evaluated 1 review + approval')
  },
)

// ───────────────────────────────────────────────────────────────────────────────────────────────
// A-D5 — THE SAME SHAPE ON A TRANSFER
// ───────────────────────────────────────────────────────────────────────────────────────────────
async function seedTransferWithOpenAsn(label: string) {
  const { db } = await import('@/lib/db')
  const tag = `${uid()}-papk-tr-${label}`
  const product = await db.product.create({
    data: { sku: tag, name: `papk transfer ${label}`, type: 'SIMPLE', countryOfOrigin: 'CN' },
    select: { id: true },
  })
  const source = await db.warehouse.create({ data: { code: `${uid()}-S`, name: `${tag} source`, type: 'STANDARD' }, select: { id: true } })
  const destination = await db.warehouse.create({
    data: { code: `${uid()}-D`, name: `${tag} dest`, type: 'STANDARD' },
    select: { id: true, code: true, name: true },
  })
  const sourceLayer = await db.costLayer.create({
    data: { productId: product.id, warehouseId: source.id, receivedQty: '10.000000', remainingQty: '0.000000', unitCostBase: UNIT_COST },
    select: { id: true },
  })
  const snapshot = [{ costLayerId: sourceLayer.id, qty: '10.000000', unitCostBase: `${UNIT_COST}.000000` }]
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
          productName: `papk transfer ${label}`,
          qty: '10.0000',
          qtyReceived: '0.0000',
          costLayerSnapshot: snapshot,
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const transferLineId = transfer.lines[0]!.id
  const externalAsnId = `${tag}-asn`
  const asn = await db.wmsAsnMap.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-papk: a test fixture row, not a core flow branch
      externalAsnId,
      sourceType: 'STOCK_TRANSFER',
      sourceId: transfer.id,
      warehouseId: destination.id,
      status: 'OPEN',
      lines: {
        create: [{
          externalAsnLineId: `${externalAsnId}-1`,
          sourceType: 'STOCK_TRANSFER_LINE',
          sourceLineId: transferLineId,
          productId: product.id,
          sku: tag,
          expectedQty: '10.0000',
        }],
      },
    },
    select: { id: true, lines: { select: { id: true, externalAsnLineId: true } } },
  })
  const binding = {
    id: `binding-${tag}`,
    connector: 'mintsoft', // wms-connector-boundary-ok: o3d-papk: a test fixture value, not a core flow branch
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
    tag,
    productId: product.id,
    sku: tag,
    destinationId: destination.id,
    transferId: transfer.id,
    transferLineId,
    asnLineMapId: asn.lines[0]!.id,
    externalAsnId,
    externalAsnLineId: asn.lines[0]!.externalAsnLineId,
    binding,
  }
}

test(
  'A-D5 transfer H1: align 6, manual partial 4, Mintsoft books 6: landed stays 10 and qtyReceived reaches 10, stock stays 10',
  SKIP,
  async () => {
    const seeded = await seedTransferWithOpenAsn('ad5')
    const { db } = await import('@/lib/db')
    const { applyMintsoftAlignmentForProduct } = await import('@/lib/connectors/mintsoft/sync/stock-sync')
    const { receiveTransferPartial } = await import('@/app/actions/transfers')
    const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')
    const { loadTransferLineLandedQty } = await import('@/lib/domain/inventory/transfer-landed-quantity')

    const aligned = await applyMintsoftAlignmentForProduct({
      binding: seeded.binding as never,
      jobId: `papk-${uid()}`,
      productId: seeded.productId,
      sku: seeded.sku,
      delta: 6,
      imsQty: 0,
      dryRun: false,
    })
    assert.equal(aligned.applied, true, `PRECONDITION: alignment applied: ${JSON.stringify(aligned)}`)
    const manual = await receiveTransferPartial(seeded.transferId, [{ lineId: seeded.transferLineId, qty: 4 }], `papk-${randomUUID()}`)
    assert.equal(manual.message ?? null, null, `PRECONDITION: the manual partial receipt of 4 succeeded: ${JSON.stringify(manual)}`)

    const stockOf = async () => Number((await db.stockLevel.findUnique({
      where: { productId_warehouseId: { productId: seeded.productId, warehouseId: seeded.destinationId } },
      select: { quantity: true },
    }))?.quantity ?? 0)
    const landedOf = async () => {
      const line = await db.stockTransferLine.findUniqueOrThrow({ where: { id: seeded.transferLineId }, select: { id: true, qtyReceived: true } })
      return { landed: (await loadTransferLineLandedQty(db, [line])).get(seeded.transferLineId)!.qtyNumber, qtyReceived: Number(line.qtyReceived) }
    }
    const mid = await landedOf()
    assert.equal(await stockOf(), 10, 'PRECONDITION: 6 aligned + 4 manual = 10 in stock')
    assert.equal(mid.qtyReceived, 4, 'PRECONDITION: qtyReceived is the manual 4')
    assert.equal(mid.landed, 10, 'PRECONDITION: landed is 10 before the book-in')

    const event = await db.wmsInboundReceiptEvent.create({
      data: {
        connector: 'mintsoft', // wms-connector-boundary-ok: o3d-papk: a test fixture row, not a core flow branch
        externalEventId: `${uid()}-evt`,
        externalAsnId: seeded.externalAsnId,
        payload: { asnId: seeded.externalAsnId },
      },
      select: { id: true },
    })
    const remote = liveMintsoftBookedInAsnRef({
      externalAsnId: seeded.externalAsnId,
      externalLineId: seeded.externalAsnLineId,
      sourceLineId: seeded.transferLineId,
      sku: seeded.sku,
      expectedQty: 10,
      bookedQty: 6,
    })
    const result = await processBookedInEvent(event.id, { fetchRemoteAsn: async () => ({ ...remote, status: 'RECEIVED', raw: null }) })
    assert.equal(result.status, 'processed', `PRECONDITION: the transfer book-in processed: ${JSON.stringify(result)}`)

    const after = await landedOf()
    console.log(`# A-D5: after book-in stock=${await stockOf()} qtyReceived=${after.qtyReceived} landed=${after.landed}`)
    assert.equal(await stockOf(), 10, 'the book-in covers units already in stock: it adds none')
    assert.equal(after.landed, 10, 'a book-in changes landed by exactly the stock it adds (0): landed must not fall')
    assert.equal(after.qtyReceived, 10, 'the 6 covered units are folded into qtyReceived beside the manual 4')
    console.log('# A-D5: evaluated 1 transfer sequence')
  },
)
