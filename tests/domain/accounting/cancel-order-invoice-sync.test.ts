import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cancelPendingSalesInvoiceSyncForOrder,
  retireSalesInvoiceForCancelledOrder,
} from '@/lib/domain/accounting/cancel-order-invoice-sync'
import { claimHeldFrom, heldClaimWhere } from '@/lib/domain/accounting/sync-claim-fence'
import { updateAtAttemptRevision } from '@/lib/domain/accounting/sync-log-attempt'
import { createSyncLogStore, syncLogRow, type SyncLogStore } from '../../fixtures/accounting-sync-log-store.ts'

/**
 * A transaction client whose accountingSyncLog is the REAL in-memory store (so a compare-and-swap
 * genuinely matches or genuinely does not) and whose mirror side is recorded.
 */
function storeTx(store: SyncLogStore) {
  const eventUpdateMany: Array<{ where?: unknown; data?: unknown }> = []
  const tx = {
    accountingSyncLog: store.delegate,
    accountingEvent: {
      findMany: async () => [{ id: 'event-1', type: 'SALES_INVOICE', sourceEntityType: 'SalesOrder', sourceEntityId: 'order-1' }],
      updateMany: async (args: { where?: unknown; data?: unknown }) => { eventUpdateMany.push(args); return { count: 1 } },
    },
    accountingEventLog: { createMany: async () => ({ count: 1 }) },
  }
  return { tx: tx as never, eventUpdateMany }
}

const CLAIMED_ROW = {
  id: 'synclog-42',
  type: 'SALES_INVOICE',
  referenceType: 'SalesOrder',
  referenceId: 'order-1',
}

type Call = { where?: unknown; data?: unknown }

function mockTx(pendingEventIds: string[], livePostingClaim: unknown = null) {
  const calls: {
    syncFindFirst: Call[]
    syncRetire: Call[]
    syncUpdateMany: Call[]
    eventFindMany: Call[]
    eventUpdateMany: Call[]
    eventLogCreateMany: Call[]
  } = { syncFindFirst: [], syncRetire: [], syncUpdateMany: [], eventFindMany: [], eventUpdateMany: [], eventLogCreateMany: [] }

  const tx = {
    accountingSyncLog: {
      // o3d-7o0: the posting-intent probe. The sweep refuses outright while a fresh PROCESSING claim
      // exists for the order, so the default here is "nothing in flight" — which is what every
      // pre-existing test in this file assumes. The refusal itself is exercised in
      // tests/accounting/cancel-invoice-posting-intent.test.ts against a where-honouring store.
      findFirst: async (args: Call) => {
        calls.syncFindFirst.push(args)
        return livePostingClaim
      },
      // o3d-e2mz r3: the retirement is ONE statement that also names the rows it retired.
      updateManyAndReturn: async (args: Call) => {
        calls.syncRetire.push(args)
        return [{ id: 'synclog-1', attemptRevision: 2 }]
      },
      updateMany: async (args: Call) => {
        calls.syncUpdateMany.push(args)
        return { count: 1 }
      },
    },
    accountingEvent: {
      findMany: async (args: Call) => {
        calls.eventFindMany.push(args)
        return pendingEventIds.map((id) => ({
          id,
          type: 'SALES_INVOICE',
          sourceEntityType: 'SalesOrder',
          sourceEntityId: 'order-1',
        }))
      },
      updateMany: async (args: Call) => {
        calls.eventUpdateMany.push(args)
        return { count: pendingEventIds.length }
      },
    },
    accountingEventLog: {
      createMany: async (args: Call) => {
        calls.eventLogCreateMany.push(args)
        return { count: pendingEventIds.length }
      },
    },
  }
  return { tx: tx as never, calls }
}

const NOW = new Date('2026-07-18T12:00:00.000Z')

test('cancelPendingSalesInvoiceSyncForOrder cancels the sync log with the CANCELLED terminal state', async () => {
  const { tx, calls } = mockTx(['event-1'])
  await cancelPendingSalesInvoiceSyncForOrder(tx, 'order-1', NOW)

  // o3d-e2mz r3: ONE statement decides and retires, whatever fence class each row is in — the fence
  // bump that follows is scoped to the ids that statement returned, not to a second predicate.
  assert.equal(calls.syncRetire.length, 1)
  const where = calls.syncRetire[0].where as {
    referenceId: string
    type: { in: string[] }
    externalTransactionId: unknown
    OR: Array<{ status: string; processingStartedAt?: unknown }>
  }
  const data = calls.syncRetire[0].data as { status: string; processingStartedAt: unknown; attemptRevision?: unknown }
  assert.equal(
    data.attemptRevision,
    undefined,
    'the retiring statement must not carry a blanket bump — that would forge an attempt on an unfenced row',
  )
  // The bump names the fenced rows the retirement returned, and nothing else.
  assert.equal(calls.syncUpdateMany.length, 1)
  assert.deepEqual(calls.syncUpdateMany[0].where, { id: { in: ['synclog-1'] } })
  assert.deepEqual(calls.syncUpdateMany[0].data, { attemptRevision: { increment: 1 } })

  // CANCELLED (not FAILED) so reconciliation/backfill sweeps ignore it.
  assert.equal(data.status, 'CANCELLED')
  assert.equal(data.processingStartedAt, null)
  assert.equal(where.referenceId, 'order-1')
  assert.deepEqual(where.type.in, ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'])
  // Only never-posted rows are swept — a row that posted then reverted keeps its external id and must
  // not be falsely recorded as never-posted.
  assert.equal(where.externalTransactionId, null)
})

test('cancelPendingSalesInvoiceSyncForOrder targets every not-yet-posted row, INCLUDING a fresh claim', async () => {
  const { tx, calls } = mockTx([])
  await cancelPendingSalesInvoiceSyncForOrder(tx, 'order-1', NOW)

  const shared = calls.syncRetire[0].where as { referenceId: string; externalTransactionId: unknown }
  assert.equal(shared.referenceId, 'order-1')
  // SYNCED rows and anything that already names a document are out of scope — a cancel-after-post
  // needs an explicit reversal, and recording it as never-posted would hide a real receivable.
  assert.equal(shared.externalTransactionId, null)
  const or = (calls.syncRetire[0].where as { OR: Array<{ status: string; processingStartedAt?: unknown }> }).OR
  // PENDING and FAILED (both would otherwise still post — a drain or a "Retry All"), and PROCESSING
  // WITHOUT QUALIFICATION.
  assert.deepEqual(or.map((clause) => clause.status), ['PENDING', 'FAILED', 'PROCESSING'])
  // o3d-e2mz r4: no staleness predicate at all. The 15-minute cutoff was what excluded a freshly
  // claimed row, and that exclusion is the claim-first hole — asserted structurally as well as
  // behaviourally (below) because a cutoff reintroduced at any interval brings the hole back.
  assert.deepEqual(
    or.filter((clause) => clause.processingStartedAt !== undefined),
    [],
    'no processingStartedAt predicate may narrow the PROCESSING clause',
  )
})

// ---------------------------------------------------------------------------
// o3d-e2mz r4 — THE CLAIM-FIRST SCHEDULE.
//
// The one interleaving in which a cancelled sale could still grow an ACCREC invoice with nothing
// anywhere recording it:
//
//   1. the cancellation transaction writes the order to CANCELLED — uncommitted;
//   2. a worker claims the invoice row (minting attempt N+1) and reads the order with an ordinary
//      findUnique that still sees the LIVE status, so the post-time backstop passes it;
//   3. the cancel-time sweep runs and — before r4 — skipped the freshly-claimed PROCESSING row;
//   4. the cancellation commits, the worker posts, and its writeback CAS SUCCEEDS because nothing
//      moved its fence.
//
// Step 3 is the only step this transaction controls, so that is where it is closed.
// ---------------------------------------------------------------------------

test('o3d-e2mz r4: the sweep retires a claim taken SECONDS ago, and fences its holder out', async () => {
  const claimedAt = new Date(NOW.getTime() - 2_000)
  const store = createSyncLogStore([syncLogRow({
    ...CLAIMED_ROW,
    status: 'PROCESSING',
    attemptRevision: 4,
    processingStartedAt: claimedAt,
  })])
  const { tx } = storeTx(store)

  const retired = await cancelPendingSalesInvoiceSyncForOrder(tx, 'order-1', NOW)

  assert.equal(retired, 1, 'a two-second-old claim is retired, not left to finish')
  assert.equal(store.get('synclog-42')?.status, 'CANCELLED')
  assert.equal(store.get('synclog-42')?.attemptRevision, 5, 'and its attempt is advanced as it is retired')

  // STEP 4, the one that used to succeed: the worker posted and now tries to stamp the row SYNCED
  // with the external id. It must find nothing — that miss is what routes it into the fence-loss
  // escalation instead of silently reopening a cancelled sale.
  const wroteBack = await updateAtAttemptRevision(
    { accountingSyncLog: store.delegate } as never,
    { id: 'synclog-42', attemptRevision: 4 },
    { status: 'SYNCED', externalTransactionId: 'XERO-INV-9', syncedAt: NOW },
  )
  assert.equal(wroteBack, false, 'the claim holder cannot write back onto the cancelled row')
  assert.equal(store.get('synclog-42')?.status, 'CANCELLED')
  assert.equal(
    store.get('synclog-42')?.externalTransactionId,
    null,
    'and it certainly cannot record a receivable against a cancelled sale by the back door',
  )
})

test('o3d-e2mz r4: a fresh claim that FAILS its post also loses the CAS, leaving the row cancelled', async () => {
  // The other outcome of the same schedule. `applyMainSyncFailureRetry` is fenced on the attempt, so
  // this must not drag the row back to PENDING and round the queue again on a sale that is gone.
  const store = createSyncLogStore([syncLogRow({
    ...CLAIMED_ROW,
    status: 'PROCESSING',
    attemptRevision: 4,
    retryCount: 0,
    processingStartedAt: new Date(NOW.getTime() - 1_000),
  })])
  const { tx } = storeTx(store)

  await cancelPendingSalesInvoiceSyncForOrder(tx, 'order-1', NOW)

  const requeued = await updateAtAttemptRevision(
    { accountingSyncLog: store.delegate } as never,
    { id: 'synclog-42', attemptRevision: 4 },
    { status: 'PENDING', retryCount: 1, errorMessage: 'Xero timed out' },
  )
  assert.equal(requeued, false)
  assert.equal(store.get('synclog-42')?.status, 'CANCELLED')
  assert.equal(store.get('synclog-42')?.retryCount, 0, 'the retired row is not re-armed for another attempt')
})

test('o3d-e2mz r4: a fresh claim that ALREADY POSTED is still excluded — its document must not be denied', async () => {
  // The boundary of the widening. `externalTransactionId` is the only thing separating "a post is in
  // flight" from "a post landed", and a row that names a document is a real receivable: retiring it
  // would record that it never posted and hide it from every recovery path.
  const store = createSyncLogStore([syncLogRow({
    ...CLAIMED_ROW,
    status: 'PROCESSING',
    attemptRevision: 4,
    externalTransactionId: 'XERO-77',
    processingStartedAt: new Date(NOW.getTime() - 1_000),
  })])
  const { tx } = storeTx(store)

  const retired = await cancelPendingSalesInvoiceSyncForOrder(tx, 'order-1', NOW)

  assert.equal(retired, 0)
  assert.equal(store.get('synclog-42')?.status, 'PROCESSING')
  assert.equal(store.get('synclog-42')?.attemptRevision, 4, 'and its fence is untouched, so its own writeback still lands')
})

test('o3d-e2mz r4: a freshly claimed UNFENCED row is retired and STAYS at revision 0', async () => {
  // Widening the predicate must not widen the forgery. A connector whose processor stamps no attempt
  // sits at revision 0 permanently; bumping it to 1 here would invent an attempt that never existed.
  const store = createSyncLogStore([syncLogRow({
    ...CLAIMED_ROW,
    connector: 'quickbooks',
    status: 'PROCESSING',
    attemptRevision: 0,
    processingStartedAt: new Date(NOW.getTime() - 1_000),
  })])
  const { tx } = storeTx(store)

  assert.equal(await cancelPendingSalesInvoiceSyncForOrder(tx, 'order-1', NOW), 1)
  assert.equal(store.get('synclog-42')?.status, 'CANCELLED')
  assert.equal(store.get('synclog-42')?.attemptRevision, 0)
})

test('cancelPendingSalesInvoiceSyncForOrder voids the not-yet-posted mirrored events', async () => {
  const { tx, calls } = mockTx(['event-1', 'event-2'])
  await cancelPendingSalesInvoiceSyncForOrder(tx, 'order-1', NOW)

  // Only PENDING/FAILED (un-posted) mirror events are selected.
  const findWhere = calls.eventFindMany[0].where as { status: { in: string[] }; sourceEntityId: string; type: { in: string[] } }
  assert.deepEqual(findWhere.status.in, ['PENDING', 'FAILED'])
  assert.equal(findWhere.sourceEntityId, 'order-1')

  // They are terminalised to VOID with the external id cleared, and an audit log is written per event.
  assert.equal(calls.eventUpdateMany.length, 1)
  const eventData = calls.eventUpdateMany[0].data as { status: string; externalId: unknown }
  assert.equal(eventData.status, 'VOID')
  assert.equal(eventData.externalId, null)
  assert.equal(calls.eventLogCreateMany.length, 1)
  assert.equal((calls.eventLogCreateMany[0].data as unknown[]).length, 2)
})

test('cancelPendingSalesInvoiceSyncForOrder writes no mirror updates when there are no un-posted events', async () => {
  const { tx, calls } = mockTx([])
  await cancelPendingSalesInvoiceSyncForOrder(tx, 'order-1', NOW)

  // The sync log is still cancelled, but nothing touches the mirror when there is nothing un-posted.
  assert.equal(calls.syncRetire.length, 1)
  assert.equal(calls.eventUpdateMany.length, 0)
  assert.equal(calls.eventLogCreateMany.length, 0)
})

test('retireSalesInvoiceForCancelledOrder fences on the ATTEMPT, not on the claim timestamp', async () => {
  // o3d-e2mz Finding 1. The claim timestamp is gone: `processingStartedAt` says WHEN a claim was taken,
  // never WHICH, so two claims in the same millisecond shared a token. A caller naming an older attempt
  // must now match nothing even though the row is still PROCESSING with the same timestamp.
  const claimedAt = new Date('2026-07-18T11:59:00.000Z')
  const store = createSyncLogStore([syncLogRow({
    ...CLAIMED_ROW,
    status: 'PROCESSING',
    attemptRevision: 4,
    processingStartedAt: claimedAt,
  })])
  const { tx, eventUpdateMany } = storeTx(store)

  // THE CLAIM IS IDENTICAL ON BOTH CALLS — the same `processingStartedAt` the row carries — so
  // o3d-550x's `heldClaimWhere` half matches every time and cannot be what refuses the stale one.
  // Only the attempt revision can, which is the point: two claims in the same millisecond share a
  // timestamp and cannot share a revision. The composed predicate is pinned below.
  const held = claimHeldFrom(claimedAt)
  const stale = await retireSalesInvoiceForCancelledOrder(tx, { id: 'synclog-42', attemptRevision: 3 }, 'order-1', held)

  assert.equal(stale, false, 'an older attempt must not retire a row a newer attempt owns')
  assert.equal(store.get('synclog-42')?.status, 'PROCESSING')
  assert.equal(eventUpdateMany.length, 0, 'the mirror must not be touched when the CAS loses')

  const current = await retireSalesInvoiceForCancelledOrder(tx, { id: 'synclog-42', attemptRevision: 4 }, 'order-1', held)

  assert.equal(current, true)
  assert.equal(store.get('synclog-42')?.status, 'CANCELLED')
  // o3d-xl63 r6: the ownership half of that WHERE is the SHARED `heldClaimWhere`, not a second
  // hand-spelt copy — pinned by value so a re-spelt predicate cannot drift from the one the two sync
  // processors fence with.
  assert.deepEqual(
    store.updateManyWheres.at(-1),
    {
      ...heldClaimWhere('synclog-42', held),
      attemptRevision: 4,
      externalTransactionId: null,
    },
  )
  assert.equal(eventUpdateMany.length, 1)
  assert.equal((eventUpdateMany[0].data as { status: string }).status, 'VOID')
})

test('retireSalesInvoiceForCancelledOrder ADVANCES the attempt it retires, fencing out the claim holder', async () => {
  // The hole Finding 1 named: a writer that retires a row without moving the revision leaves the worker
  // holding that attempt with a writeback CAS that still succeeds — silently reversing the cancellation.
  const store = createSyncLogStore([syncLogRow({
    ...CLAIMED_ROW,
    status: 'PROCESSING',
    attemptRevision: 4,
    processingStartedAt: new Date('2026-07-18T11:59:00.000Z'),
  })])
  const { tx } = storeTx(store)

  assert.equal(
    await retireSalesInvoiceForCancelledOrder(
      tx,
      { id: 'synclog-42', attemptRevision: 4 },
      'order-1',
      claimHeldFrom(new Date('2026-07-18T11:59:00.000Z')),
    ),
    true,
  )
  assert.equal(store.get('synclog-42')?.attemptRevision, 5, 'retiring a row must move it to a new attempt')

  // The worker that still holds attempt 4 now finds nothing to write to.
  const revived = await updateAtAttemptRevision(
    { accountingSyncLog: store.delegate } as never,
    { id: 'synclog-42', attemptRevision: 4 },
    { status: 'PENDING', errorMessage: 'Xero timed out' },
  )
  assert.equal(revived, false, 'the retired attempt must be un-writable')
  assert.equal(store.get('synclog-42')?.status, 'CANCELLED')
})

test('retireSalesInvoiceForCancelledOrder never retires a row that already names a document', async () => {
  const store = createSyncLogStore([syncLogRow({
    ...CLAIMED_ROW,
    status: 'PROCESSING',
    attemptRevision: 4,
    // The claim and the attempt both MATCH here, deliberately: the only thing that may refuse this
    // retirement is the document the row already names.
    processingStartedAt: new Date('2026-07-18T11:59:00.000Z'),
    externalTransactionId: 'XERO-77',
  })])
  const { tx, eventUpdateMany } = storeTx(store)

  assert.equal(
    await retireSalesInvoiceForCancelledOrder(
      tx,
      { id: 'synclog-42', attemptRevision: 4 },
      'order-1',
      claimHeldFrom(new Date('2026-07-18T11:59:00.000Z')),
    ),
    false,
  )
  assert.equal(store.get('synclog-42')?.status, 'PROCESSING')
  assert.equal(store.get('synclog-42')?.attemptRevision, 4)
  assert.equal(eventUpdateMany.length, 0)
})

test('an UNFENCED caller retires its row and leaves it at revision 0, forging no attempt', async () => {
  // The QuickBooks shape: that processor stamps no attempt revision, so it can name none. It is retired
  // on the remaining guards alone, and the row must NOT come out claiming to have had an attempt — a
  // forged revision 1 would let a later decision believe it was fenced when nothing ever fenced it.
  const store = createSyncLogStore([syncLogRow({
    ...CLAIMED_ROW,
    connector: 'quickbooks',
    status: 'PROCESSING',
    attemptRevision: 0,
    processingStartedAt: new Date('2026-07-18T11:59:00.000Z'),
  })])
  const { tx } = storeTx(store)

  assert.equal(
    await retireSalesInvoiceForCancelledOrder(
      tx,
      { id: 'synclog-42', attemptRevision: 0 },
      'order-1',
      claimHeldFrom(new Date('2026-07-18T11:59:00.000Z')),
    ),
    true,
  )
  assert.equal(store.get('synclog-42')?.status, 'CANCELLED')
  assert.equal(store.get('synclog-42')?.attemptRevision, 0, 'an unfenced row must stay unfenced')
})

test('the cancel-time sweep advances the fence, so a stale-claim worker cannot revive the cancelled sale', async () => {
  // The sweep retires stale-PROCESSING rows, and "stale" is a GUESS about a worker that may still be
  // alive holding that attempt. Before o3d-e2mz round 2 the sweep moved no revision, so that worker's
  // failure/writeback CAS still matched and put the row back in the live set.
  const store = createSyncLogStore([syncLogRow({
    ...CLAIMED_ROW,
    status: 'PROCESSING',
    attemptRevision: 4,
    processingStartedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
  })])
  const { tx } = storeTx(store)

  const retired = await cancelPendingSalesInvoiceSyncForOrder(tx, 'order-1', NOW)

  assert.equal(retired, 1)
  assert.equal(store.get('synclog-42')?.status, 'CANCELLED')
  assert.equal(store.get('synclog-42')?.attemptRevision, 5, 'the sweep must move the row to a new attempt')

  const revived = await updateAtAttemptRevision(
    { accountingSyncLog: store.delegate } as never,
    { id: 'synclog-42', attemptRevision: 4 },
    { status: 'PENDING', errorMessage: 'Xero timed out' },
  )
  assert.equal(revived, false)
  assert.equal(store.get('synclog-42')?.status, 'CANCELLED')
})

test('the cancel-time sweep leaves an UNFENCED row at revision 0 rather than forging an attempt', async () => {
  const store = createSyncLogStore([
    syncLogRow({ ...CLAIMED_ROW, id: 'qbo-1', connector: 'quickbooks', status: 'PENDING', attemptRevision: 0 }),
    syncLogRow({ ...CLAIMED_ROW, id: 'xero-1', status: 'PENDING', attemptRevision: 2 }),
  ])
  const { tx } = storeTx(store)

  const retired = await cancelPendingSalesInvoiceSyncForOrder(tx, 'order-1', NOW)

  assert.equal(retired, 2, 'both fence classes are swept')
  assert.equal(store.get('qbo-1')?.status, 'CANCELLED')
  assert.equal(store.get('qbo-1')?.attemptRevision, 0, 'revision 0 means "never fence-claimed" and must stay 0')
  assert.equal(store.get('xero-1')?.status, 'CANCELLED')
  assert.equal(store.get('xero-1')?.attemptRevision, 3)
})

test('cancelPendingSalesInvoiceSyncForOrder does not clobber an event a worker posted between read and update', async () => {
  // Simulate the race: findMany saw the event as PENDING, but a worker POSTED it (with an external id)
  // before our VOID update. The compare-and-swap update then matches 0 rows, and no false void log is
  // written — the real posted document is preserved.
  const eventUpdateMany: Array<{ where?: unknown; data?: unknown }> = []
  const eventLogCreateMany: unknown[] = []
  const tx = {
    // o3d-7o0: findFirst is the posting-intent probe; nothing is in flight in this scenario.
    accountingSyncLog: {
      findFirst: async () => null,
      updateManyAndReturn: async () => [{ id: 'synclog-1', attemptRevision: 0 }],
      updateMany: async () => ({ count: 1 }),
    },
    accountingEvent: {
      findMany: async ({ where }: { where: { status?: unknown } }) => {
        const status = (where as { status?: { in?: string[] } | string }).status
        // First call (select PENDING/FAILED) returns the event; the post-update VOID re-read finds none.
        if (status && typeof status === 'object' && 'in' in status) {
          return [{ id: 'event-1', type: 'SALES_INVOICE', sourceEntityType: 'SalesOrder', sourceEntityId: 'order-1' }]
        }
        return []
      },
      updateMany: async (args: { where?: unknown; data?: unknown }) => {
        eventUpdateMany.push(args)
        return { count: 0 } // CAS lost — the row is no longer PENDING/FAILED.
      },
    },
    accountingEventLog: { createMany: async (args: { data: unknown[] }) => { eventLogCreateMany.push(...args.data); return { count: 0 } } },
  }

  await cancelPendingSalesInvoiceSyncForOrder(tx as never, 'order-1', NOW)

  // The VOID update was attempted with the status predicate, but nothing was voided and nothing logged.
  assert.equal(eventUpdateMany.length, 1)
  const updateWhere = eventUpdateMany[0].where as { status: { in: string[] } }
  assert.deepEqual(updateWhere.status.in, ['PENDING', 'FAILED'])
  assert.equal(eventLogCreateMany.length, 0)
})

/**
 * o3d-e2mz r3 (Codex r2 finding 1) — A CLAIM MUST NOT BE ABLE TO SLIP THROUGH THE SWEEP.
 *
 * Round 2 split the retirement into two statements partitioned on `attemptRevision`: the fenced set
 * (retire and advance) and the unfenced set (retire, no bump). A sync log is CREATED at revision 0
 * and only reaches 1 when a processor claims it — so the ordinary case here, a PENDING invoice
 * nobody has picked up yet, is in the unfenced half. A claim landing between the two statements
 * carried the row across the partition: the fenced statement had already passed it by at revision 0,
 * and the unfenced statement no longer matched it at revision 1. The row was never cancelled, the
 * sweep counted nothing, and the worker's fence was intact — a silent escape, in the branch built to
 * make exactly this collision detectable.
 *
 * The wrapper below fires a real processor-shaped claim (a compare-and-swap on the revision it read)
 * after the sweep's FIRST write to accountingSyncLog, which is where that window was.
 */
function txWithClaimAfterFirstWrite(store: SyncLogStore, rowId: string) {
  const claims: boolean[] = []
  let fired = false
  const claimOnce = async () => {
    if (fired) return
    fired = true
    const claimed = await (store.delegate.updateMany as (args: unknown) => Promise<{ count: number }>)({
      // Exactly the claim `accountingSyncLogClaimWhere` builds: the row, at the revision that was
      // read, in a claimable status.
      where: { id: rowId, attemptRevision: 0, OR: [{ status: 'PENDING' }, { status: 'PROCESSING' }] },
      data: { status: 'PROCESSING', processingStartedAt: new Date(), attemptRevision: { increment: 1 } },
    })
    claims.push(claimed.count > 0)
  }

  const wrapped = new Proxy({}, {
    get: (_target, prop: string) => async (args: never) => {
      const result = await (store.delegate[prop] as (a: never) => Promise<unknown>)(args)
      if (prop === 'updateMany' || prop === 'updateManyAndReturn') await claimOnce()
      return result
    },
  })

  const tx = {
    accountingSyncLog: wrapped,
    accountingEvent: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    accountingEventLog: { createMany: async () => ({ count: 0 }) },
  }
  return { tx: tx as never, claims }
}

test('a claim landing mid-sweep cannot carry an unclaimed row out of the sweep (o3d-e2mz r3)', async () => {
  const store = createSyncLogStore([syncLogRow({
    ...CLAIMED_ROW,
    id: 'synclog-fresh',
    status: 'PENDING',
    attemptRevision: 0,
  })])
  const { tx, claims } = txWithClaimAfterFirstWrite(store, 'synclog-fresh')

  const retired = await cancelPendingSalesInvoiceSyncForOrder(tx, 'order-1', NOW)

  assert.equal(retired, 1, 'the sweep must account for the row it retired')
  assert.equal(store.get('synclog-fresh')?.status, 'CANCELLED', 'the row must not escape cancellation')
  assert.deepEqual(claims, [false], 'the claim must lose: one statement decided this row, and it decided CANCELLED')
  assert.equal(
    store.get('synclog-fresh')?.attemptRevision,
    0,
    'and the row it never claimed must still be at revision 0 — no forged attempt',
  )
})

test('a fenced row swept alongside an unfenced one advances only its own attempt (o3d-e2mz r3)', async () => {
  // Both fence classes retired by the SAME statement, and only the fenced one bumped — the property
  // the two-statement split existed to get, without the window it opened.
  const store = createSyncLogStore([
    syncLogRow({ ...CLAIMED_ROW, id: 'unfenced-1', status: 'PENDING', attemptRevision: 0 }),
    syncLogRow({ ...CLAIMED_ROW, id: 'fenced-1', status: 'FAILED', attemptRevision: 7 }),
  ])
  const { tx } = storeTx(store)

  const retired = await cancelPendingSalesInvoiceSyncForOrder(tx, 'order-1', NOW)

  assert.equal(retired, 2)
  assert.equal(store.get('unfenced-1')?.status, 'CANCELLED')
  assert.equal(store.get('unfenced-1')?.attemptRevision, 0)
  assert.equal(store.get('fenced-1')?.status, 'CANCELLED')
  assert.equal(store.get('fenced-1')?.attemptRevision, 8)
  // The bump statement names ids, so it can never reach a row this sweep did not retire.
  const bump = store.updateManyWheres.at(-1) as { id?: { in?: string[] } }
  assert.deepEqual(bump.id?.in, ['fenced-1'])
})
