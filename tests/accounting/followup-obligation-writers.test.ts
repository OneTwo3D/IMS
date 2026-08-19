import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// o3d-9kek Codex r10 finding 1 — the NORMAL Xero writer must claim the follow-up obligation.
//
// r9 introduced `backReferenceFollowUpsPendingAt` as the durable record of "the link is written, the
// follow-ups are not" and wired it into the repair SWEEP. The sweep is the repair route; the
// connector is where nearly every row actually goes, and it did not claim anything. So the exact
// window the column exists to close was still open on the primary path:
//
//   1. the row is marked SYNCED with its external id (committed),
//   2. the back-reference is written,
//   3. the process dies before enqueueFollowUps runs.
//
// Afterwards that row is SYNCED, linked, and marker-null — indistinguishable from one that
// completed. The outbox loop skips SYNCED rows outright, and the sweep computes owesFollowUps=false,
// calls it reconciled and stamps backReferenceCheckedAt. The payment, PDF or attachment is gone and
// nothing ever says so.
//
// These tests drive the REAL processPendingXeroSync — both the direct loop and the outbox loop —
// down the already-posted branch, so nothing has to simulate an HTTP post, and assert the two
// properties that make the marker worth having:
//
//   • it is claimed BEFORE the link is written (in fact in the same transaction as the SYNCED
//     transition, so there is no interval at all), and
//   • it is released ONLY once the follow-ups have actually been enqueued.
// ---------------------------------------------------------------------------

type SyncRow = {
  id: string
  connector: string
  type: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  status: string
  payload: Record<string, unknown>
  retryCount: number
  processingStartedAt: Date | null
  syncedAt: Date | null
  errorMessage: string | null
  createdAt: Date
  backReferenceCheckedAt: Date | null
  backReferenceFollowUpsPendingAt: Date | null
  /**
   * o3d-0m56 r10: the two columns the money-attempt repair reads. `attemptStampingCustodyAt` is
   * written by every production create path, so a row this codebase made carries it and the repair
   * passes it over; a row left without it is one a binary outside stamping custody wrote.
   */
  remoteAttemptedAt?: Date | null
  attemptStampingCustodyAt?: Date | null
}

type BillRow = { id: string; accountingInvoiceId: string | null }

const SYNC_COLUMNS = new Set([
  'id', 'connector', 'type', 'referenceType', 'referenceId', 'externalTransactionId', 'status',
  'payload', 'retryCount', 'processingStartedAt', 'syncedAt', 'errorMessage', 'createdAt',
  'backReferenceCheckedAt', 'backReferenceFollowUpsPendingAt',
])

/**
 * A where-clause interpreter that THROWS on a column it does not know, rather than matching
 * everything. A double that silently ignores a predicate turns "the compound where prevents a stale
 * double-write" into an assertion about nothing.
 */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(condition as Array<Record<string, unknown>>).some((clause) => matches(row, clause))) return false
      continue
    }
    if (key === 'AND') {
      if (!(condition as Array<Record<string, unknown>>).every((clause) => matches(row, clause))) return false
      continue
    }
    if (!SYNC_COLUMNS.has(key)) throw new Error(`fake db: unknown column "${key}" in where clause`)
    const value = row[key] ?? null
    if (condition === null) {
      if (value !== null) return false
      continue
    }
    if (typeof condition === 'object' && !(condition instanceof Date)) {
      const ops = condition as Record<string, unknown>
      for (const [op, operand] of Object.entries(ops)) {
        const left = value instanceof Date ? value.getTime() : value
        const right = operand instanceof Date ? operand.getTime() : operand
        if (op === 'in') { if (!(operand as unknown[]).includes(value)) return false; continue }
        if (op === 'not') { if (operand === null ? value === null : left === right) return false; continue }
        if (op === 'lt') { if (!((left as number) < (right as number))) return false; continue }
        if (op === 'lte') { if (!((left as number) <= (right as number))) return false; continue }
        if (op === 'gt') { if (!((left as number) > (right as number))) return false; continue }
        if (op === 'gte') { if (!((left as number) >= (right as number))) return false; continue }
        throw new Error(`fake db: unsupported operator "${op}"`)
      }
      continue
    }
    const left = value instanceof Date ? value.getTime() : value
    const right = condition instanceof Date ? condition.getTime() : condition
    if (left !== right) return false
  }
  return true
}

/**
 * Every write, in order, each carrying a SNAPSHOT of the sync row's obligation marker taken at the
 * instant the write happened. Ordering is the whole property under test — "the marker ends up set"
 * is true of a marker written afterwards too, and that is the version this finding rejected.
 */
type Journal = Array<{ op: string; markerAtThisPoint: Date | null; data?: Record<string, unknown> }>

const state = {
  syncRows: [] as SyncRow[],
  bills: [] as BillRow[],
  journal: [] as Journal,
  activities: [] as Array<{ action: string; level?: string; description?: string }>,
  outbox: [] as Array<Record<string, unknown>>,
  /** Sync-log ids whose follow-up enqueue must fail (a transient database error inside it). */
  failFollowUpsFor: new Set<string>(),
  /** Sync-log ids whose obligation RELEASE must fail. */
  failReleaseFor: new Set<string>(),
}

function marker(): Date | null {
  return state.syncRows[0]?.backReferenceFollowUpsPendingAt ?? null
}

function record(op: string, data?: Record<string, unknown>) {
  state.journal.push({ op, markerAtThisPoint: marker(), data })
}

const syncLogClient = {
  async findMany(args: { where: Record<string, unknown> }) {
    return state.syncRows.filter((row) => matches(row, args.where)).map((row) => ({ ...row }))
  },
  async findUnique(args: { where: { id: string } }) {
    const row = state.syncRows.find((candidate) => candidate.id === args.where.id)
    return row ? { ...row } : null
  },
  async count(args: { where: Record<string, unknown> }) {
    // Scoped to the per-reference lookup (hasExistingSyncLog, the first thing the follow-up enqueue
    // does) so the failure is a realistic transient database error INSIDE enqueueFollowUps rather
    // than a stubbed-out throw — and so it does not also break the run's unrelated tail count.
    if ('referenceId' in args.where && state.failFollowUpsFor.has(state.syncRows[0]?.id ?? '')) {
      record('followups.attempted-and-failed')
      throw new Error('transient: follow-up lookup failed')
    }
    return state.syncRows.filter((row) => matches(row, args.where)).length
  },
  async create(args: { data: Record<string, unknown> }) {
    const row = {
      ...blankRow(),
      ...args.data,
      id: `followup-${state.syncRows.length}`,
    } as SyncRow
    state.syncRows.push(row)
    record('followup.created', { type: String(args.data.type) })
    return { ...row }
  },
  async update(args: { where: { id: string }; data: Record<string, unknown> }) {
    const row = state.syncRows.find((candidate) => candidate.id === args.where.id)
    if (!row) throw new Error(`fake db: no sync row ${args.where.id}`)
    if (args.data.backReferenceFollowUpsPendingAt === null && state.failReleaseFor.has(row.id)) {
      record('release.attempted-and-failed')
      throw new Error('transient: could not clear the obligation')
    }
    Object.assign(row, args.data)
    record('syncLog.update', args.data)
    return { ...row }
  },
  async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
    const matched = state.syncRows.filter((row) => matches(row, args.where))
    for (const row of matched) Object.assign(row, args.data)
    record('syncLog.updateMany', args.data)
    return { count: matched.length }
  },
}

const billClient = {
  async findUnique(args: { where: { id: string } }) {
    const bill = state.bills.find((candidate) => candidate.id === args.where.id)
    return bill ? { accountingInvoiceId: bill.accountingInvoiceId } : null
  },
  async update(args: { where: { id: string }; data: Record<string, unknown> }) {
    const bill = state.bills.find((candidate) => candidate.id === args.where.id)
    if (!bill) throw new Error(`fake db: no bill ${args.where.id}`)
    Object.assign(bill, args.data)
    // THE MOMENT THAT MATTERS: the document is now linked. Whatever the marker reads here is what
    // a process death one instruction later would leave behind for ever.
    record('backReference.written', args.data)
    return bill
  },
  async updateMany() { return { count: 0 } },
}

const outboxClient = {
  async create(args: { data: Record<string, unknown> }) {
    const row = { ...args.data, id: `outbox-${state.outbox.length}`, lockedAt: null, lockedBy: null }
    state.outbox.push(row)
    return row
  },
  async findUnique(args: { where: Record<string, unknown> }) {
    return state.outbox.find((row) => row.idempotencyKey === (args.where as { idempotencyKey?: string }).idempotencyKey
      || row.id === (args.where as { id?: string }).id) ?? null
  },
  async findMany() { return state.outbox.filter((row) => row.status === 'PENDING') },
  async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
    const target = state.outbox.filter((row) => row.id === (args.where as { id?: string }).id)
    for (const row of target) Object.assign(row, args.data)
    return { count: target.length }
  },
}

const MONEY_TYPES = new Set(['INVOICE_PAYMENT', 'BILL_PAYMENT', 'PURCHASE_CREDIT_NOTE_ALLOCATION'])

/**
 * o3d-0m56 r10: a sync run REPAIRS money rows outside attempt-stamping custody before it claims
 * anything, and that repair is raw SQL.
 *
 * The double applies the rule rather than returning a convenient 0. Returning 0 would be a double
 * that cannot tell the difference between "no row needed repairing" and "the repair no longer
 * matches anything", and the rows in this file are created through the production enqueue path, so
 * they carry custody and the repair correctly leaves them alone.
 */
function repairOutsideCustody(): number {
  const matched = state.syncRows.filter((row) => row.remoteAttemptedAt == null
    && row.attemptStampingCustodyAt == null
    && MONEY_TYPES.has(String(row.type)))
  for (const row of matched) {
    row.remoteAttemptedAt = row.syncedAt ?? row.processingStartedAt ?? row.createdAt
  }
  return matched.length
}

const db = {
  accountingSyncLog: syncLogClient,
  async $executeRaw() { return repairOutsideCustody() },
  purchaseInvoice: billClient,
  salesOrder: { async findUnique() { return null }, async update() { return {} } },
  salesOrderRefund: { async findUnique() { return null }, async update() { return {} } },
  supplierCreditNote: { async findUnique() { return null }, async update() { return {} } },
  integrationOutbox: outboxClient,
  async $transaction(fn: (tx: unknown) => Promise<unknown>) {
    return fn(db)
  },
}

mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string }) => { state.activities.push(entry) },
    logActivityPersisted: async (entry: { action: string }) => { state.activities.push(entry); return true },
  },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: { updateMirroredAccountingEventStatus: async () => {} },
})
// The FRESH-POST branch — the one the finding named by line — needs a connector call to succeed.
// Only these two are stubbed, so everything between "the ledger accepted it" and "the follow-ups are
// enqueued" is the real production code.
mock.module('@/lib/connectors/xero/auth', {
  namedExports: { getGrantedScopes: async () => null },
})
mock.module('@/lib/connectors/xero/bills', {
  namedExports: {
    pushPurchaseBill: async () => ({ success: true, invoiceId: 'XBILL-1', invoiceNumber: 'BILL-001' }),
    updatePurchaseBill: async () => ({ success: true, invoiceId: 'XBILL-1' }),
  },
})
mock.module('@/lib/connectors/quickbooks/bills', {
  namedExports: {
    pushPurchaseBill: async () => ({ success: true, invoiceId: 'XBILL-1' }),
  },
})

let connectorUnderTest = 'xero'

function blankRow(): SyncRow {
  return {
    id: 'log-1',
    connector: connectorUnderTest,
    type: 'PURCHASE_INVOICE',
    referenceType: 'PurchaseInvoice',
    referenceId: 'bill-1',
    externalTransactionId: 'XBILL-1',
    status: 'PENDING',
    // supplierInvoicePath is what makes the bill-attachment follow-up real work rather than an
    // early return, so "the follow-ups ran" is observable as a created row.
    payload: { supplierInvoicePath: 'uploads/bill-1.pdf' },
    retryCount: 0,
    processingStartedAt: null,
    syncedAt: null,
    errorMessage: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    backReferenceCheckedAt: null,
    backReferenceFollowUpsPendingAt: null,
  }
}

function reset(connector = 'xero') {
  connectorUnderTest = connector
  state.syncRows = [blankRow()]
  state.bills = [{ id: 'bill-1', accountingInvoiceId: null }]
  state.journal = []
  state.activities = []
  state.outbox = []
  state.failFollowUpsFor.clear()
  state.failReleaseFor.clear()
}

/** The single sync row under test (the follow-up rows the run creates are appended after it). */
function subject(): SyncRow {
  return state.syncRows[0]
}

/**
 * The outbox job for the SUBJECT row, or undefined. Which loop ran is otherwise invisible — both
 * report `succeeded: 1` — and an outbox assertion that silently passed on the direct loop would be
 * an assertion about nothing. (Follow-up enqueues schedule their OWN outbox jobs on both paths, so
 * this has to be keyed on the subject's id rather than on the table being non-empty.)
 */
function subjectOutboxJob() {
  return state.outbox.find((row) => String(row.idempotencyKey).includes('log-1'))
}

function journalOps(): string[] {
  return state.journal.map((entry) => entry.op)
}

function firstJournalEntry(op: string) {
  const entry = state.journal.find((candidate) => candidate.op === op)
  assert.ok(entry, `expected a "${op}" write; saw ${JSON.stringify(journalOps())}`)
  return entry
}

async function runDirect() {
  process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = 'false'
  const { processPendingXeroSync } = await import('@/lib/connectors/xero/sync-processor')
  return processPendingXeroSync()
}

async function runViaOutbox() {
  process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = 'true'
  const { processPendingXeroSync } = await import('@/lib/connectors/xero/sync-processor')
  return processPendingXeroSync()
}

test('[o3d-9kek r10 f1] the direct Xero writer claims the follow-up obligation IN the SYNCED write', async () => {
  reset()

  const result = await runDirect()

  assert.equal(result.succeeded, 1)
  assert.equal(subjectOutboxJob(), undefined, 'this is the DIRECT loop — no outbox job for the subject row')
  // The claim is not a call of its own: it rides the update that flips the row to SYNCED, so there
  // is no interval — not even one statement wide — in which the row is SYNCED with an external id
  // and silent about what it still owes.
  const synced = state.journal.find((entry) => entry.op === 'syncLog.update' && entry.data?.status === 'SYNCED')
  assert.ok(synced, 'the row must be marked SYNCED')
  assert.ok(
    synced.data?.backReferenceFollowUpsPendingAt instanceof Date,
    'the obligation must be claimed in the SAME write as the SYNCED transition, not in a later one',
  )

  // …and it was already durable at the instant the document became linked. This is the assertion
  // the pre-fix code fails: it wrote the link with the marker still null.
  assert.ok(
    firstJournalEntry('backReference.written').markerAtThisPoint instanceof Date,
    'the link must never be written while nothing records that follow-ups are outstanding',
  )
  assert.equal(state.bills[0].accountingInvoiceId, 'XBILL-1')
})

test('[o3d-9kek r10 f1] the direct Xero writer releases it only after the follow-ups are enqueued', async () => {
  reset()

  await runDirect()

  const ops = journalOps()
  const linked = ops.indexOf('backReference.written')
  const enqueued = ops.indexOf('followup.created')
  const released = ops.lastIndexOf('syncLog.update')
  assert.ok(enqueued > linked, 'the follow-ups are enqueued after the link')
  assert.ok(released > enqueued, 'and the obligation is discharged only after that')
  assert.equal(
    state.journal[released].data?.backReferenceFollowUpsPendingAt,
    null,
    'the release is what clears the marker',
  )
  assert.equal(subject().backReferenceFollowUpsPendingAt, null, 'nothing is owed once the work is queued')
  // The follow-up itself, so "released" cannot be passing because nothing ran at all.
  assert.equal(state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length, 1)
})

test('[o3d-9kek r10 f1] a failed Xero follow-up enqueue leaves the obligation CLAIMED', async () => {
  reset()
  state.failFollowUpsFor.add('log-1')

  const result = await runDirect()

  assert.equal(result.failed, 1)
  assert.equal(state.bills[0].accountingInvoiceId, 'XBILL-1', 'the link half succeeded')
  assert.equal(state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length, 0, 'the follow-up half did not')
  assert.ok(
    subject().backReferenceFollowUpsPendingAt instanceof Date,
    'so the row must still say it owes them — this is the state the repair sweep reads',
  )
  // The existing retry bookkeeping is untouched: back to PENDING with the attempt counted.
  assert.equal(subject().status, 'PENDING')
  assert.equal(subject().retryCount, 1)
})

test('[o3d-9kek r10 f1] a release that fails does not fail the entry, and leaves the work recorded as owed', async () => {
  reset()
  state.failReleaseFor.add('log-1')

  const result = await runDirect()

  // The post happened, the link happened, the follow-ups were enqueued. A marker that would not
  // clear is not a reason to drive any of that again — the caller's follow-up-failure path would
  // re-post work that succeeded.
  assert.equal(result.succeeded, 1)
  assert.equal(result.failed, 0)
  assert.equal(state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length, 1)
  assert.ok(journalOps().includes('release.attempted-and-failed'))
  // Left claimed, which is the SAFE direction: the next sweep finds a linked row that still says it
  // owes follow-ups and re-enqueues them idempotently. Noise, not loss.
  assert.ok(subject().backReferenceFollowUpsPendingAt instanceof Date)
  assert.equal(subject().status, 'SYNCED', 'and the row is not dragged out of SYNCED, which would let it post twice')
})

test('[o3d-9kek r10 f1] the OUTBOX Xero writer claims and releases it the same way', async () => {
  // The line the finding named. This is the loop production actually runs (the flag defaults on),
  // and it is also the loop that skips a SYNCED row outright on the next pass — so a crash here
  // left nothing behind that any later run would look at.
  reset()

  const result = await runViaOutbox()

  assert.equal(result.succeeded, 1, 'the outbox loop must have processed the row, not skipped it')
  assert.equal(subjectOutboxJob()?.status, 'SUCCEEDED', 'and it really went through the outbox, not the direct loop')
  const synced = state.journal.find((entry) => entry.op === 'syncLog.update' && entry.data?.status === 'SYNCED')
  assert.ok(synced?.data?.backReferenceFollowUpsPendingAt instanceof Date, 'claimed in the SYNCED write')
  assert.ok(
    firstJournalEntry('backReference.written').markerAtThisPoint instanceof Date,
    'and durable before the link is written',
  )
  assert.equal(state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length, 1)
  assert.equal(subject().backReferenceFollowUpsPendingAt, null, 'released once the follow-ups are enqueued')
})

test('[o3d-9kek r10 f1] a failed follow-up enqueue on the OUTBOX path leaves the obligation claimed too', async () => {
  reset()
  state.failFollowUpsFor.add('log-1')

  const result = await runViaOutbox()

  assert.equal(result.failed, 1)
  assert.ok(subjectOutboxJob(), 'the outbox loop is the one under test here')
  assert.equal(state.bills[0].accountingInvoiceId, 'XBILL-1')
  assert.ok(subject().backReferenceFollowUpsPendingAt instanceof Date)
})

// ---------------------------------------------------------------------------
// THE FRESH-POST BRANCH — sync-processor.ts:1071-1074, the exact lines the finding cited.
//
// The tests above drive the already-posted branch, which is the same shape but not the same code.
// This is the branch nearly every document takes the FIRST time: the external id does not exist yet,
// it is written by the very transaction that flips the row to SYNCED, and the follow-ups run after
// it. So the claim has to ride that same transaction — the id and the record of what it owes become
// durable together or not at all.
// ---------------------------------------------------------------------------

/** No externalTransactionId, so processEntry posts and the SYNCED write is what records the id. */
function freshRow(): SyncRow {
  return { ...blankRow(), externalTransactionId: null }
}

test('[o3d-9kek r10 f1] a FRESHLY POSTED Xero row claims the obligation in the write that records its external id', async () => {
  reset()
  state.syncRows = [freshRow()]

  const result = await runDirect()

  assert.equal(result.succeeded, 1)
  const synced = state.journal.find((entry) => entry.op === 'syncLog.update' && entry.data?.status === 'SYNCED')
  assert.ok(synced, 'the row must be marked SYNCED')
  assert.equal(synced.data?.externalTransactionId, 'XBILL-1', 'this is the write that records the id')
  assert.ok(
    synced.data?.backReferenceFollowUpsPendingAt instanceof Date,
    'so it is also the write that must record the obligation — there is no safe interval between them',
  )
  assert.ok(firstJournalEntry('backReference.written').markerAtThisPoint instanceof Date)
  assert.equal(subject().backReferenceFollowUpsPendingAt, null, 'released once the follow-ups are enqueued')
  assert.equal(state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length, 1)
})

test('[o3d-9kek r10 f1] the same holds on the OUTBOX fresh-post branch', async () => {
  reset()
  state.syncRows = [freshRow()]

  const result = await runViaOutbox()

  assert.equal(result.succeeded, 1)
  assert.equal(subjectOutboxJob()?.status, 'SUCCEEDED', 'the outbox loop, not the direct one')
  const synced = state.journal.find((entry) => entry.op === 'syncLog.update' && entry.data?.status === 'SYNCED')
  assert.equal(synced?.data?.externalTransactionId, 'XBILL-1')
  assert.ok(synced?.data?.backReferenceFollowUpsPendingAt instanceof Date)
  assert.ok(firstJournalEntry('backReference.written').markerAtThisPoint instanceof Date)
  assert.equal(subject().backReferenceFollowUpsPendingAt, null)
})

test('[o3d-9kek r10 f1] a fresh post whose follow-ups fail keeps the obligation, and never re-posts', async () => {
  reset()
  state.syncRows = [freshRow()]
  state.failFollowUpsFor.add('log-1')

  const result = await runDirect()

  assert.equal(result.failed, 1)
  assert.equal(subject().externalTransactionId, 'XBILL-1', 'the id is durable, which is what stops a second post')
  assert.equal(state.bills[0].accountingInvoiceId, 'XBILL-1')
  assert.equal(state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length, 0)
  assert.ok(
    subject().backReferenceFollowUpsPendingAt instanceof Date,
    'and the outstanding follow-ups are recorded as outstanding',
  )
})

// ---------------------------------------------------------------------------
// QUICKBOOKS — the same obligation, claimed the same way.
//
// Three rounds running, a fix landed in one connector and the identical hole survived in the other,
// so these are deliberately the Xero tests again against the other writer rather than a lighter
// version of them. QuickBooks is the secondary connector for FEATURES; a known silent-loss window
// is not a feature, and leaving it open on one side while closing it on the other would be a
// difference nobody chose.
//
// What is genuinely different, and stays different: the QuickBooks repair SWEEP is still unwired
// (o3d-s36z, realm isolation, is its precondition — see the block at the end of its sync-processor).
// Recording the obligation and repairing it are separate acts, and only the second is what that
// issue gates: the marker is a timestamp on the sync row and crosses no realm boundary. It has to
// be written at the moment it is true, because afterwards the state is unrecoverable — which is the
// same reason there is no backfill for rows written before the column existed.
// ---------------------------------------------------------------------------

async function runQuickBooks() {
  const { processPendingQuickBooksSync } = await import('@/lib/connectors/quickbooks/sync-processor')
  return processPendingQuickBooksSync()
}

test('[o3d-9kek r10 f1] the QuickBooks writer claims the obligation IN the SYNCED write too', async () => {
  reset('quickbooks')

  const result = await runQuickBooks()

  assert.equal(result.succeeded, 1)
  const synced = state.journal.find((entry) => entry.op === 'syncLog.update' && entry.data?.status === 'SYNCED')
  assert.ok(synced, 'the row must be marked SYNCED')
  assert.ok(
    synced.data?.backReferenceFollowUpsPendingAt instanceof Date,
    'claimed in the SAME write as the SYNCED transition, exactly as Xero does',
  )
  assert.ok(
    firstJournalEntry('backReference.written').markerAtThisPoint instanceof Date,
    'the link is never written while nothing records that follow-ups are outstanding',
  )
  assert.equal(state.bills[0].accountingInvoiceId, 'XBILL-1')
  assert.equal(state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length, 1)
  assert.equal(subject().backReferenceFollowUpsPendingAt, null, 'and released once the follow-ups are enqueued')
})

test('[o3d-9kek r10 f1] a FRESHLY POSTED QuickBooks row claims it in the write that records its external id', async () => {
  reset('quickbooks')
  state.syncRows = [{ ...blankRow(), externalTransactionId: null }]

  const result = await runQuickBooks()

  assert.equal(result.succeeded, 1)
  const synced = state.journal.find((entry) => entry.op === 'syncLog.update' && entry.data?.status === 'SYNCED')
  assert.equal(synced?.data?.externalTransactionId, 'XBILL-1')
  assert.ok(synced?.data?.backReferenceFollowUpsPendingAt instanceof Date)
  assert.ok(firstJournalEntry('backReference.written').markerAtThisPoint instanceof Date)
  assert.equal(subject().backReferenceFollowUpsPendingAt, null, 'released once the follow-ups are enqueued')
})

test('[o3d-9kek r10 f1] a QuickBooks fresh post whose follow-ups fail keeps the obligation, and is still counted succeeded', async () => {
  // QuickBooks SWALLOWS a follow-up failure here — it logs an ERROR and marks the entry succeeded,
  // so the row ends up looking exactly like one that completed. That is precisely why the marker
  // must not be released on this path: it is the only remaining evidence the work is owed.
  reset('quickbooks')
  state.syncRows = [{ ...blankRow(), externalTransactionId: null }]
  state.failFollowUpsFor.add('log-1')

  const result = await runQuickBooks()

  assert.equal(result.succeeded, 1, 'QuickBooks does not fail the entry for this')
  assert.ok(state.activities.some((entry) => entry.action === 'quickbooks_followup_error'), 'it reports it instead')
  assert.equal(state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length, 0)
  assert.ok(
    subject().backReferenceFollowUpsPendingAt instanceof Date,
    'and the row still says it owes follow-ups — nothing else about it does',
  )
  assert.equal(subject().status, 'SYNCED')
})

test('[o3d-9kek r10 f1] a failed QuickBooks follow-up enqueue leaves the obligation CLAIMED', async () => {
  // This branch has no catch of its own: the throw reaches the loop's outer handler, which counts a
  // failure and schedules a retry. Either way the marker must survive — it is the only thing left
  // that distinguishes this row from one whose follow-ups ran, and with the QuickBooks sweep
  // unwired it is also the state that makes the work recoverable the day o3d-s36z lands.
  reset('quickbooks')
  state.failFollowUpsFor.add('log-1')

  const result = await runQuickBooks()

  assert.equal(result.failed, 1)
  assert.equal(state.bills[0].accountingInvoiceId, 'XBILL-1', 'the link half succeeded')
  assert.equal(state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length, 0, 'the follow-up half did not')
  assert.ok(subject().backReferenceFollowUpsPendingAt instanceof Date)
  assert.equal(subject().retryCount, 1)
})
