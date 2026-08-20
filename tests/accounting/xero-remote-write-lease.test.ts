import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-xl63 ROUND 5, FINDING 1 & 2 — THE CLAIM AT THE MOMENT IT IS RELIED ON.
 *
 * Round 4 re-took the claim once, in front of `processEntry`, and flagged in its own commit message
 * what that left open: "time burnt inside the processor between the re-take and each individual push
 * call is still unfenced". `processEntry` is not a POST. It reads the granted scopes, guards against a
 * cancelled order, resolves contacts and looks items up — and every one of those goes through a client
 * whose in-request budget is six minutes PER CALL. So the claim proven at the top of the entry can be
 * long gone by the time the document is actually sent.
 *
 * And at the far end the same gap existed inside the persist itself: its deadline was derived from a
 * claim believed held, but the write it then made was `update({ where: { id } })` — conditioned on
 * nothing. A claim taken in between was invisible to it, and the write would flip a row another worker
 * was posting under to SYNCED, carrying this worker's id.
 *
 * THE DOUBLE HERE HONOURS `where`, WHICH IS THE ENTIRE POINT. A double that returns a canned count
 * cannot observe a fence at all: every one of these tests would pass against completely unfenced code,
 * because the thing under test IS the WHERE clause. So `accountingSyncLog.updateMany` below evaluates
 * the predicate against real row state, and "another worker steals the row" is a real mutation of that
 * state at a chosen instant rather than a number a test asserted into existence.
 */

const CLAIM_STALE_MS = 15 * 60 * 1000

type Row = Record<string, unknown>

const state = {
  row: null as Row | null,
  posted: [] as string[],
  activity: [] as Array<{ action?: string; level?: string; description?: string; metadata?: Record<string, unknown> }>,
  mirroredEventWrites: 0,
  /** Called when processEntry reads the granted scopes — i.e. after the lease opens, before any fence. */
  onScopes: null as (null | (() => void)),
  /** Called from inside the mocked push, i.e. after the document has "reached Xero". */
  onPost: null as (null | (() => void)),
  pendingServed: false,
  outbox: {
    lockHeld: true,
    calls: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
  },
  /** Every fenced write attempted against the sync row, with whether it MATCHED. */
  syncLogWrites: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown>; count: number }>,
}

/** Evaluate one Prisma-style predicate against a value. Only the shapes this module actually uses. */
function matchValue(value: unknown, predicate: unknown): boolean {
  if (predicate === null) return value === null || value === undefined
  if (predicate instanceof Date) return value instanceof Date && value.getTime() === predicate.getTime()
  if (predicate !== null && typeof predicate === 'object') {
    const p = predicate as Record<string, unknown>
    if ('lt' in p) return value != null && Number(value) < Number(p.lt)
    if ('lte' in p) return value != null && Number(value) <= Number(p.lte)
    if ('gt' in p) return value != null && Number(value) > Number(p.gt)
    if ('gte' in p) return value != null && Number(value) >= Number(p.gte)
    if ('in' in p) return (p.in as unknown[]).includes(value)
    if ('not' in p) return value !== p.not
    throw new Error(`the double does not implement the predicate ${JSON.stringify(predicate)} — it must not GUESS`)
  }
  return value === predicate
}

function matchesWhere(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, predicate] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(predicate as Array<Record<string, unknown>>).some((clause) => matchesWhere(row, clause))) return false
      continue
    }
    if (key === 'AND') {
      if (!(predicate as Array<Record<string, unknown>>).every((clause) => matchesWhere(row, clause))) return false
      continue
    }
    if (!matchValue(row[key], predicate)) return false
  }
  return true
}

function syncLogModel(): Record<string, unknown> {
  return {
    findMany: async ({ where }: { where?: Record<string, unknown> }) => {
      if (state.pendingServed || !state.row) return []
      state.pendingServed = true
      return where && !matchesWhere(state.row, where) ? [] : [{ ...state.row }]
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const matched = !!state.row && matchesWhere(state.row, where)
      state.syncLogWrites.push({ where, data, count: matched ? 1 : 0 })
      if (!matched) return { count: 0 }
      Object.assign(state.row!, data)
      return { count: 1 }
    },
    update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (state.row && matchesWhere(state.row, where)) Object.assign(state.row, data)
      return { ...state.row }
    },
    findUnique: async ({ where }: { where: Record<string, unknown> }) =>
      (state.row && matchesWhere(state.row, where) ? { ...state.row } : null),
    findFirst: async () => null,
    count: async () => 0,
  }
}

function makeDbDouble(): Record<string, unknown> {
  const permissive = new Proxy({}, {
    get: (_target, method: string) => async () => {
      if (method === 'findMany') return []
      if (method === 'count') return 0
      if (method === 'findUnique' || method === 'findFirst') return null
      if (method === 'updateMany') return { count: 1 }
      return {}
    },
  })
  const events = new Proxy({}, {
    get: (_target, method: string) => async () => {
      if (method === 'findMany') return []
      if (method === 'findUnique' || method === 'findFirst') return null
      state.mirroredEventWrites += 1
      return method === 'updateMany' ? { count: 1 } : {}
    },
  })
  const syncLog = syncLogModel()
  const db: Record<string, unknown> = new Proxy({}, {
    get: (_target, key: string) => {
      if (key === '$transaction') {
        return async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(db) : [])
      }
      if (key === 'then') return undefined
      if (key === 'accountingSyncLog') return syncLog
      if (key === 'accountingEvent' || key === 'accountingEventLog') return events
      if (key === 'integrationOutbox') {
        return {
          updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            state.outbox.calls.push(args)
            return { count: state.outbox.lockHeld ? 1 : 0 }
          },
        }
      }
      if (key === 'salesOrder') {
        return { findUnique: async () => ({ id: 'so-1', customerId: 'cust-1', status: 'PROCESSING' }), update: async () => ({}) }
      }
      return permissive
    },
  })
  return db
}

mock.module('@/lib/db', {
  namedExports: {
    db: makeDbDouble(),
    POST_REMOTE_PERSIST_TX_OPTIONS: { maxWait: 11_000, timeout: 15_000 },
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: Record<string, unknown>) => { state.activity.push(entry) },
    logActivityPersisted: async (entry: Record<string, unknown>) => { state.activity.push(entry); return true },
  },
})
mock.module('@/lib/connectors/xero/auth', {
  namedExports: {
    getGrantedScopes: async () => { state.onScopes?.(); return null },
  },
})
mock.module('@/lib/connectors/xero/invoices', {
  namedExports: {
    pushSalesInvoice: async (data: { invoiceNumber: string }) => {
      state.posted.push(data.invoiceNumber)
      // The document has now reached Xero. Anything that happens after this line happens while the
      // ledger already holds it.
      state.onPost?.()
      return { success: true, invoiceId: 'XERO-INV-1', invoiceNumber: data.invoiceNumber }
    },
    updateSalesInvoice: async () => ({ success: true, invoiceId: 'XERO-INV-1' }),
  },
})

const processor = () => import('@/lib/connectors/xero/sync-processor')

function reset(): void {
  state.row = {
    id: 'log-1',
    connector: 'xero',
    type: 'SALES_INVOICE',
    status: 'PENDING',
    referenceType: 'SalesOrder',
    referenceId: 'so-1',
    externalTransactionId: null,
    retryCount: 0,
    errorMessage: null,
    processingStartedAt: null,
    createdAt: new Date('2026-08-20T09:00:00.000Z'),
    payload: { invoiceNumber: 'INV-1', contactName: 'A Customer', date: '2026-08-20', currency: 'GBP', lines: [] },
  }
  state.posted = []
  state.activity = []
  state.mirroredEventWrites = 0
  state.onScopes = null
  state.onPost = null
  state.pendingServed = false
  state.outbox = { lockHeld: true, calls: [] }
  state.syncLogWrites = []
  process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = 'false'
}

/** The fenced write that records the posted document, if it was attempted at all. */
function settlingWrite() {
  return state.syncLogWrites.find((w) => w.data.status === 'SYNCED' && w.data.externalTransactionId === 'XERO-INV-1')
}

/** Another worker re-claims the row: same id, a claim stamp that is not ours. */
function stealTheRow(): void {
  state.row!.status = 'PROCESSING'
  state.row!.processingStartedAt = new Date('2031-01-01T00:00:00.000Z')
}

test('r5 #1: a claim lost DURING the entry — after the lease opened, before the document was sent — posts nothing', async () => {
  reset()
  // The theft lands where round 4 could not see it: inside processEntry, between the lease opening and
  // the push. This is the scope read; in production it is any of the reads that precede a post, each of
  // which can sit out a rate limit for minutes.
  state.onScopes = stealTheRow

  const { processPendingXeroSync } = await processor()
  const result = await processPendingXeroSync()

  assert.deepEqual(state.posted, [],
    'the document must NOT be sent: the row now belongs to another worker, so this would be the second one')
  assert.equal(result.succeeded, 0)
  assert.equal(result.skipped, 1, 'handed back, not failed — nothing was sent, so no retry should be spent')
  assert.equal(result.failed, 0)

  const warning = state.activity.find((a) => a.action === 'xero_sync_claim_lost_before_post')
  assert.ok(warning, 'the lost claim is recorded, not swallowed')
  assert.match(warning.description ?? '', /posting would have created a second document/)
  assert.equal(warning.metadata?.operation, 'sales-invoice',
    'and names WHICH remote write was refused, which is the whole difference between this and round 4')
  assert.equal(warning.metadata?.reason, 'claim-lost')

  assert.equal(state.row?.status, 'PROCESSING')
  assert.deepEqual(state.row?.processingStartedAt, new Date('2031-01-01T00:00:00.000Z'),
    "and the thief's claim is left exactly as it was — nothing this worker did touched the row")
})

test('control: with the claim held throughout, the sweep posts exactly once and records it', async () => {
  reset()

  const { processPendingXeroSync } = await processor()
  const result = await processPendingXeroSync()

  assert.deepEqual(state.posted, ['INV-1'], 'the ordinary path must be untouched by the fences')
  assert.equal(result.skipped, 0, 'nothing was handed back')
  // Asserted on the WRITE rather than on `result.succeeded` or on the row's final state: the follow-up
  // enqueue that runs after the persist reaches plumbing this double does not model, and hands the row
  // back to PENDING afterwards. The property under test is that the fenced write LANDED.
  const settled = settlingWrite()
  assert.ok(settled, 'the persist must have attempted to record the document')
  assert.equal(settled.count, 1, 'and the claim fence must have MATCHED — the ordinary path is not blocked by it')
  assert.ok(settled.where.processingStartedAt instanceof Date,
    'fenced on a real claim timestamp rather than on the row id alone')
  assert.equal(settled.where.status, 'PROCESSING')
  assert.equal(state.activity.some((a) => a.action === 'xero_sync_claim_lost_before_post'), false)
  assert.equal(state.activity.some((a) => a.action === 'xero_sync_claim_lost_during_persist'), false)
})

test('r5 #2: a claim taken WHILE the document was in flight cannot be recorded over the top of it', async () => {
  reset()
  // The narrowest window there is, and the one no pre-check can close: the claim is taken after the
  // persist's deadline was derived and before its write lands. Round 4's zero-deadline refusal cannot
  // see this — the arithmetic still says the claim is healthy.
  state.onPost = stealTheRow

  const { processPendingXeroSync } = await processor()
  const result = await processPendingXeroSync()

  assert.deepEqual(state.posted, ['INV-1'], 'the document DID reach Xero — that is the premise of this test')
  assert.equal(result.failed, 1, 'and the row is reported as not recorded')
  assert.equal(result.succeeded, 0)

  const settled = settlingWrite()
  assert.ok(settled,
    'the persist must have been ATTEMPTED — otherwise this test proves nothing about the fence, only that '
      + 'the code took some other branch')
  assert.equal(settled.count, 0, 'and the claim fence must have matched NO row, which is what stopped it')
  assert.equal(settled.where.status, 'PROCESSING')
  assert.ok(settled.where.processingStartedAt instanceof Date,
    "the WHERE carries this worker's claim: an `update({ where: { id } })` could not have refused at all")

  assert.equal(state.row?.status, 'PROCESSING',
    'the row must NOT be flipped to SYNCED: it belongs to another worker, which is at this moment posting under it')
  assert.deepEqual(state.row?.processingStartedAt, new Date('2031-01-01T00:00:00.000Z'),
    "the persist must not have overwritten the other worker's claim")
  assert.equal(state.row?.externalTransactionId, null,
    "and must not have stamped THIS worker's document id onto the other worker's row")
  assert.equal(state.mirroredEventWrites, 0,
    'the fence throws before the mirrored event, so the transaction rolls back whole rather than half-recording')

  const alarm = state.activity.find((a) => a.action === 'xero_sync_claim_lost_during_persist')
  assert.ok(alarm, 'a document is in Xero that no row names — that is an ERROR, not a warning')
  assert.equal(alarm.level, 'ERROR')
  assert.equal(alarm.metadata?.externalId, 'XERO-INV-1',
    'the id is the only evidence that survives, so it has to be IN the record')
  assert.match(alarm.description ?? '', /CHECK XERO/)
  assert.match(alarm.description ?? '', /SECOND time/,
    'and says plainly what may already have happened, rather than reporting a generic persistence fault')
})

test('r5 #1: the absolute lease deadline covers the preparation calls and is NOT extended by a renewal', async () => {
  reset()
  const { openRemoteWriteLease, XERO_ENTRY_LEASE_MS } = await processor()

  // Claim the row as the sweep would, so the lease has something to renew.
  const claimedAt = new Date('2026-08-20T10:00:00.000Z')
  state.row!.status = 'PROCESSING'
  state.row!.processingStartedAt = claimedAt

  let clock = 0
  const lease = await openRemoteWriteLease('log-1', claimedAt, undefined, () => clock)
  assert.ok(lease, 'the claim was ours, so the lease opened')
  assert.equal(lease.deadlineAt, XERO_ENTRY_LEASE_MS, 'fixed from the moment the entry started')

  // A renewal mid-entry: the claim moves, the deadline does not.
  clock = XERO_ENTRY_LEASE_MS - 1
  const early = await lease.fenceBeforeRemoteWrite('sales-invoice')
  assert.equal(early.ok, true, 'one millisecond inside the lease, the write may still begin')
  assert.equal(lease.deadlineAt, XERO_ENTRY_LEASE_MS,
    'and renewing the CLAIM must not renew the LEASE — otherwise a row wedged behind a rate limit '
      + 'renews itself for ever and never posts')

  const heldAfterRenewal = lease.heldFrom()
  clock = XERO_ENTRY_LEASE_MS
  const late = await lease.fenceBeforeRemoteWrite('sales-invoice')
  assert.equal(late.ok, false,
    'ON the deadline the remote write must not begin — the lease is spent, and a renewal that reset it '
      + 'would let one entry hold the row for ever without ever posting')
  assert.equal(late.ok === false && late.result.notPosted?.reason, 'lease-expired',
    'and it is the LEASE that refused, not a lost claim: the claim here is still ours')
  assert.match(late.ok === false ? late.result.error ?? '' : '', /preparation calls included/)
  assert.deepEqual(lease.heldFrom(), heldAfterRenewal,
    'and an expired lease does not extend its own claim on the way to refusing — the deadline is '
      + 'checked BEFORE the renewal')
})

test('r5 #1: the fence renews the OUTBOX lock too, and refuses without touching the row claim when it is gone', async () => {
  reset()
  const { openRemoteWriteLease } = await processor()

  const claimedAt = new Date('2026-08-20T10:00:00.000Z')
  state.row!.status = 'PROCESSING'
  state.row!.processingStartedAt = claimedAt

  const outboxRows = state.outbox.calls

  const lockedAt = new Date('2026-08-20T10:00:00.000Z')
  const job = { id: 'job-1', lockedAt, attempts: 0 } as unknown as Parameters<typeof openRemoteWriteLease>[2]

  const lease = await openRemoteWriteLease('log-1', claimedAt, job)
  assert.ok(lease)

  const ok = await lease.fenceBeforeRemoteWrite('sales-invoice')
  assert.equal(ok.ok, true)
  assert.equal(outboxRows.length, 1, 'the fence renews the queue-side lock as well as the row claim')
  assert.equal(outboxRows[0].where.id, 'job-1')
  assert.deepEqual(outboxRows[0].where.lockedAt, lockedAt,
    'fenced on the EXACT lock this worker holds — anything looser would renew a lock somebody else took')
  assert.ok((job as { lockedAt: Date }).lockedAt.getTime() > lockedAt.getTime(),
    "and advances the caller's copy, or every markXeroOutbox* helper would fence on a lockedAt that no longer exists")

  // Now the queue side is taken. The refusal must come BEFORE the row claim is renewed, so the two
  // never disagree about who holds this work.
  state.outbox.lockHeld = false
  const heldBefore = lease.heldFrom()
  const lost = await lease.fenceBeforeRemoteWrite('sales-invoice')
  assert.equal(lost.ok, false)
  assert.equal(lost.ok === false && lost.result.notPosted?.reason, 'claim-lost')
  assert.match(lost.ok === false ? lost.result.error ?? '' : '', /lock on outbox job job-1/)
  assert.deepEqual(lease.heldFrom(), heldBefore,
    'the row claim is left exactly as it was: the outbox lock is checked first for precisely this reason')
})
