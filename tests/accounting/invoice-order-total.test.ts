import assert from 'node:assert/strict'
import test from 'node:test'

import { fullReversalOrderTotal, invoicePostedOrderTotal, type InvoiceSyncRowReader } from '@/lib/domain/accounting/invoice-order-total'

/**
 * o3d-hqvrp.389 (round-2 review, medium): the order total on a full-refund / chargeback credit note follows how the INVOICE was posted, not the value of
 * `xero_round_to_order_total_enabled` when the credit note is raised. The setting is deliberately not consulted here at all: flipping it between the invoice and the
 * credit note changes nothing.
 */
const readerWith = (payloads: Array<Record<string, unknown> | null>): InvoiceSyncRowReader => ({
  accountingSyncLog: { findFirst: async () => (payloads.length ? { payload: payloads[0] } : null) },
})
const FULL = { refundStatus: 'FULL', refunds: [{ id: 'r1', chargeback: false }] }

test('invoice posted WITH the rounding line (setting on then) keeps the order total on its credit note, even though the setting is off now', async () => {
  assert.deepEqual(await fullReversalOrderTotal(readerWith([{ orderTotal: 100 }]), 'o1', FULL, 'r1'), { orderTotal: 100 })
})

test('invoice posted WITHOUT the rounding line (setting off then) gets no order total on its credit note, even though the setting is on now', async () => {
  assert.deepEqual(await fullReversalOrderTotal(readerWith([{ lines: [] }]), 'o1', FULL, 'r1'), {})
  assert.deepEqual(await fullReversalOrderTotal(readerWith([]), 'o1', FULL, 'r1'), {})
})

test('a chargeback is a full reversal; a partial refund or a second refund never carries the order total', async () => {
  const r = readerWith([{ orderTotal: 100 }])
  assert.deepEqual(await fullReversalOrderTotal(r, 'o1', { refundStatus: 'PARTIAL', refunds: [{ id: 'r1', chargeback: true }] }, 'r1'), { orderTotal: 100 })
  assert.deepEqual(await fullReversalOrderTotal(r, 'o1', { refundStatus: 'PARTIAL', refunds: [{ id: 'r1', chargeback: false }] }, 'r1'), {})
  assert.deepEqual(await fullReversalOrderTotal(r, 'o1', { refundStatus: 'FULL', refunds: [{ id: 'r0', chargeback: false }, { id: 'r1', chargeback: false }] }, 'r1'), {})
  assert.deepEqual(await fullReversalOrderTotal(r, 'o1', null, 'r1'), {})
})

test('a malformed order total on the invoice row is ignored', async () => {
  assert.equal(await invoicePostedOrderTotal(readerWith([{ orderTotal: 'x' }]), 'o1'), null)
  assert.equal(await invoicePostedOrderTotal(readerWith([{ orderTotal: 0 }]), 'o1'), null)
})

test('the order total is read from the order\'s own invoice rows (SALES_INVOICE / SALES_INVOICE_UPDATE that posted or will post), newest first', async () => {
  let seen: unknown
  const reader: InvoiceSyncRowReader = { accountingSyncLog: { findFirst: async (args) => { seen = args; return null } } }
  await invoicePostedOrderTotal(reader, 'o9')
  const a = seen as { where: { referenceId: string; type: { in: string[] }; status: { in: string[] } }; orderBy: unknown }
  assert.equal(a.where.referenceId, 'o9')
  assert.deepEqual(a.where.type.in, ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'])
  assert.ok(!a.where.status.in.includes('FAILED') && !a.where.status.in.includes('CANCELLED'))
  assert.deepEqual(a.orderBy, [{ createdAt: 'desc' }])
})
