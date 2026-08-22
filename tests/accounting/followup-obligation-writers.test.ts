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
  /** o3d-e2mz: the per-attempt identity the claim compare-and-swaps on and every write fences on. */
  attemptRevision: number
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
  /**
   * o3d-nepa r3: when data retention compacted this row to an attribution-only tombstone. NULL =
   * the payload is intact. The double carries it because it is the ONLY thing that distinguishes a
   * row whose follow-ups can still be rebuilt from one whose body was thrown away — `payload: {}`
   * looks identical either way, which is exactly why the loss was silent.
   */
  backReferenceEvidenceCompactedAt: Date | null
}

type BillRow = { id: string; accountingInvoiceId: string | null }

const SYNC_COLUMNS = new Set([
  'id', 'connector', 'type', 'referenceType', 'referenceId', 'externalTransactionId', 'status',
  'payload', 'retryCount', 'processingStartedAt', 'syncedAt', 'errorMessage', 'createdAt',
  'backReferenceCheckedAt', 'backReferenceFollowUpsPendingAt', 'backReferenceEvidenceCompactedAt',
  // o3d-e2mz: the per-attempt identity every processor write is now fenced on. Listed here rather
  // than tolerated, because this matcher's whole contract is to throw on a predicate it cannot
  // honour — silently ignoring the fence would turn these assertions into assertions about nothing.
  'attemptRevision',
  // o3d-0m56 r10 / o3d-anu8 r3: the two columns that together decide whether a NULL attempt stamp
  // is evidence. The claim statement reads BOTH, so a double that could not see them would let a
  // laundering claim through and report a pass.
  'remoteAttemptedAt', 'attemptStampingCustodyAt',
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
    // o3d-anu8 r3: `NOT` is a real Prisma operator and the claim/custody statement now uses one —
    // `stampingCustodyOnClaim` refuses to restore custody to a money row that carries neither
    // custody nor an attempt stamp. Interpreting it (rather than ignoring it, or throwing) is what
    // makes these doubles evaluate the predicate production evaluates.
    if (key === 'NOT') {
      if (matches(row, condition as Record<string, unknown>)) return false
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
type Journal = Array<{ op: string; markerAtThisPoint: Date | null; data?: Record<string, unknown>; where?: Record<string, unknown> }>

const state = {
  syncRows: [] as SyncRow[],
  bills: [] as BillRow[],
  journal: [] as Journal,
  // o3d-bqw7: `metadata` is CAPTURED, not dropped. The discard warning now carries what was
  // actually lost as data rather than only as prose, and a double that swallowed the field would
  // make "the warning names the right follow-up" unassertable while looking asserted.
  activities: [] as Array<{ action: string; level?: string; description?: string; metadata?: Record<string, unknown> }>,
  outbox: [] as Array<Record<string, unknown>>,
  /** Sync-log ids whose follow-up enqueue must fail (a transient database error inside it). */
  failFollowUpsFor: new Set<string>(),
  /** Sync-log ids whose obligation RELEASE must fail. */
  failReleaseFor: new Set<string>(),
  /**
   * Activity actions whose PERSISTED write must report failure (o3d-nepa r3). `logActivityPersisted`
   * returns false rather than throwing when the row cannot be written, and a double that always
   * returned true could not tell a warning that landed from one that did not — which is the whole
   * of the "settle only if the announcement is on record" property.
   */
  unpersistableActivityActions: new Set<string>(),
  /** Every write to the mirrored AccountingEvent, in order. See the mirror mock below. */
  mirror: [] as Array<{ syncLogId: string; status: string; externalId: string | null }>,
}

function marker(): Date | null {
  return state.syncRows[0]?.backReferenceFollowUpsPendingAt ?? null
}

function record(op: string, data?: Record<string, unknown>, where?: Record<string, unknown>) {
  state.journal.push({ op, markerAtThisPoint: marker(), data, where })
}

const syncLogClient = {
  async findMany(args: { where: Record<string, unknown> }) {
    // THE INJECTION POINT MOVED WITH THE CODE (o3d-m5qk / o3d-hbgo). `hasExistingSyncLog` — the first
    // thing the follow-up enqueue does — used to be a `count`, and this failure was injected there.
    // It is now a `findMany`, because the live-row check has to read each row's PAYLOAD to compare the
    // external document the follow-up targets; a per-reference COUNT cannot answer that. Left on
    // `count`, the injection stopped firing and three tests passed while asserting nothing.
    if ('referenceId' in args.where && state.failFollowUpsFor.has(state.syncRows[0]?.id ?? '')) {
      record('followups.attempted-and-failed')
      throw new Error('transient: follow-up lookup failed')
    }
    return state.syncRows.filter((row) => matches(row, args.where)).map((row) => ({ ...row }))
  },
  async findUnique(args: { where: { id: string } }) {
    const row = state.syncRows.find((candidate) => candidate.id === args.where.id)
    return row ? { ...row } : null
  },
  async count(args: { where: Record<string, unknown> }) {
    // Kept honest but no longer the injection point — see findMany above. It stays scoped-free so the
    // run's unrelated tail count is unaffected.
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
    // The WHERE is journalled too (o3d-xl63 r5 #2): the fresh-post SYNCED write is claim-FENCED now,
    // and a journal that recorded only `data` could not tell a fenced write from an unfenced one.
    record('syncLog.updateMany', args.data, args.where)
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
  // o3d-19gy: the processor asks which accounting connection is live before it posts anything, and
  // stamps the same answer onto every follow-up payload it queues. A double with no token row is a
  // DISCONNECTED instance, which is a different scenario from the one these tests are about.
  accountingToken: { async findUnique() { return { tenantId: 'tenant-A' } } },
  // The outbox runner reads the filed unrecorded-posted-document incidents once per batch, before it
  // decides anything about a settled row (Codex r3, HIGH). Nothing in this file files one, so the
  // honest answer is "none" — not a missing model.
  activityLog: { async findMany() { return [] }, async create(args: { data: unknown }) { return args.data } },
  purchaseInvoice: billClient,
  salesOrder: { async findUnique() { return null }, async update() { return {} } },
  salesOrderRefund: { async findUnique() { return null }, async update() { return {} } },
  supplierCreditNote: { async findUnique() { return null }, async update() { return {} } },
  integrationOutbox: outboxClient,
  async $transaction(fn: (tx: unknown) => Promise<unknown>) {
    return fn(db)
  },
  // TWO raw statements reach this double now, and it must tell them apart (o3d-clxw + o3d-0m56 r10).
  // A single member that assumed either one would silently serve the other: both are
  // `UPDATE accounting_sync_logs`, so the loose regex below is not enough on its own to discriminate.
  //
  //  • o3d-0m56 r10 — the attempt-stamping custody REPAIR, run once at the top of the processor
  //    before anything is claimed. Recognised by the column it sets.
  //  • o3d-clxw r4 — the SYNCED write stamping `syncedAt` from the DATABASE's clock rather than this
  //    host's, in the same transaction, so the payment poller's reversal fence compares two readings
  //    of one clock instead of two machines' wall clocks.
  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = strings.join('?')
    if (/"remoteAttemptedAt" = COALESCE/.test(sql)) return repairOutsideCustody()
    if (!/UPDATE accounting_sync_logs/.test(sql)) throw new Error(`fake db: unexpected raw statement ${sql}`)
    const row = state.syncRows.find((candidate) => candidate.id === values[0])
    if (row) row.syncedAt = new Date()
    return 1
  },
}

mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string }) => { state.activities.push(entry) },
    logActivityPersisted: async (entry: { action: string }) => {
      state.activities.push(entry)
      return !state.unpersistableActivityActions.has(entry.action)
    },
  },
})
// RECORDED, not swallowed (Codex round 2, HIGH). The mirrored AccountingEvent is the ledger's own
// copy of what IMS believes it posted, and the whole finding is that a follow-up failure on the
// already-posted arm could stamp it FAILED for a document that is in QuickBooks. A no-op double
// cannot see that, which is how the port shipped with it.
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: {
    updateMirroredAccountingEventStatus: async (_client: unknown, params: { syncLogId: string; status: string; externalId?: string | null }) => {
      state.mirror.push({ syncLogId: params.syncLogId, status: params.status, externalId: params.externalId ?? null })
    },
  },
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

/**
 * o3d-peh1 — THE LEDGER FENCE'S VERDICT, SWITCHABLE, SO A REFUSAL CAN BE DRIVEN THROUGH THE REAL LOOP.
 *
 * `enqueueFollowUpSyncLog` asks the ledger whether the attempt it is about to queue is already in it,
 * on BOTH connectors and for every follow-up, and a "no" is returned to the caller as a REFUSAL —
 * `{ enqueued: false }` — rather than thrown. That return value is the thing under test: a refusal
 * and a success differ only in what the caller does with them, which is why nothing simulated can
 * stand in for the caller here.
 *
 * CLEAR by default, so every other test in this file is untouched. `postMoneyUnderLedgerFence` and
 * the two probe helpers are re-exported as pass-throughs because `mock.module` replaces the whole
 * module and both processors import them at load time.
 */
let ledgerVerdict: { clear: true } | { clear: false; reason: string } = { clear: true }

mock.module('@/lib/connectors/accounting-settlement-probe', {
  namedExports: {
    ledgerClearsFollowUpRevival: async () => ledgerVerdict,
    postMoneyUnderLedgerFence: async (_params: unknown, run: () => Promise<unknown>) => run(),
    probeLedgerSettlement: async () => ({ ok: true, records: [] }),
    settlementProbeKey: () => 'probe-key',
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
    // o3d-e2mz: an unclaimed row starts at 0 — the claim compare-and-swaps on the value it read and
    // writes one higher. A double that omitted it would answer `undefined` to the claim's predicate,
    // no row would ever be claimed, and every assertion below would be about a run that did nothing.
    attemptRevision: 0,
    processingStartedAt: null,
    syncedAt: null,
    errorMessage: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    backReferenceCheckedAt: null,
    backReferenceFollowUpsPendingAt: null,
    backReferenceEvidenceCompactedAt: null,
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
  state.unpersistableActivityActions.clear()
  state.mirror.length = 0
  ledgerVerdict = { clear: true }
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
  // o3d-550x: the SYNCED transition is an updateMany now — its where carries the "do not overwrite a
  // DIFFERENT document" precondition, which Prisma's unique-where update cannot express. The property
  // this file is about is unchanged: the obligation is claimed in the SAME write.
  const synced = state.journal.find((entry) => entry.op === 'syncLog.updateMany' && entry.data?.status === 'SYNCED')
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
  // o3d-550x: the SYNCED transition is an updateMany now — its where carries the "do not overwrite a
  // DIFFERENT document" precondition, which Prisma's unique-where update cannot express. The property
  // this file is about is unchanged: the obligation is claimed in the SAME write.
  const synced = state.journal.find((entry) => entry.op === 'syncLog.updateMany' && entry.data?.status === 'SYNCED')
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
// o3d-nepa r3 — A RETRY OVER A COMPACTED ROW MUST NOT DISCHARGE THE OBLIGATION IN SILENCE.
//
// Data retention compacts an expired-but-unresolved sync row to an attribution-only tombstone: the
// columns the back-reference write needs survive, and `payload` — which is what the FOLLOW-UPS are
// built from — becomes `{}`. Handed `{}` the enqueue takes no branch, enqueues nothing and returns
// NORMALLY, so the short-circuit below read it as success and released
// `backReferenceFollowUpsPendingAt`: the last record that a payment, PDF or attachment was still
// owed. A bulk "Retry all" over old failures therefore destroyed the evidence of its own loss.
//
// The repair sweep had announced exactly this since o3d-9kek r4. The processors — the path an
// operator actually triggers — did not. These tests are that announcement, on both loops, plus the
// asymmetry that makes it worth having: the obligation is released only once the warning LANDED.
//
// A tombstone is seeded with an empty payload, because that is what compaction leaves; the
// BILL_ATTACHMENT follow-up therefore cannot be built, and its absence is asserted so the warning
// is about a real loss rather than a decoration.
// ---------------------------------------------------------------------------

const DISCARD_ACTION = 'xero_backreference_followups_discarded'

function compactedRow(): SyncRow {
  return {
    ...blankRow(),
    status: 'PENDING',
    payload: {},
    backReferenceEvidenceCompactedAt: new Date('2026-01-05T00:00:00Z'),
  }
}

function discardWarning() {
  return state.activities.find((entry) => entry.action === DISCARD_ACTION)
}

test('[o3d-nepa r3] retrying a COMPACTED row announces the follow-ups it can no longer rebuild', async () => {
  reset()
  state.syncRows = [compactedRow()]

  const result = await runDirect()

  assert.equal(result.succeeded, 1, 'the row still settles — the document really did post')
  // The loss is real: nothing was enqueued, because there is nothing left to enqueue it from.
  assert.equal(
    state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length,
    0,
    'the attachment follow-up could not be rebuilt from an emptied payload',
  )
  const warning = discardWarning()
  assert.ok(warning, `expected the discard warning; saw ${JSON.stringify(state.activities.map((entry) => entry.action))}`)
  assert.equal(warning.level, 'WARNING')
  assert.match(String(warning.description), /had already posted, so this retry settled the sync row without re-sending it/)
  assert.match(String(warning.description), /its payload was compacted away/)
  assert.match(String(warning.description), /XBILL-1/, 'names the external id the operator has to go and look at')
  assert.match(String(warning.description), /re-drive it manually/)
  // Settled only because the warning landed.
  assert.equal(subject().backReferenceFollowUpsPendingAt, null)
  assert.equal(subject().status, 'SYNCED')
})

test('[o3d-nepa r3] the OUTBOX loop announces it too — that is the loop production runs', async () => {
  reset()
  state.syncRows = [compactedRow()]

  const result = await runViaOutbox()

  assert.equal(result.succeeded, 1)
  assert.equal(subjectOutboxJob()?.status, 'SUCCEEDED', 'the outbox loop, not the direct one')
  assert.ok(discardWarning(), 'the same warning, from the loop that handles nearly every row')
  assert.equal(state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length, 0)
  assert.equal(subject().backReferenceFollowUpsPendingAt, null)
})

test('[o3d-nepa r3] a discard warning that could NOT be written leaves the obligation claimed', async () => {
  // The asymmetry the sweep already applies: repeating a warning is noise, losing it is silence —
  // and this loss cannot be undone by a later run, so settling past a failed write would destroy the
  // work and the notice in one step. The row goes back to PENDING still owing its follow-ups, so
  // the next pass (or the repair sweep) gets another chance to say so.
  reset()
  state.syncRows = [compactedRow()]
  state.unpersistableActivityActions.add(DISCARD_ACTION)

  const result = await runDirect()

  assert.equal(result.failed, 1, 'an unannounceable loss is not a success')
  assert.ok(
    subject().backReferenceFollowUpsPendingAt instanceof Date,
    'the obligation survives — it is the only remaining trace that the payment or attachment is owed',
  )
  assert.equal(subject().status, 'PENDING')
  assert.equal(subject().retryCount, 1)
  assert.match(
    String(subject().errorMessage),
    /compacted/,
    'and the row says why it did not settle, rather than reporting a generic follow-up failure',
  )
})

// ---------------------------------------------------------------------------
// o3d-bqw7 + o3d-kemx — THE STAMP IS BROADER THAN THE LOSS, AND THE FALSE HALF HOLDS WORK.
//
// r3/r4 warned whenever the compaction stamp was set. The stamp says "the payload was thrown away";
// the warning claims "its outstanding follow-ups can no longer be enqueued". A `CREDIT_NOTE` row is
// a back-reference type, so retention DOES compact it — and neither connector's `enqueueFollowUps`
// has a `CREDIT_NOTE` branch, so it has never owed a follow-up of any kind. Every one of those rows
// was warned about, about nothing.
//
// The second half is o3d-kemx and it is not noise. The announcement GATES THE RELEASE, so a warning
// that is false AND unwritable holds an already-posted row at PENDING and re-drives it on every
// pass. These two tests are deliberately written as the ABSENCE of a warning and the PRESENCE of a
// settle — asserting that a warning appeared is what the old behaviour would also pass.
// ---------------------------------------------------------------------------

/**
 * A sales CREDIT_NOTE tombstone: compacted by retention (it is in BACK_REFERENCE_SWEEP_TYPES), and
 * owed nothing that the payload was carrying. The PURCHASE_INVOICE tombstone above is its opposite
 * and stays the control — if the narrowing were wrong in the other direction that test goes red.
 */
function compactedCreditNoteRow(): SyncRow {
  return {
    ...blankRow(),
    type: 'CREDIT_NOTE',
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    externalTransactionId: 'XCN-1',
    status: 'PENDING',
    payload: {},
    backReferenceEvidenceCompactedAt: new Date('2026-01-05T00:00:00Z'),
  }
}

test('[o3d-bqw7] a tombstone whose type owes NO payload-built follow-up is not warned about', async () => {
  reset()
  state.syncRows = [compactedCreditNoteRow()]

  const result = await runDirect()

  assert.equal(result.succeeded, 1)
  assert.equal(
    discardWarning(),
    undefined,
    'nothing was discarded: CREDIT_NOTE has no branch in enqueueFollowUps, so the payload was carrying no work',
  )
  assert.equal(subject().status, 'SYNCED')
  assert.equal(subject().backReferenceFollowUpsPendingAt, null, 'and the obligation is discharged, because it was met')
})

test('[o3d-kemx] a FALSE discard warning that cannot be written must not hold an already-posted row', async () => {
  // The stranding, exactly. The row lost nothing, so there is nothing to announce — and with the
  // announcement narrowed the failing activity log is never consulted. Before the narrowing this
  // row went back to PENDING with the obligation still claimed, every pass, for as long as the log
  // kept failing: a posted document held open by a warning about a loss that never happened.
  reset()
  state.syncRows = [compactedCreditNoteRow()]
  state.unpersistableActivityActions.add(DISCARD_ACTION)

  const result = await runDirect()

  assert.equal(result.failed, 0, 'an unwritable warning about nothing is not a reason to fail the row')
  assert.equal(result.succeeded, 1)
  assert.equal(subject().status, 'SYNCED', 'the document posted and the row says so')
  assert.equal(subject().retryCount, 0, 'and it was not re-driven')
  assert.equal(
    subject().backReferenceFollowUpsPendingAt,
    null,
    'the obligation is released: it was discharged by an enqueue that correctly had nothing to do',
  )
})

test('[o3d-bqw7] a REAL discard still warns, and names what was discarded rather than the whole menu', async () => {
  // The control for both tests above, and the assertion that the narrowing did not merely delete
  // the alarm. A PURCHASE_INVOICE tombstone loses its supplier-invoice attachment — the path is
  // gone with the payload — so the warning must fire AND must say which follow-up that is. The old
  // wording listed "invoice PDF, payment registration or bill attachment" on every row, including
  // the two of the three this row could never have owed.
  reset()
  state.syncRows = [compactedRow()]

  await runDirect()

  const warning = discardWarning()
  assert.ok(warning, 'a real loss is still announced')
  assert.match(String(warning.description), /the supplier invoice attachment can no longer be enqueued/)
  assert.equal(
    /invoice PDF/.test(String(warning.description)),
    false,
    'a PURCHASE_INVOICE never owed a PDF follow-up; naming one sends the operator looking for work that never existed',
  )
  assert.deepEqual(warning.metadata?.discardedFollowUps, ['the supplier invoice attachment'])
})

test('[o3d-bqw7] a SALES_INVOICE tombstone is warned about its PAYMENT, and told the PDF survived', async () => {
  // The mixed case. Both halves are load-bearing: the payment is gated on `payload._registerPayment`
  // and is genuinely gone, while the INVOICE_PDF is built from externalTransactionId + referenceId
  // and is enqueued on this very pass. A warning that named the PDF as lost would be contradicted
  // by the row sitting in the queue next to it.
  reset()
  state.syncRows = [compactedSalesInvoiceRow()]

  await runDirect()

  const warning = discardWarning()
  assert.ok(warning, 'the payment registration really is unrecoverable')
  assert.match(String(warning.description), /the payment registration can no longer be enqueued/)
  assert.match(String(warning.description), /The invoice PDF is built from columns compaction keeps/)
  assert.equal(pdfFollowUps().length, 1, 'and it was in fact enqueued, which is why it must not be reported as lost')
})

test('[o3d-nepa r3] an INTACT row is not warned about — the check is the stamp, not an empty payload', async () => {
  // A row whose type carries no body has `payload: {}` too. Warning on emptiness would fire on
  // every one of them and train the operator to ignore the line that matters, so the tombstone
  // STAMP is what decides.
  reset()
  state.syncRows = [{ ...blankRow(), payload: {} }]

  const result = await runDirect()

  assert.equal(result.succeeded, 1)
  assert.equal(discardWarning(), undefined, 'an empty payload is not the same fact as a compacted one')
  assert.equal(subject().backReferenceFollowUpsPendingAt, null)
})

// ---------------------------------------------------------------------------
// o3d-nepa r4 (Codex finding 1) — AN UNWRITABLE WARNING MUST NOT WITHHOLD THE WORK THAT SURVIVED.
//
// r3 announced the loss BEFORE calling the enqueue and threw when the announcement could not be
// written. But r3's own stated reason for still calling the enqueue on a tombstone is that SOME
// follow-ups are rebuilt from columns compaction KEEPS: a SALES_INVOICE tombstone still carries its
// external id and its referenceId, which is everything the INVOICE_PDF follow-up is built from. With
// the announcement first, a failed activity-log write stopped that enqueue from ever running — so
// the refusal to settle the row, which exists to protect the follow-ups, was withholding the very
// follow-ups it could still deliver, and the retry meets the same unwritable log next pass.
//
// The enqueue now runs first. What the announcement gates is the RELEASE, which is the property r3
// was actually defending.
// ---------------------------------------------------------------------------

/**
 * A tombstone whose follow-up SURVIVES compaction. `enqueueSalesInvoiceFollowUps` builds the
 * INVOICE_PDF row from `externalTransactionId` and `referenceId` alone — no payload — while the
 * payment follow-up it also owns is gated on `payload._registerPayment` and is genuinely lost. That
 * mixture is the case the finding is about; the PURCHASE_INVOICE tombstone above loses everything,
 * so it could never have shown the difference.
 */
function compactedSalesInvoiceRow(): SyncRow {
  return {
    ...blankRow(),
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    externalTransactionId: 'XINV-1',
    status: 'PENDING',
    payload: {},
    backReferenceEvidenceCompactedAt: new Date('2026-01-05T00:00:00Z'),
  }
}

function pdfFollowUps(): SyncRow[] {
  return state.syncRows.filter((row) => row.type === 'INVOICE_PDF')
}

test('[o3d-nepa r4] a compacted row still gets the follow-ups compaction did not destroy', async () => {
  // The baseline, so the test below is about the WARNING failing rather than about this row having
  // no rebuildable follow-up in the first place.
  reset()
  state.syncRows = [compactedSalesInvoiceRow()]

  const result = await runDirect()

  assert.equal(result.succeeded, 1)
  assert.equal(pdfFollowUps().length, 1, 'the PDF follow-up is built from columns the tombstone keeps')
  assert.ok(discardWarning(), 'and the loss of the payload-built ones is still announced')
  assert.equal(subject().backReferenceFollowUpsPendingAt, null, 'the warning landed, so the obligation is discharged')
})

test('[o3d-nepa r4] and it gets them even when the loss warning cannot be written down', async () => {
  // THE DEFECT. Under r3 this run enqueued NOTHING: the announcement threw before the enqueue was
  // reached, so the PDF that was perfectly rebuildable was withheld — every pass, for as long as the
  // activity write kept failing.
  reset()
  state.syncRows = [compactedSalesInvoiceRow()]
  state.unpersistableActivityActions.add(DISCARD_ACTION)

  const result = await runDirect()

  assert.equal(pdfFollowUps().length, 1, 'the rebuildable follow-up is released regardless of the log write')
  // AND the property r3 was defending is untouched: an unannounced loss does not settle.
  assert.equal(result.failed, 1)
  assert.ok(
    subject().backReferenceFollowUpsPendingAt instanceof Date,
    'the obligation still survives, so a later pass announces what was lost',
  )
  assert.equal(subject().status, 'PENDING')
  assert.match(String(subject().errorMessage), /compacted/)
})

test('[o3d-nepa r4] the OUTBOX loop releases the surviving follow-ups on an unwritable warning too', async () => {
  // Both short-circuit sites carry the same ordering; a fix applied to one loop is not a fix.
  reset()
  state.syncRows = [compactedSalesInvoiceRow()]
  state.unpersistableActivityActions.add(DISCARD_ACTION)

  const result = await runViaOutbox()

  assert.equal(subjectOutboxJob()?.status !== 'SUCCEEDED', true, 'the job is not completed on an unannounced loss')
  assert.equal(pdfFollowUps().length, 1)
  assert.equal(result.failed, 1)
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
  // o3d-550x: the SYNCED transition is an updateMany now — its where carries the "do not overwrite a
  // DIFFERENT document" precondition, which Prisma's unique-where update cannot express. The property
  // this file is about is unchanged: the obligation is claimed in the SAME write.
  const synced = state.journal.find((entry) => entry.op === 'syncLog.updateMany' && entry.data?.status === 'SYNCED')
  assert.ok(synced, 'the row must be marked SYNCED')
  // o3d-xl63 r5 #2 ASSERTED `synced.where.status === 'PROCESSING'` here — the settling write fenced
  // on this worker's claim. SUPERSEDED by #639, and deliberately not restated: o3d-550x considered
  // claim-fencing this exact write and rejected it, because a displaced worker that DID post must
  // still be able to record its document id or the document sits in Xero with nothing naming it.
  // The hazard that assertion named — "an update keyed on the row id alone would settle a row
  // another worker had taken" — is closed by a DIFFERENT precondition, which is what is asserted
  // instead: the write refuses to overwrite a row that already names another document. That is a
  // real precondition on the WHERE, so the concern it was raised against is still covered.
  assert.ok(
    Array.isArray((synced.where as { OR?: unknown[] } | undefined)?.OR),
    'the settling write must still carry a precondition — the "do not overwrite a DIFFERENT document" '
      + 'OR-clause — rather than being keyed on the row id alone',
  )
  // The other half of the same superseded r5 #2 assertion (the claim INSTANT in the WHERE). Not
  // restated, for the reason above; what this test exists to prove — the id and the obligation ride
  // ONE write — is asserted immediately below and is untouched by any of it.
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
  // o3d-550x: the SYNCED transition is an updateMany now — its where carries the "do not overwrite a
  // DIFFERENT document" precondition, which Prisma's unique-where update cannot express. The property
  // this file is about is unchanged: the obligation is claimed in the SAME write.
  //
  // o3d-xl63 r5 #2 ASSERTED `synced.where.status === 'PROCESSING'` here — that the settling write is
  // also fenced on this worker's claim. That assertion is SUPERSEDED by #639 and is deliberately not
  // restated: o3d-550x considered claim-fencing this exact write and rejected it in as many words,
  // because a displaced worker that DID post must still be able to record its document id or the
  // document exists in Xero with nothing in IMS naming it. The window r5 #2 was closing is closed
  // instead by the precondition above — the row must not already name a DIFFERENT document — which
  // refuses the same overwrite without discarding the evidence. See the note on the r5 #2 test in
  // tests/accounting/xero-remote-write-lease.test.ts.
  const synced = state.journal.find((entry) => entry.op === 'syncLog.updateMany' && entry.data?.status === 'SYNCED')
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
  // QuickBooks is unchanged by o3d-550x (out of scope), so its SYNCED transition is still `update`.
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
  // QuickBooks is unchanged by o3d-550x (out of scope), so its SYNCED transition is still `update`.
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
  // The branch catches this itself now (Codex round 2, HIGH) and routes it to the follow-up-only
  // retry transition instead of the main-post failure handler. The counted failure and the retry are
  // unchanged, which is why this test reads exactly as it did; what changed is only that the
  // transition no longer contradicts the ledger — pinned by the two tests at the end of this file.
  // Either way the marker must survive: it is the only thing left that distinguishes this row from
  // one whose follow-ups ran, and with the QuickBooks sweep unwired it is also the state that makes
  // the work recoverable the day o3d-s36z lands.
  reset('quickbooks')
  state.failFollowUpsFor.add('log-1')

  const result = await runQuickBooks()

  assert.equal(result.failed, 1)
  assert.equal(state.bills[0].accountingInvoiceId, 'XBILL-1', 'the link half succeeded')
  assert.equal(state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length, 0, 'the follow-up half did not')
  assert.ok(subject().backReferenceFollowUpsPendingAt instanceof Date)
  assert.equal(subject().retryCount, 1)
})

// ---------------------------------------------------------------------------
// o3d-peh1, CROSS-PORTED — A REFUSED FOLLOW-UP ENQUEUE MUST NOT REPORT THE PARENT AS SETTLED.
//
// `requireFollowUpsEnqueued` exists on both connectors: the enqueue can decline (the planner cannot
// tell which of several attempts committed, or the ledger fence says the settlement is already in
// it) and it says so by RETURNING `{ enqueued: false }`. The guard turns that into a throw so the
// obligation release below it cannot run.
//
// On QuickBooks the throw landed in a catch that treats every follow-up exception as best-effort:
// it logged an ERROR and fell through to `result.succeeded++`. So the parent was SYNCED, counted
// synced, and the money-moving child had never been queued — the o3d-peh1 defect exactly, surviving
// on the connector whose caller was not changed. The QuickBooks repair sweep is still unwired
// (o3d-s36z), so nothing else was going to come back for it either.
//
// These run the REAL processPendingQuickBooksSync down the fresh-post branch — the branch the
// finding names — so what is asserted is the caller's behaviour, not a re-description of the guard.
// A passing Xero test proves nothing here: the two callers are separate code.
// ---------------------------------------------------------------------------

test('[o3d-peh1] a REFUSED QuickBooks follow-up enqueue does not count the entry as succeeded', async () => {
  reset('quickbooks')
  state.syncRows = [{ ...blankRow(), externalTransactionId: null }]
  ledgerVerdict = { clear: false, reason: 'a settlement matching this attempt is already in QuickBooks' }

  const result = await runQuickBooks()

  assert.equal(result.succeeded, 0, 'nothing was queued, so nothing about this entry is finished')
  assert.equal(result.failed, 1)
  assert.equal(
    state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length,
    0,
    'the refusal is real: no follow-up row exists',
  )
  assert.ok(
    state.activities.some((entry) => entry.action === 'quickbooks_followup_enqueue_refused'),
    'and it is on record as a refusal, not as a generic failure',
  )
})

test('[o3d-peh1] the refused parent goes back to UNSETTLED, keeping its external id and its obligation', async () => {
  reset('quickbooks')
  state.syncRows = [{ ...blankRow(), externalTransactionId: null }]
  ledgerVerdict = { clear: false, reason: 'a settlement matching this attempt is already in QuickBooks' }

  await runQuickBooks()

  assert.equal(subject().status, 'PENDING', 'the row is owed work again, so it must be claimable again')
  assert.equal(subject().retryCount, 1, 'and bounded by the same retry budget as every other failure')
  assert.equal(subject().processingStartedAt, null, 'the claim is given up — nothing is in flight')
  // THE TWO FACTS THE REVERSAL MUST NOT DESTROY.
  assert.equal(
    subject().externalTransactionId,
    'XBILL-1',
    'the external id is POST EVIDENCE — it is the only local record the bill is in QuickBooks, and it is '
    + 'what makes the retry take the idempotency short-circuit instead of posting a second document',
  )
  assert.ok(
    subject().backReferenceFollowUpsPendingAt instanceof Date,
    'the obligation is still owed; the release runs only on the arm where the enqueue actually happened',
  )
  assert.equal(state.bills[0].accountingInvoiceId, 'XBILL-1', 'the back-reference half succeeded and stands')
})

test('[o3d-peh1] a refused entry re-runs into the short-circuit and never posts a second document', async () => {
  reset('quickbooks')
  state.syncRows = [{ ...blankRow(), externalTransactionId: null }]
  ledgerVerdict = { clear: false, reason: 'a settlement matching this attempt is already in QuickBooks' }

  await runQuickBooks()
  // The ambiguity clears — an operator reconciled the ledger — and the next cron pass picks the row
  // up again. THIS is what "unsettled" has to mean: recoverable without a second post.
  ledgerVerdict = { clear: true }
  const second = await runQuickBooks()

  assert.equal(second.succeeded, 1, 'the retry settles it')
  assert.equal(subject().status, 'SYNCED')
  assert.equal(
    state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length,
    1,
    'the follow-up the refusal withheld is queued exactly once',
  )
  assert.equal(subject().backReferenceFollowUpsPendingAt, null, 'and only now is the obligation released')
})

test('[o3d-peh1] a plain follow-up FAILURE is still best-effort — the port did not widen', async () => {
  // The catch has to tell a refusal from a transient error, and this is the case it must leave alone.
  // A failed enqueue is retryable work the obligation marker records; QuickBooks deliberately does
  // not fail the entry for it (the test above this block pins that), and changing it here would be a
  // second change wearing this one's clothes.
  reset('quickbooks')
  state.syncRows = [{ ...blankRow(), externalTransactionId: null }]
  state.failFollowUpsFor.add('log-1')

  const result = await runQuickBooks()

  assert.equal(result.succeeded, 1)
  assert.equal(result.failed, 0)
  assert.equal(subject().status, 'SYNCED')
  assert.equal(subject().retryCount, 0)
  assert.ok(subject().backReferenceFollowUpsPendingAt instanceof Date)
})

// ---------------------------------------------------------------------------
// CODEX ROUND 2, HIGH — THE FINAL REFUSAL MUST NOT RECORD A LIVE DOCUMENT AS A FAILED POST.
//
// Round 1 closed o3d-peh1 by preserving `externalTransactionId` across a refusal. That is what puts
// the row into the ALREADY-POSTED short-circuit on its next pass, and the short-circuit does two
// things before it touches the follow-ups: it writes the row SYNCED and it writes the mirrored
// AccountingEvent POSTED. Then the follow-up refusal threw — into the loop's MAIN-POST failure
// handler, whose terminal arm stamps that same mirrored event FAILED.
//
// So the row round 1 saved from being reported settled ended up reported as a FAILED POST of a
// document that is in QuickBooks. Round 1's own note on `markSyncLogForFollowUpRetry` says why that
// is the wrong write — "this document POSTED, the mirror already says so, and overwriting it would
// make the ledger's own copy of the record contradict the ledger" — and that transition is now the
// one both posted arms use.
//
// THESE DRIVE THE QUICKBOOKS LOOP, from a row that ALREADY CARRIES AN EXTERNAL ID, all the way to
// the final retry. The Xero twin has had its own catch since o3d-nepa and passes either way, so only
// the QuickBooks path can show this.
// ---------------------------------------------------------------------------

/** MAX_RETRIES on the QuickBooks processor. The fifth pass is the one that terminalises the row. */
const QBO_MAX_RETRIES = 5

function mirrorFailures() {
  return state.mirror.filter((entry) => entry.status === 'FAILED')
}

test('[o3d-peh1 r2] a REFUSED follow-up on an already-posted QuickBooks row never records it as a failed post', async () => {
  reset('quickbooks')
  // blankRow() already carries XBILL-1, which is what sends this row down the short-circuit — the
  // starting condition the finding names.
  ledgerVerdict = { clear: false, reason: 'a settlement matching this attempt is already in QuickBooks' }

  for (let pass = 0; pass < QBO_MAX_RETRIES; pass += 1) await runQuickBooks()

  assert.equal(subject().retryCount, QBO_MAX_RETRIES, 'the row really was driven to its last retry')
  assert.equal(subject().status, 'FAILED', 'and the retry budget is still bounded — that part is unchanged')
  assert.deepEqual(
    mirrorFailures(),
    [],
    'but the DOCUMENT is in QuickBooks, and nothing may write the mirrored event FAILED for it',
  )
  assert.ok(state.mirror.length > 0, 'the mirror was written — POSTED — so the assertion above is about real writes')
  assert.deepEqual(
    [...new Set(state.mirror.map((entry) => entry.status))],
    ['POSTED'],
    'every mirrored write for this row says POSTED, which is what the ledger holds',
  )
  assert.equal(subject().externalTransactionId, 'XBILL-1', 'post evidence survives the terminal transition')
  assert.ok(
    subject().backReferenceFollowUpsPendingAt instanceof Date,
    'and so does the obligation: the follow-ups were never enqueued',
  )
  assert.equal(
    state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length,
    0,
    'the refusal was real throughout — nothing was ever queued',
  )
})

test('[o3d-peh1 r2] a PLAIN follow-up failure on the already-posted arm is recorded the same way', async () => {
  // The catch on this arm is deliberately catch-all. A plain failure here was never best-effort —
  // it already counted FAILED through the outer handler — so the only thing that changes is which
  // transition writes it, and a mirror stamped FAILED is just as untrue for a transient error as
  // for a refusal. (The FRESH-POST arm's narrow `instanceof` catch is a different rule and is
  // pinned separately, above.)
  reset('quickbooks')
  state.failFollowUpsFor.add('log-1')

  for (let pass = 0; pass < QBO_MAX_RETRIES; pass += 1) await runQuickBooks()

  assert.equal(subject().status, 'FAILED')
  assert.deepEqual(mirrorFailures(), [], 'the bill is in QuickBooks; a FAILED mirror would deny it')
  assert.equal(subject().externalTransactionId, 'XBILL-1')
  assert.ok(subject().backReferenceFollowUpsPendingAt instanceof Date)
  assert.ok(
    state.activities.some((entry) => entry.action === 'quickbooks_followup_error'),
    'and it is reported, so the outstanding work is visible rather than merely recorded',
  )
})

test('[o3d-peh1 r2] the already-posted arm still settles normally once the refusal clears', async () => {
  // The control: the catch must not turn a recoverable row into a permanently failed one. Same row,
  // same short-circuit, refusal lifted before the budget runs out.
  reset('quickbooks')
  ledgerVerdict = { clear: false, reason: 'a settlement matching this attempt is already in QuickBooks' }

  await runQuickBooks()
  ledgerVerdict = { clear: true }
  const second = await runQuickBooks()

  assert.equal(second.succeeded, 1)
  assert.equal(subject().status, 'SYNCED')
  assert.equal(subject().backReferenceFollowUpsPendingAt, null, 'the obligation is discharged only now')
  assert.equal(state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length, 1)
  assert.deepEqual(mirrorFailures(), [])
})
