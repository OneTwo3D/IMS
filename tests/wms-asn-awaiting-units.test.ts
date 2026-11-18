import assert from 'node:assert/strict'
import test from 'node:test'
import { isWmsAsnAwaitingUnits, wmsAsnAwaitingUnitsWhere } from '../lib/domain/wms/asn-awaiting-units.ts'
import { getProductIncomingStock } from '../lib/domain/inventory/product-lifecycle-archive.ts'
import { resolveBackInStockDates } from '../lib/domain/inventory/back-in-stock-date.ts'

/**
 * o3d-42a05: the Mintsoft sync writes BOOKED_IN from the warehouse's status with closedAt null and the
 * receipt not yet applied, so BOOKED_IN-with-closedAt-null still expects units. These pin that the
 * incoming-stock readers keep such an ASN, and still drop one whose receipt is accounted for (closedAt set).
 */
type AsnRow = { status: string; closedAt: Date | null }
type LineRow = {
  sourceType: string
  sourceLineId: string
  expectedQty: number
  qtyAccountedViaSnapshot: number
  qtyAccountedViaReceipt: number
  asn: AsnRow
}

function matches(asn: AsnRow, where: ReturnType<typeof wmsAsnAwaitingUnitsWhere>): boolean {
  return (where.OR ?? []).some((clause) => {
    const status = clause.status as string | { in: string[] }
    const statusOk = typeof status === 'string' ? asn.status === status : status.in.includes(asn.status)
    const closedOk = !('closedAt' in clause) || (clause.closedAt === null && asn.closedAt === null)
    return statusOk && closedOk
  })
}

// A cancelled-dispatch transfer's ASN, left open: its parent is not IN_TRANSIT, so only the ASN arm speaks.
function clientWith(lines: LineRow[]) {
  return {
    purchaseOrderLine: { findMany: async () => [] },
    stockTransferLine: { findMany: async () => [] },
    productionOrder: { findMany: async () => [] },
    wmsAsnLineMap: {
      findMany: async (args: { where: { asn: ReturnType<typeof wmsAsnAwaitingUnitsWhere> } }) =>
        lines.filter((line) => matches(line.asn, args.where.asn)),
    },
  } as unknown as NonNullable<Parameters<typeof getProductIncomingStock>[1]>['client']
}

const line = (asn: AsnRow, over: Partial<LineRow> = {}): LineRow => ({
  sourceType: 'STOCK_TRANSFER_LINE', sourceLineId: 'tl-1', expectedQty: 10, qtyAccountedViaSnapshot: 0, qtyAccountedViaReceipt: 0, asn, ...over,
})

test('BOOKED_IN with closedAt null still counts as incoming stock; BOOKED_IN with closedAt set does not', async () => {
  const open = await getProductIncomingStock('p', { client: clientWith([line({ status: 'BOOKED_IN', closedAt: null })]) })
  assert.equal(open.wmsAsn, '10')
  const closed = await getProductIncomingStock('p', { client: clientWith([line({ status: 'BOOKED_IN', closedAt: new Date() })]) })
  assert.equal(closed.wmsAsn, '0')
  const partial = await getProductIncomingStock('p', { client: clientWith([line({ status: 'PARTIALLY_BOOKED_IN', closedAt: null })]) })
  assert.equal(partial.wmsAsn, '10')
})

test('units already accounted on a BOOKED_IN-not-closed ASN are subtracted, never double counted', async () => {
  const result = await getProductIncomingStock('p', {
    client: clientWith([line({ status: 'BOOKED_IN', closedAt: null }, { qtyAccountedViaSnapshot: 4 })]),
  })
  assert.equal(result.wmsAsn, '6')
})

test('isWmsAsnAwaitingUnits: one rule over a loaded row', () => {
  assert.equal(isWmsAsnAwaitingUnits({ status: 'BOOKED_IN', closedAt: null }), true)
  assert.equal(isWmsAsnAwaitingUnits({ status: 'BOOKED_IN', closedAt: new Date() }), false)
  assert.equal(isWmsAsnAwaitingUnits({ status: 'OPEN', closedAt: null }), true)
  assert.equal(isWmsAsnAwaitingUnits({ status: 'CREATE_PENDING', closedAt: null }), false)
})

test('back-in-stock dating uses the ETA of a BOOKED_IN ASN that is not yet closed', () => {
  const eta = new Date('2099-01-05T00:00:00Z')
  const po = { id: 'l1', productId: 'p', qty: 10, qtyReceived: 0, expectedDelivery: null, po: { expectedDelivery: null } }
  const asnLine = (closedAt: Date | null) => ({
    sourceLineId: 'l1', expectedQty: 10, qtyAccountedViaSnapshot: 0, qtyAccountedViaReceipt: 0,
    asn: { eta, status: 'BOOKED_IN', closedAt },
  })
  const now = new Date('2098-12-01T00:00:00Z')
  assert.equal(resolveBackInStockDates([po], [asnLine(null)], now).get('p'), '2099-01-05')
  assert.equal(resolveBackInStockDates([po], [asnLine(new Date())], now).get('p'), undefined)
})
