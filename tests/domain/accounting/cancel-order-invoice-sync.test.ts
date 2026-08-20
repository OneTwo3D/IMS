import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cancelPendingSalesInvoiceSyncForOrder,
  retireSalesInvoiceForCancelledOrder,
} from '@/lib/domain/accounting/cancel-order-invoice-sync'

type Call = { where?: unknown; data?: unknown }

function mockTx(pendingEventIds: string[], livePostingClaim: unknown = null) {
  const calls: {
    syncFindFirst: Call[]
    syncUpdateMany: Call[]
    eventFindMany: Call[]
    eventUpdateMany: Call[]
    eventLogCreateMany: Call[]
  } = { syncFindFirst: [], syncUpdateMany: [], eventFindMany: [], eventUpdateMany: [], eventLogCreateMany: [] }

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

  assert.equal(calls.syncUpdateMany.length, 1)
  const where = calls.syncUpdateMany[0].where as {
    referenceId: string
    type: { in: string[] }
    externalTransactionId: unknown
    OR: Array<{ status: string; processingStartedAt?: unknown }>
  }
  const data = calls.syncUpdateMany[0].data as { status: string; processingStartedAt: unknown }

  // CANCELLED (not FAILED) so reconciliation/backfill sweeps ignore it.
  assert.equal(data.status, 'CANCELLED')
  assert.equal(data.processingStartedAt, null)
  assert.equal(where.referenceId, 'order-1')
  assert.deepEqual(where.type.in, ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'])
  // Only never-posted rows are swept — a row that posted then reverted keeps its external id and must
  // not be falsely recorded as never-posted.
  assert.equal(where.externalTransactionId, null)
})

test('cancelPendingSalesInvoiceSyncForOrder targets PENDING/FAILED and stale-PROCESSING rows, never a fresh claim', async () => {
  const { tx, calls } = mockTx([])
  await cancelPendingSalesInvoiceSyncForOrder(tx, 'order-1', NOW)

  const or = (calls.syncUpdateMany[0].where as { OR: Array<{ status: string; processingStartedAt?: { lt?: Date } | null }> }).OR
  // PENDING and FAILED (both would otherwise still post — a drain or a "Retry All"), plus PROCESSING
  // with a null/stale claim. A freshly-claimed (recent processingStartedAt) row is deliberately NOT
  // matched, so an in-flight post is left to finish; SYNCED rows are already posted and out of scope.
  assert.deepEqual(or.map((clause) => clause.status), ['PENDING', 'FAILED', 'PROCESSING', 'PROCESSING'])
  const staleClause = or.find((clause) => clause.processingStartedAt && 'lt' in clause.processingStartedAt)
  assert.ok(staleClause, 'a stale-processing cutoff clause is present')
  const cutoff = (staleClause!.processingStartedAt as { lt: Date }).lt
  // Cutoff is 15 minutes before "now".
  assert.equal(NOW.getTime() - cutoff.getTime(), 15 * 60 * 1000)
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
  assert.equal(calls.syncUpdateMany.length, 1)
  assert.equal(calls.eventUpdateMany.length, 0)
  assert.equal(calls.eventLogCreateMany.length, 0)
})

test('retireSalesInvoiceForCancelledOrder claim-fences on PROCESSING and voids the order mirror when it wins', async () => {
  const syncUpdateMany: Array<{ where?: unknown; data?: unknown }> = []
  const eventUpdateMany: Array<{ where?: unknown; data?: unknown }> = []
  const tx = {
    accountingSyncLog: {
      updateMany: async (args: { where?: unknown; data?: unknown }) => { syncUpdateMany.push(args); return { count: 1 } },
    },
    accountingEvent: {
      findMany: async () => [{ id: 'event-1', type: 'SALES_INVOICE', sourceEntityType: 'SalesOrder', sourceEntityId: 'order-1' }],
      updateMany: async (args: { where?: unknown; data?: unknown }) => { eventUpdateMany.push(args); return { count: 1 } },
    },
    accountingEventLog: { createMany: async () => ({ count: 1 }) },
  }

  const claimedAt = new Date('2026-07-18T11:59:00.000Z')
  const retired = await retireSalesInvoiceForCancelledOrder(tx as never, 'synclog-42', 'order-1', claimedAt)

  assert.equal(retired, true)
  // Claim-fenced CAS: id + status=PROCESSING + this worker's exact processingStartedAt + no external id,
  // so it never clobbers a reclaimed row or one that already posted.
  assert.equal(syncUpdateMany.length, 1)
  assert.deepEqual(syncUpdateMany[0].where, {
    id: 'synclog-42',
    status: 'PROCESSING',
    processingStartedAt: claimedAt,
    externalTransactionId: null,
  })
  assert.equal((syncUpdateMany[0].data as { status: string }).status, 'CANCELLED')
  // Only after winning the CAS is the order's un-posted mirror voided.
  assert.equal(eventUpdateMany.length, 1)
  assert.equal((eventUpdateMany[0].data as { status: string }).status, 'VOID')
})

test('retireSalesInvoiceForCancelledOrder leaves a row (and its mirror) alone when the claim CAS loses', async () => {
  const eventUpdateMany: unknown[] = []
  const tx = {
    accountingSyncLog: {
      updateMany: async () => ({ count: 0 }), // row is no longer PROCESSING — reclaimed/posted elsewhere.
    },
    accountingEvent: {
      findMany: async () => { throw new Error('mirror must not be touched when the CAS loses') },
      updateMany: async (args: unknown) => { eventUpdateMany.push(args); return { count: 0 } },
    },
    accountingEventLog: { createMany: async () => ({ count: 0 }) },
  }

  const retired = await retireSalesInvoiceForCancelledOrder(tx as never, 'synclog-42', 'order-1', new Date('2026-07-18T11:59:00.000Z'))

  assert.equal(retired, false)
  assert.equal(eventUpdateMany.length, 0)
})

test('cancelPendingSalesInvoiceSyncForOrder does not clobber an event a worker posted between read and update', async () => {
  // Simulate the race: findMany saw the event as PENDING, but a worker POSTED it (with an external id)
  // before our VOID update. The compare-and-swap update then matches 0 rows, and no false void log is
  // written — the real posted document is preserved.
  const eventUpdateMany: Array<{ where?: unknown; data?: unknown }> = []
  const eventLogCreateMany: unknown[] = []
  const tx = {
    // o3d-7o0: findFirst is the posting-intent probe; nothing is in flight in this scenario.
    accountingSyncLog: { findFirst: async () => null, updateMany: async () => ({ count: 1 }) },
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
