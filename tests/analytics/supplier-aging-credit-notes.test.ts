import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-tomf: supplier aging published the full bill and never mentioned POSTED supplier credit notes.
 * The Credited column carries them beside the billed figures (same VAT-inclusive basis); the billed
 * figures and age bands are deliberately not reduced (a credit note is only optionally tied to a bill).
 */

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireApiAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
  },
})

let lastArgs: unknown = null
let SUPPLIERS: unknown[] = []
mock.module('@/lib/db', {
  namedExports: { db: { supplier: { findMany: async (args: unknown) => { lastArgs = args; return SUPPLIERS } } } },
})

function po(credits: number[]) {
  return {
    totalBase: 1200, taxBase: 200, directFreightBase: 0, subtotalBase: 1000,
    lines: [{ totalBase: 1000 }], poSentAt: null, receivedAt: null,
    invoices: [{ totalBase: 1200, invoiceDate: new Date(Date.now() - 10 * 86400000), paidAt: null }],
    returns: [],
    supplierCreditNotes: credits.map((amountBase) => ({ amountBase })),
  }
}

test('supplier aging: POSTED credit notes are published as Credited, billed figures untouched (o3d-tomf)', async () => {
  SUPPLIERS = [{ id: 's1', name: 'Acme', purchaseOrders: [po([100.005, 50]), po([25])] }]
  const { getSupplierAging } = await import('@/app/actions/purchase-stats')
  const [row] = await getSupplierAging()
  assert.equal(row.creditedAmount, 175.01, 'summed exactly, rounded once')
  assert.equal(row.billedAmount, 2400, 'the bill is not silently reduced')
  assert.equal(row.billedWithoutPaymentMarker, 2400)
})

test('supplier aging: the query asks for POSTED credit notes only (DRAFT is not a document)', async () => {
  SUPPLIERS = [{ id: 's1', name: 'Acme', purchaseOrders: [po([])] }]
  const { getSupplierAging } = await import('@/app/actions/purchase-stats')
  const [row] = await getSupplierAging()
  assert.equal(row.creditedAmount, 0)
  const sel = (lastArgs as { select: { purchaseOrders: { select: { supplierCreditNotes: unknown } } } }).select.purchaseOrders.select
  assert.deepEqual(sel.supplierCreditNotes, { where: { status: 'POSTED' }, select: { amountBase: true } })
})
