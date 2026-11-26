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
