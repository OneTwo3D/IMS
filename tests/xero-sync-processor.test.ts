import assert from 'node:assert/strict'
import test from 'node:test'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  applyMainSyncFailureRetry,
  buildXeroIdempotencyKey,
  decideInvoicePaymentClaim,
  findInvoicePaymentsBlockedByEarlierLiveLogs,
  findInvoiceUpdatesBlockedByPendingCreate,
  invoicePaymentDeferralMessage,
  isXeroAccountingOutboxEnabled,
} from '@/lib/connectors/xero/sync-processor'
import { claimHeldFrom } from '@/lib/domain/accounting/sync-claim-fence'

/**
 * Xero 400s an Idempotency-Key over 128 chars and the document never reaches the ledger.
 * The manual-journal branch passed a long composite as entryId (omitting `payload`, so the
 * hash branch was skipped) and built a 156-char key, so STOCK_RECEIPT journals NEVER
 * posted. The 400 body was being discarded, so it read as a bare "HTTP 400" and was
 * written off as a demo-tenant quirk (e2e/xero.spec.ts:134 fixme).
 */
const XERO_MAX = 128

test('Xero idempotency key stays within the length Xero accepts, even for a long entryId', () => {
  // The exact shape that was failing in production: purchase-receipt:<cuid>:<ref>:<sha256>
  const longEntryId =
    'purchase-receipt:cmrmplxiw0002huigplkbkj1m:RCP-PO-20260715-PDGA-MRMPLY9U:' +
    '90bcbacb89490dd370735fbbb0a01b6f7a70b08c0a029ba254b293721cc82182'
  const key = buildXeroIdempotencyKey(longEntryId, 'manual-journal')
  assert.ok(
    key.length <= XERO_MAX,
    `key must be <= ${XERO_MAX} chars or Xero 400s the journal; got ${key.length}`,
  )
})

test('Xero idempotency key is deterministic when hashed, so idempotency survives', () => {
  // The whole point of the key: the same source must always produce the same key, or a
  // retry posts a DUPLICATE journal to the ledger.
  const longEntryId = 'purchase-receipt:' + 'x'.repeat(200)
  assert.equal(
    buildXeroIdempotencyKey(longEntryId, 'manual-journal'),
    buildXeroIdempotencyKey(longEntryId, 'manual-journal'),
  )
})

test('Xero idempotency keys stay distinct for different long sources', () => {
  const a = buildXeroIdempotencyKey('purchase-receipt:' + 'a'.repeat(200), 'manual-journal')
  const b = buildXeroIdempotencyKey('purchase-receipt:' + 'b'.repeat(200), 'manual-journal')
  assert.notEqual(a, b, 'two different receipts must not collide onto one key')
})

test('Xero idempotency key leaves short keys human-readable', () => {
  // Only over-long keys change shape; the common case stays greppable in Xero's UI.
  assert.equal(buildXeroIdempotencyKey('abc123', 'manual-journal'), 'ims-manual-journal-abc123')
})

test('Xero accounting outbox processor feature flag defaults on', () => {
  assert.equal(isXeroAccountingOutboxEnabled(undefined), true)
  assert.equal(isXeroAccountingOutboxEnabled(''), true)
  assert.equal(isXeroAccountingOutboxEnabled('true'), true)
})

test('Xero accounting outbox processor feature flag accepts rollback values', () => {
  assert.equal(isXeroAccountingOutboxEnabled('false'), false)
  assert.equal(isXeroAccountingOutboxEnabled('0'), false)
  assert.equal(isXeroAccountingOutboxEnabled(' off '), false)
})

test('out-of-order INVOICE_PAYMENT entries are blocked by older live logs in one batched lookup', async () => {
  const t1 = new Date('2026-01-01T09:00:00.000Z')
  const t2 = new Date('2026-01-01T10:00:00.000Z')
  const t3 = new Date('2026-01-01T11:00:00.000Z')
  const findManyCalls: unknown[] = []
  const client = {
    accountingSyncLog: {
      findMany: async (args: unknown) => {
        findManyCalls.push(args)
        return [
          { id: 'payment-1', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: t1 },
          { id: 'payment-2', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: t2 },
          { id: 'payment-3', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: t3 },
        ]
      },
    },
  }

  const blocked = await findInvoicePaymentsBlockedByEarlierLiveLogs(client as never, [
    { id: 'payment-3', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: t3 },
    { id: 'payment-1', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: t1 },
    { id: 'payment-2', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: t2 },
  ])

  assert.deepEqual([...blocked].sort(), ['payment-2', 'payment-3'])
  assert.equal(findManyCalls.length, 1)
  assert.deepEqual(findManyCalls[0], {
    where: {
      connector: 'xero',
      type: 'INVOICE_PAYMENT',
      status: { in: ['PENDING', 'PROCESSING'] },
      OR: [{ referenceType: 'SalesOrder', referenceId: 'order-1' }],
    },
    select: { id: true, referenceType: true, referenceId: true, status: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
})

// ---------------------------------------------------------------------------
// ROUND 3 #2: THE ORDER HAS TO BE TOTAL.
//
// `createdAt` is a transaction clock. Two INVOICE_PAYMENT rows inserted in one transaction, or in two
// that committed inside the same tick, carry the IDENTICAL timestamp — and under a strict `<` neither
// is "after" the other, so NEITHER was deferred and both ran.
//
// That is not cosmetic. The post-time capacity guard is allowed to treat PENDING/PROCESSING siblings
// as consuming no capacity ONLY because this function lets exactly one live entry per order be
// undeferred at a time; the later ones re-run the arithmetic against the earlier one's SYNCED row.
// Two same-timestamp receipts defeat that, both read a table in which neither has posted, and both
// post — the invoice is settled twice.
// ---------------------------------------------------------------------------

function orderingClient(rows: Array<{ id: string; createdAt: Date }>) {
  return {
    accountingSyncLog: {
      findMany: async () => rows.map((row) => ({
        ...row,
        referenceType: 'SalesOrder',
        referenceId: 'order-1',
      })),
    },
  }
}

function orderingEntries(rows: Array<{ id: string; createdAt: Date }>) {
  return rows.map((row) => ({
    id: row.id,
    type: 'INVOICE_PAYMENT' as const,
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
  createdAt: row.createdAt,
  }))
}

test('two INVOICE_PAYMENT rows sharing a timestamp still serialise — exactly one is left undeferred', async () => {
  const t = new Date('2026-01-01T09:00:00.000Z')
  const rows = [{ id: 'payment-a', createdAt: t }, { id: 'payment-b', createdAt: new Date(t) }]

  const blocked = await findInvoicePaymentsBlockedByEarlierLiveLogs(
    orderingClient(rows) as never,
    orderingEntries(rows),
  )

  // Before the tie-break this set was EMPTY: both entries ran, and both posted.
  assert.deepEqual([...blocked], ['payment-b'], 'the id tie-break must elect payment-a and defer payment-b')
})

test('three same-timestamp receipts leave exactly one runnable, not three', async () => {
  const t = new Date('2026-01-01T09:00:00.000Z')
  const rows = [
    { id: 'payment-c', createdAt: new Date(t) },
    { id: 'payment-a', createdAt: new Date(t) },
    { id: 'payment-b', createdAt: new Date(t) },
  ]

  const blocked = await findInvoicePaymentsBlockedByEarlierLiveLogs(
    orderingClient(rows) as never,
    orderingEntries(rows),
  )

  assert.deepEqual([...blocked].sort(), ['payment-b', 'payment-c'])
})

test('the winner is elected by the comparator, not by the order the rows arrive in', async () => {
  // Two independent runners each compute this set from their own snapshot. If the election depended on
  // the query's row order rather than a total comparator, they could elect DIFFERENT winners and each
  // let its own entry through — the same double post, reached from two processes instead of one.
  const t = new Date('2026-01-01T09:00:00.000Z')
  const forwards = [{ id: 'payment-a', createdAt: new Date(t) }, { id: 'payment-b', createdAt: new Date(t) }]
  const backwards = [...forwards].reverse()

  const first = await findInvoicePaymentsBlockedByEarlierLiveLogs(
    orderingClient(forwards) as never,
    orderingEntries(forwards),
  )
  const second = await findInvoicePaymentsBlockedByEarlierLiveLogs(
    orderingClient(backwards) as never,
    orderingEntries(backwards),
  )

  assert.deepEqual([...first], ['payment-b'])
  assert.deepEqual([...second], ['payment-b'])
})

test('a strictly earlier row still wins regardless of how the ids sort', async () => {
  // Guards against the tie-break being promoted into the primary key: `createdAt` decides whenever it
  // discriminates, and only a tie falls through to the id.
  const early = { id: 'zzz-earlier', createdAt: new Date('2026-01-01T09:00:00.000Z') }
  const late = { id: 'aaa-later', createdAt: new Date('2026-01-01T10:00:00.000Z') }

  const blocked = await findInvoicePaymentsBlockedByEarlierLiveLogs(
    orderingClient([early, late]) as never,
    orderingEntries([early, late]),
  )

  assert.deepEqual([...blocked], ['aaa-later'])
})

test('audit-H5: SALES_INVOICE_UPDATE is deferred while its SALES_INVOICE CREATE is still live', async () => {
  const tCreate = new Date('2026-02-01T09:00:00.000Z')
  const tUpdate = new Date('2026-02-01T10:00:00.000Z')
  const findManyCalls: unknown[] = []
  const client = {
    accountingSyncLog: {
      findMany: async (args: unknown) => {
        findManyCalls.push(args)
        // A live (PENDING) CREATE for the same SalesOrder.
        return [
          { id: 'create-1', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: tCreate },
        ]
      },
    },
  }

  const blocked = await findInvoiceUpdatesBlockedByPendingCreate(client as never, [
    { id: 'update-1', type: 'SALES_INVOICE_UPDATE', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: tUpdate },
  ])
  assert.deepEqual([...blocked], ['update-1'])
  // One batched lookup for the matching CREATE type/reference.
  assert.equal(findManyCalls.length, 1)
  assert.deepEqual(findManyCalls[0], {
    where: {
      connector: 'xero',
      status: { in: ['PENDING', 'PROCESSING'] },
      OR: [{ type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'order-1' }],
    },
    select: { id: true, type: true, referenceType: true, referenceId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
})

test('audit-H5: PURCHASE_INVOICE_UPDATE is NOT deferred once its CREATE has posted (no live CREATE)', async () => {
  const client = {
    accountingSyncLog: {
      findMany: async () => [] as unknown[], // CREATE already SYNCED → not live
    },
  }
  const blocked = await findInvoiceUpdatesBlockedByPendingCreate(client as never, [
    { id: 'update-2', type: 'PURCHASE_INVOICE_UPDATE', referenceType: 'PurchaseOrder', referenceId: 'po-1', createdAt: new Date('2026-02-02T10:00:00.000Z') },
  ])
  assert.equal(blocked.size, 0)
})

test('audit-H5: an UPDATE is not blocked by a CREATE for a different document', async () => {
  const client = {
    accountingSyncLog: {
      // Query is OR-filtered by reference, so a CREATE for another order is never returned.
      findMany: async () => [] as unknown[],
    },
  }
  const blocked = await findInvoiceUpdatesBlockedByPendingCreate(client as never, [
    { id: 'update-3', type: 'SALES_INVOICE_UPDATE', referenceType: 'SalesOrder', referenceId: 'order-9', createdAt: new Date('2026-02-03T10:00:00.000Z') },
  ])
  assert.equal(blocked.size, 0)
})

test('audit-H5: non-update entries are ignored (no lookup)', async () => {
  let called = false
  const client = { accountingSyncLog: { findMany: async () => { called = true; return [] } } }
  const blocked = await findInvoiceUpdatesBlockedByPendingCreate(client as never, [
    { id: 'pay-1', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: new Date() },
  ])
  assert.equal(blocked.size, 0)
  assert.equal(called, false)
})

test('audit-H5: UPDATE is deferred when its CREATE shares the same createdAt (same-ms queue)', async () => {
  const t = new Date('2026-02-04T10:00:00.000Z')
  const client = {
    accountingSyncLog: {
      findMany: async () => [
        { id: 'create-s', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'order-s', createdAt: t },
      ],
    },
  }
  const blocked = await findInvoiceUpdatesBlockedByPendingCreate(client as never, [
    { id: 'update-s', type: 'SALES_INVOICE_UPDATE', referenceType: 'SalesOrder', referenceId: 'order-s', createdAt: t },
  ])
  assert.deepEqual([...blocked], ['update-s'])
})

test('audit-H5: UPDATE is NOT deferred by a CREATE queued AFTER it (re-issued CREATE) — no indefinite defer', async () => {
  const tUpdate = new Date('2026-02-05T10:00:00.000Z')
  const tLaterCreate = new Date('2026-02-05T11:00:00.000Z')
  const client = {
    accountingSyncLog: {
      findMany: async () => [
        { id: 'create-late', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'order-l', createdAt: tLaterCreate },
      ],
    },
  }
  const blocked = await findInvoiceUpdatesBlockedByPendingCreate(client as never, [
    { id: 'update-l', type: 'SALES_INVOICE_UPDATE', referenceType: 'SalesOrder', referenceId: 'order-l', createdAt: tUpdate },
  ])
  assert.equal(blocked.size, 0)
})

// ---------------------------------------------------------------------------
// AN ELECTION IS NOT AN EXCLUSION (Codex round 4 #3).
//
// The tests above establish that every runner computing the blocked set from THE SAME ROWS elects the
// same winner. Round 3 then leaned on that as if it serialised the post. It does not: each runner
// computes the set ONCE, before its claim loop, from its own snapshot, and a row that commits between
// two snapshots is in one and not the other. "Am I the smallest?" can always be invalidated by a
// smaller key arriving later, so no amount of agreement about ORDER produces exclusion.
//
// decideInvoicePaymentClaim adds the test that only ever looks BACKWARD — something else for this
// reference is already claimed, therefore I may not be — which a later row cannot undo.
// ---------------------------------------------------------------------------

const T0 = new Date('2026-03-01T09:00:00.000Z')
const T1 = new Date('2026-03-01T09:00:05.000Z')

test('a sibling already PROCESSING blocks this entry even when this entry is the earliest (round 4 #3)', () => {
  // THE DEFECT, in one assertion. By createdAt, `payment-early` is the winner and the round-3 rule
  // would run it — while `payment-late` is on the wire RIGHT NOW for the same order. Both post, and
  // the post-time capacity guard cannot see it: at the moment each read the table, neither had SYNCED.
  const decision = decideInvoicePaymentClaim({
    entryId: 'payment-early',
    live: [
      { id: 'payment-early', status: 'PENDING', createdAt: T0 },
      { id: 'payment-late', status: 'PROCESSING', createdAt: T1 },
    ],
  })

  assert.equal(decision.claim, false)
  assert.equal(decision.claim === false && decision.reason, 'ANOTHER_ENTRY_IS_POSTING')
  assert.equal(decision.claim === false && decision.blockedBy, 'payment-late')
})

test('two runners reading different rows cannot both claim, which the total order alone could not prevent', () => {
  // The exact interleaving: runner A reads at t1 and sees only X, so X claims. A second receipt Y then
  // commits with an EARLIER createdAt (a re-driven row keeping its original timestamp, or clock skew
  // between app instances). Runner B reads at t2 and sees {X PROCESSING, Y PENDING}.
  //
  // Under "elect the minimum", B's minimum is Y — B elects ITSELF and posts alongside X. Under the
  // backward-looking test, X's claim is a fact B cannot argue with.
  const runnerA = decideInvoicePaymentClaim({
    entryId: 'payment-x',
    live: [{ id: 'payment-x', status: 'PENDING', createdAt: T1 }],
  })
  assert.equal(runnerA.claim, true, 'the first runner takes the slot')

  const runnerB = decideInvoicePaymentClaim({
    entryId: 'payment-y',
    live: [
      { id: 'payment-x', status: 'PROCESSING', createdAt: T1 },
      { id: 'payment-y', status: 'PENDING', createdAt: T0 },
    ],
  })
  assert.equal(runnerB.claim, false)
  assert.equal(runnerB.claim === false && runnerB.reason, 'ANOTHER_ENTRY_IS_POSTING')
  assert.equal(runnerB.claim === false && runnerB.blockedBy, 'payment-x')
})

test('an earlier PENDING sibling still defers this entry, and names it', () => {
  // Ordering keeps its job: with nothing claimed, the earliest live entry goes first. The reason is
  // reported separately from the exclusion because the two say different things to an operator
  // reading the queue.
  const decision = decideInvoicePaymentClaim({
    entryId: 'payment-late',
    live: [
      { id: 'payment-early', status: 'PENDING', createdAt: T0 },
      { id: 'payment-late', status: 'PENDING', createdAt: T1 },
    ],
  })

  assert.equal(decision.claim, false)
  assert.equal(decision.claim === false && decision.reason, 'AN_EARLIER_ENTRY_IS_WAITING')
  assert.equal(decision.claim === false && decision.blockedBy, 'payment-early')
})

test('the earliest live entry claims when nothing else holds the slot', () => {
  const decision = decideInvoicePaymentClaim({
    entryId: 'payment-early',
    live: [
      { id: 'payment-early', status: 'PENDING', createdAt: T0 },
      { id: 'payment-late', status: 'PENDING', createdAt: T1 },
    ],
  })
  assert.equal(decision.claim, true)
})

test('an entry never blocks itself, so a stale claim can still be re-taken', () => {
  // A stale reclaim reads its OWN row back as PROCESSING. Counting that as "another entry is posting"
  // would make every stale row permanently unretryable.
  const decision = decideInvoicePaymentClaim({
    entryId: 'payment-x',
    live: [{ id: 'payment-x', status: 'PROCESSING', createdAt: T0 }],
  })
  assert.equal(decision.claim, true)
})

test('a PROCESSING sibling blocks whether or not its claim has gone stale', () => {
  // Staleness measures elapsed time; "dead" and "slow" do not differ by duration. The deferral costs a
  // minute, and the stale row is itself re-claimable, so this terminates — it does not strand.
  const decision = decideInvoicePaymentClaim({
    entryId: 'payment-y',
    live: [
      { id: 'payment-stale', status: 'PROCESSING', createdAt: new Date('2020-01-01T00:00:00.000Z') },
      { id: 'payment-y', status: 'PENDING', createdAt: T1 },
    ],
  })
  assert.equal(decision.claim, false)
  assert.equal(decision.claim === false && decision.reason, 'ANOTHER_ENTRY_IS_POSTING')
})

test('the blocking entry reported is stable under row order, not whichever the database returned first', () => {
  const forwards = [
    { id: 'payment-b', status: 'PROCESSING', createdAt: T1 },
    { id: 'payment-a', status: 'PROCESSING', createdAt: T0 },
    { id: 'payment-me', status: 'PENDING', createdAt: T1 },
  ]
  const backwards = [...forwards].reverse()
  const first = decideInvoicePaymentClaim({ entryId: 'payment-me', live: forwards })
  const second = decideInvoicePaymentClaim({ entryId: 'payment-me', live: backwards })
  // Both rows are PROCESSING, so the answer must be the exclusion, not the ordering — and it must name
  // the same one either way, or two operators reading the same queue are told different things.
  assert.equal(first.claim === false && first.reason, 'ANOTHER_ENTRY_IS_POSTING')
  assert.equal(second.claim === false && second.reason, 'ANOTHER_ENTRY_IS_POSTING')
  assert.equal(first.claim === false && first.blockedBy, 'payment-a')
  assert.equal(second.claim === false && second.blockedBy, 'payment-a')
})

// ---------------------------------------------------------------------------
// ROUND 5 #1: A STALE CLAIM AND AN EARLIER PENDING ROW DEFERRED TO EACH OTHER FOR EVER.
//
// Round 4 argued the exclusion terminates because "a stale row is itself re-claimable". It was not:
// the exclusion pointed forward in status (something is PROCESSING, so I may not claim) and the
// ordering pointed backward in time (something older is waiting, so I may not claim), and with the
// stale claim being the NEWER row the two rules admitted nobody. Not a slow queue — a stopped one.
//
// The cut is at the ordering rule only. The holder of the slot is not queueing for the slot.
// ---------------------------------------------------------------------------

const T_STALE = new Date('2026-03-01T09:00:05.000Z')
const T_EARLIER = new Date('2026-03-01T09:00:00.000Z')

test('a stale PROCESSING holder is not deferred behind the earlier PENDING row that is deferred behind IT (round 5 #1)', () => {
  // THE DEADLOCK, both halves in one test. Under round 4, BOTH of these were `claim: false`, so the
  // order's payment never posted no matter how many times either runner came back.
  const live = [
    { id: 'payment-earlier', status: 'PENDING', createdAt: T_EARLIER },
    { id: 'payment-stale', status: 'PROCESSING', createdAt: T_STALE },
  ]

  const holder = decideInvoicePaymentClaim({ entryId: 'payment-stale', live })
  assert.equal(holder.claim, true, 'the row that already holds the slot must be admitted, or nothing ever moves')

  // And the other half is UNCHANGED: the earlier row still refuses to post alongside an in-flight one.
  // Termination must not be bought by letting both of them run.
  const waiter = decideInvoicePaymentClaim({ entryId: 'payment-earlier', live })
  assert.equal(waiter.claim, false)
  assert.equal(waiter.claim === false && waiter.reason, 'ANOTHER_ENTRY_IS_POSTING')
  assert.equal(waiter.claim === false && waiter.blockedBy, 'payment-stale')
})

test('the holder exemption does not let a holder post alongside a DIFFERENT in-flight entry', () => {
  // The counter-guard. If the exemption had been written above the exclusion test — "I am PROCESSING,
  // therefore I claim" — two PROCESSING rows would each admit themselves and both post. Exclusion
  // still runs first, so a second in-flight entry refuses this one however stale its own claim is.
  const decision = decideInvoicePaymentClaim({
    entryId: 'payment-stale',
    live: [
      { id: 'payment-other', status: 'PROCESSING', createdAt: T_EARLIER },
      { id: 'payment-stale', status: 'PROCESSING', createdAt: T_STALE },
    ],
  })
  assert.equal(decision.claim, false)
  assert.equal(decision.claim === false && decision.reason, 'ANOTHER_ENTRY_IS_POSTING')
  assert.equal(decision.claim === false && decision.blockedBy, 'payment-other')
})

test('the run-snapshot pre-filter does not hand the holder its claim straight back (round 5 #1)', async () => {
  // The second half of the deadlock, and the one that survives a fix confined to the decision helper:
  // both runners take the locked claim and THEN consult this set, deferring the entry if it is a
  // member. Round 4's local "is anything live earlier than me?" rule said yes for the stale holder, so
  // the holder was claimed and immediately deferred on every pass.
  const client = {
    accountingSyncLog: {
      findMany: async () => [
        { id: 'payment-earlier', status: 'PENDING', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: T_EARLIER },
        { id: 'payment-stale', status: 'PROCESSING', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: T_STALE },
      ],
    },
  }

  const blocked = await findInvoicePaymentsBlockedByEarlierLiveLogs(client as never, [
    { id: 'payment-stale', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: T_STALE },
    { id: 'payment-earlier', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: T_EARLIER },
  ])

  // Exactly the two verdicts decideInvoicePaymentClaim reaches — the pre-filter may not disagree with
  // the decider that authorised the claim.
  assert.deepEqual([...blocked], ['payment-earlier'])
})

test('the deferral message names the blocking entry and distinguishes waiting from in-flight', () => {
  // The errorMessage is what an operator staring at a stuck queue reads. "Deferred" alone tells them
  // nothing about whether to wait or to go and look.
  assert.match(
    invoicePaymentDeferralMessage({ reason: 'ANOTHER_ENTRY_IS_POSTING', blockedBy: 'log-9' }),
    /log-9 for the same order is being sent now/,
  )
  assert.match(
    invoicePaymentDeferralMessage({ reason: 'AN_EARLIER_ENTRY_IS_WAITING', blockedBy: 'log-9' }),
    /until earlier invoice payment sync log log-9 posts/,
  )
})

test('the claim and the exclusion test are taken together under the order row lock', () => {
  // Structural, because the whole point is WHERE these two statements sit relative to each other. Read
  // outside the lock, the decision is stale before it is used and the fix is cosmetic.
  const src = readFileSync(join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8')
  const start = src.indexOf('async function claimAccountingSyncLog(')
  assert.ok(start > 0, 'the claim helper must exist')
  const block = src.slice(start, src.indexOf('async function deferPaymentUntilEarlierLogsPost(', start))

  const txAt = block.indexOf('db.$transaction(async (tx) => {')
  const lockAt = block.indexOf('await lockSalesOrder(tx, entry.referenceId)')
  const readAt = block.indexOf('tx.accountingSyncLog.findMany(')
  const decideAt = block.indexOf('decideInvoicePaymentClaim({')
  const writeAt = block.indexOf('tx.accountingSyncLog.updateMany(')
  assert.ok(txAt > 0, 'the invoice-payment claim must open a transaction')
  assert.ok(lockAt > txAt, 'the order row lock must be taken first')
  assert.ok(readAt > lockAt, 'the live rows must be read UNDER the lock')
  assert.ok(decideAt > readAt && writeAt > decideAt, 'the decision and the claim must follow, in that order')
  // Only order-scoped invoice payments pay for the lock; nothing else is competing for a per-reference
  // post slot, and putting an order lock in front of every journal push would be a new hazard.
  assert.ok(
    block.includes("entry.type !== 'INVOICE_PAYMENT' || entry.referenceType !== 'SalesOrder'"),
    'the locked path must be scoped to order-scoped invoice payments',
  )
})

test('both runners take the claim through the same helper — neither may claim raw', () => {
  // The direct processor and the outbox worker are the two runners in the finding. A fix applied to
  // one of them is not a fix.
  const src = readFileSync(join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8')
  const direct = src.slice(src.indexOf('async function processPendingXeroSyncDirect('), src.indexOf('async function processPendingXeroSyncViaOutbox('))
  const outbox = src.slice(src.indexOf('async function processPendingXeroSyncViaOutbox('))
  for (const [name, block] of [['direct', direct], ['outbox', outbox]] as const) {
    // RE-POINTED, NOT RELAXED (o3d-e2mz): the helper now also carries the ATTEMPT the claim mints,
    // so the call is `(entry, claimedAt, staleClaimCutoff, attempt)`. The property this pins is
    // unchanged and is still exact — the runner reaches the claim ONLY through the one helper — and
    // the negative below still forbids a raw one.
    assert.ok(
      block.includes('await claimAccountingSyncLog(entry, claimedAt, staleClaimCutoff, attempt)'),
      `the ${name} runner must claim through the exclusion helper`,
    )
    assert.equal(
      block.indexOf('where: accountingSyncLogClaimWhere(entry.id, staleClaimCutoff)'),
      -1,
      `the ${name} runner must not take a raw, unserialised claim`,
    )
    assert.ok(block.includes("claim.outcome === 'deferred'"), `the ${name} runner must handle a declined claim`)
  }
})

// ---------------------------------------------------------------------------
// ROUND 6: A DISPLACED OWNER COULD ERASE THE REPLACEMENT'S CLAIM AND REOPEN THE POST SLOT.
//
// Round 5 admitted the holder of the slot past the ordering test and rested the safety on the stale
// cutoff being "the only re-claim authority". It is — but a re-claim only helps if the worker it
// displaced can no longer write the row. Its failure write was fenced on `{ id, retryCount }`, and a
// re-claim does not advance retryCount, so the displaced owner's update matched and landed: the
// replacement's PROCESSING claim was overwritten with PENDING while its request was still on the wire.
//
// Nothing then holds the slot, so decideInvoicePaymentClaim admits a sibling for the same order and a
// second payment posts against the same invoice — with no SYNCED row anywhere for the capacity guard
// to count. The release is now fenced on the claim INSTANT, so only the owner can give the row back.
// ---------------------------------------------------------------------------

const T_DISPLACED_CLAIM = new Date('2026-03-01T09:00:00.000Z')
const T_REPLACEMENT_CLAIM = new Date('2026-03-01T09:20:00.000Z')

/**
 * A one-row store that HONOURS the where clause, because the whole property under test is which
 * writes match and which do not. A double that ignored `where` would report the fix as working and
 * the defect as working equally well.
 */
function makeRowStore(row: {
  id: string
  status: string
  processingStartedAt: Date | null
  retryCount: number
  /**
   * o3d-e2mz: the per-attempt identity every processor write is now fenced on, in ADDITION to the
   * claim instant. Carried and MATCHED here rather than ignored: this predicate answers "true" to
   * any key it does not know, so a double without it would let `applyMainSyncFailureRetry` write
   * through the attempt fence and the o3d-a3wx assertions below would hold with that fence removed.
   */
  attemptRevision?: number
}) {
  const state = { attemptRevision: 4, ...row }
  const matches = (where: Record<string, unknown>) => (
    (where.id === undefined || where.id === state.id)
    && (where.status === undefined || where.status === state.status)
    && (where.retryCount === undefined || where.retryCount === state.retryCount)
    && (where.attemptRevision === undefined || where.attemptRevision === state.attemptRevision)
    && (where.processingStartedAt === undefined
      || (where.processingStartedAt as Date | null)?.valueOf() === state.processingStartedAt?.valueOf())
  )
  const accountingSyncLog = {
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (!matches(where)) return { count: 0 }
      Object.assign(state, data)
      return { count: 1 }
    },
    findUnique: async () => ({ retryCount: state.retryCount, status: state.status }),
  }
  const tx = new Proxy({ accountingSyncLog }, {
    get(_target, prop: string) {
      if (prop === 'accountingSyncLog') return accountingSyncLog
      return new Proxy({}, { get: () => async () => undefined })
    },
  })
  return { tx: tx as never, state }
}

/**
 * o3d-e2mz: the attempt the runner minted when it claimed this row. It MATCHES the row's revision in
 * both tests below, deliberately — the property they pin is o3d-a3wx's, that the CLAIM INSTANT
 * decides, so the revision must not be what refuses the displaced write.
 */
const PAYMENT_ATTEMPT = { id: 'payment-claimed', attemptRevision: 4 }
const PAYMENT_ENTRY = {
  id: 'payment-claimed',
  retryCount: 2,
  type: 'INVOICE_PAYMENT' as const,
  referenceType: 'SalesOrder',
  referenceId: 'order-1',
}

test('o3d-a3wx r6: a displaced owner cannot un-claim the replacement, so the post slot stays shut', async () => {
  // The row was re-taken at 09:20 after the 09:00 claim went stale. The 09:00 worker is still alive —
  // a timeout cannot recall a request already on the wire — and now reports its failure.
  const { tx, state } = makeRowStore({
    id: 'payment-claimed',
    status: 'PROCESSING',
    processingStartedAt: T_REPLACEMENT_CLAIM,
    retryCount: 2,
  })

  await applyMainSyncFailureRetry(tx, PAYMENT_ATTEMPT, PAYMENT_ENTRY, 'connection reset', {}, claimHeldFrom(T_DISPLACED_CLAIM))

  assert.equal(state.status, 'PROCESSING', 'the replacement still holds the row')
  assert.equal(state.processingStartedAt?.valueOf(), T_REPLACEMENT_CLAIM.valueOf())
  assert.equal(state.retryCount, 2, 'and its attempt budget was not spent by a worker that no longer owns it')

  // THE CONSEQUENCE, which is the reason this matters: the slot is still held, so the sibling waiting
  // to settle the same order is refused. With the row dropped to PENDING it would have been admitted
  // and posted a second payment against an invoice the replacement is settling right now.
  const sibling = decideInvoicePaymentClaim({
    entryId: 'payment-sibling',
    live: [
      { id: 'payment-sibling', status: 'PENDING', createdAt: new Date('2026-03-01T08:59:00.000Z') },
      { id: state.id, status: state.status, createdAt: new Date('2026-03-01T09:00:05.000Z') },
    ],
  })
  assert.equal(sibling.claim, false)
  assert.equal(sibling.claim === false && sibling.reason, 'ANOTHER_ENTRY_IS_POSTING')
  assert.equal(sibling.claim === false && sibling.blockedBy, 'payment-claimed')
})

test('o3d-a3wx r6: the worker that DOES own the claim still records its failure and frees the slot', async () => {
  // The counter-guard. Fencing must not freeze the row: the actual owner writes, the row leaves
  // PROCESSING, and the sibling it was blocking is admitted on the next pass.
  const { tx, state } = makeRowStore({
    id: 'payment-claimed',
    status: 'PROCESSING',
    processingStartedAt: T_REPLACEMENT_CLAIM,
    retryCount: 2,
  })

  const result = await applyMainSyncFailureRetry(tx, PAYMENT_ATTEMPT, PAYMENT_ENTRY, 'connection reset', {}, claimHeldFrom(T_REPLACEMENT_CLAIM))

  assert.equal(state.status, 'PENDING')
  assert.equal(state.retryCount, 3)
  assert.equal(result.finalFailure, false)

  const sibling = decideInvoicePaymentClaim({
    entryId: 'payment-sibling',
    live: [
      { id: 'payment-sibling', status: 'PENDING', createdAt: new Date('2026-03-01T08:59:00.000Z') },
      { id: state.id, status: state.status, createdAt: new Date('2026-03-01T09:00:05.000Z') },
    ],
  })
  assert.equal(sibling.claim, true, 'the earliest unclaimed row goes next once nothing is posting')
})

test('o3d-a3wx r6: neither runner releases a claim with an unfenced write', () => {
  // Structural, and paired with the behavioural tests above: the fence is only worth anything if EVERY
  // release carries it. `update({ where: { id } })` cannot express "only while I still hold it" —
  // Prisma's unique-where update takes no extra predicate — so a release must go through updateMany.
  //
  // r7, after Codex found this test inspecting nothing: the r6 version scanned for
  // `accountingSyncLog.update(`, which never matches `accountingSyncLog.updateMany(` — the shape EVERY
  // release actually uses. It therefore examined zero release sites and passed unconditionally, and its
  // one real assertion was a bare `includes` that a single fenced site anywhere satisfied on behalf of
  // all the others. Removing the fence from any individual release still passed it.
  //
  // So it now scans the WHOLE FILE rather than the two runner blocks (three fenced releases live in
  // helpers outside them), reads each call's argument by balancing braces, and asserts PER SITE. The
  // two deliberate unfenced writers are named here rather than pattern-matched, so a NEW unfenced
  // release fails even though the documented ones pass.
  const src = readFileSync(join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8')

  // Slicing to the first `})` — as r6 did — truncates at the first nested object, and a regex cannot
  // balance braces at all.
  const callArgument = (from: number): string => {
    const open = src.indexOf('{', from)
    let depth = 0
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1
      else if (src[i] === '}') {
        depth -= 1
        if (depth === 0) return src.slice(open, i + 1)
      }
    }
    throw new Error('unbalanced call argument in sync-processor.ts')
  }
  const enclosingFunction = (offset: number): string => {
    const before = src.slice(0, offset)
    const declarations = [...before.matchAll(/(?:export )?(?:async )?function (\w+)/g)]
    return declarations.length > 0 ? declarations[declarations.length - 1][1] : '<top level>'
  }

  // Both are documented in sync-processor.ts with the reason they cannot carry the claim fence.
  const DELIBERATELY_UNFENCED = new Map([
    // Runs only AFTER the post succeeded and the row was written SYNCED with processingStartedAt: null,
    // so there is no claim left to match and the row is out of the live set either way.
    ['markSyncLogForFollowUpRetry', 'post-success follow-up retry'],
  ])

  let fencedReleases = 0
  let revivals = 0
  let exempt = 0
  const pattern = /accountingSyncLog\.(updateMany|update)\(/g
  for (let match = pattern.exec(src); match !== null; match = pattern.exec(src)) {
    const arg = callArgument(match.index)
    if (!arg.includes('data:')) continue
    const data = arg.slice(arg.indexOf('data:'))
    const where = arg.includes('where:') ? arg.slice(arg.indexOf('where:'), arg.indexOf('data:')) : ''
    const fn = enclosingFunction(match.index)
    const line = src.slice(0, match.index).split('\n').length
    const site = `${fn} (${match[1]} at line ${line})`

    // Ternary-aware: `status: finalFailure ? 'FAILED' : 'PENDING'` is a release too, and matching only
    // the literal `status: 'PENDING'` would skip it.
    const writesQueued = /status:[^,]*'PENDING'/.test(data) || /status:[^,]*'FAILED'/.test(data)
    if (!writesQueued) continue

    // A revival takes a row that is already FAILED — nobody holds a claim on it — back to PENDING, and
    // is fenced on that status instead. It is not a claim holder giving its own claim back.
    if (where.includes("status: 'FAILED'")) {
      revivals += 1
      continue
    }

    if (DELIBERATELY_UNFENCED.has(fn)) {
      assert.ok(
        !where.includes('heldClaimWhere('),
        `${site} is recorded as deliberately unfenced (${DELIBERATELY_UNFENCED.get(fn)}) but now carries ` +
          `the claim fence — update the exemption list rather than leaving the two disagreeing`,
      )
      exempt += 1
      continue
    }

    fencedReleases += 1
    assert.ok(
      where.includes('heldClaimWhere('),
      `${site} hands a claimed row back to the queue without the claim fence: a worker whose claim was ` +
        `already taken over would erase the replacement's claim and reopen the post slot while the ` +
        `replacement's request is still on the wire`,
    )
    assert.equal(
      match[1],
      'updateMany',
      `${site} releases a claim through update(), which cannot carry the fence predicate`,
    )
  }

  // The r6 version was wrong by inspecting nothing and passing. These bounds make that failure loud:
  // if the call shape moves again, the scan finds too few sites and this test fails instead of going
  // quietly vacuous.
  //
  // SUPERSEDED NUMBER (o3d-m5qk): this required 8. It was 8 because eight inline release statements
  // were spelt out across the two runners — which is precisely what o3d-550x deleted, folding all of
  // them into the ONE fenced statement `releaseClaimForRetry`. Six of the eight therefore no longer
  // exist in this file, and demanding them back would be demanding the copies whose existence was the
  // defect. The rule is unchanged and is still enforced on every site that IS here; what changed is
  // that most sites moved, so the shared statement they moved into is asserted below rather than
  // trusted.
  assert.equal(
    fencedReleases,
    2,
    `expected to reach both remaining in-file claim-release sites; found ${fencedReleases}. Either a ` +
      `release was added (raise this number and confirm it is fenced) or the call shape moved and this ` +
      `test is inspecting nothing`,
  )
  assert.equal(revivals, 1, `expected exactly the one FAILED→PENDING revival; found ${revivals}`)
  assert.equal(exempt, 1, `expected exactly the one deliberately unfenced writer; found ${exempt}`)

  // WHERE THE OTHER SIX WENT, asserted rather than assumed. If `releaseClaimForRetry` ever stopped
  // carrying the fence, this file's scan would still pass while every deferral and backoff in both
  // runners quietly released unfenced — the exact silent-vacuity failure the bounds above exist for.
  const shared = readFileSync(join(process.cwd(), 'lib/domain/accounting/sync-claim-fence.ts'), 'utf8')
  const release = shared.slice(shared.indexOf('export async function releaseClaimForRetry('))
  assert.ok(release.length > 0, 'the one shared non-terminal release must exist')
  assert.ok(
    release.includes('accountingSyncLog.updateMany('),
    'the shared release must write through updateMany, which is what can carry a predicate',
  )
  // RE-POINTED, NOT RELAXED (o3d-e2mz): the predicate is now COMPOSED — `heldClaimWhere` spread
  // together with the optional attempt revision — because the two answer different questions and
  // neither implies the other. What this pins is what it always pinned: the claim half is the SHARED
  // `heldClaimWhere`, called with the holder at the point of the write, not re-spelt here.
  assert.ok(
    release.includes('...heldClaimWhere(entryId, claim),'),
    'the shared release must fence on the claim the caller holds, read at the point of the write',
  )
  assert.ok(
    release.includes('...(attempt ? { attemptRevision: attempt.attemptRevision } : {}),'),
    'and on the attempt the caller minted, where it minted one',
  )
  assert.ok(
    release.includes("status: 'PENDING'"),
    'and it must be the statement that actually hands the row back, not a wrapper around another one',
  )
})
