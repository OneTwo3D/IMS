import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PurchaseBillFirstPostingInFlightError,
  refreshPendingPurchaseInvoiceCreate,
  type PendingCreateRefreshTx,
} from '@/lib/domain/purchasing/purchase-invoice-pending-create-refresh'
import type { PurchaseInvoiceAccountingPayload } from '@/lib/domain/purchasing/purchase-invoice-edit'

const edited = { invoiceNumber: 'SUP-1', contactName: 'S', date: '2026-11-01', currency: 'GBP', reference: 'PO-1', lines: [{ description: 'x', quantity: 10, unitAmount: 10, accountCode: '631' }] } as unknown as PurchaseInvoiceAccountingPayload

function fake(rows: Array<Record<string, unknown>>, swapCount = 1, legacy: Array<Record<string, unknown>> = [], siblings: Array<{ id: string; accountingInvoiceId: string | null }> = [{ id: 'inv1', accountingInvoiceId: null }]) {
  const writes: Array<{ where: Record<string, unknown>; data: { payload: unknown } }> = []
  const tx = {
    accountingSyncLog: {
      findMany: async (args: { where: { referenceType: string } }) => (args.where.referenceType === 'PurchaseOrder' ? legacy : rows),
      updateMany: async (args: { where: Record<string, unknown>; data: { payload: unknown } }) => { writes.push(args); return { count: swapCount } },
    },
    purchaseInvoice: { findMany: async () => siblings },
  } as unknown as PendingCreateRefreshTx
  return { tx, writes }
}
const unsent = { id: 'r1', connector: 'xero', status: 'PENDING', externalTransactionId: null, abandonedBeforeRemoteCall: false, settlementBasis: null, remoteAttemptedAt: null, attemptStampingCustodyAt: new Date(), backReferenceEvidenceCompactedAt: null, payload: { _postingMode: 'submitted', _idempotencyKey: 'k1', _connectionProvenance: 'xero:t', lines: [] } }
const run = (tx: PendingCreateRefreshTx) => refreshPendingPurchaseInvoiceCreate({ tx, invoiceId: 'inv1', poId: 'po1', currentInvoiceNumber: 'SUP-1', chartConnector: 'xero', accountingPayload: edited })

// [mutation: build the payload without the row's enqueue stamps, or without guarding the swap on the unsent proof]
test('an unsent create row takes the edited document and keeps its own stamps', async () => {
  const { tx, writes } = fake([unsent])
  assert.deepEqual(await run(tx), { kind: 'refreshed', syncLogId: 'r1' })
  assert.equal(writes.length, 1)
  const payload = writes[0]!.data.payload as Record<string, unknown>
  assert.equal(payload._idempotencyKey, 'k1')
  assert.equal(payload._postingMode, 'submitted')
  assert.equal(payload._connectionProvenance, 'xero:t')
  assert.equal(payload.accountingInvoiceId, undefined)
  assert.equal((payload.lines as Array<{ unitAmount: number }>)[0]!.unitAmount, 10)
  assert.deepEqual(writes[0]!.where.status, { in: ['PENDING', 'FAILED'] })
  assert.equal(writes[0]!.where.remoteAttemptedAt, null)
})

test('a create row that FAILED before any request was made is refreshed too (a retry would otherwise post the old bill)', async () => {
  const { tx, writes } = fake([{ ...unsent, status: 'FAILED' }])
  assert.deepEqual(await run(tx), { kind: 'refreshed', syncLogId: 'r1' })
  assert.equal(writes.length, 1)
})

test('no create row: nothing is owed and nothing is written', async () => {
  const { tx, writes } = fake([])
  assert.deepEqual(await run(tx), { kind: 'no-create-row' })
  assert.equal(writes.length, 0)
})

test('a recorded shadow and a retired never-sent attempt are not postings: nothing is owed, nothing is written', async () => {
  const shadow = { ...unsent, id: 's1', status: 'CANCELLED', settlementBasis: 'HELD_SHADOW' }
  const retired = { ...unsent, id: 's2', status: 'CANCELLED', abandonedBeforeRemoteCall: true }
  for (const rows of [[shadow], [retired], [shadow, retired]]) {
    const { tx, writes } = fake(rows)
    assert.deepEqual(await run(tx), { kind: 'no-create-row' })
    assert.equal(writes.length, 0)
  }
  const { tx, writes } = fake([retired, unsent])
  assert.deepEqual(await run(tx), { kind: 'refreshed', syncLogId: 'r1' }, 'a retired attempt beside a live one does not make it ambiguous')
  assert.equal(writes.length, 1)
})

test('a row that may have left IMS refuses the edit and is not written', async () => {
  const cases: Array<[string, Record<string, unknown>[]]> = [
    ['claimed', [{ ...unsent, status: 'PROCESSING' }]],
    ['posted', [{ ...unsent, status: 'SYNCED', externalTransactionId: 'X1' }]],
    ['attempted', [{ ...unsent, status: 'FAILED', remoteAttemptedAt: new Date() }]],
    ['no custody proof', [{ ...unsent, attemptStampingCustodyAt: null }]],
    ['two rows', [unsent, { ...unsent, id: 'r2' }]],
  ]
  for (const [label, rows] of cases) {
    const { tx, writes } = fake(rows)
    await assert.rejects(run(tx), PurchaseBillFirstPostingInFlightError, label)
    assert.equal(writes.length, 0, label)
  }
  for (const [label, row] of [['compacted evidence', { ...unsent, backReferenceEvidenceCompactedAt: new Date() }], ['pending row that names a document', { ...unsent, externalTransactionId: 'X9' }], ['legacy row with a settlement basis', { ...unsent, settlementBasis: 'OPERATOR_ASSERTION' }]] as const) {
    const f = fake([row])
    await assert.rejects(run(f.tx), PurchaseBillFirstPostingInFlightError, label)
    assert.equal(f.writes.length, 0, label)
  }
  const noChart = fake([unsent])
  await assert.rejects(refreshPendingPurchaseInvoiceCreate({ tx: noChart.tx, invoiceId: 'inv1', poId: 'po1', currentInvoiceNumber: 'SUP-1', chartConnector: null, accountingPayload: edited }), PurchaseBillFirstPostingInFlightError, 'no chart connector')
  const { tx } = fake([{ ...unsent, connector: 'quickbooks' }])
  await assert.rejects(run(tx), PurchaseBillFirstPostingInFlightError, 'a row of another connector than the chart')
})

test('a worker that claims the row between the read and the swap makes the swap match nothing: refused', async () => {
  const { tx } = fake([unsent], 0)
  await assert.rejects(run(tx), PurchaseBillFirstPostingInFlightError)
})

// ---- legacy create rows: keyed to the purchase order, naming no bill
const legacyRow = { ...unsent, id: 'L1', payload: { ...(unsent.payload as object), invoiceNumber: 'SUP-1' } }

// [mutation: ignore the legacy rows (the bug), or refresh one without the attribution checks]
test('a legacy PO-keyed create row is refreshed when it is provably this bill\'s and unsent', async () => {
  const { tx, writes } = fake([], 1, [legacyRow])
  assert.deepEqual(await run(tx), { kind: 'refreshed', syncLogId: 'L1' })
  assert.equal(writes.length, 1)
  assert.equal((writes[0]!.data.payload as Record<string, unknown>)._idempotencyKey, 'k1')
})

test('a legacy row that cannot be attributed to this bill refuses the edit', async () => {
  const cases: Array<[string, Parameters<typeof fake>]> = [
    ['another bill on the order is also waiting for a document', [[], 1, [legacyRow], [{ id: 'inv1', accountingInvoiceId: null }, { id: 'inv2', accountingInvoiceId: null }]]],
    ['two live legacy rows', [[], 1, [legacyRow, { ...legacyRow, id: 'L2' }]]],
    ['the row carries another supplier invoice number', [[], 1, [{ ...legacyRow, payload: { ...(legacyRow.payload as object), invoiceNumber: 'OTHER' } }]]],
    ['the row carries no invoice number while the bill has one', [[], 1, [{ ...legacyRow, payload: { _idempotencyKey: 'k1' } }]]],
  ]
  for (const [label, args] of cases) {
    const f = fake(...args)
    await assert.rejects(run(f.tx), PurchaseBillFirstPostingInFlightError, label)
    assert.equal(f.writes.length, 0, label)
  }
})

test('an attributable legacy row that may have left IMS refuses the edit', async () => {
  for (const patch of [{ status: 'PROCESSING' }, { status: 'FAILED', remoteAttemptedAt: new Date() }, { status: 'SYNCED', externalTransactionId: 'X1' }]) {
    const f = fake([], 1, [{ ...legacyRow, ...patch }])
    await assert.rejects(run(f.tx), PurchaseBillFirstPostingInFlightError, JSON.stringify(patch))
    assert.equal(f.writes.length, 0)
  }
})

test('legacy rows that belong to OTHER bills (their document is linked there), shadows and retired attempts are not this bill\'s', async () => {
  const posted = { ...legacyRow, status: 'SYNCED', externalTransactionId: 'XA' }
  const siblings = [{ id: 'inv1', accountingInvoiceId: null }, { id: 'inv0', accountingInvoiceId: 'XA' }]
  assert.deepEqual(await run(fake([], 1, [posted], siblings).tx), { kind: 'no-create-row' })
  const shadow = { ...legacyRow, status: 'CANCELLED', settlementBasis: 'HELD_SHADOW' }
  assert.deepEqual(await run(fake([], 1, [shadow]).tx), { kind: 'no-create-row' })
  const mixed = fake([], 1, [posted, legacyRow], siblings)
  assert.deepEqual(await run(mixed.tx), { kind: 'refreshed', syncLogId: 'L1' })
})

test('a bill that has its own create row ignores the legacy ones', async () => {
  const { tx } = fake([unsent], 1, [{ ...legacyRow, id: 'L9', status: 'PROCESSING' }])
  assert.deepEqual(await run(tx), { kind: 'refreshed', syncLogId: 'r1' })
})
