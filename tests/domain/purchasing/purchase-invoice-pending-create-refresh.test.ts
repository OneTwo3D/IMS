import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PurchaseBillFirstPostingInFlightError,
  refreshPendingPurchaseInvoiceCreate,
  type PendingCreateRefreshTx,
} from '@/lib/domain/purchasing/purchase-invoice-pending-create-refresh'
import type { PurchaseInvoiceAccountingPayload } from '@/lib/domain/purchasing/purchase-invoice-edit'

const edited = { invoiceNumber: 'SUP-1', contactName: 'S', date: '2026-11-01', currency: 'GBP', reference: 'PO-1', lines: [{ description: 'x', quantity: 10, unitAmount: 10, accountCode: '631' }] } as unknown as PurchaseInvoiceAccountingPayload

function fake(rows: Array<Record<string, unknown>>, swapCount = 1) {
  const writes: Array<{ where: Record<string, unknown>; data: { payload: unknown } }> = []
  const tx = {
    accountingSyncLog: {
      findMany: async () => rows,
      updateMany: async (args: { where: Record<string, unknown>; data: { payload: unknown } }) => { writes.push(args); return { count: swapCount } },
    },
  } as unknown as PendingCreateRefreshTx
  return { tx, writes }
}
const unsent = { id: 'r1', connector: 'xero', status: 'PENDING', externalTransactionId: null, remoteAttemptedAt: null, attemptStampingCustodyAt: new Date(), backReferenceEvidenceCompactedAt: null, payload: { _postingMode: 'submitted', _idempotencyKey: 'k1', _connectionProvenance: 'xero:t', lines: [] } }
const run = (tx: PendingCreateRefreshTx) => refreshPendingPurchaseInvoiceCreate({ tx, invoiceId: 'inv1', chartConnector: 'xero', accountingPayload: edited })

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

test('no create row: nothing is owed and nothing is written', async () => {
  const { tx, writes } = fake([])
  assert.deepEqual(await run(tx), { kind: 'no-create-row' })
  assert.equal(writes.length, 0)
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
  const { tx } = fake([{ ...unsent, connector: 'quickbooks' }])
  await assert.rejects(run(tx), PurchaseBillFirstPostingInFlightError, 'a row of another connector than the chart')
})

test('a worker that claims the row between the read and the swap makes the swap match nothing: refused', async () => {
  const { tx } = fake([unsent], 0)
  await assert.rejects(run(tx), PurchaseBillFirstPostingInFlightError)
})
