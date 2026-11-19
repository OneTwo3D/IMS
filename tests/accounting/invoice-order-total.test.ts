import assert from 'node:assert/strict'
import test from 'node:test'

import { fullReversalOrderTotal, invoicePostedOrderTotal, type InvoiceSyncRowReader } from '@/lib/domain/accounting/invoice-order-total'

/**
 * o3d-hqvrp.389 (round-2 review, medium): the order total on a full-refund / chargeback credit note follows how the INVOICE was posted, not the value of
 * `xero_round_to_order_total_enabled` when the credit note is raised. The setting is deliberately not consulted here at all: flipping it between the invoice and the
 * credit note changes nothing.
 */
type Row = { createdAt: Date; status?: string; externalTransactionId?: string | null; abandonedBeforeRemoteCall?: boolean | null; settlementBasis?: string | null; payload: unknown }
const rowsReader = (rows: Row[]): InvoiceSyncRowReader => ({
  accountingSyncLog: {
    findMany: async () => rows.map((r) => ({ status: 'SYNCED', externalTransactionId: 'xero-1', abandonedBeforeRemoteCall: null, settlementBasis: null, ...r })),
  },
})
/** A confirmed-posted invoice row per payload, newest first. */
const readerWith = (payloads: Array<Record<string, unknown> | null>): InvoiceSyncRowReader =>
  rowsReader(payloads.map((payload, i) => ({ createdAt: new Date(2026, 10, 19 - i), payload })))
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

test('the order total is read from the order\'s own invoice rows (SALES_INVOICE / SALES_INVOICE_UPDATE) with the ledger-standing columns', async () => {
  let seen: unknown
  const reader: InvoiceSyncRowReader = { accountingSyncLog: { findMany: async (args) => { seen = args; return [] } } }
  assert.equal(await invoicePostedOrderTotal(reader, 'o9'), null)
  const a = seen as { where: { referenceId: string; type: { in: string[] } }; select: Record<string, boolean> }
  assert.equal(a.where.referenceId, 'o9')
  assert.deepEqual(a.where.type.in, ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'])
  for (const k of ['status', 'externalTransactionId', 'abandonedBeforeRemoteCall', 'settlementBasis', 'createdAt', 'payload']) assert.equal(a.select[k], true, k)
})

// Round 3 (medium): the order total comes from the invoice version Xero HOLDS (invoiceToReverse), not the newest pending row.
const OLD_POSTED = { createdAt: new Date('2026-11-01'), payload: { lines: [] } } // posted while the setting was off: no orderTotal
test('a later invoice update that is still PENDING does not lend its order total to the credit note (the newest version is not known to be in Xero)', async () => {
  const r = rowsReader([OLD_POSTED, { createdAt: new Date('2026-11-05'), status: 'PENDING', externalTransactionId: null, payload: { orderTotal: 0.06 } }])
  assert.equal(await invoicePostedOrderTotal(r, 'o1'), null)
  assert.deepEqual(await fullReversalOrderTotal(r, 'o1', FULL, 'r1'), {})
})

test('a later invoice update that FAILED with an unknown outcome is not skipped to read an older row', async () => {
  const r = rowsReader([
    { createdAt: new Date('2026-11-01'), payload: { orderTotal: 0.06 } },
    { createdAt: new Date('2026-11-05'), status: 'FAILED', externalTransactionId: null, payload: { orderTotal: 0.07 } },
  ])
  assert.equal(await invoicePostedOrderTotal(r, 'o1'), null)
})

test('a later invoice update proven never sent (cancelled before any remote call) is skipped: the confirmed older version decides', async () => {
  const r = rowsReader([
    { createdAt: new Date('2026-11-01'), payload: { orderTotal: 0.06 } },
    { createdAt: new Date('2026-11-05'), status: 'CANCELLED', externalTransactionId: null, abandonedBeforeRemoteCall: true, payload: { orderTotal: 0.99 } },
  ])
  assert.equal(await invoicePostedOrderTotal(r, 'o1'), 0.06)
})

test('the newest CONFIRMED_POSTED update decides, over an older invoice', async () => {
  const r = rowsReader([
    { createdAt: new Date('2026-11-01'), payload: { lines: [] } },
    { createdAt: new Date('2026-11-05'), payload: { orderTotal: 0.06 } },
  ])
  assert.equal(await invoicePostedOrderTotal(r, 'o1'), 0.06)
})
