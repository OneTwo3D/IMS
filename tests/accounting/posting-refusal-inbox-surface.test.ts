import assert from 'node:assert/strict'
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
      // Only the classification's read is answered: it is the one that excludes CANCELLED rows. Every
      // other read of this table in the inbox stays empty, so each section's count stays attributable.
      where && typeof where.status === 'object' && where.status !== null && 'not' in (where.status as object)
        ? liveSyncRows
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
  assert.match(row.handPostOrder, /ALREADY holds INV-EDIT-1/,
    'with what the ledger holds stated, so the operator edits that document instead of raising a second one')
  assert.equal(row.remedy, invoiceUpdateRefusal.remedy, 'and the site\'s own remedy is verbatim')
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
  assert.match(row.handPostOrder, /IMS will not queue this posting while you hold it/,
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
      + `revision=${(data as unknown as { accountingHandPostClaimsRevision?: number }).accountingHandPostClaimsRevision}`)
    assert.ok(Array.isArray(head), 'the inbox payload carries it')
    assert.deepEqual(head.map((claim) => claim.refusalId), ['lh-ancient', 'lh-recent'], 'held longest FIRST')
    assert.equal(head[0]!.stale, true, 'and the longest-held one is flagged')
    // o3d-j625 r24: the payload carries the claim-set REVISION, not a count for the page to compare — round 23
    // showed a count cannot carry a completeness claim. `0` here because nothing has been taken or released
    // through the app in this fixture; what matters is that the field is present and a number.
    assert.equal(
      typeof (data as unknown as { accountingHandPostClaimsRevision?: unknown }).accountingHandPostClaimsRevision,
      'number',
      'the inbox payload carries the claim-set revision the walk compares against')
    assert.equal((data as unknown as { accountingHandPostClaimsTotalAtEnd?: unknown }).accountingHandPostClaimsTotalAtEnd,
      undefined,
      'and r22\'s count is GONE from the payload, not merely unread — leaving it would invite a later change to '
      + 'consult it again, which is the defect round 23 found')

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
 * o3d-j625 r24 (Codex round 23, HIGH) — THE PAGE DISTINGUISHES THREE STATES, AND NOT BY COUNTING
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * r22 guarded "that is every active claim" with a count and round 23 defeated it with two CANCELLING changes.
 * The behavioural half of the replacement — that a take, a release and a mark each move a strictly increasing
 * revision, and that the reviewer's 51-claim scenario is caught — is proven in
 * tests/accounting/posting-refusal-mark-handled. What is left is a fact about the component: which of the
 * three states it prints, and on what.
 *
 * DISCLOSED, from r22: the first version of this assertion was existential (`match(/claimsTotalAtEnd/)`) and
 * the harness found it green, because the identifier survived inside the branch it guarded. The rule here is
 * therefore about the deciding COMPARISON and the `?` it decides, and about the ABSENCE of any count in it.
 *
 * WHAT WOULD STILL PASS THIS: wording an operator might misread, and a comparison written with the operands
 * swapped (`!==` is symmetric, so there is nothing to get backwards — which is part of why a revision is a
 * better guard than an inequality between two counts). What it establishes is that the claim of completeness
 * is conditional on the revision and on nothing else.
 */
test('[o3d-j625 r24] the page claims completeness only when the claim-set REVISION did not move', async () => {
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const source = await readFile(
    path.join(process.cwd(), 'app', '(dashboard)', 'sync', 'exceptions', 'exceptions-client.tsx'),
    'utf8',
  )
  const at = source.indexOf('That is every active claim.')
  assert.ok(at >= 0, 'the sentence must still be in the page, or this test asserts nothing')
  const decision = source.slice(source.lastIndexOf('{claimsMatched', 0 + at), at)
  console.log(`[r24 sentence] deciding expression = ${decision.replace(/\s+/g, ' ').slice(0, 220)}`)

  assert.match(decision, /claimsRevisionNow !== claimsRevisionAtStart\s*\?/,
    'THE GUARD: completeness is conditional on the revision of the active claim set being unchanged between the '
    + 'start of the walk and its last page. Two cancelling changes move it by 2, so they cannot look like an '
    + 'unchanged set — which is exactly what a count could not tell.')

  /**
   * AND NO COUNT IS CONSULTED. This is the round-23 finding stated as an ABSENCE, which is a universal check
   * and therefore has no room for a correcting line beside a stale one: neither the rows shown nor any total
   * may appear in the expression that decides completeness.
   */
  assert.doesNotMatch(decision, /claims\.length/, 'the number of rows shown is not part of the decision')
  assert.doesNotMatch(decision, /claimsTotal/, 'nor is any total')
  assert.doesNotMatch(decision, /totalAtEnd/, 'nor r22\'s total-as-of-the-last-page')

  // THE THIRD STATE, and it says what to do. "More pages" is the Show-more branch; this is the middle one.
  const incomplete = source.slice(at - 700, at)
  assert.match(incomplete, /may be INCOMPLETE/, 'the middle state says the list may be incomplete, in those words')
  assert.match(incomplete, /\$\{claimsRevisionNow - claimsRevisionAtStart\}/,
    'and says HOW MANY acts moved the set, which is what the revision can honestly report')
  assert.match(incomplete, /Reload to start again/, 'with something the operator can do about it')

  // NON-VACUITY: all three states live in this one expression, so "the decision is the revision" is a fact
  // about a branch that exists rather than about a string that happens not to appear.
  assert.match(decision, /claimsMatched !== null/, 'the lookup state is the first branch')
  assert.ok(source.indexOf('Show more claims') > 0, 'and the more-pages state is its own control')
})

/**
 * o3d-j625 r24 — AND THE TWO NUMBERS THE PAGE COMPARES ARE THE RIGHT TWO.
 *
 * FOUND BY THE MUTATION HARNESS, NOT BY A TEST. The test above asserts the DECISION is the revision; it says
 * nothing about where the two operands come from, and two mutations exploited exactly that gap:
 *
 *   · report page one's revision as the current one, so the comparison can never fire;
 *   · re-base the start revision on every APPEND, so the comparison spans one page instead of the walk.
 *
 * Both leave the decision's grammar intact and every other test green. The state updates in `loadClaims` are
 * therefore asserted directly — the operands, not just the operator.
 *
 * WHAT WOULD STILL PASS THIS: a `loadClaims` that never runs (the button could be unwired — the walk's
 * behaviour is proven server-side in posting-refusal-mark-handled, and the Show-more control's existence is
 * asserted by the test above), and a rename of either state variable that keeps both roles. What it
 * establishes is that the CURRENT revision tracks the latest page and the START revision does not.
 */
test('[o3d-j625 r24] the walk compares the LATEST page against the walk\'s START, and an append does not re-base', async () => {
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const source = await readFile(
    path.join(process.cwd(), 'app', '(dashboard)', 'sync', 'exceptions', 'exceptions-client.tsx'),
    'utf8',
  )
  const start = source.indexOf('function loadClaims(')
  assert.ok(start >= 0, 'the loader must still be a named function, or this test asserts nothing')
  const block = source.slice(start, source.indexOf('\n  }', start))
  console.log(`[r24 operands] loadClaims block = ${block.length} chars`)

  assert.match(block, /setClaimsRevisionNow\(page\.claimSetRevision\)/,
    'the CURRENT revision comes from the page just read — reporting the walk\'s starting value here would make '
    + 'the comparison unable to fire at all')
  assert.doesNotMatch(block, /setClaimsRevisionNow\(claimsRevisionAtStart\)/,
    'and never from the start value, which is the operand it is compared against')
  assert.match(block, /if \(!options\.append\) setClaimsRevisionAtStart\(page\.claimSetRevision\)/,
    'the START revision is re-based only when the walk RESTARTS (a lookup, or a fresh first page). Re-basing on '
    + 'an append would forgive every change that happened before the latest page, so the comparison would span '
    + 'one page rather than the whole walk — which is the defect round 23 found, at a different scale.')

  // NON-VACUITY: the block really does contain unconditional setters, so "this one is conditional" is a fact
  // about a guard that exists rather than about a pattern absent from the whole file.
  assert.match(block, /setClaimsCursor\(page\.nextCursor\)/, 'the block does set other state unconditionally')
})
