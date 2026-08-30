import assert from 'node:assert/strict'
import test from 'node:test'

import {
  STRANDED_ACCOUNTING_SYNC_STATUSES,
  buildStrandedSyncRowOrderBy,
  buildStrandedSyncRowWhere,
  describeStrandedSyncRow,
  pageStrandedSyncRows,
} from '@/lib/domain/accounting/stranded-sync-rows'

/**
 * The loader's answer to "can anything still claim a row on this connector?".
 *
 * QUIESCED is the default the older tests were written against — it is what the read model used to
 * pass unconditionally. `stillClaimable` is the state round 5 found: a row off the active connector
 * whose connector's sync toggle is still on, so the manual Sync button can reclaim it.
 */
const QUIESCED = () => true
const STILL_CLAIMABLE = () => false

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
  const page = pageStrandedSyncRows(rows, 3, NOW, QUIESCED)
  assert.equal(page.hasMore, true, 'the extra row proves more exist')
  assert.equal(page.rows.length, 3, 'the extra row is dropped, not shown')
  assert.deepEqual(page.rows.map((row) => row.id), ['log-0', 'log-1', 'log-2'])
})

test('a complete page reports no more — and the probe row is not counted as one', () => {
  const exact = pageStrandedSyncRows(Array.from({ length: 3 }, (_, i) => sourceRow({ id: `log-${i}` })), 3, NOW, QUIESCED)
  assert.equal(exact.hasMore, false, 'exactly `take` rows means the list is complete')
  assert.equal(exact.rows.length, 3)

  const short = pageStrandedSyncRows([sourceRow()], 3, NOW, QUIESCED)
  assert.equal(short.hasMore, false)
  assert.equal(short.rows.length, 1)

  const none = pageStrandedSyncRows([], 3, NOW, QUIESCED)
  assert.equal(none.hasMore, false)
  assert.deepEqual(none.rows, [])
})

test('paged rows are described, not returned raw', () => {
  const page = pageStrandedSyncRows([sourceRow()], 3, NOW, QUIESCED)
  assert.equal(page.rows[0].ageDays, 10)
  assert.equal(page.rows[0].createdAt, '2026-08-04T10:00:00.000Z')
})

function stranded(
  over: Partial<Parameters<typeof describeStrandedSyncRow>[0]> = {},
  unclaimable: (connector: string) => boolean = QUIESCED,
) {
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
    unclaimable,
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
    'id', 'notSettleableReason', 'referenceId', 'referenceType', 'requiresAttemptAdoption', 'settleable',
    'settleableOutcomes', 'settlementCaveat', 'status', 'type',
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
  // Two remaining gates, and the operator is owed the one that actually applies. A single
  // "cannot be settled" would send someone to check a connector that will never help.
  const pending = stranded({ status: 'PENDING', attemptRevision: 4 })
  assert.equal(pending.settleable, false)
  assert.match(pending.notSettleableReason ?? '', /nothing has been sent/)

  assert.equal(pending.settlementCaveat, null, 'a caveat is for a decision that can be made')
  assert.equal(pending.requiresAttemptAdoption, false)

  // o3d-jit6 r1#3: a DAILY_BATCH row is no longer one of them. It IS settleable — POSTED only — and
  // the half it does not admit is stated as a caveat rather than as a missing control.
  const batch = stranded({ status: 'FAILED', type: 'DAILY_BATCH_GROUP_B', attemptRevision: 4 })
  assert.equal(batch.settleable, true)
  assert.equal(batch.notSettleableReason, null)
  assert.deepEqual(batch.settleableOutcomes, ['POSTED'])
  assert.match(batch.settlementCaveat ?? '', /cannot be settled as NOT POSTED/)
})

test('a STRANDED row at revision 0 reaches the remedy by adoption — this list is the whole point of it', () => {
  // r3, Codex finding 3. This used to be the third "cannot be settled" gate above, and it applied to
  // EVERY row on this page: buildStrandedSyncRowWhere selects only rows on a connector that is not
  // the active one, so nothing participating in the attempt fence will ever claim one, so its
  // revision never leaves 0. The per-row remedy this list exists to point at did not reach a single
  // row that motivated it.
  //
  // The fixture can reach the state: `stranded()` produces exactly what the loader's select returns
  // for such a row, and 0 is what the migration gives every pre-existing row.
  const adoptable = stranded({ status: 'FAILED', attemptRevision: 0 })
  assert.equal(adoptable.settleable, true)
  assert.equal(adoptable.requiresAttemptAdoption, true)
  assert.equal(adoptable.notSettleableReason, null)
  // The minting is said out loud rather than done quietly.
  assert.match(adoptable.settlementCaveat ?? '', /MINTS one/)
  assert.match(adoptable.settlementCaveat ?? '', /NOT proof that nothing posted/)
})

// ---------------------------------------------------------------------------
// ROUND 5 (Codex HIGH #1) — BEING ON THIS PAGE IS NOT PROOF THAT NOTHING CAN CLAIM THE ROW.
//
// The test directly above encodes the round-3/round-4 argument: `buildStrandedSyncRowWhere` selects
// rows off the active connector, therefore nothing in the attempt fence can claim them, therefore
// every row here is adoptable. The second step is false, and QuickBooks rows are the counter-example
// the whole feature was built for — `triggerQuickBooksSync` gates on `quickbooks_sync_enabled` and
// never resolves the active connector, so with Xero enabled beside it every QuickBooks row is listed
// here while any holder of `sync` can press the button and have the stale-claim sweep reclaim one.
//
// These are about what the read model DOES with that answer, not about how it is computed; the rule
// itself is pinned in tests/domain/accounting/sync-row-claimability.test.ts.
// ---------------------------------------------------------------------------

test('[round 5] a revision-0 row whose connector can STILL claim it is refused, not adopted', () => {
  const row = stranded({ status: 'PROCESSING', attemptRevision: 0 }, STILL_CLAIMABLE)
  assert.equal(row.settleable, false, 'adopting here is overwritten by the next press of the Sync button')
  assert.equal(row.requiresAttemptAdoption, false)
  assert.equal(row.settlementCaveat, null, 'a caveat is for a decision that can be made')
})

test('[round 5] and it says WHY, naming the toggle — not the generic active-connector sentence', () => {
  const row = stranded({ status: 'PROCESSING', attemptRevision: 0 }, STILL_CLAIMABLE)
  const reason = row.notSettleableReason ?? ''
  // The lever, by its settings key: an operator cannot act on "it is claimable".
  assert.match(reason, /quickbooks_sync_enabled/)
  assert.match(reason, /manual\s+Sync button/)
  // And NOT the wording for a row on the ACTIVE connector, whose remedy (retry it, the processor
  // stamps an attempt) is a different action against a different cause.
  assert.doesNotMatch(reason, /It is on the ACTIVE connector/)
})

test('[round 5] the question is asked PER CONNECTOR, so one quiesced connector does not adopt the other', () => {
  // With no accounting plugin enabled at all, buildStrandedSyncRowWhere selects EVERY unresolved
  // row, so one page carries both connectors. A single boolean for the page would adopt rows on a
  // connector nobody asked about.
  const onlyXeroQuiesced = (connector: string) => connector === 'xero'
  const page = pageStrandedSyncRows(
    [
      { ...sourceRow({ id: 'log-x', connector: 'xero', attemptRevision: 0 }) },
      { ...sourceRow({ id: 'log-q', connector: 'quickbooks', attemptRevision: 0 }) },
    ],
    10,
    NOW,
    onlyXeroQuiesced,
  )
  const byId = new Map(page.rows.map((row) => [row.id, row]))
  assert.equal(byId.get('log-x')?.settleable, true, 'the quiesced connector keeps the adoption remedy')
  assert.equal(byId.get('log-q')?.settleable, false, 'the one that can still sweep does not')
  assert.match(byId.get('log-q')?.notSettleableReason ?? '', /quickbooks_sync_enabled/)
})

test('[round 5] a FENCED row is unaffected — the fence, not the toggle, is what protects it', () => {
  // The claimability question is only ever asked of revision 0. A row carrying a real attempt is
  // settled against that attempt, and a concurrent claim is refused by the CAS rather than by this.
  const row = stranded({ status: 'FAILED', attemptRevision: 3 }, STILL_CLAIMABLE)
  assert.equal(row.settleable, true)
  assert.equal(row.notSettleableReason, null)
})
