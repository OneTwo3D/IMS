import assert from 'node:assert/strict'
import test from 'node:test'

import {
  STRANDED_ACCOUNTING_SYNC_STATUSES,
  buildStrandedSyncRowOrderBy,
  buildStrandedSyncRowWhere,
  describeStrandedSyncRow,
  pageStrandedSyncRows,
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

test('the order is total — createdAt alone is not deterministic within a transaction', () => {
  // Rows queued inside one transaction share a createdAt, so ordering on it alone lets the
  // database return them in any order: a truncated page would then differ between renders, and
  // the same row could appear, vanish and reappear on refresh. `id` is unique, so the pair is a
  // total order.
  assert.deepEqual(buildStrandedSyncRowOrderBy(), [{ createdAt: 'asc' }, { id: 'asc' }])
})

function sourceRow(over: Partial<Parameters<typeof describeStrandedSyncRow>[0]> = {}) {
  return {
    id: 'log-1',
    connector: 'quickbooks',
    type: 'INVOICE_PAYMENT',
    status: 'FAILED',
    referenceType: 'SalesOrder',
    referenceId: 'order-7',
    externalTransactionId: null,
    errorMessage: null,
    createdAt: new Date('2026-08-04T10:00:00.000Z'),
    // o3d-e2mz: a claimed attempt, so the default fixture describes a row an operator COULD settle.
    // Rows at 0 are covered explicitly where that matters.
    attemptRevision: 3,
    ...over,
  }
}

test('a `take + 1` read is paged down to `take`, and reports that rows are hidden', () => {
  // The starvation this exists to expose: the list is READ-ONLY — nothing on the page can clear
  // a FAILED row (that needs the claim generation, o3d-e2mz) — so if the oldest `take` rows are
  // FAILED they never move, and every newer stranded row is invisible FOREVER. Returning a bare
  // array of the oldest `take` said nothing about that.
  const rows = Array.from({ length: 4 }, (_, i) => sourceRow({ id: `log-${i}` }))
  const page = pageStrandedSyncRows(rows, 3, NOW)
  assert.equal(page.hasMore, true, 'the extra row proves more exist')
  assert.equal(page.rows.length, 3, 'the extra row is dropped, not shown')
  assert.deepEqual(page.rows.map((row) => row.id), ['log-0', 'log-1', 'log-2'])
})

test('a complete page reports no more — and the probe row is not counted as one', () => {
  const exact = pageStrandedSyncRows(Array.from({ length: 3 }, (_, i) => sourceRow({ id: `log-${i}` })), 3, NOW)
  assert.equal(exact.hasMore, false, 'exactly `take` rows means the list is complete')
  assert.equal(exact.rows.length, 3)

  const short = pageStrandedSyncRows([sourceRow()], 3, NOW)
  assert.equal(short.hasMore, false)
  assert.equal(short.rows.length, 1)

  const none = pageStrandedSyncRows([], 3, NOW)
  assert.equal(none.hasMore, false)
  assert.deepEqual(none.rows, [])
})

test('paged rows are described, not returned raw', () => {
  const page = pageStrandedSyncRows([sourceRow()], 3, NOW)
  assert.equal(page.rows[0].ageDays, 10)
  assert.equal(page.rows[0].createdAt, '2026-08-04T10:00:00.000Z')
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
      attemptRevision: 3,
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

test('a stranded PROCESSING row is LISTED, not filtered out — visibility was the whole of item 1', () => {
  // The row a connector switch left claimed forever is exactly the one nothing else shows.
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

test('the described row now carries its settlement affordance — o3d-osl8 item 2 exists', () => {
  // THIS TEST WAS INVERTED, deliberately. It previously asserted `settleable` / `notSettleableReason`
  // were ABSENT, because a UI reason string saying why a row "cannot be settled" is incoherent with
  // no settle button anywhere. There is a settle button now (o3d-nf9i / o3d-osl8 item 2), and the
  // incoherence would be the other way round: a row an operator can SEE and cannot act on, with no
  // explanation, reads as "there is nothing to do here".
  const row = stranded() as Record<string, unknown>
  assert.deepEqual(Object.keys(row).sort(), [
    'ageDays', 'attemptRevision', 'connector', 'createdAt', 'errorMessage', 'externalTransactionId',
    'id', 'notSettleableReason', 'referenceId', 'referenceType', 'settleable', 'settlementCaveat',
    'status', 'type',
  ])
})

test('the attempt a settlement would name is carried to the UI — the operator cannot name what they were never shown', () => {
  assert.equal(stranded({ attemptRevision: 7 }).attemptRevision, 7)
  assert.equal(stranded({ attemptRevision: 0 }).attemptRevision, 0)
})

test('a FAILED or PROCESSING row on a claimed attempt is offered the control, with the caveat that applies', () => {
  const failed = stranded({ status: 'FAILED', attemptRevision: 2 })
  assert.equal(failed.settleable, true)
  assert.equal(failed.notSettleableReason, null)
  assert.match(failed.settlementCaveat ?? '', /NOT proof that nothing posted/)

  const processing = stranded({ status: 'PROCESSING', attemptRevision: 2 })
  assert.equal(processing.settleable, true)
  assert.match(processing.settlementCaveat ?? '', /may never have returned/)
})

test('a row that cannot be settled says WHY, and each reason names its own cause', () => {
  // Three independent gates, and the operator is owed the one that actually applies. A single
  // "cannot be settled" would send someone to check a connector that will never help.
  const unfenced = stranded({ status: 'FAILED', attemptRevision: 0 })
  assert.equal(unfenced.settleable, false)
  assert.match(unfenced.notSettleableReason ?? '', /carries no attempt revision/)

  const pending = stranded({ status: 'PENDING', attemptRevision: 4 })
  assert.equal(pending.settleable, false)
  assert.match(pending.notSettleableReason ?? '', /nothing has been sent/)

  const batch = stranded({ status: 'FAILED', type: 'DAILY_BATCH_GROUP_B', attemptRevision: 4 })
  assert.equal(batch.settleable, false)
  assert.match(batch.notSettleableReason ?? '', /DAILY BATCH row/)

  for (const row of [unfenced, pending, batch]) {
    assert.equal(row.settlementCaveat, null, 'a caveat is for a decision that can be made')
  }
})
