import assert from 'node:assert/strict'
import test from 'node:test'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  buildXeroIdempotencyKey,
  decideInvoicePaymentClaim,
  findInvoicePaymentsBlockedByEarlierLiveLogs,
  findInvoiceUpdatesBlockedByPendingCreate,
  invoicePaymentDeferralMessage,
  isXeroAccountingOutboxEnabled,
} from '@/lib/connectors/xero/sync-processor'

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
    select: { id: true, referenceType: true, referenceId: true, createdAt: true },
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
    assert.ok(
      block.includes('await claimAccountingSyncLog(entry, claimedAt, staleClaimCutoff)'),
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
