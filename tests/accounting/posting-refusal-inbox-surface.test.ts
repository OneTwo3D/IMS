import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test, { mock } from 'node:test'

/**
 * o3d-j625 r4 — THE REFUSAL REACHES THE SURFACE AN OPERATOR ACTUALLY LOOKS AT.
 *
 * The sibling tests prove a refusal is WRITTEN and that the posting being made CLEARS it. This one
 * proves the other half of the owner's decision: that the exception inbox — the page that already lists
 * work IMS owes — selects those rows, counts them in its total, and hands the operator the fields it
 * needs to act (both connectors, what stands in IMS, the remedy). Without this, "durable" would be a
 * property of a table nobody reads.
 *
 * The database is doubled by a Proxy that answers "nothing there" for every model, so the only rows in
 * the inbox are the refusals under test and every count below is attributable to them.
 */

const refusalRows = [
  {
    id: 'refusal-1',
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'so-1',
    // o3d-j625 r14: the fourth part of the posting key. The listing selects it so the live-row
    // classification is about the POSTING and not the document.
    scope: '',
    // o3d-j625 r14: and a KIND, so `clearing` is non-null and the Mark-as-handled affordance is actually
    // offered on this row. The r14 fix makes the mark the SAFE FIRST STEP when a queued row exists, so a
    // fixture with no kind could not tell an affordance that is still offered from one that was removed.
    kind: 'sales_invoice_held_release',
    chartConnector: 'xero',
    activeConnector: 'quickbooks',
    reason: 'retired_chart',
    committed: 'the order SO-1001 is invoiced in IMS',
    remedy: 'Re-queue the invoice from the order once the accounting connector selection has settled.',
    refusedCount: 4,
    firstRefusedAt: new Date('2026-09-10T08:00:00.000Z'),
    lastRefusedAt: new Date('2026-09-14T08:00:00.000Z'),
  },
]

/**
 * BOTH predicates, separately. A single shared field was a hole the mutation harness found: the list
 * query runs after the count, so a count with the wrong predicate was overwritten and the assertion
 * passed anyway. The count is also FILTERED here rather than canned, so a predicate that stopped
 * excluding resolved rows changes the number the page badges.
 */
/** One OPEN refusal and one already resolved, so a predicate that stops excluding resolved rows shows. */
const resolvedRow = {
  id: 'refusal-resolved',
  type: 'CREDIT_NOTE',
  referenceType: 'SalesOrderRefund',
  referenceId: 'refund-9',
  scope: '',
  chartConnector: 'xero',
  activeConnector: 'xero',
  reason: 'retired_chart',
  committed: 'the refund is recorded in IMS',
  remedy: 'nothing — this one was posted after the selection settled',
  refusedCount: 1,
  firstRefusedAt: new Date('2026-09-01T08:00:00.000Z'),
  lastRefusedAt: new Date('2026-09-01T08:00:00.000Z'),
  resolvedAt: new Date('2026-09-02T08:00:00.000Z'),
}

/**
 * o3d-j625 r14 — RECEIPT B's REFUSAL, whose posting key differs from receipt A's ONLY IN `scope`.
 *
 * Added because a mutation proved the first version of the scope test examined nothing: it used a live row
 * of a different TYPE, so the classification's map key already differed in `type` and dropping `scope` from
 * it changed no outcome. An INVOICE_PAYMENT is one RECEIPT against one document (o3d-j625 r5 HIGH 3), so
 * two receipts on one order are two postings that differ in exactly the component under test.
 */
const receiptBRefusal = {
  id: 'refusal-receipt-b',
  type: 'INVOICE_PAYMENT',
  referenceType: 'SalesOrder',
  referenceId: 'so-1',
  scope: 'payment:pay-B',
  kind: 'invoice_payment_receipt',
  chartConnector: 'xero',
  activeConnector: null,
  reason: 'payment_account_not_in_ledger',
  committed: 'the receipt is recorded against the order in IMS',
  remedy: 'Re-map the payment method against the connector now in use.',
  refusedCount: 1,
  firstRefusedAt: new Date('2026-09-11T08:00:00.000Z'),
  lastRefusedAt: new Date('2026-09-11T08:00:00.000Z'),
}

function matchesRefusalWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  // o3d-j625 r18 (Codex round 17, HIGH 2): the ACTIVE-CLAIM predicate. Evaluated rather than canned,
  // because the property under test is which rows a claims view admits — and a double that ignored this
  // half would pass the whole of `allRows` back and hide the very limit the finding is about.
  if ('handPostClaimedAt' in where) {
    const claimed = where.handPostClaimedAt
    const held = row.handPostClaimedAt instanceof Date
    if (claimed && typeof claimed === 'object' && 'not' in (claimed as object)) {
      if ((claimed as { not: unknown }).not === null && !held) return false
    } else if (claimed === null && held) return false
  }
  /**
   * o3d-j625 r18 — AND THE HOLDER, because a double that ignores a predicate grants it.
   *
   * DISCLOSED RIG FAULT, found by the mutation harness and not by the test: without this clause, scoping the
   * claims query to `handPostClaimedBy: viewerId` — which hides a departed colleague's claim, the whole of
   * HIGH 2 — left the reproduction GREEN, because the double returned every row whatever the query asked.
   * An unevaluated predicate is a predicate the test cannot be about.
   */
  if ('handPostClaimedBy' in where && where.handPostClaimedBy !== row.handPostClaimedBy) return false
  /**
   * o3d-j625 r22 — THE IDENTITY KEYSET. The walk's cursor is now `{ id: { gt: … } }`; a double that ignored it
   * would return every row whatever page was asked for, which is the rig fault r18 disclosed on this very
   * evaluator (an unevaluated predicate is a predicate the test cannot be about).
   */
  if ('id' in where) {
    const bound = where.id
    if (bound && typeof bound === 'object' && 'gt' in (bound as object)) {
      if (!(String(row.id) > String((bound as { gt: unknown }).gt))) return false
    } else if (bound !== row.id) return false
  }
  if (!('resolvedAt' in where)) return true
  const condition = where.resolvedAt
  if (condition && typeof condition === 'object' && 'gte' in (condition as object)) {
    return row.resolvedAt instanceof Date && row.resolvedAt >= (condition as { gte: Date }).gte
  }
  return row.resolvedAt === condition
}

/**
 * o3d-j625 r18 (Codex round 17, HIGH 2) — THE DOUBLE NOW HONOURS `orderBy` AND `take`.
 *
 * It used to return every matching row whatever the query asked for, so a section capped at 50 rows looked
 * uncapped and the finding — "a claim beyond the limit is not in the actionable UI" — was invisible to this
 * file. Honouring both is what lets the reproduction below hold 50 older refusals in front of a newer claim.
 */
function pageRefusals(rows: Array<Record<string, unknown>>, orderBy: unknown, take: number | undefined): Array<Record<string, unknown>> {
  const sorted = [...rows]
  if (orderBy && typeof orderBy === 'object') {
    const [field, direction] = Object.entries(orderBy as Record<string, string>)[0] ?? []
    if (field) {
      sorted.sort((a, b) => {
        const left = a[field] instanceof Date ? (a[field] as Date).getTime() : 0
        const right = b[field] instanceof Date ? (b[field] as Date).getTime() : 0
        return direction === 'desc' ? right - left : left - right
      })
    }
  }
  return typeof take === 'number' ? sorted.slice(0, take) : sorted
}

const seen: { countWhere?: Record<string, unknown>; listWhere?: Record<string, unknown>; listOrderBy?: unknown; listTake?: number; resolvedWhere?: Record<string, unknown>; claimsWhere?: Record<string, unknown>; claimsOrderBy?: unknown; claimsTake?: number; longestHeldOrderBy?: unknown; longestHeldTake?: number } = {}

const emptyModel = {
  findMany: async () => [],
  findFirst: async () => null,
  findUnique: async () => null,
  count: async () => 0,
  groupBy: async () => [],
  aggregate: async () => ({}),
  updateMany: async () => ({ count: 0 }),
}

/**
 * o3d-j625 r10 (Codex round 9, HIGH) — the PROVISIONAL CLAIMS the inbox also lists.
 *
 * Refusals a business transaction had to hold because another job held the posting key. They live on
 * `integration_outbox`, so the double answers only the provisional predicate and leaves every other read
 * of that table (the outbox-failure section's) empty, which keeps each count attributable.
 */
const provisionalClaims: Array<Record<string, unknown>> = []

const PROVISIONAL_OPERATION = 'posting-refusal.provisional'
const isProvisionalRead = (where: Record<string, unknown> | undefined) => where?.operation === PROVISIONAL_OPERATION

/**
 * o3d-j625 r14 (Codex, HIGH) — THE LIVE ACCOUNTING SYNC ROWS, which now decide what the remedy SAYS.
 *
 * Empty by default, so every existing test in this file keeps rendering the refusing site's own remedy —
 * which is the control for the new behaviour rather than an accident: with nothing queued, posting by hand
 * is safe and the instruction is unchanged.
 */
const liveSyncRows: Array<Record<string, unknown>> = []

const db = new Proxy({
  accountingSyncLog: {
    ...emptyModel,
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => (
      // Only the classification's read is answered. o3d-1e7sl: it used to be recognised by its
      // `status: { not: 'CANCELLED' }` clause, which is gone - the read now takes EVERY row for the postings
      // (an OR of the refusals' keys) and classifies in TypeScript through the ledger-standing module. Every
      // other read of this table in the inbox stays empty, so each section's count stays attributable.
      where && Array.isArray(where.OR)
        ? liveSyncRows.map((row) => ({ settlementBasis: null, abandonedBeforeRemoteCall: null, ...row }))
        : []
    ),
  },
  integrationOutbox: {
    ...emptyModel,
    count: async ({ where }: { where: Record<string, unknown> }) => (isProvisionalRead(where) ? provisionalClaims.length : 0),
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => (isProvisionalRead(where) ? provisionalClaims : []),
  },
  accountingPostingRefusal: {
    ...emptyModel,
    // BOTH reads are recorded, because the count and the list are separate queries and a section that
    // counted rows it did not list (or listed rows it did not count) would be the usual inbox bug.
    count: async ({ where }: { where: Record<string, unknown> }) => {
      seen.countWhere = where
      return allRows.filter((row) => matchesRefusalWhere(row, where)).length
    },
    findMany: async ({ where, orderBy, take }: { where: Record<string, unknown>; orderBy?: unknown; take?: number }) => {
      // o3d-j625 r6: the page also reads RECENTLY RESOLVED rows (review H4). Only the OUTSTANDING list's
      // arguments are recorded here — the resolved list is asserted by its own test below.
      // o3d-j625 r18: and the ACTIVE-CLAIM read is recorded separately, because the whole of HIGH 2 is that
      // it must not be the refusal list's query — same predicate, same ordering, same cap would be the bug.
      if ('handPostClaimedAt' in where || 'AND' in where) {
        // o3d-j625 r22: there are TWO claim reads now and they must not overwrite each other's record — the
        // WALK (ordered by identity, the reachability path) and the age-ordered LONGEST-HELD head (a display
        // aid). Told apart by their ordering, which is the very thing under test.
        const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, string>>
        if (keys[0] && 'handPostClaimedAt' in keys[0]) {
          seen.longestHeldOrderBy = orderBy
          seen.longestHeldTake = take
        } else {
          seen.claimsWhere = where
          seen.claimsOrderBy = orderBy
          seen.claimsTake = take
        }
      } else if (where.resolvedAt === null) {
        seen.listWhere = where
        seen.listOrderBy = orderBy
        seen.listTake = take
      } else {
        seen.resolvedWhere = where
      }
      return pageRefusals(allRows.filter((row) => matchesRefusalWhere(row, where)), orderBy, take)
    },
  },
  $queryRaw: async () => [],
  $queryRawUnsafe: async () => [],
  $transaction: async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(db) : []),
} as Record<string, unknown>, {
  get: (target, key: string) => (key in target ? target[key] : emptyModel),
})

/**
 * MUTABLE, so one test can add a row without moving every count in this file.
 *
 * o3d-j625 r14: receipt B's refusal is pushed by the scope test alone and removed after it. The first
 * attempt put it here, which changed `summary.accountingPostingRefusals` and `summary.total` and turned
 * three existing tests red at baseline — a fixture change that moves other tests' numbers is not a fixture
 * change, it is a rewrite of what they assert.
 */
const allRows: Array<Record<string, unknown>> = [
  ...refusalRows.map((row) => ({ ...row, resolvedAt: null })),
  resolvedRow,
]

mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({ user: { id: 'u1', email: 'u@example.test', name: 'U', role: 'ADMIN', supplierId: null, sessionInvalidReason: null, totpEnabled: false, totpVerified: false } }),
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined, logActivityPersisted: async () => true } })

test('[o3d-j625 r4] the exception inbox LISTS refused postings, counts them in its total, and names both connectors and the remedy', async () => {
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')

  const data = await getExceptionInboxData()

  assert.equal(data.summary.accountingPostingRefusals, 1, 'counted')
  assert.equal(data.summary.total, 1, 'and counted in the inbox TOTAL — the number the page badges')
  assert.equal(data.accountingPostingRefusals.length, 1, 'and listed')
  const row = data.accountingPostingRefusals[0]
  assert.equal(row.type, 'SALES_INVOICE')
  assert.equal(row.referenceType, 'SalesOrder')
  assert.equal(row.referenceId, 'so-1')
  assert.equal(row.chartConnector, 'xero', 'the chart the payload was built from')
  assert.equal(row.activeConnector, 'quickbooks', 'AND what is active now — round 2 omitted this half')
  assert.equal(row.reason, 'retired_chart')
  assert.equal(row.committed, refusalRows[0].committed)
  assert.equal(row.remedy, refusalRows[0].remedy)
  assert.equal(row.refusedCount, 4)
  assert.equal(row.firstRefusedAt, '2026-09-10T08:00:00.000Z', 'serialised for the client')
})

test('[o3d-j625 r4/r5] only OUTSTANDING refusals are selected — a resolved one is not work', async () => {
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')
  const data = await getExceptionInboxData()
  // o3d-j625 r5 (review M-16) — ASSERTED AS BEHAVIOUR, NOT AS A LITERAL SHAPE. r4 deep-equalled the
  // predicate object, so a semantically identical rewrite (`{ resolvedAt: { equals: null } }`) failed while a
  // predicate that stopped excluding resolved rows would have to be spelt exactly wrong to be caught. What
  // matters is which rows come back.
  assert.equal(data.summary.accountingPostingRefusals, 1, 'the resolved row is not counted')
  assert.deepEqual(data.accountingPostingRefusals.map((row) => row.id), ['refusal-1'], 'nor listed')
  assert.ok(seen.countWhere && seen.listWhere, 'and both queries were made')
})

test('[o3d-j625 r5 M-16] the section is OLDEST DEBT FIRST and capped, as its own copy claims', async () => {
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')
  await getExceptionInboxData()
  assert.deepEqual(seen.listOrderBy, { firstRefusedAt: 'asc' },
    'the list claims oldest first: a refusal repeating for a week is the one to look at, not the one that '
    + 'last happened to run')
  assert.equal(typeof seen.listTake, 'number', 'and it is capped like every other section')
  assert.ok((seen.listTake ?? 0) > 0)
})

/**
 * o3d-j625 r10 (Codex round 9, HIGH) — AN UNRECONCILED CLAIM IS VISIBLE, AND VISIBLY NOT YET ACTIONABLE.
 *
 * A refusal that could not take its posting key is held with the caller's transaction and settled by the
 * accounting-sync tick. If that tick is not running, the claim must not sit invisibly: the whole finding
 * was that a refusal nothing lists is a silent non-posting. But it also must not read as an ordinary debt
 * — while it is unconfirmed the posting may still belong to the job that held the key, so "post this by
 * hand" is the one instruction that could put the journal in the ledger twice.
 */
test('[o3d-j625 r10] an unreconciled provisional claim is LISTED and counted, marked unconfirmed, with no way to mark it handled', async () => {
  provisionalClaims.length = 0
  provisionalClaims.push({
    id: 'claim-7',
    attempts: 0,
    status: 'PENDING',
    createdAt: new Date('2026-09-24T10:00:00.000Z'),
    payloadJson: {
      key: { type: 'MANUFACTURING_JOURNAL', referenceType: 'ProductionOrder', referenceId: 'po-7', scope: '' },
      record: {
        kind: 'manufacturing_journal',
        chartConnector: 'xero',
        activeConnector: 'quickbooks',
        reason: 'retired_chart',
        committed: 'the production order is completed in IMS',
        remedy: 'Post the manufacturing journal by hand and mark this row handled.',
      },
      decidedAt: '2026-09-24T10:00:00.000Z',
      mergeOnly: false,
    },
  })
  const [{ getExceptionInboxData }, copy] = await Promise.all([
    import('@/app/actions/sync-exceptions'),
    import('@/lib/domain/accounting/posting-refusal-copy'),
  ])

  const data = await getExceptionInboxData()

  assert.equal(data.summary.accountingPostingRefusalsUnconfirmed, 1, 'counted, and counted separately')
  assert.equal(data.summary.accountingPostingRefusals, 2, 'and included in the section\'s own badge (1 debt + 1 claim)')
  assert.equal(data.summary.total, 2, 'and in the inbox TOTAL — a claim nothing settles is work somebody must look at')

  const claim = data.accountingPostingRefusals.find((row) => row.id === 'claim-7')
  assert.ok(claim, 'the claim is listed in the refusal section, beside the established debts')
  assert.equal(claim.unconfirmed, true, 'and marked as what it is')
  assert.equal(claim.type, 'MANUFACTURING_JOURNAL', 'naming the posting, from the claim\'s own payload')
  assert.equal(claim.referenceId, 'po-7')
  assert.equal(claim.chartConnector, 'xero')
  // THE PART THAT MATTERS. The claim's stored remedy asks for a hand posting; that instruction must NOT
  // be what the page shows while IMS cannot yet say the posting is owed.
  assert.equal(claim.remedy, copy.ACCOUNTING_POSTING_REFUSAL_UNCONFIRMED_REMEDY)
  assert.doesNotMatch(claim.remedy, /mark this row handled/i)
  assert.equal(claim.kind, null, 'no kind, which is what withholds the Mark-as-handled affordance')
  assert.equal(claim.clearing, null)

  // And the established debt beside it is untouched by any of this.
  const debt = data.accountingPostingRefusals.find((row) => row.id === 'refusal-1')
  assert.ok(debt)
  assert.equal(debt.unconfirmed, false)
  assert.equal(debt.remedy, refusalRows[0].remedy)
  provisionalClaims.length = 0
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * o3d-j625 r14 (Codex, HIGH) — A KEPT DEBT MUST NOT INSTRUCT AN OPERATOR TO DUPLICATE A QUEUED POSTING
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE CHAIN Codex executed. r12 keeps a debt it cannot prove was discharged — an enqueue that commits
 * between a refusal's decision and its UNCONTENDED lock acquisition leaves a PENDING sync row and the
 * refusal is still recorded (tests/concurrency/posting-refusal-record-race, "an UNCONTENDED refusal with a
 * posting queued after it IS recorded"). The inbox then rendered the refusing site's own remedy for it:
 * "post it by hand and mark this row handled". `markPostingHandled` does refuse a posting that may already
 * be in the ledger — r12's defence — but it refuses when the operator comes BACK TO MARK, which is after
 * they have posted. In between, the worker can post the PENDING row. Two ledger entries; the mark then
 * correctly refuses, after the damage.
 *
 * WHY THE FIX IS THE INSTRUCTION AND NOT THE GUARD, and why the debt is still listed: see
 * `classifyQueuedRowsForRefusals` in app/actions/sync-exceptions.ts. The guard is the same one, moved in
 * front of the ledger write by inverting the order the operator is given.
 *
 * o3d-lkh4 is absorbed here: it filed exactly this shape as a MEDIUM before Codex graded it HIGH.
 */

/** A live sync row for refusal-1's posting (SALES_INVOICE / SalesOrder / so-1, document scope). */
function liveRowFor(overrides: Record<string, unknown>) {
  return {
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'so-1',
    payload: {},
    status: 'PENDING',
    attemptRevision: 0,
    externalTransactionId: null,
    ...overrides,
  }
}

test('[o3d-j625 r14] a refusal whose posting has an UNSENT queued row is told to mark FIRST, never to post first', async () => {
  liveSyncRows.length = 0
  liveSyncRows.push(liveRowFor({}))
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')

  const data = await getExceptionInboxData()
  const row = data.accountingPostingRefusals.find((candidate) => candidate.id === 'refusal-1')

  assert.ok(row, 'PRECONDITION: the debt is STILL LISTED — r12 keeps it, and a debt nobody can see is the '
    + 'failure this table exists to end. A fix that hid it would be worse than the bug.')
  assert.equal(row.queuedRow, 'unsent',
    'classified at render time from the row a processor has not claimed')
  console.log(`[r14/r16 unsent] queuedRow=${row.queuedRow} order=${JSON.stringify(row.handPostOrder)}`)

  /**
   * o3d-j625 r16 (Codex round 15) — THE ASSERTIONS MOVED FROM `remedy` TO `handPostOrder`, AND THE ORDER
   * ITSELF CHANGED.
   *
   * r14 rewrote the refusing site's own remedy when a live row existed. Round 15 made the order a MECHANISM
   * rather than a sentence, and the site's remedy is now never rewritten at all — round 12's property
   * without r14's exception (the CONTROL below asserts byte equality for the ordinary case, and it does so
   * for THIS case too). What to do first is its own field.
   *
   * And the first step is no longer "Mark as handled": the mark is the acknowledgement, and it refuses
   * without a claim. The act that stops IMS posting is TAKING the posting.
   */
  assert.equal(row.remedy, refusalRows[0].remedy,
    'the refusing site\'s own remedy is verbatim even here — it is not the page\'s job to rewrite it')
  assert.ok(row.handPostOrder, 'and the ORDER of operations is its own field')
  assert.match(row.handPostOrder, /DO NOT POST THIS BY HAND YET/,
    'THE r14 FINDING: with a row that can still post, telling the operator to post by hand is an instruction '
    + 'to duplicate the posting — the worker can post the PENDING row while they are in the ledger')
  assert.match(row.handPostOrder, /Take for hand posting" FIRST/,
    'THE r16 FINDING: and the first step is the ACT that stops IMS queueing it, not an acknowledgement the '
    + 'operator gives afterwards — an instruction cannot cover the interval they are in the ledger')
  assert.match(row.handPostOrder, /cancels the queued row/,
    'and it says what taking it does to the unsent row, because that is why the order is safe')
  assert.equal(row.handPostClaim, null, 'nobody is settling it yet')
  // The affordance must STILL be offered: it is the safe first step now, so removing it would leave the
  // operator with the unsafe one.
  assert.equal(row.clearing, 'retried', 'and the hand-posting affordance is still offered')
})

test('[o3d-1e7sl G6/G7] the inbox classifies the rows under a refused posting by STANDING: retired rows never block the remedy, and an unproven one is REPORTED', async () => {
  // C1 / D1. A CANCELLED row cannot post again, so it does not make the instruction "do not post by hand" - the
  // remedy for an asserted-not-posted or unresolved attempt IS to take the posting, hand-post and mark it
  // handled. But a retired row that is not PROVEN unsent is not "nothing": the order names it and tells the
  // operator to look in the ledger first. The classification is made in TypeScript over EVERY row for the
  // posting (the `status: { not: 'CANCELLED' }` read it replaces dropped these rows without a trace).
  const { ledgerStanding } = await import('@/lib/domain/accounting/ledger-standing')
  type Case = { name: string; standing: string; row: Record<string, unknown>; queuedRow: 'unsent' | 'may-be-sent' | null; reports: RegExp | null }
  const cases: Case[] = [
    { name: 'LIVE_WORK never claimed', standing: 'LIVE_WORK', row: {}, queuedRow: 'unsent', reports: null },
    { name: 'LIVE_WORK claimed before', standing: 'LIVE_WORK', row: { attemptRevision: 3 }, queuedRow: 'may-be-sent', reports: null },
    { name: 'CONFIRMED_POSTED', standing: 'CONFIRMED_POSTED', row: { status: 'SYNCED', externalTransactionId: 'DOC-C', attemptRevision: 1 }, queuedRow: 'may-be-sent', reports: null },
    { name: 'ASSERTED_POSTED', standing: 'ASSERTED_POSTED', row: { status: 'SYNCED', externalTransactionId: 'DOC-T', settlementBasis: 'OPERATOR_ASSERTION', attemptRevision: 1 }, queuedRow: 'may-be-sent', reports: null },
    { name: 'UNKNOWN FAILED', standing: 'UNKNOWN', row: { status: 'FAILED', attemptRevision: 1 }, queuedRow: 'may-be-sent', reports: null },
    { name: 'ASSERTED_NOT_POSTED (retired)', standing: 'ASSERTED_NOT_POSTED', row: { status: 'CANCELLED', settlementBasis: 'OPERATOR_ASSERTION', attemptRevision: 1 }, queuedRow: null, reports: /settled by an operator as NOT posted \(an assertion, not proof that it did not post\)/ },
    { name: 'UNKNOWN CANCELLED (retired, no proof)', standing: 'UNKNOWN', row: { status: 'CANCELLED', attemptRevision: 1 }, queuedRow: null, reports: /nothing on the row says whether it reached the ledger/ },
    { name: 'PROVEN_NOT_POSTED (retired, proven)', standing: 'PROVEN_NOT_POSTED', row: { status: 'CANCELLED', abandonedBeforeRemoteCall: true }, queuedRow: null, reports: null },
  ]
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')
  let reported = 0
  for (const c of cases) {
    liveSyncRows.length = 0
    const live = liveRowFor(c.row)
    liveSyncRows.push(live)
    const standing = ledgerStanding({
      status: String(live.status), externalTransactionId: (live.externalTransactionId as string | null) ?? null,
      settlementBasis: ((c.row.settlementBasis as string | undefined) ?? null), abandonedBeforeRemoteCall: ((c.row.abandonedBeforeRemoteCall as boolean | undefined) ?? null),
    })
    console.log(`# G7 precondition: ${c.name}: standing ${standing}`)
    assert.equal(standing, c.standing, `fixture is not the standing it names: ${c.name}`)
    const data = await getExceptionInboxData()
    const row = data.accountingPostingRefusals.find((candidate) => candidate.id === 'refusal-1')
    assert.ok(row, `${c.name}: the debt is still listed`)
    assert.equal(row.queuedRow, c.queuedRow, c.name)
    if (c.reports) {
      reported += 1
      assert.equal(row.retiredUnproven.length, 1, c.name)
      assert.match(row.retiredUnproven[0]!, c.reports, c.name)
      assert.match(String(row.handPostOrder), /check the ledger for that document first; post it ONLY if it is absent/i, `${c.name}: the order tells the operator to look first`)
      // And still offers the act that closes it: a retired row must not turn the remedy into a dead end.
      assert.match(String(row.handPostOrder), /Take for hand posting" FIRST/, c.name)
    } else {
      assert.deepEqual(row.retiredUnproven, [], `${c.name}: nothing unproven to report`)
      assert.doesNotMatch(String(row.handPostOrder), /Earlier attempt\(s\) at this posting were retired without proof/, c.name)
    }
  }
  console.log(`# G7 cases: ${cases.length}; reported-unproven ${reported}`)
  assert.equal(reported, 2)
})

test('[o3d-j625 r14] a refusal whose queued row MAY ALREADY HAVE POSTED is sent to the sync log, not to the ledger', async () => {
  liveSyncRows.length = 0
  // Claimed by a processor: it may have been sent and put back for a retry. `markPostingHandled` refuses
  // this, so "mark first" would be a dead end and the honest instruction is different.
  liveSyncRows.push(liveRowFor({ attemptRevision: 3 }))
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')

  const data = await getExceptionInboxData()
  const row = data.accountingPostingRefusals.find((candidate) => candidate.id === 'refusal-1')

  assert.ok(row, 'still listed')
  assert.equal(row.queuedRow, 'may-be-sent')
  console.log(`[r14/r16 may-be-sent] queuedRow=${row.queuedRow} order=${JSON.stringify(row.handPostOrder)}`)
  assert.equal(row.remedy, refusalRows[0].remedy, 'the site\'s own remedy, verbatim (r16)')
  assert.ok(row.handPostOrder)
  assert.match(row.handPostOrder, /DO NOT POST THIS BY HAND\./)
  assert.match(row.handPostOrder, /settle THAT row first/,
    'the operator is sent to the surface that owns the ambiguity, and told the claim will refuse until they '
    + 'have been')
  assert.ok(!/Take for hand posting" FIRST/.test(row.handPostOrder),
    'and NOT told to take it first, because taking it refuses a row that may have been sent — an '
    + 'instruction that ends in a refusal is not a remedy')
})

test('[o3d-j625 r14] CONTROL — with NO live row the refusing site\'s own remedy stands, and post-by-hand is what it says', async () => {
  /**
   * Round 12's property, unchanged: a genuinely owed posting reaches the inbox with the instruction the
   * refusing site wrote. Without this control the two tests above are satisfied by rewriting EVERY
   * refusal's remedy, which would bury the one instruction that is correct when nothing can post.
   */
  liveSyncRows.length = 0
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')

  const data = await getExceptionInboxData()
  const row = data.accountingPostingRefusals.find((candidate) => candidate.id === 'refusal-1')

  assert.ok(row, 'listed')
  assert.equal(row.queuedRow, null, 'nothing live for this posting key')
  assert.equal(row.remedy, refusalRows[0].remedy,
    'so the remedy is the refusing site\'s own, verbatim — this is the ordinary case and it must not be '
    + 'rewritten')
  console.log(`[r14 control] queuedRow=${row.queuedRow} remedy=${JSON.stringify(row.remedy)}`)
})

test('[o3d-j625 r14] receipt A\'s queued row does not rewrite receipt B\'s remedy — the key is the POSTING, not the document', async (t) => {
  /**
   * o3d-j625 r5 HIGH 3, re-asked of the INSTRUCTION. An INVOICE_PAYMENT is one RECEIPT against one
   * document, so receipt A's queued row says nothing about receipt B's refusal — and a classification keyed
   * on the three indexed columns alone would rewrite B's remedy from A's row, which is the old
   * document-scoped sync-log mistake moved into the operator's instructions.
   *
   * THIS TEST EXISTS IN THIS SHAPE BECAUSE A MUTATION FOUND THE FIRST ONE VACUOUS. That version used a live
   * row of a different TYPE, so the map key already differed without `scope` and dropping `scope`
   * (mutation z5) changed nothing — the test passed while examining nothing. Receipt A and receipt B differ
   * in EXACTLY `scope`, so the mutation now fails, which is the only thing that makes this assertion
   * evidence about the key rather than about the type.
   */
  liveSyncRows.length = 0
  liveSyncRows.push(liveRowFor({
    type: 'INVOICE_PAYMENT',
    payload: { paymentId: 'pay-A', _idempotencyKey: 'invoice-payment:so-1:pay-A' },
  }))
  allRows.push({ ...receiptBRefusal, resolvedAt: null })
  t.after(() => { allRows.splice(allRows.findIndex((row) => row.id === receiptBRefusal.id), 1) })
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')

  const data = await getExceptionInboxData()
  const receiptA = data.accountingPostingRefusals.find((candidate) => candidate.id === 'refusal-1')
  const receiptB = data.accountingPostingRefusals.find((candidate) => candidate.id === 'refusal-receipt-b')

  assert.ok(receiptB, 'PRECONDITION: receipt B\'s refusal is listed — without it this test examines nothing')
  console.log(`[r14 scope] receiptB.queuedRow=${receiptB.queuedRow} receiptB.remedy=${JSON.stringify(receiptB.remedy)}`)
  assert.equal(receiptB.queuedRow, null,
    'receipt A is queued; receipt B is a DIFFERENT posting on the same document and nothing is queued for it')
  assert.equal(receiptB.remedy, receiptBRefusal.remedy,
    'so B keeps its own remedy. Keyed on the document instead of the posting, B would be told not to post a '
    + 'receipt nothing has queued — and the receipt that IS owed would never be entered')
  // And the SALES_INVOICE refusal is untouched too: a different type is also a different posting.
  assert.equal(receiptA?.queuedRow, null)
  assert.equal(receiptA?.remedy, refusalRows[0].remedy)
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 * o3d-j625 r16 (Codex round 15, HIGH 2) — A COMPLETED POSTING OF AN EARLIER EDIT IS NOT A ROW THAT COULD
 * POST *THIS* REFUSAL
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * SALES_INVOICE_UPDATE and PURCHASE_INVOICE_UPDATE share one posting key across successive edits by design.
 * r14 asked only "is this row provably unsent?", so edit 1's SYNCED row classified edit 2's refusal as
 * `may-be-sent` — and the remedy then refuses for ever, sending the operator to settle a row that succeeded.
 * The discriminator is the pair of predicates that already existed: `isPostableAccountingSyncStatus` (can it
 * still post?) and `postingKeyIsReusedAcrossPostings` (is it a different posting?).
 */
const invoiceUpdateRefusal = {
  id: 'refusal-invoice-update',
  type: 'SALES_INVOICE_UPDATE',
  referenceType: 'SalesOrder',
  referenceId: 'so-2',
  scope: '',
  kind: 'sales_invoice_update',
  chartConnector: 'xero',
  activeConnector: 'quickbooks',
  reason: 'retired_chart',
  committed: 'the order SO-1002 holds edit 2 in IMS and the ledger holds edit 1',
  remedy: 'Re-save the order once the accounting connector selection has settled.',
  refusedCount: 1,
  firstRefusedAt: new Date('2026-09-12T08:00:00.000Z'),
  lastRefusedAt: new Date('2026-09-12T08:00:00.000Z'),
}

test('[o3d-j625 r16 HIGH 2] an EARLIER edit\'s completed row leaves the newly refused edit with a usable remedy', async (t) => {
  liveSyncRows.length = 0
  liveSyncRows.push({
    type: 'SALES_INVOICE_UPDATE',
    referenceType: 'SalesOrder',
    referenceId: 'so-2',
    payload: {},
    status: 'SYNCED',
    attemptRevision: 1,
    externalTransactionId: 'INV-EDIT-1',
  })
  allRows.push({ ...invoiceUpdateRefusal, resolvedAt: null })
  t.after(() => {
    allRows.splice(allRows.findIndex((row) => row.id === invoiceUpdateRefusal.id), 1)
    liveSyncRows.length = 0
  })
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')

  const data = await getExceptionInboxData()
  const row = data.accountingPostingRefusals.find((candidate) => candidate.id === invoiceUpdateRefusal.id)

  assert.ok(row, 'PRECONDITION: the debt is listed — the ledger holds a stale invoice, which is real work')
  console.log(`[r16 HIGH-2 surface] queuedRow=${row.queuedRow} earlier=${JSON.stringify(row.earlierPostings)} order=${JSON.stringify(row.handPostOrder)}`)

  assert.equal(row.queuedRow, null,
    'THE FINDING: the only row for this posting key POSTED AN EARLIER EDIT. It can never post again and it '
    + 'is not this refusal\'s posting, so classifying this refusal as "may already have been sent" leaves '
    + 'the current ledger update with no remedy at all.')
  assert.deepEqual(row.earlierPostings, ['INV-EDIT-1'],
    'and it is NOT silently ignored: the document the ledger already holds is named, because the hand '
    + 'posting replaces it rather than joining it')
  assert.ok(row.handPostOrder)
  assert.match(row.handPostOrder, /Take for hand posting" FIRST/,
    'so the way forward is the ordinary one — take it, post it, confirm it')
  assert.match(row.handPostOrder, /The ledger holds INV-EDIT-1 for this obligation \(confirmed by the connector\)/, 'with what the ledger holds stated')
  assert.match(row.handPostOrder, /check the ledger for the CURRENT version/, 'and the instruction is the CURRENT-version check, so the operator updates that document instead of raising a second one or stopping at the earlier one')
  assert.doesNotMatch(row.handPostOrder, /post it in the ledger now/i, 'Codex r9: an earlier document exists, so the plain wording is unreachable')
  assert.equal(row.remedy, invoiceUpdateRefusal.remedy, 'and the site\'s own remedy is verbatim')
})

test('[o3d-1e7sl Codex r6] an earlier edit whose document id an OPERATOR typed in keeps its standing in the inbox order: not "REPLACES", not "post it now"', async (t) => {
  liveSyncRows.length = 0
  liveSyncRows.push({
    type: 'SALES_INVOICE_UPDATE', referenceType: 'SalesOrder', referenceId: 'so-2', payload: {},
    status: 'SYNCED', attemptRevision: 1, externalTransactionId: 'INV-TYPED-1', settlementBasis: 'OPERATOR_ASSERTION',
  })
  allRows.push({ ...invoiceUpdateRefusal, resolvedAt: null })
  t.after(() => {
    allRows.splice(allRows.findIndex((row) => row.id === invoiceUpdateRefusal.id), 1)
    liveSyncRows.length = 0
  })
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')
  const data = await getExceptionInboxData()
  const row = data.accountingPostingRefusals.find((candidate) => candidate.id === invoiceUpdateRefusal.id)
  assert.ok(row)
  assert.deepEqual(row.earlierPostingDetails, [{ ref: 'INV-TYPED-1', standing: 'ASSERTED_POSTED' }], 'the standing survives into the inbox row')
  assert.match(row.handPostOrder ?? '', /INV-TYPED-1 \(an id an operator typed in\) as posted/)
  assert.match(row.handPostOrder ?? '', /has NOT verified it\./)
  assert.match(row.handPostOrder ?? '', /check the ledger for the CURRENT version/)
  assert.doesNotMatch(row.handPostOrder ?? '', /ALREADY holds|REPLACES|post it in the ledger now|Then post it,/i)
})

test('[o3d-1e7sl Codex r7] the inbox order for a COMBINED state (retired unproven attempt AND confirmed earlier invoice): the earlier invoice never satisfies "do not post again"', async (t) => {
  liveSyncRows.length = 0
  liveSyncRows.push({ type: 'SALES_INVOICE_UPDATE', referenceType: 'SalesOrder', referenceId: 'so-2', payload: {}, status: 'SYNCED', attemptRevision: 1, externalTransactionId: 'INV-EDIT-1' })
  liveSyncRows.push({ type: 'SALES_INVOICE_UPDATE', referenceType: 'SalesOrder', referenceId: 'so-2', payload: {}, status: 'CANCELLED', attemptRevision: 1, externalTransactionId: null })
  allRows.push({ ...invoiceUpdateRefusal, resolvedAt: null })
  t.after(() => {
    allRows.splice(allRows.findIndex((row) => row.id === invoiceUpdateRefusal.id), 1)
    liveSyncRows.length = 0
  })
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')
  const data = await getExceptionInboxData()
  const row = data.accountingPostingRefusals.find((candidate) => candidate.id === invoiceUpdateRefusal.id)
  assert.ok(row)
  assert.equal(row.retiredUnproven.length, 1, 'PRECONDITION: the retired unproven attempt is reported')
  assert.equal(row.earlierPostings.length, 1, 'PRECONDITION: and so is the confirmed earlier invoice')
  const order = row.handPostOrder ?? ''
  assert.match(order, /check the ledger for the CURRENT version/)
  assert.match(order, /if the current version is there, do not post again/)
  assert.match(order, /if only an earlier version is there, apply the update to it/)
  assert.doesNotMatch(order, /If it exists, do not post again/, 'the earlier invoice being there does not satisfy the retired attempt\'s check')
})

test('[o3d-1e7sl Codex r7] the inbox order for a COMBINED BILL_PAYMENT state says "payment", not "update"', async (t) => {
  const billPaymentRefusal = { ...invoiceUpdateRefusal, id: 'refusal-bp', type: 'BILL_PAYMENT', referenceType: 'PurchaseInvoice', referenceId: 'bill-1', resolvedAt: null }
  liveSyncRows.length = 0
  liveSyncRows.push({ type: 'BILL_PAYMENT', referenceType: 'PurchaseInvoice', referenceId: 'bill-1', payload: {}, status: 'SYNCED', attemptRevision: 1, externalTransactionId: 'PAY-1' })
  liveSyncRows.push({ type: 'BILL_PAYMENT', referenceType: 'PurchaseInvoice', referenceId: 'bill-1', payload: {}, status: 'CANCELLED', attemptRevision: 1, externalTransactionId: null })
  allRows.push(billPaymentRefusal as never)
  t.after(() => {
    allRows.splice(allRows.findIndex((row) => row.id === 'refusal-bp'), 1)
    liveSyncRows.length = 0
  })
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')
  const data = await getExceptionInboxData()
  const row = data.accountingPostingRefusals.find((candidate) => candidate.id === 'refusal-bp')
  assert.ok(row, 'PRECONDITION: the bill payment refusal is listed')
  assert.equal(row.earlierPostings.length, 1, 'PRECONDITION: the earlier payment is carried')
  assert.match(row.handPostOrder ?? '', /check the ledger for the CURRENT payment/)
  assert.match(row.handPostOrder ?? '', /if only an earlier payment is there, register THIS payment as a NEW payment and do NOT alter the earlier payment/)
})

test('[o3d-j625 r16 HIGH 2 CONTROL] on a key that names ONE posting for ever, a completed row STILL blocks', async (t) => {
  /**
   * WHAT WOULD STILL PASS THE TEST ABOVE WITHOUT THIS ONE: ignoring every completed row, whatever its type.
   * That re-opens HIGH 1 — on a key that is not reused, a SYNCED row may be this very posting (a false debt
   * round 12 deliberately keeps), and telling the operator to post it by hand would duplicate it. refusal-1
   * is SALES_INVOICE, which is NOT in REUSED_POSTING_KEY_TYPES, and the same row shape must block there.
   */
  liveSyncRows.length = 0
  liveSyncRows.push(liveRowFor({ status: 'SYNCED', attemptRevision: 1, externalTransactionId: 'INV-ALREADY' }))
  t.after(() => { liveSyncRows.length = 0 })
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')

  const data = await getExceptionInboxData()
  const row = data.accountingPostingRefusals.find((candidate) => candidate.id === 'refusal-1')
  assert.ok(row)
  console.log(`[r16 HIGH-2 control] queuedRow=${row.queuedRow} earlier=${JSON.stringify(row.earlierPostings)}`)
  assert.equal(row.queuedRow, 'may-be-sent',
    'a completed row on a key that names one posting for ever may BE this posting, so it still blocks')
  assert.deepEqual(row.earlierPostings, [], 'and it is not an earlier edit — this key has no successive edits')
})

/**
 * o3d-j625 r16 (Codex round 15, HIGH 1) — WHO IS SETTLING IT, ON THE PAGE.
 *
 * The claim is what closes the interval, so the page has to show it: an operator who cannot see that
 * somebody else is in the ledger with this posting will go there too, and the claim would have bought
 * nothing at the only place it is read by a person.
 */
test('[o3d-j625 r16 HIGH 1] a claim held by ANOTHER operator is rendered as theirs, and offers no confirm', async (t) => {
  liveSyncRows.length = 0
  const target = allRows.find((row) => row.id === 'refusal-1')!
  target.handPostClaimedAt = new Date('2026-09-26T09:00:00.000Z')
  target.handPostClaimedBy = 'u2'
  t.after(() => { target.handPostClaimedAt = null; target.handPostClaimedBy = null })
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')

  const data = await getExceptionInboxData()
  const row = data.accountingPostingRefusals.find((candidate) => candidate.id === 'refusal-1')
  assert.ok(row)
  console.log(`[r16 claim other] claim=${JSON.stringify(row.handPostClaim)} order=${JSON.stringify(row.handPostOrder)}`)
  assert.ok(row.handPostClaim)
  assert.equal(row.handPostClaim.mine, false, 'the viewer is u1 and the holder is u2')
  assert.equal(row.handPostClaim.at, '2026-09-26T09:00:00.000Z')
  assert.ok(row.handPostOrder)
  assert.match(row.handPostOrder, /Do NOT post it as well/,
    'THE POINT: a second operator must be told somebody is in the ledger with this posting')
  assert.ok(!/Take for hand posting" FIRST/.test(row.handPostOrder),
    'and not invited to take it — the claim is held, so taking it would be refused')
  assert.equal(row.remedy, refusalRows[0].remedy, 'the site\'s own remedy, verbatim, still')
})

test('[o3d-j625 r16 HIGH 1] a claim held by the VIEWER says post it now, then confirm', async (t) => {
  liveSyncRows.length = 0
  const target = allRows.find((row) => row.id === 'refusal-1')!
  target.handPostClaimedAt = new Date('2026-09-26T09:30:00.000Z')
  target.handPostClaimedBy = 'u1'
  t.after(() => { target.handPostClaimedAt = null; target.handPostClaimedBy = null })
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')

  const data = await getExceptionInboxData()
  const row = data.accountingPostingRefusals.find((candidate) => candidate.id === 'refusal-1')
  assert.ok(row)
  console.log(`[r16 claim mine] claim=${JSON.stringify(row.handPostClaim)} order=${JSON.stringify(row.handPostOrder)}`)
  assert.ok(row.handPostClaim)
  assert.equal(row.handPostClaim.mine, true)
  assert.ok(row.handPostOrder)
  assert.match(row.handPostOrder, /YOU are settling this by hand/)
  assert.match(row.handPostOrder, /While you hold the claim, IMS does not queue this posting/,
    'which is the promise the claim actually makes, and the reason the order is safe')
  assert.match(row.handPostOrder, /"Mark as handled"/, 'and the acknowledgement is the SECOND step')
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 * o3d-j625 r18 (Codex round 17, HIGH 2) — EVERY ACTIVE CLAIM MUST BE DISCOVERABLE AND RELEASABLE
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A hand-post claim has NO EXPIRY, deliberately: r16 rejected a timer because a claim that lapsed would
 * re-open exactly the interval it closes. That decision is only safe if a human can always find the claim
 * and give it back. Round 17's finding is that they cannot: the only claim display and the only Release
 * control ride on the OUTSTANDING REFUSAL LIST, which takes the oldest 50 by `firstRefusedAt` with no claim
 * priority, no pagination and no stale-claim alert. With 50 older refusals standing, a holder who leaves
 * can leave a NEWER claim outside the actionable UI indefinitely — IMS goes on declining that posting while
 * the inbox shows nothing but an aggregate count.
 *
 * THE REPRODUCTION: 50 older refusals, then one newer refusal that is CLAIMED. The claim must be reachable
 * without depending on the refusal list's limit or its ordering.
 */
test('[o3d-j625 r18 HIGH 2] an active claim behind 50 older refusals is still listed, with its holder and age, and releasable', async () => {
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')
  const added: Array<Record<string, unknown>> = []
  // 50 older debts — exactly the cap, so the claimed row below cannot be the 51st by luck.
  for (let index = 0; index < 50; index += 1) {
    added.push({
      id: `older-${index}`,
      type: 'MANUFACTURING_JOURNAL',
      referenceType: 'ProductionOrder',
      referenceId: `po-old-${index}`,
      scope: '',
      kind: 'manufacturing_journal',
      chartConnector: 'xero',
      activeConnector: null,
      reason: 'retired_chart',
      committed: 'the production order is completed in IMS',
      remedy: 'Post the manufacturing journal by hand and mark this row handled.',
      refusedCount: 1,
      firstRefusedAt: new Date(`2026-08-${String((index % 28) + 1).padStart(2, '0')}T08:00:00.000Z`),
      lastRefusedAt: new Date('2026-09-01T08:00:00.000Z'),
      resolvedAt: null,
      handPostClaimedAt: null,
      handPostClaimedBy: null,
    })
  }
  const claimedRow = {
    id: 'claimed-newer',
    type: 'SALES_INVOICE_UPDATE',
    referenceType: 'SalesOrder',
    referenceId: 'so-claimed',
    scope: '',
    kind: 'sales_invoice_update',
    chartConnector: 'xero',
    activeConnector: null,
    reason: 'retired_chart',
    committed: 'the order is updated in IMS',
    remedy: 'Re-save the order once the cause is resolved, or correct the invoice by hand in the ledger.',
    refusedCount: 1,
    // NEWER than all fifty, which is precisely why the oldest-first cap hides it.
    firstRefusedAt: new Date('2026-09-25T08:00:00.000Z'),
    lastRefusedAt: new Date('2026-09-25T08:00:00.000Z'),
    resolvedAt: null,
    handPostClaimedAt: new Date('2026-09-20T08:00:00.000Z'),
    handPostClaimedBy: 'u2',
  }
  added.push(claimedRow)
  allRows.push(...added)

  try {
    const data = await getExceptionInboxData()

    // PRECONDITION — the cap really bites, and the claimed row really is outside it. Printed, so a fixture
    // that stopped exercising the limit is visible rather than inferred.
    console.log(`[r18 HIGH-2] refusal rows listed=${data.accountingPostingRefusals.length} `
      + `claimed row present=${data.accountingPostingRefusals.some((row) => row.id === 'claimed-newer')}`)
    assert.equal(data.accountingPostingRefusals.length, 50,
      'PRECONDITION: the actionable list is capped at 50 and the cap is reached')
    assert.equal(data.accountingPostingRefusals.some((row) => row.id === 'claimed-newer'), false,
      'PRECONDITION (and the finding): the claim is NOT in the list that carries the Release control')

    // THE FINDING. A claim with no expiry must be reachable independently of that list.
    const claims = (data as unknown as { accountingHandPostClaims?: Array<Record<string, unknown>> }).accountingHandPostClaims
    assert.ok(Array.isArray(claims),
      'THE FINDING (round 17 HIGH 2): there is no view of the active hand-post claims at all. The only '
      + 'Release control rides on the oldest-50 refusal list, so a claim behind 50 older debts is a '
      + 'permanent suppression nobody can reach — and r16 removed the expiry that would otherwise end it.')
    assert.equal(claims.length, 1, 'every active claim, not the ones that happen to be in the refusal page')
    const claim = claims[0] as Record<string, unknown>
    assert.equal(claim.refusalId, 'claimed-newer', 'named by the row Release acts on, so the control works from here')
    assert.equal(claim.by, 'u2')
    assert.equal(claim.byName, 'u2', 'a user id in an instruction is not something an operator can act on')
    assert.equal(claim.mine, false, 'the viewer is u1')
    assert.equal(claim.at, '2026-09-20T08:00:00.000Z')
    assert.equal(typeof claim.heldForHours, 'number', 'and its AGE, which is the only stale signal a claim can have')
    assert.equal(claim.stale, true, 'held since 2026-09-20 — long past the threshold, and flagged as such')
    assert.equal(claim.type, 'SALES_INVOICE_UPDATE')
    assert.equal(claim.referenceId, 'so-claimed')

    // AND IT IS COUNTED, so the page can say "N postings are being settled by hand" without listing them.
    assert.equal((data.summary as unknown as { accountingHandPostClaims?: number }).accountingHandPostClaims, 1)

    // AND IT IS ITS OWN QUERY. Same predicate/ordering/cap as the refusal list would be the bug itself.
    assert.ok(seen.claimsWhere, 'the claims view has its own query')
    /**
     * o3d-j625 r22 (Codex round 21, HIGH) — THE WALK IS ORDERED BY IDENTITY, AND BY NOTHING ELSE.
     *
     * r20 ordered it `[{ handPostClaimedAt }, { id }]` — oldest claim first, with the id as a total-order
     * tiebreak because the timestamp is not unique. Round 21 showed the timestamp is not STABLE either: it is
     * rewritten on every re-take from an application clock, and a cursor over a rewritable key can put the
     * same row on both sides of itself, so a re-taken claim beyond page one is skipped (or shown twice) and
     * the walk still reports completeness. An id is assigned at creation and rewritten by nothing here, so it
     * is both total and FIXED. The surfacing oldest-claim-first bought moves to `longestHeld`, below.
     */
    assert.deepEqual(seen.claimsOrderBy, [{ id: 'asc' }],
      'IDENTITY, which a re-take cannot rewrite — the walk\'s completeness is a property of that')
    assert.deepEqual(seen.longestHeldOrderBy, [{ handPostClaimedAt: 'asc' }, { id: 'asc' }],
      'and the age-ordered head is the ONE place the claim time still orders anything — nothing paginates '
      + 'through it, so a rewritable key is harmless there')
    assert.ok((seen.longestHeldTake ?? 0) > 0 && (seen.longestHeldTake ?? 0) <= 10,
      `and it is short: ${seen.longestHeldTake} rows, a look rather than a route`)
    // r18 asserted the cap was BIGGER than the refusal list's. Round 19's finding is that a bigger cap is
    // still a cap, so what is asserted now is that the section carries a way PAST it.
    assert.equal(
      (data as unknown as { accountingHandPostClaimsNextCursor?: string | null }).accountingHandPostClaimsNextCursor ?? null,
      null,
      'one claim fits on the first page, so there is no next page to advertise')
    assert.equal(seen.claimsTake, 51, 'the page is read with ONE row over, which is how "is there a next page" is answered')
  } finally {
    for (const row of added) allRows.splice(allRows.indexOf(row), 1)
  }
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 * o3d-j625 r20 (Codex round 19, HIGH) — THE RELEASE CONTROL IS RENDERED FOR EVERY CLAIM THE WALK RETURNS
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * r18's HIGH-2 test asserted that each claim row CARRIED `refusalId` — the field Release acts on — and I
 * disclosed at the time that carrying the field is not offering the control. Round 19's finding is about a
 * claim "the UI renders Release only for" some of, so the field is exactly the wrong thing to assert.
 *
 * The behavioural half is proven where it can be executed: tests/accounting/posting-refusal-mark-handled
 * walks past the page boundary, finds the claim, and RELEASES it through the real server action. What is
 * left is that the page offers that action on every row it draws, and that is a fact about the component's
 * source, so it is read as source — the same way this repository already asserts the inbox's other copy.
 *
 * WHAT WOULD STILL PASS THIS: a Release button rendered outside the claims table, or one wired to the wrong
 * id. The first is excluded by slicing the claims `.map(` block itself; the second by requiring the handler
 * to name `claim.refusalId`, which is the id the action takes. What it does NOT establish is that the
 * button is reachable on a narrow screen or that the row is visible — no source test can.
 */
test('[o3d-j625 r20 HIGH] the claims section offers Release on EVERY row, unconditionally', async () => {
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const source = await readFile(
    path.join(process.cwd(), 'app', '(dashboard)', 'sync', 'exceptions', 'exceptions-client.tsx'),
    'utf8',
  )

  // The claims table's row block, sliced so nothing outside it can satisfy the assertions below.
  const start = source.indexOf('{claims.map((claim) => (')
  assert.ok(start >= 0, 'the claims table must still map over the walked rows, or this test asserts nothing')
  const end = source.indexOf('</Table>', start)
  assert.ok(end > start, 'and the block must terminate, or the slice is the whole file')
  const block = source.slice(start, end)
  console.log(`[r20 control] claims row block = ${block.length} chars`)

  const releaseHandlers = [...block.matchAll(/setReleasingRefusal\(\{ id: claim\.refusalId/g)]
  console.log(`[r20 control] Release handlers bound to claim.refusalId: ${releaseHandlers.length}`)
  assert.equal(releaseHandlers.length, 1,
    'exactly ONE Release control per claim row, wired to the id the release action takes')
  assert.match(block, /Release\s*<\/Button>/, 'and it is labelled Release, which is what the operator looks for')

  /**
   * AND IT IS NOT CONDITIONAL. This is the assertion round 19's finding is really about: r16's REFUSAL rows
   * gate their controls on `handPostClaim`/`mine`, and a claims row that did the same would hide the control
   * on exactly the claims a departed holder left behind. The check is about the GRAMMAR of the guard — any
   * `mine`, any `?`-guarded Button — rather than about proximity to a correcting comment.
   */
  const releaseCell = block.slice(block.lastIndexOf('<TableCell', block.indexOf('setReleasingRefusal')))
  assert.doesNotMatch(releaseCell, /claim\.mine/,
    'the Release control must not be gated on whose claim it is — anybody with sync may end one, and a '
    + 'holder-only control is a departed holder\'s permanent suppression')
  assert.doesNotMatch(releaseCell, /\?\s*\(\s*<Button/,
    'nor gated on anything else: every row the walk returns is one somebody must be able to act on')

  // NON-VACUITY: the same slice DOES contain a conditional elsewhere in the row, so "no conditional" is a
  // fact about this cell and not about a regex that never matches anything in this file.
  assert.match(block, /claim\.stale \? \(/, 'the row does render something conditionally, so the check above can fail')
})

/**
 * o3d-j625 r20 — AND THE PAGE SAYS WHAT THE LOOKUP SEARCHES, in the words the query actually uses.
 *
 * "I searched and it was not there" must never be evidence that a claim does not exist. The hint and the
 * predicate are written in two places and would otherwise drift; this holds them together.
 */
test('[o3d-j625 r20] the lookup hint names every field the query matches, and disclaims the one it does not', async () => {
  const [{ ACCOUNTING_POSTING_HAND_POST_CLAIM_SEARCH_HINT }, { readFile }, path] = await Promise.all([
    import('@/lib/domain/accounting/posting-refusal-copy'),
    import('node:fs/promises'),
    import('node:path'),
  ])
  const actions = await readFile(path.join(process.cwd(), 'app', 'actions', 'sync-exceptions.ts'), 'utf8')
  const start = actions.indexOf('function handPostClaimSearchWhere')
  assert.ok(start >= 0, 'the search predicate must still be a named function, or this test asserts nothing')
  const predicate = actions.slice(start, actions.indexOf('\n}', start))
  const fields = ['id', 'referenceId', 'referenceType', 'type']
  for (const field of fields) {
    assert.match(predicate, new RegExp(`\\b${field}:`), `PRECONDITION: the query matches ${field}`)
  }
  console.log(`[r20 hint] predicate fields=${JSON.stringify(fields)}`)
  assert.match(ACCOUNTING_POSTING_HAND_POST_CLAIM_SEARCH_HINT, /reference id/i)
  assert.match(ACCOUNTING_POSTING_HAND_POST_CLAIM_SEARCH_HINT, /reference type/i)
  assert.match(ACCOUNTING_POSTING_HAND_POST_CLAIM_SEARCH_HINT, /posting type/i)
  assert.match(ACCOUNTING_POSTING_HAND_POST_CLAIM_SEARCH_HINT, /refusal id/i)
  // The disclaimer is the load-bearing half: the holder's NAME is resolved after the read, so it cannot be
  // searched, and a hint that stayed silent about it would make an empty result look like an absent claim.
  assert.doesNotMatch(predicate, /handPostClaimedBy/, 'PRECONDITION: the holder is genuinely not searched')
  assert.match(ACCOUNTING_POSTING_HAND_POST_CLAIM_SEARCH_HINT, /NOT the holder/i, 'and the page says so')
})

/**
 * o3d-j625 r22 (Codex round 21, HIGH) — THE INBOX SHIPS THE AGE-ORDERED HEAD, AND THE PAGE RENDERS IT.
 *
 * The walk is ordered by identity, so its first page is no longer the oldest claims. `longestHeld` is what
 * keeps a stranded claim surfacing without being hunted, and it is only useful if the page actually draws it
 * with a Release on each row. The behavioural half (what the query returns) is proven in
 * tests/accounting/posting-refusal-mark-handled; this is the half that is a fact about the component.
 *
 * WHAT WOULD STILL PASS THIS: a head rendered below the walk rather than above it (position is not asserted —
 * only that it exists, is age-ordered and is actionable), and a head whose rows are visually cramped. What it
 * does establish is that the surfacing is not merely computed and then dropped.
 */
test('[o3d-j625 r22 HIGH] the inbox ships the longest-held head, and the page draws it with a Release on each row', async () => {
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')
  const added = [
    { id: 'lh-ancient', at: new Date('2026-01-01T00:00:00.000Z') },
    { id: 'lh-recent', at: new Date('2026-09-25T00:00:00.000Z') },
  ].map((seed) => ({
    id: seed.id,
    type: 'SALES_INVOICE_UPDATE',
    referenceType: 'SalesOrder',
    referenceId: `so-${seed.id}`,
    scope: '',
    kind: 'sales_invoice_update',
    chartConnector: 'xero',
    activeConnector: null,
    reason: 'retired_chart',
    committed: 'the order is updated in IMS',
    remedy: 'Re-save the order once the cause is resolved.',
    refusedCount: 1,
    firstRefusedAt: new Date('2026-09-25T08:00:00.000Z'),
    lastRefusedAt: new Date('2026-09-25T08:00:00.000Z'),
    resolvedAt: null,
    handPostClaimedAt: seed.at,
    handPostClaimedBy: 'u2',
  }))
  allRows.push(...added)
  try {
    const data = await getExceptionInboxData()
    const head = (data as unknown as { accountingHandPostClaimsLongestHeld?: Array<{ refusalId: string; stale: boolean }> })
      .accountingHandPostClaimsLongestHeld
    console.log(`[r22 surface head] ${JSON.stringify(head?.map((claim) => claim.refusalId))} `
      + `walkCursor=${(data as unknown as { accountingHandPostClaimsNextCursor?: string | null }).accountingHandPostClaimsNextCursor}`)
    assert.ok(Array.isArray(head), 'the inbox payload carries it')
    assert.deepEqual(head.map((claim) => claim.refusalId), ['lh-ancient', 'lh-recent'], 'held longest FIRST')
    assert.equal(head[0]!.stale, true, 'and the longest-held one is flagged')
    /**
     * o3d-j625 r26 (owner decision) — NOTHING IN THE PAYLOAD SUPPORTS A COMPLETENESS CLAIM ANY MORE.
     *
     * r22 sent `totalAtEnd`; r24 replaced it with `claimSetRevision`. Both are gone with the sentence they
     * existed for. Asserted as an ABSENCE — a universal check — because leaving either field in the contract
     * is how a later change starts consulting it again, and the whole point of the scope decision is that
     * there is no longer anything to consult.
     */
    assert.equal((data as unknown as { accountingHandPostClaimsTotalAtEnd?: unknown }).accountingHandPostClaimsTotalAtEnd,
      undefined, 'r22\'s count is gone from the payload')
    assert.equal((data as unknown as { accountingHandPostClaimsRevision?: unknown }).accountingHandPostClaimsRevision,
      undefined, 'and so is r24\'s revision')

    const { readFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const source = await readFile(
      path.join(process.cwd(), 'app', '(dashboard)', 'sync', 'exceptions', 'exceptions-client.tsx'),
      'utf8',
    )
    const start = source.indexOf('{data.accountingHandPostClaimsLongestHeld.map(')
    assert.ok(start >= 0, 'the page must map over the head, or this test asserts nothing about rendering')
    const block = source.slice(start, source.indexOf('</ul>', start))
    console.log(`[r22 surface head] rendered block = ${block.length} chars`)
    assert.match(block, /setReleasingRefusal\(\{ id: claim\.refusalId/,
      'each head row offers Release, wired to the id the release action takes')
    assert.match(block, /heldForHours/, 'and shows how long it has been held, which is the whole point of the block')
    /*
     * NOT GATED ON WHOSE CLAIM IT IS. The rule is about the GRAMMAR of the guard — a conditional wrapping an
     * ELEMENT — not about the identifier appearing at all: the row legitimately reads `claim.mine ? 'you' :
     * …` to name the holder, and banning the word would make this test about the wording instead of the
     * control. A holder-only Release is a departed holder's permanent suppression, which is what both this
     * block and the walk beneath it exist to end.
     */
    assert.doesNotMatch(block, /claim\.mine \?\s*\(/, 'and its Release is not wrapped in a holder conditional')
    assert.doesNotMatch(block, /\?\s*\(\s*<Button/, 'nor in any other conditional')
    assert.match(block, /claim\.mine \? 'you'/, 'CONTROL: the identifier IS present, for the holder\'s name — so '
      + 'the checks above are about a conditional around the control and not about a word never written here')
  } finally {
    for (const row of added) allRows.splice(allRows.indexOf(row), 1)
  }
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 * o3d-j625 r26 (owner decision, after Codex rounds 19/21/23/25) — THE COMPLETENESS SENTENCE IS ABSENT
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Four rounds and eight HIGHs went to one property: "that is every active claim". r20 answered a cap with a
 * walk, r22 answered a rewritable key with the row's id and a count, r24 answered the count with a strictly
 * increasing revision, and r25 still found two more ways the assertion was wrong plus a clear that orphaned a
 * claim outright. The owner's decision is to remove the claim rather than defend it a fifth time.
 *
 * This test is the ratchet. It is an ABSENCE check — universal, so unlike an `includes` it has no room for a
 * correcting line sitting beside a stale one — and it bans the hedges as well as the sentence, because
 * "probably everything" is the same defect with a qualifier.
 *
 * WHAT WOULD STILL PASS THIS: a completeness claim phrased in words nobody has thought of (the list below is
 * finite), and a claim made somewhere other than this component — the server no longer ships anything that
 * could support one, which the payload-absence assertions above cover. What it does establish is that the
 * specific sentence and its known weakenings cannot come back unnoticed.
 */
test('[o3d-j625 r26] the claims section makes NO completeness claim, and no hedged version of one', async () => {
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const client = await readFile(
    path.join(process.cwd(), 'app', '(dashboard)', 'sync', 'exceptions', 'exceptions-client.tsx'),
    'utf8',
  )
  const actions = await readFile(path.join(process.cwd(), 'app', 'actions', 'sync-exceptions.ts'), 'utf8')

  // The rendered strings only: a comment may (and does) explain what was removed and why.
  const rendered = client.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const banned: Array<[RegExp, string]> = [
    [/every active claim/i, 'the sentence itself'],
    [/that is (all|every)/i, 'its shorter forms'],
    [/all (of them|the claims)/i, 'and its paraphrases'],
    [/(probably|likely|should be) (everything|complete|all)/i, 'a HEDGED claim, which is the same defect with a qualifier'],
    [/nothing (else|more) (is|was) held/i, 'a claim made by denying the complement'],
    [/(list|walk) is complete/i, 'a claim about the list rather than the claims'],
  ]
  for (const [pattern, why] of banned) {
    assert.doesNotMatch(rendered, pattern, `the page must not claim completeness — ${why}`)
  }

  // AND THE MACHINERY IS GONE, not merely unread: a field nothing consults is how a later change starts
  // consulting it. Both of the supports the removed sentence had are absent from the server contract.
  /*
   * The identifiers as CODE — declared, assigned or read — rather than anywhere in the text. Both modules
   * explain at length what was removed and why, and naming a deleted field in a comment is the opposite of
   * shipping it; stripping comments first was tried and is fragile, because a string literal containing a
   * comment delimiter shifts the pairing.
   */
  for (const [source, name, label] of [
    [actions, 'totalAtEnd', 'r22\'s count is gone from the page contract'],
    [actions, 'claimSetRevision', 'and r24\'s revision is gone from it too'],
    [client, 'claimsRevisionAtStart', 'with no client state left to compare against'],
    [client, 'claimsRevisionNow', 'and none to compare'],
  ] as Array<[string, string, string]>) {
    assert.doesNotMatch(source, new RegExp(`\\b${name}\\s*:`), `${label} (no declaration or assignment)`)
    assert.doesNotMatch(source, new RegExp(`\\.${name}\\b`), `${label} (no read)`)
    assert.doesNotMatch(source, new RegExp(`\\b${name}\\s*[!=<>]`), `${label} (no comparison)`)
  }

  // NON-VACUITY: the section still EXISTS and still says what it is for, so this is an absence inside a
  // living surface rather than a test that passes because the whole feature was deleted.
  assert.match(rendered, /Postings being settled by hand/, 'the section is still there')
  assert.match(rendered, /Show more claims/, 'with paging as navigation')
  assert.match(rendered, /Release/, 'and Release on its rows')
  console.log('[r26 absence] section present, completeness claim and both of its supports absent')
})

/**
 * o3d-j625 r26 — AND THE COPY SAYS WHAT THE SECTION *DOES* MEAN, since it no longer says what it used to.
 *
 * WHAT WOULD STILL PASS THIS: copy that is accurate but unhelpful. It establishes that the three things that
 * actually make a stranded claim actionable are described to the operator rather than left to be discovered.
 */
test('[o3d-j625 r26] the section copy describes finding a claim, not having seen them all', async () => {
  const copy = await import('@/lib/domain/accounting/posting-refusal-copy')
  const detail = copy.ACCOUNTING_POSTING_HAND_POST_CLAIM_DETAIL
  console.log(`[r26 copy] ${detail.slice(0, 160)}…`)
  assert.doesNotMatch(detail, /every active claim is reachable/i,
    'the heading detail no longer promises reachability as a property — that promise is what four rounds of '
    + 'findings were about')
  assert.match(detail, /oldest|longest/i, 'it says the longest-held come first')
  assert.match(detail, /search|find|look/i, 'it points at the lookup for a specific document')
  assert.match(detail, /anybody with sync access may release/i, 'and it still states who may release a claim')
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 * o3d-j625 r26 (Codex round 25, HIGH 1) — EVERY WRITER TO A REFUSAL ROW, AND WHETHER IT CONSIDERS THE CLAIM
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Round 25's HIGH 1 was one unguarded writer. The question it raises is the census: are there OTHERS? A
 * second unguarded writer is round 27, so this enumerates them from the SOURCE and requires each to be
 * accounted for, in the shape this repository already uses for the sync-log-row primitive census.
 *
 * THE FINDINGS OF THE CENSUS, and each is asserted below rather than asserted in prose:
 *
 *   posting-mark-handled.ts   the CLAIM write        — predicate `handPostClaimedAt: null` (only one claimant)
 *                             the RELEASE            — predicate `handPostClaimedAt: { not: null }`
 *                             the KEEP-OUTSTANDING   — reached only with the claim held and clears it
 *                             the RESOLVE            — reached only with the claim held and clears it
 *   posting-refusal-inbox.ts  the CLEAR              — predicate `handPostClaimedAt: null` (r26's fix)
 *                             the REOPEN reset       — `resolvedAt: { not: null }`, so never a claimed row:
 *                                                      a resolved row cannot hold a claim, because both mark
 *                                                      exits clear it
 *                             the RECORD update      — sets `resolvedAt: null`; it REOPENS rather than ending
 *                                                      a life, and r18 depends on it reaching a claimed row so
 *                                                      a postponed edit becomes visible debt
 *                             the RECORD upsert      — creates a row that by construction has no claim
 *   posting-suppression.ts    the DEFERRAL bump      — requires `handPostClaimedAt: { not: null }`: it exists
 *                                                      only to record what a live claim postponed
 *
 * NOTHING ELSE WRITES THE TABLE. No production path deletes a refusal row, and no other module reaches it.
 *
 * WHAT WOULD STILL PASS THIS: a writer added through a differently-named local alias (the walk looks for
 * `accountingPostingRefusal.<verb>` and the inbox's own `table.<verb>`), and a writer in a file not on the
 * list below. The list is derived from a repo-wide grep asserted here to find exactly these three files, so a
 * fourth file gaining a writer fails the file-set assertion rather than slipping past the per-site one.
 */
test('[o3d-j625 r26] every writer to a refusal row accounts for the hand-post claim', async () => {
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const root = process.cwd()

  // THE FILE SET, from the repository rather than from this list — so a writer in a new file is a failure
  // here and not an omission nobody notices.
  const grep = execFileSync('grep', [
    '-rlE', String.raw`(accountingPostingRefusal|\btable)\.(update|updateMany|upsert|delete|deleteMany|create)\(`,
    'lib', 'app', 'scripts',
  ], { cwd: root, encoding: 'utf8' })
  const files = grep.split('\n').filter((line) => line && !line.startsWith('app/generated/'))
    .filter((f) => /posting-refusal-inbox|posting-mark-handled|posting-suppression/.test(f)
      || /accountingPostingRefusal\.(update|updateMany|upsert|delete|deleteMany|create)\(/.test(readFileSync(path.join(root, f), 'utf8')))
  console.log(`[r26 census] files with refusal-row writers: ${JSON.stringify(files)}`)


  const expected = [
    'lib/domain/accounting/posting-mark-handled.ts',
    'lib/domain/accounting/posting-refusal-inbox.ts',
    'lib/domain/accounting/posting-suppression.ts',
  ]
  for (const file of expected) {
    assert.ok(files.includes(file), `PRECONDITION: the walk must reach ${file}, or this census asserts nothing`)
  }
  const unexpected = files.filter((f) => !expected.includes(f))
  assert.deepEqual(unexpected, [],
    'a NEW file writes accounting_posting_refusals. Add it to this census and say, for its every write, whether '
    + 'it can reach a row somebody is settling by hand — an unguarded writer is a permanent stuck suppression')

  // THE CLEAR carries the claim predicate. This is round 25's HIGH 1, asserted where it lives.
  const inbox = await readFile(path.join(root, 'lib/domain/accounting/posting-refusal-inbox.ts'), 'utf8')
  const clear = inbox.slice(inbox.indexOf('export async function clearAccountingPostingRefusal'))
  const clearBody = clear.slice(0, clear.indexOf('\n}\n'))
  assert.match(clearBody, /where: \{ \.\.\.key, resolvedAt: null, handPostClaimedAt: null \}/,
    'THE FIX: the clear can only close a row nobody is settling by hand. As a PREDICATE, so a claim taken '
    + 'between a read and this write cannot slip through')
  assert.match(clearBody, /reportClearDeclinedForHandPostClaim/,
    'and a clear that matched nothing is handled explicitly rather than as a silent no-op')
  assert.doesNotMatch(clearBody, /handPostClaimedAt: null,\s*handPostClaimedBy: null/,
    'and it NEVER clears the claim to make its own write succeed — taking it from an operator in the ledger is '
    + 'the duplicate-posting window r16 closed')

  // THE REOPEN RESET is safe by a different argument: a resolved row cannot hold a claim.
  assert.match(inbox, /where: \{ \.\.\.key, resolvedAt: \{ not: null \}, suppressedAt: null \}/,
    'the reopen reset only touches RESOLVED rows, and both mark exits clear the claim before resolving')

  // THE MARK's four writes.
  const mark = await readFile(path.join(root, 'lib/domain/accounting/posting-mark-handled.ts'), 'utf8')
  assert.match(mark, /where: \{ id: row\.id, resolvedAt: null, handPostClaimedAt: null \}/, 'the claim write admits one claimant')
  assert.match(mark, /where: \{ id: row\.id, resolvedAt: null, handPostClaimedAt: \{ not: null \} \}/, 'the release requires a claim')
  /**
   * THREE writes give the claim back, and each is reached only with a claim held: the RELEASE (whose predicate
   * demands `{ not: null }`) and the mark's TWO exits (both reached only after the mark has established that
   * the caller holds it). Counted, so a FOURTH place learning to clear a claim — which is how an operator loses
   * one from under themselves — fails here.
   */
  assert.equal((mark.match(/handPostClaimedAt: null,\n\s+handPostClaimedBy: null,/g) ?? []).length, 3,
    'exactly three writes give the claim back: the release and the mark\'s two exits')

  // THE DEFERRAL bump requires a live claim by construction.
  const suppression = await readFile(path.join(root, 'lib/domain/accounting/posting-suppression.ts'), 'utf8')
  assert.match(suppression, /where: \{ \.\.\.key, resolvedAt: null, handPostClaimedAt: \{ not: null \} \}/,
    'the deferral record only fires while a claim is held, which is the whole of what it records')

  // AND NOTHING DELETES A REFUSAL ROW in production, which is what lets the census reason about lifecycles.
  for (const file of expected) {
    const source = await readFile(path.join(root, file), 'utf8')
    assert.doesNotMatch(source, /accountingPostingRefusal\.delete/, `${file} must not delete refusal rows`)
  }
})

/**
 * o3d-j625 r28 (Codex round 27, HIGH 1) — EVERY CONSUMER OF A QUEUED ENQUEUE MUST BE ABLE TO SEE A DECLINE.
 *
 * The census above answers "does every WRITER consider the claim". Round 27 asked the same question one
 * layer out and the answer was no: the facade's post-queue clear declined correctly and then discarded the
 * fact, so `queued: true` reached every consumer. So this pins the OTHER half — that the decline is carried
 * in the outcome, by the single function that owns the decision, and that nothing clears a refusal after a
 * successful enqueue without going through it.
 *
 * WHAT WOULD STILL PASS IT: any wording change; a fourth clear call site that is NOT on a post-queue path
 * (the two in-transaction ones are named here as the exceptions they are, and are safe for a reason the
 * audit states — the key's lock is `pg_advisory_xact_lock`, held to commit, so no claim can be taken between
 * the row write and the clear in one transaction). It says nothing about what each consumer DOES with an
 * unqueued outcome: `postingIsOwed` and the per-site tests cover that.
 */
test('[o3d-j625 r28] a post-queue clear goes through the one function that also carries the decline', () => {
  const root = process.cwd()
  const read = (p: string) => readFileSync(path.join(root, p), 'utf8')

  const outcome = read('lib/domain/accounting/enqueue-outcome.ts')
  assert.match(outcome, /export async function settleQueuedEnqueueAgainstHandPostClaim/,
    'the one function that clears and adjusts together must exist')
  // The decline must MAP to an unqueued outcome. Asserted as the mapping, not as the presence of the word.
  assert.match(
    outcome,
    /case 'declined-hand-post-claim':\s*\n\s*return \{ \.\.\.outcome, queued: false, reason: 'hand-post-deferred' \}/,
    'THE FINDING: a declined clear must turn the outcome UNQUEUED. Returning `outcome` unchanged here is '
    + 'exactly what round 27 found — the refusal stays visible while the caller believes its work was queued.',
  )
  // ...and the exhaustiveness that makes a third decline reason a compile error rather than a fall-through.
  assert.match(outcome, /const unhandledClearOutcome: never = cleared/,
    'the switch must be exhaustive, so a new decline reason fails to compile instead of reporting queued')

  // The facade must not hand-roll the same decision beside it.
  const facade = read('lib/accounting.ts')
  assert.match(facade, /routed = await settleQueuedEnqueueAgainstHandPostClaim\(/,
    'the facade must route its post-queue clear through that function AND assign the result back')

  // And the clear itself must report the decline rather than swallow it.
  const inbox = read('lib/domain/accounting/posting-refusal-inbox.ts')
  assert.match(inbox, /export type PostingRefusalClearResult/,
    'the clear must return a result a caller can discriminate, not void')
  assert.match(inbox, /outcome: 'declined-hand-post-claim',/, 'and name the claimed case')

  // NON-VACUITY: every remaining clear call site is one of the two in-transaction ones, which are safe
  // because the caller's transaction holds the posting key's lock across both statements. A new call site
  // outside this list is a post-queue path that must use the function above.
  const callers = execFileSync('grep', [
    '-rln', 'clearAccountingPostingRefusal(', '--include=*.ts', 'lib', 'app',
  ], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).filter((f) => !f.startsWith('app/generated/'))
  assert.deepEqual(callers.sort(), [
    // the facade: one in-transaction site (queueAccountingSyncTx) plus the settle call it delegates to
    'lib/accounting.ts',
    // the function that owns the post-queue decision
    'lib/domain/accounting/enqueue-outcome.ts',
    // the clear itself
    'lib/domain/accounting/posting-refusal-inbox.ts',
    // the row-creating primitive: same transaction, same lock, and it returns early on a live claim anyway
    'lib/domain/accounting/sync-log-row.ts',
  ], 'a NEW file clearing refusals must be judged against the post-queue rule above, not added here silently')
  assert.match(inbox, /pg_advisory_xact_lock|runUnderPostingKeyLock/,
    'PRECONDITION: the clear must still take the posting key lock, which is what makes the in-transaction sites safe')
})

/**
 * o3d-j625 r30 (Codex round 29, HIGH 1) — THE DECLINE IS PUBLISHED FROM THE LOCK CALLBACK'S RETURN VALUE.
 *
 * `guarded` swallows the error and lets the caller proceed, so anything assigned into an outer variable from
 * inside the transaction survives a rollback and gets published anyway. r10 hit that on the recording path
 * (an optimistic initializer); r28 hit the other half on the clearing path by assigning the reportable value
 * before the write that asserts it. This pins the discipline that fixes both: the reportable value comes out
 * as the callback's RETURN, assigned only after `guarded` has returned.
 *
 * WHAT WOULD STILL PASS IT: a rewrite that keeps the shape but breaks the semantics some other way — this is
 * a structural check, and the behavioural one is the concurrency test that rolls a real deferral write back.
 * It says nothing about the `recording` path, which r10 pinned with its own pessimistic initializer.
 */
test('[o3d-j625 r30] the clear never publishes a decline assigned from inside its transaction', () => {
  const src = readFileSync(path.join(process.cwd(), 'lib/domain/accounting/posting-refusal-inbox.ts'), 'utf8')
  const clear = src.slice(
    src.indexOf('export async function clearAccountingPostingRefusal'),
    src.indexOf('async function reportDeclineNotRecorded'),
  )
  assert.ok(clear.length > 500, 'PRECONDITION: the clear body must be found, or this test reads nothing')

  // The callback RETURNS the decline. o3d-j625 r34 re-aimed this: the return is now a ternary over the two
  // decline outcomes (counted, or stamped as unaccounted), because the stamp is written inside this callback.
  // The PROPERTY is unchanged and is what this asserts — the decline leaves the callback as a returned value,
  // never as an assignment into an outer variable from inside a transaction that may still roll back.
  assert.match(clear, /return counted\s*\n?\s*\? \{ outcome: 'declined-hand-post-claim', \.\.\.claim \}/,
    'the decline must be the lock callback\'s return value')
  assert.match(clear, /outcome: 'declined-hand-post-claim-not-recorded',/,
    'and so must the unaccounted variant')
  // ...and the only assignment to the published holder is the one after the lock returns.
  const assignments = clear.match(/^\s*result = /gm) ?? []
  assert.equal(assignments.length, 1,
    `the published result must be assigned EXACTLY once, after the lock transaction committed; found `
    + `${assignments.length}. An assignment from inside the callback is r28's defect: a rollback does not undo `
    + 'it and `guarded` swallows the error, so a decline is published for a postponement that never landed.')
  assert.match(clear, /\/\/ Reached ONLY if the lock callback returned and its transaction committed/,
    'and the one assignment must be the post-commit one')
  // The deferral's own result is checked rather than reasoned about.
  assert.match(clear, /if \(recorded !== 'recorded'\) \{[\s\S]{0,200}throw new Error/,
    'a postponement that did not record must throw inside the transaction, not be assumed to have worked')
  // And the non-durable case has its own reported outcome.
  assert.match(clear, /outcome: 'declined-hand-post-claim-not-recorded'/,
    'a claim seen without a durable postponement gets its own outcome, so no caller can read it as postponed')
  assert.match(clear, /await reportDeclineNotRecorded\(/, 'and it is reported at ERROR')

  // NON-VACUITY: the consumer must map that outcome to something that is owed but NOT `hand-post-deferred`,
  // because r18 made that reason mean "postponed AND counted".
  const outcome = readFileSync(path.join(process.cwd(), 'lib/domain/accounting/enqueue-outcome.ts'), 'utf8')
  assert.match(
    outcome,
    /case 'declined-hand-post-claim-not-recorded':[\s\S]{0,2000}?return \{ \.\.\.outcome, queued: false, reason: 'refused' \}/,
    'the unrecorded decline must be answered as owed-but-not-postponed; `hand-post-deferred` there would tell '
    + 'the caller a postponement is being tracked when the count says it is not',
  )
})

/**
 * o3d-j625 r32 (Codex round 31, HIGH 1) — THE UNCOUNTED-DECLINE STAMP IS DISCHARGED WHEREVER THE COUNT IS.
 *
 * `handPostDeclineUncountedAt` keeps a reused key's debt outstanding through the mark. That makes a LEFTOVER
 * stamp as dangerous as a missing one in the other direction: a row that keeps itself outstanding for ever is
 * the r6 false debt, and marking handled would stop discharging anything on the three reused kinds. So every
 * place that resets `handPostDeferredCount` must reset the stamp, and this asserts it by COUNTING both rather
 * than by looking for one example.
 *
 * WHAT WOULD STILL PASS IT: a new discharge point that resets BOTH (which is the point — it is a pairing rule,
 * not a whitelist); and any change to what the stamp MEANS. The behavioural half is the r32 concurrency pair:
 * the uncounted decline keeps the debt, and the ordinary case still resolves.
 */
test('[o3d-j625 r32] every reset of the deferral count also clears the uncounted-decline stamp', () => {
  const mark = readFileSync(path.join(process.cwd(), 'lib/domain/accounting/posting-mark-handled.ts'), 'utf8')
  const resets = (mark.match(/^\s*handPostDeferredCount: 0,$/gm) ?? []).length
  const cleared = (mark.match(/^\s*handPostDeclineUncountedAt: null,$/gm) ?? []).length
  assert.ok(resets >= 3,
    `PRECONDITION: the three discharge points (claim, release, and both mark exits) must be found; saw ${resets}`)
  assert.equal(cleared, resets,
    `every reset of handPostDeferredCount must clear handPostDeclineUncountedAt beside it: ${resets} resets but `
    + `${cleared} clears. A leftover stamp keeps a reused key outstanding for ever, which is the r6 false debt — `
    + 'the opposite failure to the one r32 fixed, and not a lesser one.')

  // The decision itself must read BOTH signals, and only on a reused key.
  assert.match(mark, /const keepOutstanding = keyIsReused && \(deferredEdits > 0 \|\| declineUncounted\)/,
    'the reused-key mark decision must treat an uncounted decline as evidence of a postponement')
  /**
   * o3d-j625 r34 (Codex round 33, HIGH) — THIS ASSERTION IS DELIBERATELY INVERTED FROM ITS r32 FORM.
   *
   * r32 asserted the stamp was written OUTSIDE the lock callback, because a bare write inside it would have been
   * rolled back by the very failure it records. Round 33 named what that bought: the stamp became a SEPARATE
   * write, attempted after the transaction ended and the key lock was released, so it could fail on its own and
   * leave no signal at all.
   *
   * r34 writes it INSIDE, with the failing bump contained by a savepoint — so the transaction survives the
   * failure and the stamp commits with the decline or not at all. The r32 assertion is therefore now asserting
   * the defect. It is inverted rather than deleted, and the reason is recorded here, because the direction of
   * this rule is the whole of round 33's finding and a future author must not swing it back by accident.
   */
  const inbox = readFileSync(path.join(process.cwd(), 'lib/domain/accounting/posting-refusal-inbox.ts'), 'utf8')
  const lockBody = inbox.slice(inbox.indexOf('async (locked) => {'), inbox.indexOf('    result = settled'))
  assert.match(lockBody, /handPostDeclineUncountedAt: new Date\(\)/,
    'the stamp MUST be written inside the lock callback, in the same transaction as the decline')
  assert.match(lockBody, /await withSavepoint\(locked,/,
    'and the bump it replaces must be contained by a savepoint, or the failure aborts this transaction (25P02) '
    + 'and takes the stamp with it — which is why r32 could not write it here')
  // The post-lock write survives ONLY as a last-ditch fallback for the transaction failing to commit.
  assert.match(inbox, /const marked = await markDeclineUncounted\(client, key\)/,
    'the post-lock fallback is kept for the narrowed residual — the locked transaction not committing at all')
})

/**
 * o3d-j625 r34 (Codex round 33, HIGH) — THE UNACCOUNTED STATE REACHES BOTH OPERATOR-FACING PROJECTIONS.
 *
 * The fallback requirement was that the failure is visible WHERE THE OPERATOR ACTS. Three mutations — the inbox
 * row's flag, the claims list's flag, and the mark's answer — came back GREEN on the r34 sweep for want of a
 * test, which is precisely the "documented, not loud" state that was rejected. `handPostDeferredEdits` is 0
 * whenever the stamp is holding the debt, so without these flags every surface reads "none" or "0 later
 * version(s)" over a document whose ledger state is unknown.
 *
 * Source-level on purpose: both projections are server actions that need a request scope, and the behavioural
 * half (the mark's answer) is asserted against a real database in the r34 LOUD concurrency test.
 *
 * WHAT WOULD STILL PASS IT: different field names or wording, and any rendering that reads the flag. It does not
 * prove the string an operator finally sees, only that the fact reaches the component that writes it.
 */
test('[o3d-j625 r34] both operator-facing projections derive the unaccounted flag from the column', () => {
  const actions = readFileSync(path.join(process.cwd(), 'app/actions/sync-exceptions.ts'), 'utf8')
  // The inbox row and the claims row must each DERIVE it, not hardcode it.
  const derivations = actions.match(/handPostDeclineUncountedAt !== null/g) ?? []
  assert.equal(derivations.length, 2,
    `both the inbox row and the claims row must derive the flag from handPostDeclineUncountedAt; found `
    + `${derivations.length}. A hardcoded false is the mutation that made every surface say "none" over an `
    + 'unaccounted decline, and it passed the whole sweep before this test existed.')
  assert.match(actions, /handPostDeclineUnaccounted: row\.handPostDeclineUncountedAt !== null/, 'inbox row')
  assert.match(actions, /declineUnaccounted: row\.handPostDeclineUncountedAt !== null/, 'claims row')
  // ...and the mark's answer must carry it rather than a constant.
  const mark = readFileSync(path.join(process.cwd(), 'lib/domain/accounting/posting-mark-handled.ts'), 'utf8')
  assert.match(mark, /unaccountedDecline: declineUncounted,/,
    'the mark must report the state it actually read, not a constant')

  // NON-VACUITY: the operator-facing copy must BRANCH on it, or the flag reaches the page and changes nothing.
  const client = readFileSync(
    path.join(process.cwd(), 'app/(dashboard)/sync/exceptions/exceptions-client.tsx'), 'utf8',
  )
  assert.match(client, /claim\.declineUnaccounted/, 'the claims list must branch on the flag')
  assert.doesNotMatch(
    client.slice(client.indexOf('claim.declineUnaccounted'), client.indexOf('claim.declineUnaccounted') + 600),
    /^\s*\? 'none'/m,
    'and must not render "none" on the unaccounted branch',
  )
  assert.match(actions, /result\.unaccountedDecline/,
    'and the mark notice must branch on it too, instead of quoting a count of 0')

  /**
   * o3d-j625 r36 (Codex round 35, HIGH 1) — EVERY SURFACE THAT READS THE COUNT, NOT JUST THE ONES I REMEMBERED.
   *
   * r34 identified the trap (a count that is structurally 0 whenever the stamp holds the debt) and then swept
   * ONE surface. Round 35 found two more: the release action reported nothing, and the refusal table rendered the
   * flag nowhere at all. So this enumerates the surfaces rather than trusting recall — a third miss after two is
   * a pattern.
   *
   * THE RULE: every operator-facing branch on `deferredEdits > 0` must have an unaccounted branch ahead of it.
   * Asserted by counting both, so a NEW count-reading string without one fails here.
   */
  // Codex round 14: the operator-facing sentences are built by ONE function, `declinedWhileHeld(unaccounted, count)`, whose first branch is the
  // unaccounted one; every action passes the flag it read. A count-only call, or a builder that reads the count first, fails here.
  const module = readFileSync(path.join(process.cwd(), 'lib/domain/accounting/hand-post-instruction.ts'), 'utf8')
  const fn = module.slice(module.indexOf('export function declinedWhileHeld'), module.indexOf('export function declinedWhileHeld') + 700)
  assert.ok(fn.indexOf('if (unaccounted)') > 0 && fn.indexOf('if (unaccounted)') < fn.indexOf('count > 0'),
    'the shared builder must branch on the unaccounted flag BEFORE it reads the count')
  assert.ok((actions.match(/unaccounted: Boolean\(result\.declineUnaccounted\)/g) ?? []).length >= 2,
    'the release must pass the unaccounted flag to BOTH its activity description and its operator notice')
  assert.ok((actions.match(/unaccounted: Boolean\(result\.unaccountedDecline\)/g) ?? []).length >= 2,
    'the mark must pass it to BOTH its activity description and its operator notice')
  assert.equal(
    (actions.match(/declineUnaccounted/g) ?? []).length >= 4, true,
    'and it must be returned, logged, noticed and put in the metadata — or one of the surfaces goes quiet again',
  )
  // The refusal TABLE must render it, and ABOVE its action buttons: the operator decides after reading it.
  const flagAt = client.indexOf('row.handPostDeclineUnaccounted')
  assert.ok(flagAt > 0, 'the refusal row must render the unaccounted flag at all (round 35 HIGH 1)')
  /**
   * Compared WITHIN the row's own cell, not across the file: an earlier component has its own "Take for hand
   * posting" label, and a whole-file indexOf compared the flag against THAT one and failed for the wrong reason.
   * The slice starts at the flag, so finding the row's actions after it is what "before the buttons" means.
   */
  // Anchored on the CONTROLS, not on their labels: a mutation that merely wrote the button labels into the
  // warning text satisfied a label-based check while leaving the block below the buttons. `<Button` cannot be
  // faked by prose.
  const rowCellFrom = client.slice(flagAt, flagAt + 4000)
  assert.ok(rowCellFrom.includes('<Button'),
    'the unaccounted warning must come BEFORE the refusal row\'s controls — a warning under the buttons is one '
    + 'the operator reads after choosing, which is the same "documented, not loud" failure in a new place')
  const beforeFlag = client.slice(0, flagAt)
  assert.ok(
    !beforeFlag.slice(beforeFlag.lastIndexOf('row.clearingNote')).includes('<Button'),
    'and no control for this row may precede it',
  )
})
