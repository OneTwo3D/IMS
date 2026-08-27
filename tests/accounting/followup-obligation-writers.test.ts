import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { nextFollowUpObligationGeneration } from '@/lib/domain/accounting/back-reference'
import { buildFollowUpObligationBacklogWhere } from '@/lib/domain/accounting/follow-up-obligation-registry'

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
   * o3d-0bfh r4: fired ONCE, immediately before the release statement is evaluated — the exact
   * interleaving the finding is about. Production has by then minted its generation, run the
   * follow-ups and built a release fenced on that generation; this is where another writer's commit
   * lands. Given the row so it can advance the marker the way a sweep would.
   */
  raceBeforeRelease: null as ((row: SyncRow) => void) | null,
  /**
   * Activity actions whose PERSISTED write must report failure (o3d-nepa r3). `logActivityPersisted`
   * returns false rather than throwing when the row cannot be written, and a double that always
   * returned true could not tell a warning that landed from one that did not — which is the whole
   * of the "settle only if the announcement is on record" property.
   */
  unpersistableActivityActions: new Set<string>(),
  /**
   * o3d-0bfh r6: the back-reference WRITE fails (not a unique-id conflict — an ordinary transient
   * error). QuickBooks swallows that, so the entry still succeeds while the link never landed, which
   * is the path that reaches settleFollowUpObligation's RETAINED branch.
   */
  failBackReferenceWrite: false,
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
    Object.assign(row, args.data)
    record('syncLog.update', args.data)
    return { ...row }
  },
  async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
    // THE RELEASE IS AN updateMany SINCE o3d-0bfh r4, fenced on the generation the caller minted —
    // which is what moved both of these hooks off `update`. The race fires BEFORE the predicate is
    // evaluated, so the row it sees is the row production's fence will be tested against.
    if (args.data.backReferenceFollowUpsPendingAt === null) {
      const subjectRow = state.syncRows[0]
      if (subjectRow && state.raceBeforeRelease) {
        const race = state.raceBeforeRelease
        state.raceBeforeRelease = null
        race(subjectRow)
      }
      if (subjectRow && state.failReleaseFor.has(subjectRow.id)) {
        record('release.attempted-and-failed')
        throw new Error('transient: could not clear the obligation')
      }
    }
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
    if (state.failBackReferenceWrite) {
      record('backReference.attempted-and-failed')
      throw new Error('transient: could not write the back-reference')
    }
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
  state.raceBeforeRelease = null
  state.unpersistableActivityActions.clear()
  state.failBackReferenceWrite = false
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

/**
 * THE OBLIGATION IS CLAIMED WITH THE SYNCED TRANSITION, AND THE CLAIM IS A COMPARE-AND-SET
 * (o3d-9kek r10 f1, restated at o3d-0bfh r4 Codex HIGH).
 *
 * r10 asserted the claim rode the SYNCED statement's `data`. r4 had to move it OUT of that statement
 * — a `data` fragment cannot read, and a claim that cannot read the generation it replaces cannot
 * report the one it minted, so its release could only clear by id, which is the defect. It is now the
 * NEXT statement in the same transaction, and this asserts the strictly stronger property r10 was
 * reaching for:
 *
 *   • the claim is the very next write to the sync row after the SYNCED transition — no other write
 *     is interleaved, so there is no state anyone can observe in which the row is SYNCED-with-an-id
 *     and silent about what it owes (they commit together in any case);
 *   • and it is a COMPARE-AND-SET on the generation it observed, not a write by id. A claim by id
 *     would pass every other assertion in this file and take a generation that is not exclusive.
 */
function assertObligationClaimedWithTheSyncedWrite(syncedOp: 'syncLog.update' | 'syncLog.updateMany') {
  const syncedIndex = state.journal.findIndex((entry) => entry.op === syncedOp && entry.data?.status === 'SYNCED')
  assert.ok(syncedIndex >= 0, `expected a "${syncedOp}" marking the row SYNCED; saw ${JSON.stringify(journalOps())}`)
  const nextWrite = state.journal.findIndex((entry, index) => index > syncedIndex
    && (entry.op === 'syncLog.update' || entry.op === 'syncLog.updateMany'))
  assert.ok(nextWrite > syncedIndex, 'the SYNCED transition must be followed by the obligation claim')
  const claim = state.journal[nextWrite]
  assert.ok(
    claim.data?.backReferenceFollowUpsPendingAt instanceof Date,
    'the obligation must be claimed by the write IMMEDIATELY after the SYNCED transition, in the same '
      + `transaction — nothing may come between them; saw ${JSON.stringify(claim.data)}`,
  )
  assert.ok(
    claim.where && 'backReferenceFollowUpsPendingAt' in claim.where,
    'and the claim must be a COMPARE-AND-SET on the generation it observed, not a write keyed on the id alone',
  )
  return claim
}

/** The release statement — the LAST write to the sync row, and the only one that clears the marker. */
function releaseStatement() {
  const entry = [...state.journal].reverse().find((candidate) => candidate.op === 'syncLog.updateMany'
    && candidate.data?.backReferenceFollowUpsPendingAt === null)
  assert.ok(entry, `expected a release; saw ${JSON.stringify(journalOps())}`)
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
  // The claim is not a transaction of its own: it is the next statement inside the one that flips
  // the row to SYNCED, so there is no interval in which the row is SYNCED with an external id and
  // silent about what it still owes. o3d-550x made that transition an updateMany (its where carries
  // the "do not overwrite a DIFFERENT document" precondition); o3d-0bfh r4 made the claim a
  // compare-and-set of its own. Both are asserted by the helper.
  assertObligationClaimedWithTheSyncedWrite('syncLog.updateMany')

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
  const released = state.journal.indexOf(releaseStatement())
  assert.ok(enqueued > linked, 'the follow-ups are enqueued after the link')
  assert.ok(released > enqueued, 'and the obligation is discharged only after that')
  // o3d-0bfh r4: and the release is FENCED on the generation this pass minted — the claim's own
  // value, carried down rather than re-read. Cleared by id, it would erase a generation a sweep had
  // taken in the meantime, which is the finding.
  const claimed = assertObligationClaimedWithTheSyncedWrite('syncLog.updateMany').data?.backReferenceFollowUpsPendingAt
  assert.deepEqual(
    state.journal[released].where,
    { id: 'log-1', backReferenceFollowUpsPendingAt: claimed },
    'the release clears ONLY the generation this pass claimed',
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
  assertObligationClaimedWithTheSyncedWrite('syncLog.updateMany')
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
  // …and the claim is the next statement in that same transaction, so there is no safe interval
  // between them (o3d-0bfh r4 moved it out of the statement, not out of the transaction).
  assertObligationClaimedWithTheSyncedWrite('syncLog.updateMany')
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
  assertObligationClaimedWithTheSyncedWrite('syncLog.updateMany')
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
// What is genuinely different, and stays different: the QuickBooks repair SWEEP is unwired, so on
// this connector NOTHING EVER READS THE MARKER BACK (o3d-0bfh r5, Codex HIGH — the last two tests in
// this file pin that). Recording the obligation and repairing it are separate acts, and only the
// second is blocked: the marker is a timestamp on the sync row and crosses no realm boundary. It has
// to be written at the moment it is true, because afterwards the state is unrecoverable — which is
// the same reason there is no backfill for rows written before the column existed. What that
// justifies is WRITING it; it does not make anything read it. See the block at the end of the
// QuickBooks sync-processor for what the actual blocker is (o3d-8prh, not the closed o3d-s36z).
// ---------------------------------------------------------------------------

async function runQuickBooks() {
  const { processPendingQuickBooksSync } = await import('@/lib/connectors/quickbooks/sync-processor')
  return processPendingQuickBooksSync()
}

test('[o3d-9kek r10 f1] the QuickBooks writer claims the obligation IN the SYNCED write too', async () => {
  reset('quickbooks')

  const result = await runQuickBooks()

  assert.equal(result.succeeded, 1)
  // QuickBooks is unchanged by o3d-550x (out of scope), so its SYNCED transition is still `update`;
  // the claim after it is the same compare-and-set Xero takes (o3d-0bfh r4).
  assertObligationClaimedWithTheSyncedWrite('syncLog.update')
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
  assertObligationClaimedWithTheSyncedWrite('syncLog.update')
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
  // unwired it is also the state that makes the work recoverable the day a consumer is bound — which
  // waits on post-time authorization (o3d-8prh) and origin propagation, not on the closed o3d-s36z.
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
// o3d-0bfh r4 (Codex HIGH) — THE CONNECTOR-VERSUS-SWEEP INTERLEAVING.
//
// r3 made the SWEEP's claim a strictly-later compare-and-set and proved it exclusive BETWEEN SWEEPS.
// The connector release was the writer standing outside that protocol: it cleared the marker by id,
// so the sequence below lost the money the protocol exists to protect.
//
//   connector  claims generation C in the SYNCED transaction
//   connector  writes the link, enqueues the follow-ups, and its probe answers "nothing deferred"
//   sweep      reads the row, claims S (strictly later than C), enqueues — and a receipt RECORDED
//              BETWEEN THE TWO PROBES has not reached the ledger, so it answers "still owed" and
//              DELIBERATELY RETAINS S, writing nothing
//   connector  releases by id → S is gone
//
// The row is then SYNCED, linked and marker-null: the next sweep computes `owesFollowUps = false`,
// stamps `backReferenceCheckedAt`, and the row leaves the candidate population for ever with the
// receipt unregistered and nothing anywhere saying so.
//
// These drive the REAL processor to the release and land the sweep's claim in the window immediately
// before that statement — which is the same window a `pause` gives it in production, because the
// release is the connector's only remaining write to the row.
// ---------------------------------------------------------------------------

/** The generation the connector claimed on this run, read off the journal rather than assumed. */
function claimedGeneration(syncedOp: 'syncLog.update' | 'syncLog.updateMany'): Date {
  const claimed = assertObligationClaimedWithTheSyncedWrite(syncedOp).data?.backReferenceFollowUpsPendingAt
  assert.ok(claimed instanceof Date)
  return claimed
}

test('[o3d-0bfh r4] a sweep that takes the obligation after the connector claimed it keeps it, even in the SAME MILLISECOND', async () => {
  // THE SAME-MILLISECOND CASE, and it is the one that proved a plain `now()` mint unsound in r3: the
  // sweep's clock reads EXACTLY the connector's generation. A mint that wrote `now()` would write the
  // value the connector is holding, the connector's fence would match it, and the sweep's retained
  // obligation would be cleared by the very predicate added to protect it. The strictly-later mint is
  // what makes the two values distinguishable at all.
  reset()
  let sweptTo: Date | null = null
  state.raceBeforeRelease = (row) => {
    const held = row.backReferenceFollowUpsPendingAt
    assert.ok(held instanceof Date, 'the connector must be holding a generation for the sweep to advance')
    // A sweep claiming with a clock reading exactly the connector's generation — the same mint
    // production uses, so this is the sweep's real behaviour rather than a convenient value.
    sweptTo = nextFollowUpObligationGeneration(held, new Date(held.getTime()))
    row.backReferenceFollowUpsPendingAt = sweptTo
  }

  const result = await runDirect()

  assert.equal(result.succeeded, 1, "the connector's own work all landed — this is not a failure of the entry")
  assert.ok(sweptTo, 'the race must actually have fired, or this test asserts nothing')
  const connectorGeneration = claimedGeneration('syncLog.updateMany')
  assert.equal(
    (sweptTo as Date).getTime(),
    connectorGeneration.getTime() + 1,
    "the sweep's mint must be STRICTLY later than the generation it observed, inside one millisecond too",
  )
  assert.deepEqual(
    subject().backReferenceFollowUpsPendingAt,
    sweptTo,
    "the sweep's obligation SURVIVES the connector's release — this is the whole finding",
  )
  // And the row is still a candidate: unstamped, so the next sweep re-reads it and discharges the
  // obligation it is holding rather than finding a reconciled row with a receipt still unregistered.
  assert.equal(subject().backReferenceCheckedAt, null)
  assert.equal(subject().status, 'SYNCED', 'and nothing about the refusal drags the row out of SYNCED')
})

test('[o3d-0bfh r4] the same holds when the sweep claims a plainly later generation', async () => {
  // The ordinary shape of the same race — a sweep a few seconds behind the post. Kept alongside the
  // same-millisecond case because a fence that compared only "is the stored value later than mine"
  // would pass this one and fail that one.
  reset()
  const sweepGeneration = new Date('2036-01-01T00:00:00.000Z')
  state.raceBeforeRelease = (row) => { row.backReferenceFollowUpsPendingAt = sweepGeneration }

  const result = await runDirect()

  assert.equal(result.succeeded, 1)
  assert.deepEqual(subject().backReferenceFollowUpsPendingAt, sweepGeneration, "the sweep's obligation stands")
  assert.equal(subject().backReferenceCheckedAt, null, 'and the row stays a candidate')
})

test('[o3d-0bfh r4] an UNDISTURBED row is still released — the fence must not simply refuse everything', async () => {
  // THE CONTROL. A predicate that matched nothing would satisfy every assertion above while
  // discharging no obligation ever, which is the "marker left set for ever" failure wearing the
  // fix's clothes. This row is claimed and released with nobody else touching it, and the marker
  // must end up null.
  reset()

  const result = await runDirect()

  assert.equal(result.succeeded, 1)
  assert.equal(subject().backReferenceFollowUpsPendingAt, null, 'an uncontested obligation IS discharged')
  assert.equal(state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length, 1)
})

test('[o3d-0bfh r4] the QuickBooks connector honours the same fence', async () => {
  // Cross-ported deliberately. Three rounds running, a fix landed in one connector and the identical
  // hole survived in the other; the QuickBooks sweep is unwired (o3d-s36z) but the marker it will
  // read is written today, and a release that clears somebody else's generation is not made safe by
  // the reader arriving later.
  reset('quickbooks')
  const sweepGeneration = new Date('2036-01-01T00:00:00.000Z')
  state.raceBeforeRelease = (row) => { row.backReferenceFollowUpsPendingAt = sweepGeneration }

  const result = await runQuickBooks()

  assert.equal(result.succeeded, 1)
  assert.deepEqual(subject().backReferenceFollowUpsPendingAt, sweepGeneration, "the other writer's obligation stands")
})

test('[o3d-0bfh r4] and a QuickBooks row nobody touched is still released', async () => {
  // The same control on the second connector, for the same reason.
  reset('quickbooks')

  const result = await runQuickBooks()

  assert.equal(result.succeeded, 1)
  assert.equal(subject().backReferenceFollowUpsPendingAt, null)
})

// ---------------------------------------------------------------------------
// o3d-0bfh r5 (Codex HIGH) — THE QUICKBOOKS MARKER HAS NO CONSUMER, PINNED AS A FACT.
//
// Codex asked for "a test that terminates execution after the SYNCED/marker transaction and proves a
// later production run enqueues the outstanding money work". On QuickBooks that test CANNOT PASS,
// and that is the finding rather than an obstacle to it: there is no sweep binding and no cron
// invocation, so nothing re-reads the marker. The honest test is therefore the inverse — the same
// crash, the same later production run, and an assertion of exactly how far it gets — which turns a
// silent hole into a named one that fails the day somebody closes it without reading the plan.
//
// THE CRASH STATE IS PRODUCED BY THE REAL PROCESSOR, NOT SEEDED. A hand-built row would drift from
// whatever the connector actually leaves behind, and then the gap this pins would be a gap in the
// test's imagination. Run one is the existing fresh-post-with-failing-follow-ups path: it commits
// SYNCED with the external id, claims the obligation in that same transaction, fails the enqueue,
// swallows it and counts the entry succeeded. That is byte-for-byte the state a process death one
// instruction after the commit leaves.
//
// AND THE CONTROL BELOW IS THE POINT OF THE WHOLE BLOCK AT THE END OF THE QUICKBOOKS PROCESSOR: the
// recovery logic EXISTS and works perfectly. The idempotency branch re-claims and re-enqueues the
// outstanding work exactly as it should. It is simply unreachable, because no candidate query on
// this connector will ever select the row again. Without that control, "run two enqueued nothing"
// would be equally satisfied by a harness that cannot observe an enqueue at all.
// ---------------------------------------------------------------------------

/** Drive the connector to the state a crash immediately after the SYNCED/marker commit leaves. */
async function crashAfterTheSyncedCommit() {
  reset('quickbooks')
  state.syncRows = [{ ...blankRow(), externalTransactionId: null }]
  state.failFollowUpsFor.add('log-1')
  const posted = await runQuickBooks()

  // THE PRECONDITION. Every assertion after this is about a row in this exact state, and a run that
  // ended anywhere else would make the "nothing happened" below true for the wrong reason.
  assert.equal(posted.succeeded, 1, 'the post itself landed — this is a crash after success, not a failure')
  assert.equal(subject().status, 'SYNCED', 'the SYNCED transition COMMITTED')
  assert.equal(subject().externalTransactionId, 'XBILL-1', 'and it carries the id QuickBooks issued')
  assert.ok(subject().backReferenceFollowUpsPendingAt instanceof Date, 'and the obligation was claimed with it')
  assert.equal(
    state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length, 0,
    'while the money work never ran — which is the whole reason the marker is set',
  )
  return subject().backReferenceFollowUpsPendingAt as Date
}

test('[o3d-0bfh r5] a QuickBooks crash after the SYNCED/marker commit is re-driven by NOTHING', async () => {
  const owed = await crashAfterTheSyncedCommit()

  // A later production run. The follow-up injection is gone, so if anything selected this row its
  // work would succeed — the enqueue is not what stops it.
  state.failFollowUpsFor.clear()
  state.journal = []
  const later = await runQuickBooks()

  assert.equal(later.processed, 0, 'the row is SYNCED, and the processor selects PENDING and stale PROCESSING only')
  assert.deepEqual(state.journal, [], 'nothing wrote to the row at all')
  assert.equal(
    state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length, 0,
    'so the outstanding payment/PDF/email/attachment is still not enqueued — EVIDENCE IS PRESERVED, THE WORK IS NOT LIVE',
  )
  assert.deepEqual(
    subject().backReferenceFollowUpsPendingAt, owed,
    'and the obligation is still recorded, unread, by the same generation that recorded it',
  )
  // If this test ever fails, a consumer has been wired. Read the block at the end of
  // lib/connectors/quickbooks/sync-processor.ts BEFORE deleting it: closing o3d-s36z was not enough,
  // and a consumer that enqueues a payment before o3d-8prh lands can post it to the wrong company.
  // o3d-s4q2 carries the gap and the order of work; it is blocked on o3d-8prh.
})

test('[o3d-0bfh r5] CONTROL: the recovery logic works perfectly — it is only unreachable', async () => {
  const owed = await crashAfterTheSyncedCommit()

  // The ONE thing that changes: the row is returned to the candidate population, exactly as an
  // operator retry does. Nothing else about the row or the harness is touched.
  subject().status = 'PENDING'
  subject().processingStartedAt = null
  state.failFollowUpsFor.clear()
  const later = await runQuickBooks()

  assert.equal(later.processed, 1, 'now it is selected')
  assert.equal(later.succeeded, 1)
  assert.equal(
    state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length, 1,
    'and the idempotency branch re-drives the outstanding money work correctly, without re-posting the bill',
  )
  assert.equal(subject().backReferenceFollowUpsPendingAt, null, 'and only then is the obligation discharged')
  assert.notEqual(owed, null, 'the obligation this discharged is the one the crash recorded')
  // So the marker protocol is complete and correct on this connector in every respect but one: no
  // candidate query selects a SYNCED row by its marker. That single missing binding is the finding.
})

// ---------------------------------------------------------------------------
// o3d-0bfh r6 (Codex HIGH) — THE ONLY HUMAN-RECOVERY NOTIFICATION COULD BE SILENTLY LOST.
//
// The two QuickBooks paths above said, in as many words, that the activity entry IS the notification
// and human action is the entire recovery. Both wrote it with `logActivity`, which swallows a
// persistence failure and resolves `void` — so the appended `.catch()` could never fire on the
// failure that matters. The entry was then counted successful, the row stayed SYNCED, nothing
// selected it again, and no sweep consumes its marker: one transient activity-log failure left a
// payment, PDF, email or attachment permanently stalled with NO operator-visible notice at all.
//
// The fix is not a better log line. It is that the obligation is no longer announced only in the log:
// the marker on the row — a state that is already committed by the time any of this runs — is
// surfaced as an operational backlog (buildFollowUpObligationBacklogWhere, rendered in the exception
// inbox). A row carrying a marker with no consumer is ALREADY a queryable state, and a view over it
// depends on no second write landing at the worst possible moment.
//
// SO THESE TESTS FAIL THE ACTIVITY-LOG INSERT AND ASSERT THE OBLIGATION IS STILL VISIBLE, by
// evaluating the PRODUCTION where-clause against the row the production processor left behind. The
// where-interpreter throws on any predicate it cannot honour, so this cannot degrade into "some
// query matched something".
// ---------------------------------------------------------------------------

/**
 * Does the operational backlog select this row? The REAL predicate, evaluated by the same matcher
 * every other assertion in this file uses. `now` is pushed past the settling grace, because a row
 * that has just been claimed is deliberately not listed — the connector releases the marker a few
 * statements after it takes it, and a backlog that flickered on every healthy post is not a surface.
 */
function inTheOperatorBacklog(row: SyncRow, atMinutesLater = 30): boolean {
  const where = buildFollowUpObligationBacklogWhere({
    now: new Date(Date.now() + atMinutesLater * 60_000),
  }) as unknown as Record<string, unknown>
  return matches(row as unknown as Record<string, unknown>, where)
}

/** console.error, captured — the last-resort channel for a notice the database could not take. */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  return { lines, restore: () => { console.error = original } }
}

test('[o3d-0bfh r6] a follow-up failure whose ACTIVITY LOG could not be written is still visible to an operator', async () => {
  reset('quickbooks')
  state.syncRows = [{ ...blankRow(), externalTransactionId: null }]
  state.failFollowUpsFor.add('log-1')
  // THE INJECTION THIS TEST IS ABOUT: the notice cannot be persisted. Under the old code this was
  // indistinguishable from success, because logActivity reports nothing.
  state.unpersistableActivityActions.add('quickbooks_followup_error')
  const stderr = captureStderr()

  let result
  try {
    result = await runQuickBooks()
  } finally {
    stderr.restore()
  }

  // The entry is STILL counted succeeded and the row STILL ends SYNCED — that is deliberate (the
  // document is in QuickBooks), and it is precisely what makes the row indistinguishable from a
  // completed one and therefore what makes the notice load-bearing.
  assert.equal(result.succeeded, 1)
  assert.equal(subject().status, 'SYNCED')
  assert.equal(
    state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length, 0,
    'the follow-up work really did not run — otherwise there is no obligation to be visible',
  )

  // 1. The notice was ATTEMPTED and reported as unwritable, rather than being awaited and assumed.
  assert.ok(
    state.activities.some((entry) => entry.action === 'quickbooks_followup_error'),
    'the write must have been attempted through the PERSISTED logger',
  )
  assert.ok(
    stderr.lines.some((line) => line.includes('could NOT be written') && line.includes('log-1')),
    `a lost notice must reach the one channel the failed database write cannot swallow; saw ${JSON.stringify(stderr.lines)}`,
  )

  // 2. AND THE OBLIGATION IS STILL VISIBLE WITHOUT IT. This is the assertion the finding asked for:
  // the debt survives on the row, and the production backlog query selects it.
  assert.ok(
    subject().backReferenceFollowUpsPendingAt instanceof Date,
    'the marker — the durable record of the debt — is retained',
  )
  assert.ok(
    inTheOperatorBacklog(subject()),
    'and the operational backlog selects the row, so the operator sees the stalled payment/PDF/email even '
      + 'though every activity-log write for it failed',
  )
})

test('[o3d-0bfh r6] the same holds on the RETAINED-obligation path, where the log line WAS the whole notification', async () => {
  // The other site Codex named by line (settleFollowUpObligation). Reached by failing the
  // back-reference WRITE: QuickBooks swallows that, so the entry succeeds, the link never landed,
  // and the obligation is deliberately retained with a log line as its only announcement.
  reset('quickbooks')
  state.failBackReferenceWrite = true
  state.unpersistableActivityActions.add('quickbooks_followup_obligation_retained')
  const stderr = captureStderr()

  let result
  try {
    result = await runQuickBooks()
  } finally {
    stderr.restore()
  }

  assert.equal(result.succeeded, 1, 'the post landed; only the local link did not')
  assert.ok(
    state.journal.some((entry) => entry.op === 'backReference.attempted-and-failed'),
    'the link write must actually have been attempted and failed, or this row owes nothing',
  )
  assert.ok(
    state.activities.some((entry) => entry.action === 'quickbooks_followup_obligation_retained'),
    'the retained-obligation notice was attempted',
  )
  assert.ok(
    stderr.lines.some((line) => line.includes('could NOT be written')),
    `and its failure was reported rather than swallowed; saw ${JSON.stringify(stderr.lines)}`,
  )
  assert.ok(subject().backReferenceFollowUpsPendingAt instanceof Date, 'the obligation is retained')
  assert.ok(inTheOperatorBacklog(subject()), 'and it is listed for an operator with no dependence on that log write')
})

test('[o3d-0bfh r6] CONTROL: a row whose follow-ups RAN is not in the backlog', async () => {
  // Without this, "the backlog selects the row" is satisfied by a predicate that selects every row —
  // which would bury the real obligations in a list of healthy documents and be no surface at all.
  reset('quickbooks')

  const result = await runQuickBooks()

  assert.equal(result.succeeded, 1)
  assert.equal(state.syncRows.filter((row) => row.type === 'BILL_ATTACHMENT').length, 1, 'the follow-ups ran')
  assert.equal(subject().backReferenceFollowUpsPendingAt, null, 'so the obligation was discharged')
  assert.equal(inTheOperatorBacklog(subject()), false, 'and nothing about it is listed as owed')
})

test('[o3d-0bfh r6] CONTROL: a marked row inside the settling grace, and a XERO row, are not listed', async () => {
  // Two ways the backlog could cry wolf, both asserted against the real predicate:
  //
  //   • a row claimed moments ago is MID-PASS — the connector releases the marker a few statements
  //     after taking it, so listing it would flicker on every healthy post;
  //   • a Xero row's marker HAS a consumer. Listing it would tell an operator to do by hand what the
  //     sweep is about to do, which is how a duplicate payment gets recorded.
  reset('quickbooks')
  state.syncRows = [{ ...blankRow(), externalTransactionId: null }]
  state.failFollowUpsFor.add('log-1')
  await runQuickBooks()
  assert.ok(subject().backReferenceFollowUpsPendingAt instanceof Date)

  assert.equal(
    inTheOperatorBacklog(subject(), 0), false,
    'a marker claimed seconds ago is still in flight, not stranded',
  )
  assert.equal(inTheOperatorBacklog(subject(), 30), true, 'and the same row IS listed once the grace has passed')

  const asXero = { ...subject(), connector: 'xero' }
  assert.equal(
    inTheOperatorBacklog(asXero, 30), false,
    'a connector WITH a sweep consumer is never listed as needing a human',
  )
})
