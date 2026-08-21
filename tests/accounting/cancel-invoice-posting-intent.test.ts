import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { claimHeldFrom, type HeldClaim } from '@/lib/domain/accounting/sync-claim-fence'

import {
  SalesInvoicePostingInFlightError,
  assertNoSalesInvoicePostingInFlight,
  cancelPendingSalesInvoiceSyncForOrder,
  findLiveSalesInvoicePostingClaim,
} from '@/lib/domain/accounting/cancel-order-invoice-sync'
import { isPermanentStatusTransitionError } from '@/lib/domain/sales/status-transition-errors'

// ---------------------------------------------------------------------------
// o3d-7o0 — the cancel/invoice window: a cancellation committing between the post-time guard's status
// read and the irreversible external POST.
//
// o3d-5rs and #580 both left it DETECTED rather than closed, and the reason was always the same shape:
// the guard read the order OUTSIDE any lock, so the answer was already history by the time the invoice
// request went to Xero. The protocol that closes it is the one #580 used for the hard DELETE:
//
//   1. AN INTENT THAT IS DURABLE AND EARLIER THAN THE DECISION — the processor's PROCESSING claim,
//      committed by the runner before processEntry does anything. Nothing new is written; it is now READ.
//   2. BOTH DECIDING READS SERIALISE ON THE ORDER ROW — cancelSalesOrderFulfillmentState already opens
//      with lockSalesOrder, and guardCancelledSalesOrderInvoice now takes the SAME lock around its read.
//
// So for any interleaving: either the cancellation commits first and the guard reads CANCELLED and
// retires instead of posting, or the guard holds the lock and the cancellation waits — and then finds
// the live claim and REFUSES. This file pins both halves.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-04-01T12:00:00.000Z')
const FRESH_CLAIM = new Date('2026-04-01T11:58:00.000Z')   // 2 minutes old
const STALE_CLAIM = new Date('2026-04-01T11:40:00.000Z')   // 20 minutes old, past the 15-minute cutoff

type LogRow = {
  id: string
  connector: string
  type: string
  status: string
  processingStartedAt: Date | null
  referenceId: string
  externalTransactionId: string | null
}

/**
 * A sync-log store that HONOURS its where clause — including the `processingStartedAt: { gte }` cutoff
 * and the `type: { in }` list. The whole property under test is which rows count as a live posting
 * intent, so a double that ignored `where` would pass with the guard deleted.
 */
function makeSyncLogStore(rows: LogRow[]) {
  const calls = { findFirst: 0, updateMany: 0, updateManyAndReturn: 0 }
  const matches = (row: LogRow, where: Record<string, unknown>): boolean => {
    if (where.referenceId !== undefined && row.referenceId !== where.referenceId) return false
    if (where.status !== undefined && row.status !== where.status) return false
    if (where.externalTransactionId !== undefined && row.externalTransactionId !== where.externalTransactionId) return false
    const type = where.type as { in?: string[] } | string | undefined
    if (typeof type === 'string' && row.type !== type) return false
    if (type && typeof type === 'object' && type.in && !type.in.includes(row.type)) return false
    const started = where.processingStartedAt as { gte?: Date; lt?: Date } | Date | null | undefined
    if (started instanceof Date) {
      if (row.processingStartedAt?.valueOf() !== started.valueOf()) return false
    } else if (started === null) {
      if (row.processingStartedAt !== null) return false
    } else if (started && typeof started === 'object') {
      if (started.gte && !(row.processingStartedAt && row.processingStartedAt >= started.gte)) return false
      if (started.lt && !(row.processingStartedAt && row.processingStartedAt < started.lt)) return false
    }
    if (Array.isArray(where.OR)) {
      if (!(where.OR as Array<Record<string, unknown>>).some((clause) => matches(row, clause))) return false
    }
    return true
  }
  const tx = {
    accountingSyncLog: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        calls.findFirst += 1
        return rows.find((row) => matches(row, where)) ?? null
      },
      updateMany: async ({ where }: { where: Record<string, unknown> }) => {
        calls.updateMany += 1
        return { count: rows.filter((row) => matches(row, where)).length }
      },
      // o3d-e2mz r3: the sweep decides and retires in ONE statement that also NAMES the rows it
      // retired, so the fence bump that follows can be scoped to ids this transaction already holds
      // the locks on. A double without it cannot see the retirement at all.
      updateManyAndReturn: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        calls.updateManyAndReturn += 1
        calls.updateMany += 1
        const hit = rows.filter((row) => matches(row, where))
        for (const row of hit) Object.assign(row, data)
        return hit.map((row) => ({ id: row.id, attemptRevision: (row as { attemptRevision?: number }).attemptRevision ?? 0 }))
      },
    },
    accountingEvent: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    accountingEventLog: { createMany: async () => ({ count: 0 }) },
  }
  return { tx: tx as never, calls }
}

const claimedRow = (over: Partial<LogRow> = {}): LogRow => ({
  id: 'sync-1',
  connector: 'xero',
  type: 'SALES_INVOICE',
  status: 'PROCESSING',
  processingStartedAt: FRESH_CLAIM,
  referenceId: 'order-1',
  externalTransactionId: null,
  ...over,
})

test('o3d-7o0: a FRESH invoice-posting claim is a live posting intent', async () => {
  const { tx } = makeSyncLogStore([claimedRow()])
  const claim = await findLiveSalesInvoicePostingClaim(tx, 'order-1', NOW)
  assert.equal(claim?.id, 'sync-1')
})

test('o3d-7o0: cancelling an order whose invoice is mid-post is REFUSED, naming the sync row', async () => {
  const { tx } = makeSyncLogStore([claimedRow()])
  const error = await assertNoSalesInvoicePostingInFlight(tx, 'order-1', NOW).catch((e) => e)

  assert.ok(error instanceof SalesInvoicePostingInFlightError, 'the refusal has its own type')
  // The SPECIFIC reason, not a bare failure: which row, which connector, and what to do next.
  assert.match(String(error.message), /while its xero SALES_INVOICE is being posted/)
  assert.match(String(error.message), /sync log sync-1/)
  assert.match(String(error.message), /would leave a receivable in the ledger for a sale that never happened/)
})

test('o3d-7o0: the refusal is TRANSIENT — the claim ages out, so the same request succeeds later', async () => {
  // If this read as permanent, a Woo cancellation webhook would be ACKNOWLEDGED and the cancellation
  // silently dropped. status-transition-errors.ts reserves permanent for irreversible PHYSICAL facts.
  const { tx } = makeSyncLogStore([claimedRow()])
  const error = await assertNoSalesInvoicePostingInFlight(tx, 'order-1', NOW).catch((e) => e)
  assert.equal(isPermanentStatusTransitionError(error), false)
})

test('o3d-7o0: a STALE claim is not a live intent — the documented bound, not an oversight', async () => {
  // Past the 15-minute cutoff the reclaim scheme already treats the row as abandoned. Refusing here
  // too would make a row nothing will ever finish block cancellation forever.
  const { tx } = makeSyncLogStore([claimedRow({ processingStartedAt: STALE_CLAIM })])
  assert.equal(await findLiveSalesInvoicePostingClaim(tx, 'order-1', NOW), null)
  await assert.doesNotReject(() => assertNoSalesInvoicePostingInFlight(tx, 'order-1', NOW))
})

test('o3d-7o0: PENDING and FAILED rows do not block a cancel — those are what the sweep retires', async () => {
  const { tx } = makeSyncLogStore([
    claimedRow({ id: 'sync-pending', status: 'PENDING', processingStartedAt: null }),
    claimedRow({ id: 'sync-failed', status: 'FAILED', processingStartedAt: null }),
  ])
  await assert.doesNotReject(() => assertNoSalesInvoicePostingInFlight(tx, 'order-1', NOW))
})

test('o3d-7o0: a claim on a DIFFERENT order does not block this one', async () => {
  const { tx } = makeSyncLogStore([claimedRow({ referenceId: 'order-2' })])
  await assert.doesNotReject(() => assertNoSalesInvoicePostingInFlight(tx, 'order-1', NOW))
})

test('o3d-7o0: a non-invoice sync type in flight does not block a cancel', async () => {
  // COGS_REVERSAL, INVOICE_PDF and friends do not create a receivable for the sale.
  const { tx } = makeSyncLogStore([claimedRow({ type: 'COGS_REVERSAL' })])
  await assert.doesNotReject(() => assertNoSalesInvoicePostingInFlight(tx, 'order-1', NOW))
})

test('o3d-7o0: the cancel-time sweep refuses BEFORE it retires anything', async () => {
  // The invariant lives inside the module that owns the retirement, so no caller can skip it — and it
  // runs first, so a refused cancellation leaves the queue exactly as it found it.
  const { tx, calls } = makeSyncLogStore([claimedRow()])
  await assert.rejects(
    () => cancelPendingSalesInvoiceSyncForOrder(tx, 'order-1', NOW),
    SalesInvoicePostingInFlightError,
  )
  assert.equal(calls.updateMany, 0, 'nothing was retired on the refused path')
})

test('o3d-7o0: with no post in flight the sweep still retires the order\'s queued invoice work', async () => {
  // The counter-guard: the refusal must not become "cancellation never retires anything".
  const { tx, calls } = makeSyncLogStore([
    claimedRow({ id: 'sync-pending', status: 'PENDING', processingStartedAt: null }),
  ])
  const retired = await cancelPendingSalesInvoiceSyncForOrder(tx, 'order-1', NOW)
  assert.equal(retired, 1)
  assert.equal(calls.updateMany, 1)
})

// ---------------------------------------------------------------------------
// The other half: the guard's read must happen UNDER the order row lock, in the transaction that
// retires. Driven through a fake db so the STATEMENT ORDER is observable — the lock has to be first,
// or a cancellation can still commit between the read and the POST.
// ---------------------------------------------------------------------------

type GuardState = {
  orderStatus: string
  statements: string[]
  retireWheres: Array<Record<string, unknown>>
  transactions: number
}
const guardState: GuardState = { orderStatus: 'PROCESSING', statements: [], retireWheres: [], transactions: 0 }

function makeGuardTx() {
  return {
    $queryRaw: async (sql: { strings?: string[]; sql?: string } | unknown) => {
      // Prisma.sql tagged template → a Sql object. Its `strings`/`sql` carry the statement text.
      const text = (sql as { sql?: string }).sql ?? (sql as { strings?: string[] }).strings?.join('?') ?? String(sql)
      guardState.statements.push(text.replace(/\s+/g, ' ').trim())
      return []
    },
    salesOrder: {
      findUnique: async () => {
        guardState.statements.push('READ salesOrder')
        return { customerId: 'cust-1', status: guardState.orderStatus }
      },
    },
    accountingSyncLog: {
      updateMany: async ({ where }: { where: Record<string, unknown> }) => {
        guardState.statements.push('RETIRE accountingSyncLog')
        guardState.retireWheres.push(where)
        return { count: 1 }
      },
    },
    accountingEvent: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    accountingEventLog: { createMany: async () => ({ count: 0 }) },
  }
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        guardState.transactions += 1
        return fn(makeGuardTx())
      },
      salesOrder: {
        findUnique: async () => {
          // If the guard ever reads the order OUTSIDE the transaction again, this fires and the
          // ordering assertions below cannot pass.
          guardState.statements.push('READ salesOrder OUTSIDE TRANSACTION')
          return { customerId: 'cust-1', status: guardState.orderStatus }
        },
      },
    },
  },
})

type Guard = (
  // o3d-e2mz: the guard is handed the ATTEMPT this worker claimed, not a bare entry id — the
  // retirement fences on the revision as well as on the claim instant, and advances it as it lands.
  attempt: { id: string; attemptRevision: number }, referenceType: string, referenceId: string, held: HeldClaim,
) => Promise<{ post: true; customerId?: string } | { post: false; result: { success: boolean; skipped?: boolean; error?: string } }>
let guard: Guard | null = null
async function guardCancelledSalesOrderInvoice(...args: Parameters<Guard>): ReturnType<Guard> {
  if (!guard) {
    const m = await import('@/lib/connectors/xero/sync-processor')
    guard = m.guardCancelledSalesOrderInvoice as unknown as Guard
  }
  return guard(...args)
}

const CLAIMED_AT = new Date('2026-04-01T11:58:00.000Z')
// o3d-550x (Codex r2, medium 2): the guard is handed the CLAIM and asks it for the instant at the
// write, so that a renewing lease releases the claim it actually holds. A bare Date no longer type-
// checks — and this file's local `Guard` type is exactly the kind of hand-written signature that
// would otherwise have kept compiling while the fence matched nothing.
const HELD = claimHeldFrom(CLAIMED_AT)
/** o3d-e2mz: the attempt the runner minted when it claimed this row. */
const ATTEMPT = { id: 'sync-1', attemptRevision: 4 }

test.beforeEach(() => {
  guardState.orderStatus = 'PROCESSING'
  guardState.statements = []
  guardState.retireWheres = []
  guardState.transactions = 0
})

test('o3d-7o0: the guard reads the sale UNDER the order row lock, inside one transaction', async () => {
  const result = await guardCancelledSalesOrderInvoice(ATTEMPT, 'SalesOrder', 'order-1', HELD)

  assert.equal(result.post, true)
  assert.equal(guardState.transactions, 1, 'one transaction, so the lock is still held at the decision')
  assert.match(
    guardState.statements[0] ?? '',
    /SELECT id FROM "sales_orders" WHERE id = .* FOR UPDATE/,
    'the FIRST statement must be the order row lock — the same one cancelSalesOrderFulfillmentState takes',
  )
  assert.equal(guardState.statements[1], 'READ salesOrder', 'and the status read comes after it, on the same tx')
  assert.ok(
    !guardState.statements.includes('READ salesOrder OUTSIDE TRANSACTION'),
    'the sale must never be read outside the locking transaction',
  )
})

test('o3d-7o0: a cancelled order retires its claimed row in the SAME locked transaction', async () => {
  guardState.orderStatus = 'CANCELLED'
  const result = await guardCancelledSalesOrderInvoice(ATTEMPT, 'SalesOrder', 'order-1', HELD)

  assert.equal(result.post, false)
  assert.equal(result.post === false && result.result.skipped, true, 'nothing was posted, so this is a no-op skip')
  assert.equal(guardState.transactions, 1, 'the retire is NOT a second transaction taken after the lock is gone')
  assert.deepEqual(guardState.statements.slice(0, 3), [
    guardState.statements[0],
    'READ salesOrder',
    'RETIRE accountingSyncLog',
  ])
  // Still claim-fenced: an old worker must not retire a row a newer claim now owns.
  // Still claim-fenced AND now attempt-fenced (o3d-e2mz): an old worker must not retire a row a
  // newer claim owns, and a retirement that moved neither identity left the claim holder with a
  // writeback CAS that silently reversed it.
  assert.deepEqual(guardState.retireWheres[0], {
    id: 'sync-1',
    status: 'PROCESSING',
    processingStartedAt: CLAIMED_AT,
    attemptRevision: 4,
    externalTransactionId: null,
  })
})

test('o3d-7o0: an unreadable order still FAILS CLOSED — a lock timeout is not permission to post', async () => {
  const { db } = await import('@/lib/db') as unknown as { db: { $transaction: unknown } }
  const original = db.$transaction
  db.$transaction = async () => { throw new Error('lock timeout') }
  try {
    const result = await guardCancelledSalesOrderInvoice(ATTEMPT, 'SalesOrder', 'order-1', HELD)
    assert.equal(result.post, false)
    assert.equal(result.post === false && result.result.success, false)
    assert.match(String(result.post === false && result.result.error), /Could not read sales order order-1 status before posting/)
  } finally {
    db.$transaction = original
  }
})

test('o3d-7o0: a non-order reference takes no lock at all', async () => {
  const result = await guardCancelledSalesOrderInvoice(ATTEMPT, 'PurchaseOrder', 'po-1', HELD)
  assert.equal(result.post, true)
  assert.equal(guardState.transactions, 0)
  assert.deepEqual(guardState.statements, [])
})
