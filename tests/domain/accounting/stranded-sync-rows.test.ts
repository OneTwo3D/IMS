import assert from 'node:assert/strict'
import test from 'node:test'

import {
  STRANDED_ACCOUNTING_SYNC_STATUSES,
  buildStrandedSyncRowWhere,
  describeStrandedSyncRow,
} from '@/lib/domain/accounting/stranded-sync-rows'

// o3d-osl8 item 1. The stranded-row read model, tested without a database — the same way
// connector-orphans.ts and followup-idempotency.ts are, and for the same reason: the rule that
// makes these rows visible at all (NOT scoping the query to the active connector) is the part
// that must not drift back.

const NOW = new Date('2026-08-14T10:00:00.000Z')

test('the stranded where is NOT scoped to the active connector — that is the whole point', () => {
  // Every other accounting log read filters TO the active connector; this one filters AWAY from
  // it. Invert this and the rows go back to being invisible, which is the bug.
  assert.deepEqual(buildStrandedSyncRowWhere('xero'), {
    status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
    connector: { not: 'xero' },
  })
  assert.deepEqual(buildStrandedSyncRowWhere('quickbooks'), {
    status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
    connector: { not: 'quickbooks' },
  })
  // No connector enabled: nothing will process ANY unresolved row, so all of them are stranded
  // and there is no connector predicate at all.
  assert.deepEqual(buildStrandedSyncRowWhere(null), { status: { in: ['PENDING', 'PROCESSING', 'FAILED'] } })
})

test('only UNRESOLVED statuses are stranded — SYNCED and CANCELLED are finished work', () => {
  assert.deepEqual([...STRANDED_ACCOUNTING_SYNC_STATUSES], ['PENDING', 'PROCESSING', 'FAILED'])
  const where = buildStrandedSyncRowWhere('xero') as { status: { in: string[] } }
  assert.equal(where.status.in.includes('SYNCED'), false)
  assert.equal(where.status.in.includes('CANCELLED'), false)
})

function stranded(over: Partial<Parameters<typeof describeStrandedSyncRow>[0]> = {}) {
  return describeStrandedSyncRow(
    {
      id: 'log-1',
      connector: 'quickbooks',
      type: 'INVOICE_PAYMENT',
      status: 'FAILED',
      referenceType: 'SalesOrder',
      referenceId: 'order-7',
      externalTransactionId: null,
      errorMessage: 'HTTP 500 from QuickBooks',
      createdAt: new Date('2026-08-04T10:00:00.000Z'),
      ...over,
    },
    NOW,
  )
}

test('a stranded row is described with identifying detail, not counted (o3d-osl8)', () => {
  // "3 rows" is not something an operator can act on. Every field here is what they need to go
  // and look the document up in the connector it was queued for.
  const row = stranded()
  assert.equal(row.id, 'log-1')
  assert.equal(row.connector, 'quickbooks')
  assert.equal(row.type, 'INVOICE_PAYMENT')
  assert.equal(row.referenceType, 'SalesOrder')
  assert.equal(row.referenceId, 'order-7')
  assert.equal(row.status, 'FAILED')
  assert.equal(row.errorMessage, 'HTTP 500 from QuickBooks')
  assert.equal(row.externalTransactionId, null)
  assert.equal(row.createdAt, '2026-08-04T10:00:00.000Z')
})

test('the age is whole days since the row was queued — the "how long stuck" the count hid', () => {
  assert.equal(stranded().ageDays, 10)
  assert.equal(stranded({ createdAt: NOW }).ageDays, 0)
  // Not yet a full day.
  assert.equal(stranded({ createdAt: new Date('2026-08-13T10:00:00.001Z') }).ageDays, 0)
  assert.equal(stranded({ createdAt: new Date('2026-08-13T10:00:00.000Z') }).ageDays, 1)
  // A clock skew must not produce a negative age.
  assert.equal(stranded({ createdAt: new Date('2026-08-20T10:00:00.000Z') }).ageDays, 0)
})

test('a stranded PROCESSING row is LISTED, not filtered out — visibility is the whole of item 1', () => {
  // The row a connector switch left claimed forever is exactly the one nothing else shows.
  // There is no remedy for it in this PR (that needs the claim generation, o3d-e2mz), so it is
  // listed with its age and reference and nothing else is implied about it.
  const where = buildStrandedSyncRowWhere('xero') as { status: { in: string[] } }
  assert.equal(where.status.in.includes('PROCESSING'), true, 'a claimed-forever row must be LOADED')
  const row = stranded({ status: 'PROCESSING' })
  assert.equal(row.status, 'PROCESSING')
  assert.equal(row.ageDays, 10)
})

test('post evidence is surfaced — an external id means a document may already exist', () => {
  const row = stranded({ status: 'FAILED', externalTransactionId: 'INV-42' })
  assert.equal(row.externalTransactionId, 'INV-42')
})

test('the described row carries no settlement affordance — nothing here is actionable yet', () => {
  // Guard against re-importing the abandoned settlement branch's fields. `settleable` /
  // `notSettleableReason` describe a control that does not exist in this PR; a UI reason string
  // saying why a row "cannot be settled" is incoherent with no settle button anywhere.
  const row = stranded() as Record<string, unknown>
  assert.equal('settleable' in row, false)
  assert.equal('notSettleableReason' in row, false)
  assert.deepEqual(Object.keys(row).sort(), [
    'ageDays', 'connector', 'createdAt', 'errorMessage', 'externalTransactionId',
    'id', 'referenceId', 'referenceType', 'status', 'type',
  ])
})
