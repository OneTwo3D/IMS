import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregatePurchaseOrderLineOutstandingQty,
  derivePurchaseOrderReceiptStatus,
  hasPoOutstandingQty,
  isPurchaseOrderLineFullyLanded,
  isPurchaseOrderUsableForWmsReceipt,
  loadPurchaseOrderLineLandedQty,
  loadPurchaseOrderLineOutstandingQty,
  poOutstandingQtyEquals,
  purchaseOrderOutstandingTotalEntries,
  readPurchaseOrderOutstandingTotal,
  requirePoLineLandedQty,
  requirePoLineOutstandingQty,
  requirePurchaseOrderLineResidualQty,
  resolvePurchaseOrderLineLandedQty,
  resolvePurchaseOrderLineOutstandingQty,
  resolvePurchaseOrderLineResidualQty,
  sumPurchaseOrderLineOutstandingQty,
  type PurchaseOrderLandedQtyClient,
} from '@/lib/domain/inventory/po-line-landed-quantity'

/**
 * o3d-papk (6a) A1 — the PO landed-quantity combinator and the outstanding brands. Pure: no database.
 *
 * Each arm names the mutation it exists to catch and what would STILL pass it.
 */

const row = (snapshot: number, receipt: number) => ({ qtyAccountedViaSnapshot: snapshot, qtyAccountedViaReceipt: receipt })

test('A1 SUM, not max: a line spanning TWO ASNs counts both credits (mutation: max instead of sum)', () => {
  // qtyReceived 2 + unabsorbed 3 (ASN one) + unabsorbed 4 (ASN two) = 9. A `max` over the rows gives 2 + 4 = 6.
  const landed = resolvePurchaseOrderLineLandedQty({
    poLineId: 'l1',
    qtyReceived: 2,
    wmsAsnLines: [row(3, 0), row(4, 0)],
  })
  assert.equal(landed.qtyNumber, 9)
  assert.equal(landed.fromQtyReceived.toNumber(), 2)
  assert.equal(landed.fromUnabsorbedWmsSnapshot.toNumber(), 7)
  console.log('# A1 sum arm: evaluated 2 ASN rows, landed 9')
})

test('A1 FLOOR: a receipt that overtook the snapshot does not subtract (mutation: drop the floor)', () => {
  // snapshot 2, receipt 5: the book-in absorbed more than alignment ever credited (a remote regression, or
  // units booked beyond the credit). Unabsorbed is 0, NOT -3, so the 6 units in qtyReceived stay 6.
  const landed = resolvePurchaseOrderLineLandedQty({ poLineId: 'l1', qtyReceived: 6, wmsAsnLines: [row(2, 5)] })
  assert.equal(landed.qtyNumber, 6)
  assert.equal(landed.fromUnabsorbedWmsSnapshot.toNumber(), 0)
  // And a negative qtyReceived never reduces what the ASN credit says landed.
  const negative = resolvePurchaseOrderLineLandedQty({ poLineId: 'l1', qtyReceived: -1, wmsAsnLines: [row(3, 0)] })
  assert.equal(negative.qtyNumber, 3)
  console.log('# A1 floor arm: evaluated 2 fixtures')
})

test('A1 a partly absorbed credit counts only its UNABSORBED part (overlap by design)', () => {
  // 6 aligned, a book-in of 4 folded 4 of them into qtyReceived: qtyReceived 4, snapshot 6, receipt 4.
  // The 4 are in qtyReceived already, so only 2 more come from the snapshot arm: landed 6, not 10.
  const landed = resolvePurchaseOrderLineLandedQty({ poLineId: 'l1', qtyReceived: 4, wmsAsnLines: [row(6, 4)] })
  assert.equal(landed.qtyNumber, 6)
})

/** A tiny store behind the loader's client, honouring the one filter a mutation could add. */
function storeClient(rows: Array<{ sourceLineId: string; sourceType: string; closed: boolean; snapshot: number; receipt: number }>) {
  const queries: unknown[] = []
  const client = {
    wmsAsnLineMap: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        queries.push(args.where)
        const ids = (args.where.sourceLineId as { in: string[] }).in
        const closedFilter = (args.where.asn as { closedAt?: null } | undefined)?.closedAt
        return rows
          .filter((r) => r.sourceType === args.where.sourceType)
          .filter((r) => ids.includes(r.sourceLineId))
          .filter((r) => closedFilter === null ? !r.closed : true)
          .map((r) => ({ sourceLineId: r.sourceLineId, qtyAccountedViaSnapshot: r.snapshot, qtyAccountedViaReceipt: r.receipt }))
      },
    },
  } as unknown as PurchaseOrderLandedQtyClient
  return { client, queries }
}

test('A1 CLOSED rows count: a retired reservation keeps its credit (mutation: filter out closed rows)', async () => {
  const { client, queries } = storeClient([
    { sourceLineId: 'l1', sourceType: 'PURCHASE_ORDER_LINE', closed: false, snapshot: 2, receipt: 0 },
    // The retired row: closedAt set. Its 4 units are in stock and in no other column.
    { sourceLineId: 'l1', sourceType: 'PURCHASE_ORDER_LINE', closed: true, snapshot: 4, receipt: 0 },
    // A TRANSFER row with the same line id must never be read.
    { sourceLineId: 'l1', sourceType: 'STOCK_TRANSFER_LINE', closed: false, snapshot: 100, receipt: 0 },
    // Another line's row.
    { sourceLineId: 'l2', sourceType: 'PURCHASE_ORDER_LINE', closed: true, snapshot: 50, receipt: 0 },
  ])
  const landed = await loadPurchaseOrderLineLandedQty(client, [{ id: 'l1', qtyReceived: 1 }])
  assert.equal(queries.length, 1, 'ONE query for the whole set')
  assert.equal(requirePoLineLandedQty(landed, 'l1').qtyNumber, 7, '1 received + 2 open + 4 closed')
  console.log('# A1 closed-row arm: evaluated 4 stored rows, 3 belong to l1 via the PO source type')
})

test('A1 a line with no ASN rows lands exactly its qtyReceived, and an empty request makes no query', async () => {
  const { client, queries } = storeClient([])
  assert.equal((await loadPurchaseOrderLineLandedQty(client, [])).size, 0)
  assert.equal(queries.length, 0)
  const landed = await loadPurchaseOrderLineLandedQty(client, [{ id: 'l1', qtyReceived: 3 }])
  assert.equal(requirePoLineLandedQty(landed, 'l1').qtyNumber, 3)
})

test('A1 requirePoLineLandedQty and requirePoLineOutstandingQty throw rather than answer "nothing landed"', () => {
  assert.throws(() => requirePoLineLandedQty(new Map(), 'missing'), /no landed quantity was loaded for purchase-order line missing/)
  assert.throws(() => requirePoLineOutstandingQty(new Map(), 'missing'), /no outstanding quantity was loaded/)
  assert.throws(() => requirePurchaseOrderLineResidualQty(new Map(), 'missing'), /no line-scope residual quantity/)
})

test('A1 outstanding: qty minus landed, floored at zero, and ZERO for an order that expects nothing more', () => {
  const landed = (qtyReceived: number, ...rows: Array<[number, number]>) => resolvePurchaseOrderLineLandedQty({
    poLineId: 'l1',
    qtyReceived,
    wmsAsnLines: rows.map(([s, r]) => row(s, r)),
  })
  const outstanding = (lineQty: number, l: ReturnType<typeof landed>, poStatus: string) =>
    resolvePurchaseOrderLineOutstandingQty({ lineQty, landed: l, poStatus })

  assert.equal(outstanding(10, landed(0, [6, 0]), 'PO_SENT').qtyNumber, 4, 'aligned 6 of 10 leaves 4')
  assert.equal(outstanding(10, landed(4, [6, 0]), 'PARTIALLY_RECEIVED').qtyNumber, 0, '4 manual + 6 aligned is all of it')
  assert.equal(outstanding(10, landed(8, [6, 0]), 'PO_SENT').qtyNumber, 0, 'over-landed floors at zero')
  assert.equal(outstanding(10, landed(0), 'CANCELLED').qtyNumber, 0, 'CANCELLED expects nothing')
  assert.equal(outstanding(10, landed(0), 'CLOSED').qtyNumber, 0, 'CLOSED expects nothing')
  assert.equal(outstanding(10, landed(0), 'PO_SENT').qtyNumber, 10)
  // The landed quantity itself stays a physical fact on a cancelled order.
  assert.equal(outstanding(10, landed(0, [6, 0]), 'CANCELLED').landed.qtyNumber, 6)
  assert.equal(isPurchaseOrderUsableForWmsReceipt('CANCELLED'), false)
  assert.equal(isPurchaseOrderUsableForWmsReceipt('CLOSED'), false)
  for (const status of ['DRAFT', 'PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'INVOICED']) {
    assert.equal(isPurchaseOrderUsableForWmsReceipt(status), true, status)
  }
  assert.equal(hasPoOutstandingQty(outstanding(10, landed(0), 'PO_SENT')), true)
  assert.equal(hasPoOutstandingQty(outstanding(10, landed(10), 'PO_SENT')), false)
  assert.equal(poOutstandingQtyEquals(outstanding(10, landed(0), 'PO_SENT'), outstanding(10, landed(0), 'PO_SENT')), true)
  assert.equal(poOutstandingQtyEquals(outstanding(10, landed(0), 'PO_SENT'), outstanding(10, landed(1), 'PO_SENT')), false)
})

test('A1 isPurchaseOrderLineFullyLanded: landed >= qty, within the epsilon', () => {
  const l = (n: number) => resolvePurchaseOrderLineLandedQty({ poLineId: 'l', qtyReceived: 0, wmsAsnLines: [row(n, 0)] })
  assert.equal(isPurchaseOrderLineFullyLanded(10, l(9.9999)), true, 'inside the epsilon')
  assert.equal(isPurchaseOrderLineFullyLanded(10, l(9)), false)
  assert.equal(isPurchaseOrderLineFullyLanded(10, l(10)), true)
  assert.equal(isPurchaseOrderLineFullyLanded(10, l(12)), true)
})

test('A1 the loaders, residual and aggregation compose', async () => {
  const { client } = storeClient([
    { sourceLineId: 'a', sourceType: 'PURCHASE_ORDER_LINE', closed: false, snapshot: 6, receipt: 0 },
  ])
  const outstanding = await loadPurchaseOrderLineOutstandingQty(client, [
    { id: 'a', qty: 10, qtyReceived: 0, poStatus: 'PO_SENT' },
    { id: 'b', qty: 5, qtyReceived: 1, poStatus: 'PO_SENT' },
    { id: 'c', qty: 7, qtyReceived: 0, poStatus: 'CANCELLED' },
  ])
  assert.equal(outstanding.size, 3)
  assert.equal(requirePoLineOutstandingQty(outstanding, 'a').qtyNumber, 4)
  assert.equal(requirePoLineOutstandingQty(outstanding, 'b').qtyNumber, 4)
  assert.equal(requirePoLineOutstandingQty(outstanding, 'c').qtyNumber, 0)
  assert.equal(sumPurchaseOrderLineOutstandingQty(outstanding.values()).toNumber(), 8)

  const residual = resolvePurchaseOrderLineResidualQty({ lineQty: 10, landed: requirePoLineOutstandingQty(outstanding, 'a').landed })
  assert.equal(residual.poLineId, 'a')
  assert.equal(residual.qtyNumber, 4)
  // Not status-gated: the CANCELLED line's residue is still its qty minus landed (its refusal is separate).
  const cancelled = resolvePurchaseOrderLineResidualQty({ lineQty: 7, landed: requirePoLineOutstandingQty(outstanding, 'c').landed })
  assert.equal(cancelled.qtyNumber, 7)

  const totals = aggregatePurchaseOrderLineOutstandingQty([
    ['p1', requirePoLineOutstandingQty(outstanding, 'a')],
    ['p1', requirePoLineOutstandingQty(outstanding, 'b')],
    ['p2', requirePoLineOutstandingQty(outstanding, 'c')],
  ])
  assert.deepEqual(purchaseOrderOutstandingTotalEntries(totals), [['p1', 8]], 'zero totals are dropped')
  assert.equal(readPurchaseOrderOutstandingTotal(totals, 'p1'), 8)
  assert.equal(readPurchaseOrderOutstandingTotal(totals, 'p2'), 0)
  assert.equal(totals.lineCounts.get('p1'), 2)
  assert.equal(totals.lineCounts.get('p2'), 1)
})

test('C3 derivePurchaseOrderReceiptStatus: RECEIVED only when EVERY line has landed, by landed and not by qtyReceived', () => {
  const landed = (poLineId: string, qtyReceived: number, credit = 0) =>
    resolvePurchaseOrderLineLandedQty({ poLineId, qtyReceived, wmsAsnLines: credit > 0 ? [row(credit, 0)] : [] })
  // Both lines landed, line one entirely through an alignment credit (qtyReceived 0).
  assert.equal(derivePurchaseOrderReceiptStatus([
    { qty: 10, landed: landed('l1', 0, 10) },
    { qty: 5, landed: landed('l2', 5) },
  ]), 'RECEIVED')
  // One line short.
  assert.equal(derivePurchaseOrderReceiptStatus([
    { qty: 10, landed: landed('l1', 0, 10) },
    { qty: 5, landed: landed('l2', 4) },
  ]), 'PARTIALLY_RECEIVED')
  // The old derivation (qtyReceived >= qty) would have said PARTIALLY_RECEIVED for line one.
  assert.equal(derivePurchaseOrderReceiptStatus([{ qty: 10, landed: landed('l1', 0, 10) }]), 'RECEIVED')
  assert.equal(derivePurchaseOrderReceiptStatus([{ qty: 10, landed: landed('l1', 3, 4) }]), 'PARTIALLY_RECEIVED')
  console.log('# C3 derive: evaluated 4 fixtures')
})
