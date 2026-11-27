import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deferralAnchorDay,
  provenInvoiceBasisOrders,
  readInvoiceBasisDeferralSwitch,
} from '@/lib/domain/accounting/invoice-basis-deferral'

// unpaid-invoice deferral: the proof Group A1 needs before it defers an UNPAID order's revenue from its invoice.

const SINCE = new Date('2026-12-01T09:00:00.000Z')
const order = { id: 'so-1', accountingInvoiceId: 'INV-1' }
const good = {
  type: 'SALES_INVOICE', referenceId: 'so-1', externalTransactionId: 'INV-1', status: 'SYNCED', settlementBasis: null, abandonedBeforeRemoteCall: false,
  syncedAt: new Date('2026-12-02T10:00:00.000Z'), payload: { _postingMode: 'submitted', date: '2026-11-30' },
}

test('a connector-confirmed AUTHORISED invoice posted at or after switch-on is proof, dated on its document day', () => {
  const proven = provenInvoiceBasisOrders([order], [good], SINCE)
  assert.equal(proven.get('so-1')?.eventAt.toISOString(), '2026-11-30T00:00:00.000Z', 'the document day, even when it predates switch-on')
  assert.ok(provenInvoiceBasisOrders([order], [{ ...good, syncedAt: SINCE }], SINCE).has('so-1'), 'exactly at the switch-on instant counts')
})

test('anything less is not proof: the order stays in Sales', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['posted before switch-on (no backfill)', { syncedAt: new Date(SINCE.getTime() - 1) }],
    ['DRAFT mode', { payload: { _postingMode: 'draft', date: '2026-11-30' } }],
    ['no posting mode recorded', { payload: { date: '2026-11-30' } }],
    ['no document date', { payload: { _postingMode: 'submitted' } }],
    ['not synced', { status: 'PENDING', externalTransactionId: null }],
    ['operator assertion, not a connector confirmation', { settlementBasis: 'OPERATOR_ASSERTION' }],
    ['another document', { externalTransactionId: 'INV-OTHER' }],
    ['another order', { referenceId: 'so-2' }],
    ['no sync time', { syncedAt: null }],
  ]
  for (const [label, override] of cases) {
    assert.equal(provenInvoiceBasisOrders([order], [{ ...good, ...override } as typeof good], SINCE).has('so-1'), false, label)
  }
  assert.equal(provenInvoiceBasisOrders([{ id: 'so-1', accountingInvoiceId: null }], [good], SINCE).size, 0, 'no invoice id')
  const draftUpdate = { ...good, type: 'SALES_INVOICE_UPDATE', payload: { _postingMode: 'draft', date: '2026-11-30' } }
  assert.equal(provenInvoiceBasisOrders([order], [good, draftUpdate], SINCE).has('so-1'), false, 'any synced draft-mode row refuses the order')
})

test('the switch reads ON only for exactly "true" with a readable switch-on instant', async () => {
  const reader = (rows: Record<string, string>) => ({ setting: { findUnique: async ({ where }: { where: { key: string } }) => (where.key in rows ? { value: rows[where.key] } : null) } }) as never
  const KEY = 'xero_defer_unpaid_invoiced_revenue_enabled'
  const AT = 'xero_defer_unpaid_invoiced_revenue_enabled_at'
  assert.deepEqual(await readInvoiceBasisDeferralSwitch(reader({})), { on: false })
  assert.deepEqual(await readInvoiceBasisDeferralSwitch(reader({ [KEY]: 'true' })), { on: false }, 'no instant: off, never "every open invoice"')
  assert.deepEqual(await readInvoiceBasisDeferralSwitch(reader({ [KEY]: 'true', [AT]: 'garbage' })), { on: false })
  for (const v of ['TRUE', '1', 'false']) assert.deepEqual(await readInvoiceBasisDeferralSwitch(reader({ [KEY]: v, [AT]: SINCE.toISOString() })), { on: false }, v)
  assert.deepEqual(await readInvoiceBasisDeferralSwitch(reader({ [KEY]: 'true', [AT]: SINCE.toISOString() })), { on: true, since: SINCE })
})

test('the anchor day: payment day for PAID / NULL (switch-off behaviour unchanged), invoice document day for INVOICE', () => {
  const paidAt = new Date('2026-12-05T12:00:00.000Z')
  const eventAt = new Date('2026-11-30T00:00:00.000Z')
  assert.equal(deferralAnchorDay({ paidAt }), '2026-12-05')
  assert.equal(deferralAnchorDay({ paidAt, revenueDeferralBasis: null, revenueDeferralEventAt: null }), '2026-12-05')
  assert.equal(deferralAnchorDay({ paidAt, revenueDeferralBasis: 'PAID', revenueDeferralEventAt: eventAt }), '2026-12-05')
  assert.equal(deferralAnchorDay({ paidAt, revenueDeferralBasis: 'INVOICE', revenueDeferralEventAt: eventAt }), '2026-11-30', 'a later payment does not move it')
  assert.equal(deferralAnchorDay({ paidAt: null, revenueDeferralBasis: 'INVOICE', revenueDeferralEventAt: eventAt }), '2026-11-30')
})

test('the open deferral: stored, less journaled shipments, less recorded refund reversals, less any unwind; unprovable refunds refuse', async () => {
  const { openInvoiceBasisDeferral } = await import('@/lib/domain/accounting/invoice-basis-deferral')
  const base = { unearnedRevenueAmount: '400', shipments: [], refunds: [] }
  assert.equal((openInvoiceBasisDeferral(base) as { open: { toFixed(n: number): string } }).open.toFixed(2), '400.00')
  const partial = openInvoiceBasisDeferral({
    ...base,
    shipments: [{ shipmentJournalDate: new Date(), revenueRecognizedAmount: '200' }, { shipmentJournalDate: null, revenueRecognizedAmount: '100' }],
    refunds: [
      { id: 'r1', unearnedReversedAmount: '50' },
      { id: 'r2', deferralAdjustmentRef: 'A1-x', unearnedReversedAmount: null },
      { id: 'r3', unearnedReversedAmount: null, reversalStagingState: 'NOT_STAGED' },
    ],
  })
  assert.equal(partial.ok && partial.open.toFixed(2), '150.00', 'an unjournaled shipment and a netted or never-staged refund take nothing')
  assert.equal((openInvoiceBasisDeferral({ ...base, revenueDeferralUnwoundAmount: '400' }) as { open: { toFixed(n: number): string } }).open.toFixed(2), '0.00')
  assert.equal(openInvoiceBasisDeferral({ ...base, refunds: [{ id: 'r4', unearnedReversedAmount: null }] }).ok, false, 'a reversal not durably recorded')
  assert.equal(openInvoiceBasisDeferral({ ...base, refunds: [{ id: 'r5', unearnedReversedAmount: '10', accountingRetryRequired: true }] }).ok, false, 'a refund still owing a retry')
  assert.equal((openInvoiceBasisDeferral({ ...base, shipments: [{ shipmentJournalDate: new Date(), revenueRecognizedAmount: '500' }] }) as { open: { toFixed(n: number): string } }).open.toFixed(2), '0.00', 'never negative')
})

test('the stranded-deferral invariant: INVOICE basis only, not yet unwound, and only with no invoice, a voided one, or a cancelled order', async () => {
  const { evaluateAccountingInvariantRows } = await import('@/lib/domain/accounting/invariants')
  const row = (over: Record<string, unknown>) => ({
    id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'ALLOCATED', accountingInvoiceId: 'INV-1', revenueDeferralBasis: 'INVOICE',
    unearnedRevenueAmount: '400', revenueDeferralUnwoundAmount: null, revenueDeferralUnwindOwedAt: null, revenueDeferralUnwindReason: null,
    shipments: [], refunds: [], ...over,
  })
  const codes = (over: Record<string, unknown>) => evaluateAccountingInvariantRows({
    salesOrders: [], postedShipments: [], syncLogs: [], unresolvedAllocationBasisRefunds: [], reversalNeverRecordedRefunds: [],
    strandedInvoiceBasisDeferrals: [row(over) as never],
  }).filter((f) => f.code === 'invoice_basis_deferral_stranded')
  assert.equal(codes({}).length, 0, 'an ordinary deferred order with its invoice')
  assert.equal(codes({ status: 'CANCELLED' }).length, 1, 'cancelled orders are included')
  assert.equal(codes({ accountingInvoiceId: null }).length, 1, 'no invoice')
  assert.equal(codes({ revenueDeferralUnwindOwedAt: new Date(), revenueDeferralUnwindReason: 'INVOICE_VOIDED' }).length, 1, 'voided, unwind not posted yet')
  assert.equal(codes({ status: 'CANCELLED', revenueDeferralUnwoundAmount: '400' }).length, 0, 'unwound')
  assert.equal(codes({ status: 'CANCELLED', revenueDeferralBasis: 'PAID' }).length, 0, 'a PAID-basis deferral is not this check')
  assert.equal(codes({ status: 'CANCELLED', revenueDeferralBasis: null }).length, 0)
  assert.equal(codes({ status: 'CANCELLED', shipments: [{ shipmentJournalDate: new Date(), revenueRecognizedAmount: '400' }] }).length, 0, 'fully released')
})

test('the stranded-Allocated invariant: a CANCELLED INVOICE-basis order with its invoice gone and A2 debit still open', async () => {
  const { evaluateAccountingInvariantRows } = await import('@/lib/domain/accounting/invariants')
  const codes = (over: Record<string, unknown>) => evaluateAccountingInvariantRows({
    salesOrders: [], postedShipments: [], syncLogs: [], unresolvedAllocationBasisRefunds: [], reversalNeverRecordedRefunds: [],
    strandedInvoiceBasisDeferrals: [{
      id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'CANCELLED', accountingInvoiceId: null, revenueDeferralBasis: 'INVOICE',
      unearnedRevenueAmount: '400', revenueDeferralUnwoundAmount: '400', revenueDeferralUnwindOwedAt: new Date(), revenueDeferralUnwindReason: 'INVOICE_DELETED',
      inventoryAllocatedDate: new Date(), allocationBatchAmount: '40', allocationReversalAmount: null,
      shipments: [], refunds: [], allocationShipmentRelief: [], allocationRefundRelief: [], ...over,
    } as never],
  }).filter((f) => f.code === 'invoice_basis_allocation_stranded')
  assert.equal(codes({}).length, 1, 'open A2 debit on a cancelled, invoice-gone order')
  assert.equal(codes({ allocationReversalAmount: '40' }).length, 0, 'reversed')
  assert.equal(codes({ status: 'ALLOCATED' }).length, 0, 'not cancelled: it can still ship')
  assert.equal(codes({ accountingInvoiceId: 'INV-1', revenueDeferralUnwoundAmount: null, revenueDeferralUnwindOwedAt: null }).length, 0, 'invoice still standing: the refund owns it')
  assert.equal(codes({ revenueDeferralBasis: 'PAID' }).length, 0)
})
