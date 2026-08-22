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
/**
 * o3d-anu8 (Codex, this branch) — the DURABLE activity rows, written through the caller's transaction
 * client by `logActivityInTransaction`. Kept apart from `activity` above on purpose: `activity` is the
 * best-effort logger, and half the finding is that a record which belongs in one of these was in the
 * other. `rowsAtThisPoint` is how ORDERING is asserted — "the record exists" is equally true of one
 * written before the row it describes, and that is the version this fix removed.
 */
const durableActivity: Array<{ action: string; level?: string; description: string; metadata?: Record<string, unknown>; rowsAtThisPoint: number; viaTransaction: boolean }> = []
/** When set, the durable write FAILS — the case that decides whether the enqueue may still commit. */
let failDurableActivity = false
/** o3d-anu8: switchable, so ONE test can drive a ledger refusal AFTER the plan has been made. */
let ledgerVerdict: { clear: true } | { clear: false; reason: string } = { clear: true }

const accountingSyncLog = new Proxy({}, {
  get: (_target, prop: string) => (args: never) => (store.delegate[prop] as (a: never) => Promise<unknown>)(args),
})

/**
 * o3d-anu8: the transaction client and the module-level client keep SEPARATE delegates, so "written
 * through the caller's transaction" is observable. If production passed `db` instead of `tx` the row
 * would still be recorded — but as `viaTransaction: false`, and it would not roll back with the
 * enqueue, which is the whole property.
 */
function activityLogDelegate(viaTransaction: boolean) {
  return {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (failDurableActivity) throw new Error('activity log unavailable')
      durableActivity.push({ ...(data as unknown as Omit<(typeof durableActivity)[number], 'rowsAtThisPoint' | 'viaTransaction'>), rowsAtThisPoint: store.rows.length, viaTransaction })
      return data
    },
  }
}

const dbStub = {
  accountingSyncLog,
  // o3d-anu8: the enqueue now writes its carry-onward record through the transaction client, so the
  // double has to offer the delegate that write uses — and has to be able to FAIL it.
  activityLog: activityLogDelegate(false),
  // o3d-0m56's per-scope advisory lock, taken inside the revival transaction for money-moving types.
  $executeRaw: async () => 1,
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const hook = interleave
    interleave = null
    hook?.()
    // ROLLBACK IS EMULATED (o3d-anu8). The record and the row now commit together or not at all, and
    // a double that kept the row after the record threw would make that property untestable — the
    // assertion would pass with the write moved back outside the transaction.
    const snapshot = store.rows.map((row) => ({ ...row }))
    try {
      return await fn({ ...dbStub, activityLog: activityLogDelegate(true) })
    } catch (error) {
      store.rows.splice(0, store.rows.length, ...snapshot)
      throw error
    }
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
    ledgerClearsFollowUpRevival: async () => ledgerVerdict,
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
    // o3d-anu8: a FAITHFUL stand-in — production's version writes through the client it is given and
    // does NOT catch, which is the two properties the tests below are about. A stub that swallowed
    // here would make the abort test pass with the fix removed.
    logActivityInTransaction: async (client: { activityLog: { create(args: { data: unknown }): Promise<unknown> } }, params: unknown) => {
      await client.activityLog.create({ data: params })
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
  durableActivity.length = 0
  failDurableActivity = false
  ledgerVerdict = { clear: true }
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

// ---------------------------------------------------------------------------
// o3d-anu8 (Codex, this branch) — THE CARRY-ONWARD RECORD MUST DESCRIBE SOMETHING THAT HAPPENED.
//
// When a scope holds a row an operator settled as NOT_POSTED, that assertion is what dropped the
// distinct-token count and turned a refusal into an enqueue. Freeing the path is the settlement
// action's stated purpose, so the plan does not re-block — it CARRIES the reliance onward, and the
// connector records it. Without that line the resulting payment is indistinguishable from one the
// connector's own history cleared, and if the assertion was wrong nothing leads back to it.
//
// The first revision wrote that record at PLAN time with a swallowed `logActivity`, so it was:
//
//   • UNTIED TO THE OUTCOME. The word in it is "Enqueued", and at that point nothing had been. The
//     unfenced-reuse refusal, the ledger-clearance refusal and the write itself could all still stop
//     it — each leaving a WARNING asserting a money post that never happened, which is worse than
//     silence: it sends the next person reconciling a suspected duplicate to a payment that does not
//     exist and makes the assertion look acted upon.
//   • NOT DURABLE. This is the only thing that will ever say a ledger-affecting post rested on a
//     human's word rather than on evidence — o3d-nf9i's own rule, and the reason
//     `logActivityInTransaction` exists. Best-effort let the enqueue commit with the reliance
//     silently unrecorded.
//
// It is now one transaction with the row it describes.
// ---------------------------------------------------------------------------

/** A row an operator settled as NEVER POSTED. It is what clears the token ambiguity for this scope. */
function assertedNotPostedRow(overrides: Partial<Parameters<typeof syncLogRow>[0]> = {}) {
  return syncLogRow({
    id: 'log-asserted',
    connector: 'xero',
    type: 'INVOICE_PAYMENT',
    status: 'CANCELLED',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    settlementBasis: 'OPERATOR_ASSERTION',
    payload: { [FOLLOW_UP_IDEMPOTENCY_KEY]: 'xero:invoice_payment:salesorder:order-1:inv-9-old', accountingInvoiceId: 'inv-9', amount: 120 },
    ...overrides,
  })
}

const RELIANCE_ACTION = 'xero_followup_enqueue_rests_on_operator_assertion'

test('[o3d-anu8] the reliance record is written INSIDE the enqueue, after the row it describes exists', async () => {
  reset([assertedNotPostedRow()])

  await (await loadEnqueue())('INVOICE_PAYMENT', 'SalesOrder', 'order-1', { ...REQUEST }, { from: 'postedRow', payload: POSTED_ROW_PAYLOAD })

  assert.equal(store.rows.length, 2, 'the enqueue really happened')
  const record = durableActivity.find((entry) => entry.action === RELIANCE_ACTION)
  assert.ok(record, 'and the record went through the durable writer, not the best-effort logger')
  assert.equal(record.viaTransaction, true, 'through the ENQUEUE\'s transaction client, so it rolls back with the row')
  assert.equal(record.rowsAtThisPoint, 2, 'written after the created row, so "Enqueued" is a fact when it is stated')
  assert.equal(record.level, 'WARNING')
  assert.deepEqual((record.metadata as { assertedNotPostedRowIds?: string[] }).assertedNotPostedRowIds, ['log-asserted'],
    'and it names the row to go back to')
  assert.deepEqual(activity.filter((entry) => entry.action === RELIANCE_ACTION), [],
    'the best-effort logger must no longer carry it — that is the half that could silently lose it')
})

test('[o3d-anu8] a LEDGER refusal after the plan leaves no record claiming a payment was enqueued', async () => {
  reset([assertedNotPostedRow()])
  ledgerVerdict = { clear: false, reason: 'Xero already holds a settlement of 120.00 dated 2026-08-01' }

  await (await loadEnqueue())('INVOICE_PAYMENT', 'SalesOrder', 'order-1', { ...REQUEST }, { from: 'postedRow', payload: POSTED_ROW_PAYLOAD })

  assert.equal(store.rows.length, 1, 'nothing was enqueued')
  assert.deepEqual(durableActivity.filter((entry) => entry.action === RELIANCE_ACTION), [],
    'so nothing may say one was — the refusal is the only thing that happened')
  assert.deepEqual(activity.filter((entry) => entry.action === RELIANCE_ACTION), [])
  assert.ok(activity.some((entry) => entry.action === 'xero_followup_enqueue_refused'))
})

test('[o3d-anu8] an UNFENCEABLE reuse target leaves no record either', async () => {
  // The other refusal that used to run after the record was already written. The revision-0 row is
  // the reuse candidate; the asserted row is what cleared the ambiguity that would otherwise refuse.
  reset([assertedNotPostedRow(), failedPaymentRow({ attemptRevision: 0 })])

  await (await loadEnqueue())('INVOICE_PAYMENT', 'SalesOrder', 'order-1', { ...REQUEST }, { from: 'postedRow', payload: POSTED_ROW_PAYLOAD })

  assert.equal(store.get('log-pay')?.status, 'FAILED', 'the unfenceable row is left exactly as it was')
  assert.deepEqual(scheduled, [], 'and nothing was queued')
  assert.deepEqual(durableActivity.filter((entry) => entry.action === RELIANCE_ACTION), [],
    'so the reliance record must not exist: it would describe an enqueue that was refused')
  assert.deepEqual(activity.filter((entry) => entry.action === RELIANCE_ACTION), [],
    'and it must not exist on the best-effort channel either — that is where it used to be written')
  assert.ok(activity.some((entry) => entry.metadata?.reason === 'unfenced_reuse_target'))
})

test('[o3d-anu8] a REVIVAL cleared by an assertion is recorded too, and after the revival', async () => {
  reset([assertedNotPostedRow(), failedPaymentRow()])

  await (await loadEnqueue())('INVOICE_PAYMENT', 'SalesOrder', 'order-1', { ...REQUEST }, { from: 'postedRow', payload: POSTED_ROW_PAYLOAD })

  assert.equal(store.get('log-pay')?.status, 'PENDING', 'the revival happened')
  const record = durableActivity.find((entry) => entry.action === RELIANCE_ACTION)
  assert.ok(record, 'a revived row is as much a post cleared by that assertion as a created one')
  assert.equal((record.metadata as { planAction?: string }).planAction, 'reuse')
})

test('[o3d-anu8] an unwritable record ABORTS the enqueue rather than leaving an untraceable money post', async () => {
  reset([assertedNotPostedRow()])
  failDurableActivity = true

  const enqueue = await loadEnqueue()
  await assert.rejects(
    () => enqueue('INVOICE_PAYMENT', 'SalesOrder', 'order-1', { ...REQUEST }, { from: 'postedRow', payload: POSTED_ROW_PAYLOAD }),
    /activity log unavailable/,
    'the failure must propagate — swallowing it is what let the post commit unrecorded',
  )

  assert.equal(store.rows.length, 1,
    'and the follow-up row must not survive: the record and the row commit together or neither does')
  assert.deepEqual(scheduled, [])
})

test('[o3d-anu8] a scope with NO assertion in it writes nothing — this is not a per-enqueue warning', async () => {
  reset([failedPaymentRow()])

  await (await loadEnqueue())('INVOICE_PAYMENT', 'SalesOrder', 'order-1', { ...REQUEST }, { from: 'postedRow', payload: POSTED_ROW_PAYLOAD })

  assert.equal(store.get('log-pay')?.status, 'PENDING')
  assert.deepEqual(durableActivity, [], 'an ordinary revival rests on the connector s own history')
})
