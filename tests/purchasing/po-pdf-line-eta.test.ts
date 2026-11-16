import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// The order read is a double (no database): two lines, one with its own date, one following the header.
const header = new Date('2026-12-01T00:00:00.000Z')
const own = new Date('2026-12-15T00:00:00.000Z')
const lineBase = {
  description: null, qty: 5, purchaseUnitQty: null, unitCostForeign: 2, discountAmount: 0, totalForeign: 10, purchaseUnit: null,
}
const order = {
  reference: 'PO-ETA', supplierId: 's1', currency: 'GBP', createdAt: new Date('2026-11-01T00:00:00.000Z'), expectedDelivery: header,
  notes: null, supplierRef: null, subtotalForeign: 20, taxRateName: null, taxRatePercent: null, taxForeign: 0, totalForeign: 20,
  directFreightForeign: 0, discountAmount: 0,
  supplier: { name: 'S', contactName: null, email: null, addressLine1: null, addressLine2: null, city: null, postcode: null, country: null, accountNumber: null, vatNumber: null, paymentTermsDays: null },
  destinationWarehouse: null,
  lines: [
    { ...lineBase, productId: 'p1', expectedDelivery: own, product: { sku: 'A', name: 'A', barcode: null, mpn: null } },
    { ...lineBase, productId: 'p2', expectedDelivery: null, product: { sku: 'B', name: 'B', barcode: null, mpn: null } },
    { ...lineBase, productId: 'p3', expectedDelivery: new Date('2026-12-01T12:00:00.000Z'), product: { sku: 'C', name: 'C', barcode: null, mpn: null } },
  ],
}
let current: typeof order = order
const dbDouble = {
  purchaseOrder: { findUnique: async () => current },
  currency: { findUnique: async () => null },
  supplierProduct: { findMany: async () => [] },
}
mock.module('@/lib/db', { namedExports: { db: dbDouble, prisma: dbDouble } })

test('the supplier PO document carries a line date only where it differs from the header', async () => {
  const { loadPurchaseOrderDocument } = await import('../../lib/purchase-order-pdf.ts')
  const doc = await loadPurchaseOrderDocument('po-1')
  assert.ok(doc)
  assert.equal(doc.lines[0]!.deliveryDate?.toISOString(), own.toISOString(), 'a differing line date is shown')
  assert.equal(doc.lines[1]!.deliveryDate, null, 'a blank line follows the header')
  assert.equal(doc.lines[2]!.deliveryDate, null, 'the same day as the header is not repeated')
  const { poLayoutFlags, poDocumentColumns, poDocumentRows } = await import('../../lib/domain/purchasing/po-document.ts')
  const flags = poLayoutFlags(doc.lines)
  assert.equal(flags.showLineEta, true)
  const cols = poDocumentColumns('£', flags)
  assert.ok(cols.some((c) => c.label === 'Delivery'))
  assert.ok(poDocumentRows(doc.lines, flags).every((r) => r.length === cols.length))
})

test('with no differing line date the PDF layout has no Delivery column', async () => {
  current = { ...order, lines: order.lines.slice(1) }
  const { loadPurchaseOrderDocument } = await import('../../lib/purchase-order-pdf.ts')
  const doc = await loadPurchaseOrderDocument('po-1')
  const { poLayoutFlags } = await import('../../lib/domain/purchasing/po-document.ts')
  assert.equal(poLayoutFlags(doc!.lines).showLineEta, false)
})
