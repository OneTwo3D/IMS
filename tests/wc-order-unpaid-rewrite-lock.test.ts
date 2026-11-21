import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { WcFullOrder } from '@/lib/connectors/woocommerce/sync/types'

// o3d-ewe4y (9): the checks the rewrite makes UNDER THE ROW LOCK, pinned without a database. The facts the amendment step read before the lock say "unpaid"; what the transaction then sees is what decides.
// The importer's mapping modules and the database are replaced with fakes; the module under test is the real one.

type Row = { status: string; payload: unknown }
const state: { paidBlockRows: Row[]; whereSeen: Array<Record<string, unknown>>; txCurrent: Record<string, unknown> } = { paidBlockRows: [], whereSeen: [], txCurrent: {} }

const current = () => ({
  id: 'o1', status: 'PENDING_PAYMENT', isQuote: false, erasedAt: null, currency: 'GBP', fxRateToBase: 1, paidAt: null, unregisteredPaidAt: null, storeCreditForeign: 0, discountModel: 'LINE_ALLOCATED', editedInImsAt: null,
  totalForeign: 10, shippingForeign: 0, taxForeign: 0, discountAmount: 0, accountingInvoiceId: null, invoiceNumber: null, invoicedAt: null, salesInvoiceOwedAt: null, refundStatus: null, orderNumber: 'SO-1',
  _count: { allocations: 0, shipments: 0, shoppingLinks: 1, lines: 0, refunds: 0, returnExpectations: 0, payments: 0, invoiceDocuments: 0 },
  wmsOrderPush: null, lines: [], ...state.txCurrent,
})

const tx = {
  $queryRaw: async () => [],
  salesOrder: { findUnique: async () => current() },
  shoppingSyncLog: {
    // Applies the status filter the way the database would, so a dropped status in the query is visible.
    findMany: async (args: { where: { status?: { in: string[] } } }) => {
      state.whereSeen.push(args.where as Record<string, unknown>)
      const allowed = args.where.status?.in
      return state.paidBlockRows.filter((r) => !allowed || allowed.includes(r.status))
    },
  },
}
const fakeDb = {
  salesOrder: { findUnique: async () => ({ fxRateToBase: 1, currency: 'GBP' }) },
  taxRate: { findFirst: async () => null },
  $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  shoppingSyncLog: tx.shoppingSyncLog,
}

mock.module('@/lib/db', { namedExports: { db: fakeDb } })
mock.module('@/lib/activity-log', { namedExports: { logActivityInTransaction: async () => undefined, logActivity: async () => undefined } })
mock.module('@/lib/connectors/woocommerce/sync/order-import', {
  namedExports: {
    pendingFxQueueWhere: (id: string) => ({ entityId: id }),
    resolveWcOrderTaxResolution: async () => ({ lineTaxResolved: [], taxRateName: null, taxRateValue: 0, taxFallbackLines: [] }),
    shouldBlockWcTaxRateFallback: () => false,
  },
})
mock.module('@/lib/connectors/woocommerce/sync/field-mapping', { namedExports: { mapWcLineItems: async () => [], resolveWcOrderLevelDiscount: () => 0, mapWcShipping: () => ({}) } })
mock.module('@/lib/connectors/woocommerce/sync/coupon-classification', { namedExports: { planWcOrderCoupons: () => ({ refusal: null, storeCreditForeign: 0, orderLevelDiscount: 0, unallocated: 0, discountStr: null }) } })

const wc = (extra: Record<string, unknown> = {}): WcFullOrder => ({ id: 9, number: '9', line_items: [], coupon_lines: [], fee_lines: [], shipping_lines: [], tax_lines: [], date_paid_gmt: null, ...extra }) as unknown as WcFullOrder

async function rewrite(order: WcFullOrder) {
  const mod = await import('@/lib/connectors/woocommerce/sync/order-unpaid-rewrite')
  return mod.rewriteUnpaidOrderFromWc('o1', order, null)
}

test('under the lock: a paid date on the payload stops the rewrite (checked after IMS\'s own payment evidence, before the invoice and edit rules)', async () => {
  state.paidBlockRows = []
  const out = await rewrite(wc({ date_paid_gmt: '2026-11-20T09:00:00' }))
  assert.equal(out.kind, 'skipped')
  assert.match(out.kind === 'skipped' ? out.reason : '', /WooCommerce shows the order as paid/)
})

test('under the lock: an open paid-block obligation, PENDING or FAILED (given up), stops the rewrite even with no paid date; a block that is neither does not', async () => {
  for (const status of ['PENDING', 'FAILED']) {
    state.paidBlockRows = [{ status, payload: { paidBlock: { reason: 'x' } } }]
    const out = await rewrite(wc())
    assert.equal(out.kind, 'skipped', status)
    assert.match(out.kind === 'skipped' ? out.reason : '', /receipt is still to be recorded/, status)
  }
  // A SYNCED obligation, or a pending-FX row that is not a paid block, is no evidence of payment: the rewrite goes on (the fake has no more of the transaction, so it fails later, which is the point).
  for (const rows of [[{ status: 'SYNCED', payload: { paidBlock: {} } }], [{ status: 'PENDING', payload: { somethingElse: true } }]]) {
    state.paidBlockRows = rows
    await assert.rejects(() => rewrite(wc()), TypeError)
  }
})

test('under the lock: IMS-recorded payment evidence stops the rewrite (paidAt, unregisteredPaidAt, a payment row) and so does a non-open status', async () => {
  state.paidBlockRows = []
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ paidAt: new Date() }, /the order is paid/],
    [{ unregisteredPaidAt: new Date() }, /the order is paid/],
    [{ _count: { ...current()._count, payments: 1 } }, /the order is paid/],
    [{ status: 'SHIPPED' }, /the order is SHIPPED/],
  ]
  for (const [over, re] of cases) {
    state.txCurrent = over
    const out = await rewrite(wc())
    assert.equal(out.kind, 'skipped')
    assert.match(out.kind === 'skipped' ? out.reason : '', re)
  }
  state.txCurrent = {}
})

test('a booked rate or currency that changed while the payload was being mapped is a retry, never a write from a stale mapping', async () => {
  state.paidBlockRows = []
  state.txCurrent = { fxRateToBase: 1.5 }
  const out = await rewrite(wc())
  assert.equal(out.kind, 'skipped')
  assert.equal(out.kind === 'skipped' && out.retry, true)
  state.txCurrent = {}
})
