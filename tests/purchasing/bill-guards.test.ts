import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// Pure/doubled tests: no database, no network, no accounting connector is touched.
const settings = new Map<string, string>([['po_approval_threshold_base', '1000']])
let live: Record<string, unknown> = {}
const dbDouble = {
  setting: { findUnique: async ({ where }: { where: { key: string } }) => (settings.has(where.key) ? { value: settings.get(where.key)! } : null) },
  purchaseOrder: { findUnique: async () => live },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
    ...dbDouble,
    $executeRaw: async () => [],
    $queryRaw: async () => [],
  }),
}
mock.module('@/lib/db', { namedExports: { db: dbDouble, prisma: dbDouble } })

import {
  assertNoDuplicateSupplierBill, BILLABLE_PO_STATUSES, DuplicateSupplierInvoiceNumberError, normalizeSupplierInvoiceNumber, purchaseOrderBillStatusRefusal,
} from '@/lib/domain/purchasing/bill-guards'
import { validatePurchaseInvoiceLineLimits } from '@/lib/domain/purchasing/purchase-invoice-edit'

const draft = (poLineId: string | null, costLineId: string | null, qty: number, total: number) => ({
  poLineId, costLineId, description: null, qtyBilled: qty, unitCostForeign: total / qty, totalForeign: total, totalBase: total,
})
const poLineById = new Map([['L', { id: 'L', qty: 10, qtyReceived: 10, qtyReturned: 0, product: { sku: 'SKU-L' } }]])
const costLineById = new Map([['C', { id: 'C', amountForeign: 50, description: 'Freight', vatable: false }]])

// o3d-hqvrp.128
test('the same PO line repeated inside one bill request is capped cumulatively', () => {
  assert.doesNotThrow(() => validatePurchaseInvoiceLineLimits({ lineData: [draft('L', null, 6, 60), draft('L', null, 4, 40)], alreadyBilledLines: [], poLineById, costLineById }))
  assert.throws(() => validatePurchaseInvoiceLineLimits({ lineData: [draft('L', null, 10, 100), draft('L', null, 10, 100)], alreadyBilledLines: [], poLineById, costLineById }), /Line SKU-L exceeds/)
})

test('the same cost line repeated inside one bill request is capped cumulatively', () => {
  assert.throws(() => validatePurchaseInvoiceLineLimits({ lineData: [draft(null, 'C', 1, 50), draft(null, 'C', 1, 50)], alreadyBilledLines: [], poLineById, costLineById }), /Cost line "Freight" exceeds remaining amount/)
  assert.doesNotThrow(() => validatePurchaseInvoiceLineLimits({ lineData: [draft(null, 'C', 1, 20), draft(null, 'C', 1, 30)], alreadyBilledLines: [], poLineById, costLineById }))
})

// o3d-hqvrp.129
test('DRAFT, RFQ_SENT, QUOTE_RECEIVED and CANCELLED orders cannot be billed; placed orders and CLOSED (late bill) can', () => {
  for (const s of ['DRAFT', 'RFQ_SENT', 'QUOTE_RECEIVED', 'CANCELLED']) assert.match(purchaseOrderBillStatusRefusal(s, 'PO-1') ?? '', /cannot be billed/, s)
  for (const s of ['PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'INVOICED', 'PARTIALLY_RETURNED', 'RETURNED', 'CLOSED']) assert.equal(purchaseOrderBillStatusRefusal(s, 'PO-1'), null, s)
  assert.ok(BILLABLE_PO_STATUSES.includes('CLOSED'))
})

// o3d-hqvrp.130
function dupTx(found: { id: string; po: { reference: string } } | null) {
  const calls: unknown[] = []
  return {
    calls,
    tx: {
      $executeRaw: async () => { calls.push('lock'); return [] },
      purchaseInvoice: { findFirst: async (args: unknown) => { calls.push(args); return found } },
    },
  }
}

test('a bill under an invoice number the supplier already has is refused, unless overridden', async () => {
  const hit = { id: 'inv-1', po: { reference: 'PO-9' } }
  const refused = dupTx(hit)
  await assert.rejects(() => assertNoDuplicateSupplierBill(refused.tx, { supplierId: 's1', invoiceNumber: 'INV-555' }), (e: unknown) => e instanceof DuplicateSupplierInvoiceNumberError && /INV-555/.test(e.message) && /PO-9/.test(e.message))
  assert.equal(refused.calls[0], 'lock')

  const overridden = dupTx(hit)
  await assertNoDuplicateSupplierBill(overridden.tx, { supplierId: 's1', invoiceNumber: 'INV-555', override: true })
  assert.equal(overridden.calls.length, 0)

  const none = dupTx(null)
  await assertNoDuplicateSupplierBill(none.tx, { supplierId: 's1', invoiceNumber: 'INV-556' })
  const blank = dupTx(hit)
  await assertNoDuplicateSupplierBill(blank.tx, { supplierId: 's1', invoiceNumber: normalizeSupplierInvoiceNumber('   ') })
  assert.equal(blank.calls.length, 0)
})

test('the duplicate lookup is per supplier and case-insensitive', async () => {
  const d = dupTx(null)
  await assertNoDuplicateSupplierBill(d.tx, { supplierId: 's1', invoiceNumber: normalizeSupplierInvoiceNumber('  inv-555 ') })
  assert.deepEqual((d.calls[1] as { where: unknown }).where, { invoiceNumber: { equals: 'inv-555', mode: 'insensitive' }, po: { supplierId: 's1' } })
})

// o3d-nnxib
test('a document rendered at a dearer total is refused even though the live order has since been edited below the threshold', async () => {
  const { assertPoApprovedForSend } = await import('@/lib/domain/purchasing/po-approval')
  // Live order: edited DOWN to 900 ex VAT (under the 1000 threshold) after the 1500 version was rendered; approval snapshot is stale/none.
  live = { type: 'GOODS', supplierId: 's1', currency: 'GBP', totalBase: '1080', taxBase: '180', approvedAt: null, approvedTotalBase: null, approvedSupplierId: null, approvedCurrency: null }
  await assertPoApprovedForSend(dbDouble as never, 'po1') // live alone passes: the race
  const rendered = { type: 'GOODS', supplierId: 's1', currency: 'GBP', totalBase: '1800', taxBase: '300' }
  await assert.rejects(() => assertPoApprovedForSend(dbDouble as never, 'po1', rendered), /needs approval/)
  // The document that matches the live order is still sent.
  await assertPoApprovedForSend(dbDouble as never, 'po1', { ...rendered, totalBase: '1080', taxBase: '180' })
})

test('the delivery guard refuses on the rendered facts', async () => {
  const { purchaseOrderSendGuardFor } = await import('../../lib/purchase-order-email.ts')
  live = { type: 'GOODS', supplierId: 's1', currency: 'GBP', totalBase: '1080', taxBase: '180', approvedAt: null, approvedTotalBase: null, approvedSupplierId: null, approvedCurrency: null }
  let sent = false
  const guard = purchaseOrderSendGuardFor('po1', { type: 'GOODS', supplierId: 's1', currency: 'GBP', totalBase: '1800', taxBase: '300' })
  const out = await guard(async () => { sent = true; return 'ok' })
  assert.match(String(out.refused), /Not sent/)
  assert.equal(sent, false)
})
