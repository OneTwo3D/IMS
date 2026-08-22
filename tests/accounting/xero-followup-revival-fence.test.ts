import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { FOLLOW_UP_IDEMPOTENCY_KEY } from '@/lib/domain/accounting/followup-idempotency'
import { createSyncLogStore, syncLogRow, type SyncLogStore } from '../fixtures/accounting-sync-log-store.ts'

/**
 * o3d-e2mz r3 — THE AUTOMATIC FOLLOW-UP REVIVAL, FENCED ON THE ATTEMPT IT WAS PLANNED AGAINST.
 *
 * `enqueueFollowUpSyncLog` reuses a FAILED row rather than creating a replacement, because the
 * remote idempotency token lives on that row's payload and a replacement would post a money movement
 * under a key the remote system has never seen. Round 2 fenced that reuse on `(id, status: 'FAILED')`
 * — the exact ABA the operator path had just been fenced against. Status is not an identity: a row
 * leaves FAILED and comes back to it on every retry, so between the read that planned the revival and
 * the write that performs it the row can belong to a DIFFERENT attempt and still be FAILED.
 *
 * The store below is the real in-memory delegate, so a compare-and-swap genuinely matches or
 * genuinely does not; a stub returning a canned count would pass with the fence removed.
 */

process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = 'false'

let store: SyncLogStore = createSyncLogStore([])
/** Runs once, on the next db.$transaction — i.e. between the plan's read and the revival write. */
let interleave: (() => void) | null = null
const activity: Array<{ action: string; level?: string; description: string; metadata?: Record<string, unknown> }> = []
const scheduled: Array<Record<string, unknown>> = []

const accountingSyncLog = new Proxy({}, {
  get: (_target, prop: string) => (args: never) => (store.delegate[prop] as (a: never) => Promise<unknown>)(args),
})

const dbStub = {
  accountingSyncLog,
  // o3d-0m56's per-scope advisory lock, taken inside the revival transaction for money-moving types.
  $executeRaw: async () => 1,
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const hook = interleave
    interleave = null
    hook?.()
    return fn(dbStub)
  },
}

mock.module('@/lib/db', { namedExports: { db: dbStub } })
/**
 * o3d-0m56: the AUTOMATIC revival now asks the ledger whether the attempt is already in it before it
 * revives a money row — reviving under a pinned token only protects while Xero still remembers that
 * token, which is minutes, and a sweep runs long after.
 *
 * Answered CLEAR here, deliberately. This file is about the o3d-e2mz attempt compare-and-swap, and a
 * ledger that refused would stop every case before the CAS was ever attempted — the tests would pass
 * or fail on a fence they are not about. The ledger refusal's own behaviour is pinned in
 * settlement-probe.test.ts and manual-retry-guard.test.ts.
 *
 * `postMoneyUnderLedgerFence` is re-exported unused: `mock.module` replaces the whole module, and the
 * sync processor imports it at load time.
 */
mock.module('@/lib/connectors/accounting-settlement-probe', {
  namedExports: {
    ledgerClearsFollowUpRevival: async () => ({ clear: true }),
    postMoneyUnderLedgerFence: async (_params: unknown, run: () => Promise<unknown>) => run(),
    probeLedgerSettlement: async () => ({ ok: true, records: [] }),
    settlementProbeKey: () => 'probe-key',
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level?: string; description: string; metadata?: Record<string, unknown> }) => {
      activity.push(entry)
    },
  },
})
mock.module('@/lib/connectors/xero/outbox', {
  namedExports: {
    scheduleXeroAccountingOutbox: async (_client: unknown, args: Record<string, unknown>) => { scheduled.push(args) },
  },
})

async function loadEnqueue() {
  return (await import('@/lib/connectors/xero/sync-processor')).enqueueFollowUpSyncLog
}

function reset(rows: Parameters<typeof createSyncLogStore>[0]) {
  store = createSyncLogStore(rows)
  interleave = null
  activity.length = 0
  scheduled.length = 0
}

/** The remote token a previous attempt posted under; reviving must carry it forward unchanged. */
const PINNED_TOKEN = 'xero:invoice_payment:salesorder:order-1:inv-9'

function failedPaymentRow(overrides: Partial<Parameters<typeof syncLogRow>[0]> = {}) {
  return syncLogRow({
    id: 'log-pay',
    connector: 'xero',
    type: 'INVOICE_PAYMENT',
    status: 'FAILED',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    attemptRevision: 4,
    errorMessage: 'Xero timed out',
    payload: { [FOLLOW_UP_IDEMPOTENCY_KEY]: PINNED_TOKEN, accountingInvoiceId: 'inv-9', amount: 120 },
    ...overrides,
  })
}

const REQUEST = { accountingInvoiceId: 'inv-9', amount: 120 }
/**
 * o3d-19gy/o3d-s36z (merged since this test was written): the enqueue INHERITS its accounting
 * origin record from the row whose post issued these ids, and never reads the live connection.
 * These tests are about the revival compare-and-swap, so the posting row here carries no stamp —
 * exactly the pre-provenance shape — and the created row inherits none.
 */
const POSTED_ROW_PAYLOAD = {}

test('o3d-e2mz r3: reviving a FAILED follow-up CASes on the attempt it read, and advances it', async () => {
  reset([failedPaymentRow()])

  await (await loadEnqueue())('INVOICE_PAYMENT', 'SalesOrder', 'order-1', { ...REQUEST }, { from: 'postedRow', payload: POSTED_ROW_PAYLOAD })

  const revive = store.updateManyWheres.at(-1) as Record<string, unknown>
  assert.equal(revive.attemptRevision, 4, 'the revival must be a compare-and-swap on the attempt it planned against')
  assert.equal(revive.status, 'FAILED')
  const row = store.get('log-pay')
  assert.equal(row?.status, 'PENDING')
  assert.equal(row?.attemptRevision, 5, 'a revival starts a NEW attempt, so the old holder cannot write back')
  assert.deepEqual(scheduled, [{ accountingSyncLogId: 'log-pay', attempts: 0 }])
})

test('o3d-e2mz r3: a revival planned against one attempt does not land on a LATER one that returned to FAILED', async () => {
  // THE ABA. The row is retried between the plan's read and the revival write: revived, claimed,
  // attempted, and back on FAILED as attempt 6. Round 2's `(id, status: 'FAILED')` swap matched that
  // row happily — resetting an outcome it never saw and overwriting its payload, which is where the
  // pinned idempotency token lives, so the retry would go out under a token chosen for attempt 4.
  reset([failedPaymentRow()])
  interleave = () => {
    Object.assign(store.get('log-pay')!, {
      status: 'FAILED',
      attemptRevision: 6,
      errorMessage: 'Attempt 6 failed after the plan was made',
    })
  }

  await (await loadEnqueue())('INVOICE_PAYMENT', 'SalesOrder', 'order-1', { ...REQUEST }, { from: 'postedRow', payload: POSTED_ROW_PAYLOAD })

  const attempted = store.updateManyWheres.filter((where) => 'attemptRevision' in where)
  assert.deepEqual(
    attempted.map((where) => where.attemptRevision),
    [4, 6],
    'the stale swap must match nothing, and the re-plan must fence on the attempt that is actually current',
  )
  const row = store.get('log-pay')
  assert.equal(row?.status, 'PENDING')
  assert.equal(
    row?.attemptRevision,
    7,
    'the revival that landed must be the one planned against attempt 6, and it must advance it',
  )
})

test('o3d-e2mz r3: a FAILED row carrying no attempt revision is REFUSED, not revived unfenced', async () => {
  // Revision 0 means nothing that stamps an attempt has ever claimed this row — a pre-fence row, or a
  // connector whose processor does not stamp one. There is no attempt to name, so there is no way to
  // tell a revival that lands on the row we planned against from one that lands on a later attempt.
  // It fails closed and says so, rather than risking a second payment on the invoice.
  reset([failedPaymentRow({ attemptRevision: 0 })])

  await (await loadEnqueue())('INVOICE_PAYMENT', 'SalesOrder', 'order-1', { ...REQUEST }, { from: 'postedRow', payload: POSTED_ROW_PAYLOAD })

  const row = store.get('log-pay')
  assert.equal(row?.status, 'FAILED', 'the unfenceable row must be left exactly as it was')
  assert.equal(row?.attemptRevision, 0, 'and it must not be forged into a fenced one')
  assert.deepEqual(scheduled, [], 'nothing may be queued for an attempt that could not be fenced')
  const refusal = activity.find((entry) => entry.action === 'xero_followup_enqueue_refused')
  assert.ok(refusal, 'the refusal must be visible, not silent')
  assert.equal(refusal.metadata?.reason, 'unfenced_reuse_target')
  assert.equal(refusal.metadata?.syncLogId, 'log-pay')
  assert.match(refusal.description, /carries no attempt revision/)
})

test('o3d-e2mz r3: an enqueue with no FAILED row to reuse still creates one, unfenced by construction', async () => {
  // The create path has no attempt to fence on — the row does not exist yet — and must keep working.
  reset([])

  await (await loadEnqueue())('INVOICE_PAYMENT', 'SalesOrder', 'order-1', { ...REQUEST }, { from: 'postedRow', payload: POSTED_ROW_PAYLOAD })

  assert.equal(store.rows.length, 1)
  assert.equal(store.rows[0].status, 'PENDING')
  assert.equal(store.rows[0].attemptRevision, 0, 'a brand-new row has had no attempt, and must not claim one')
  assert.deepEqual(activity.filter((entry) => entry.action === 'xero_followup_enqueue_refused'), [])
})
