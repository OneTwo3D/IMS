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
  if (!('resolvedAt' in where)) return true
  const condition = where.resolvedAt
  if (condition && typeof condition === 'object' && 'gte' in (condition as object)) {
    return row.resolvedAt instanceof Date && row.resolvedAt >= (condition as { gte: Date }).gte
  }
  return row.resolvedAt === condition
}

const seen: { countWhere?: Record<string, unknown>; listWhere?: Record<string, unknown>; listOrderBy?: unknown; listTake?: number; resolvedWhere?: Record<string, unknown> } = {}

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
      if (where.resolvedAt === null) {
        seen.listWhere = where
        seen.listOrderBy = orderBy
        seen.listTake = take
      } else {
        seen.resolvedWhere = where
      }
      return allRows.filter((row) => matchesRefusalWhere(row, where))
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
