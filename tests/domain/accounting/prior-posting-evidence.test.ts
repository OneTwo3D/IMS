import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyPriorAttempts,
  describeUnresolvedPriorAttempt,
  PRIOR_ATTEMPT_COUNTERPART_EXISTS_OR,
  PRIOR_ATTEMPT_LIVE_STATUSES,
  PRIOR_ATTEMPT_SELECT,
  priorAttemptsWhere,
  type PriorAttemptRow,
} from '@/lib/domain/accounting/prior-posting-evidence'

/**
 * o3d-d0pd — A STATUS IS NOT A POSTING.
 *
 * The three accounting enqueues asked "does a posting for this idempotency key already exist?" with
 * `status IN ('PENDING','PROCESSING','SYNCED')`. A prior attempt that had reached FAILED was
 * invisible to that question AND to the partial unique index that carries the same predicate, so an
 * operator retry raised a SECOND row for the same key and both could post.
 */

const row = (over: Partial<PriorAttemptRow> = {}): PriorAttemptRow => ({
  id: 'log_1',
  status: 'FAILED',
  externalTransactionId: null,
  // o3d-f709: the whole LedgerStandingRow, explicitly null as Prisma returns an untouched row.
  settlementBasis: null,
  abandonedBeforeRemoteCall: null,
  ...over,
})

// ---------------------------------------------------------------------------
// The defect itself
// ---------------------------------------------------------------------------

test('[o3d-d0pd] a FAILED attempt is NOT nothing: it blocks a second row', () => {
  // MUTATION ROUTE: restore the old predicate — filter the rows to
  // PRIOR_ATTEMPT_LIVE_STATUSES before classifying, or return { kind: 'none' } for a FAILED row —
  // and this fails, because the enqueue would then write the duplicate.
  assert.deepEqual(
    classifyPriorAttempts([row({ id: 'log_failed' })]),
    { kind: 'unresolved', syncLogId: 'log_failed' },
    'a failure does not prove nothing posted: the remote call is made before its result is written back',
  )
})

test('[o3d-d0pd] a document id in ANY status means the counterpart already exists', () => {
  // MUTATION ROUTE: make the `posted` arm require a live status, or drop it entirely, and a FAILED
  // row naming a real Xero document reads as `unresolved` (a refusal an operator cannot clear) or
  // as `none` (a duplicate document).
  for (const status of ['FAILED', 'CANCELLED', 'SYNCED']) {
    const verdict = classifyPriorAttempts([row({ id: `log_${status}`, status, externalTransactionId: 'CN-123' })])
    if (status === 'SYNCED') {
      assert.deepEqual(verdict, { kind: 'live', syncLogId: 'log_SYNCED', asserted: false, externalTransactionId: 'CN-123' },
        'SYNCED is live to the enqueue, and the live arm answers first')
      continue
    }
    assert.deepEqual(verdict, { kind: 'posted', syncLogId: `log_${status}`, externalTransactionId: 'CN-123', asserted: false },
      `a ${status} row that names a document is a document that exists (o3d-ju8t)`)
  }
})

test('[o3d-d0pd] a blank document id is not a document', () => {
  // MUTATION ROUTE: drop the trim/emptiness check in `documentId` and this reads `posted`, which
  // would discharge the caller's obligation over a row that posted nothing.
  assert.deepEqual(classifyPriorAttempts([row({ externalTransactionId: '   ' })]), { kind: 'unresolved', syncLogId: 'log_1' })
})

// ---------------------------------------------------------------------------
// What must NOT become a blocker
// ---------------------------------------------------------------------------

test('[o3d-f709 / o3d-kj718] a CANCELLED row frees the key ONLY when its standing is PROVEN_NOT_POSTED; an unproven one REFUSES', () => {
  // THE FLIP (Codex HIGH on #724). This test used to assert `none` for a plain CANCELLED row, on the
  // argument that cancel-and-requeue is a documented remedy. The partial unique index no longer covers
  // a cancelled row, so a same-key retry beside a CLAIMED attempt that was cancelled without proof the
  // call failed would write a SECOND posting. Only rows the module calls PROVEN_NOT_POSTED free the key.
  const unproven = row({ id: 'log_claimed', status: 'CANCELLED' })
  console.log(`# precondition kj718: ${JSON.stringify(unproven)} => ${classifyPriorAttempts([unproven]).kind}`)
  assert.deepEqual(classifyPriorAttempts([unproven]), { kind: 'unresolved', syncLogId: 'log_claimed' })
  assert.equal(classifyPriorAttempts([row({ status: 'CANCELLED', abandonedBeforeRemoteCall: false })]).kind, 'unresolved')
  assert.equal(classifyPriorAttempts([row({ status: 'CANCELLED', settlementBasis: 'SOMETHING_NEWER' })]).kind, 'unresolved')
  // ISOLATING ARMS: every PROVEN shape frees it.
  assert.deepEqual(classifyPriorAttempts([row({ status: 'CANCELLED', abandonedBeforeRemoteCall: true })]), { kind: 'none' },
    'never claimed: stamped pre-call by the orphan sweep / supersession / sale-cancel sweep')
  assert.deepEqual(classifyPriorAttempts([row({ status: 'CANCELLED', settlementBasis: 'VERIFIED_REVERSAL' })]), { kind: 'none' })
})

// ---------------------------------------------------------------------------
// o3d-f709 / M11 - THE WORK SLOT. C1 and D2 at the enqueue.
// ---------------------------------------------------------------------------

test('[o3d-f709 M11, C1] a CANCELLED row an operator settled NOT_POSTED BLOCKS the slot - it is not a free one', () => {
  // THE FLIP. The test above used to carry "...for a row an operator has settled as NOT_POSTED" as its
  // reason for treating CANCELLED as free: that settlement WAS the way to re-queue. An operator's word
  // about a ledger IMS did not check is not proof, so the enqueue now refuses (D1) instead of raising a
  // second document.
  const settled = row({ id: 'log_settled', status: 'CANCELLED', settlementBasis: 'OPERATOR_ASSERTION' })
  console.log(`# precondition M11 blocked: ${JSON.stringify(settled)}`)
  assert.deepEqual(classifyPriorAttempts([settled]), { kind: 'blocked', syncLogId: 'log_settled' })
  // ISOLATING ARM: the identical row without the assertion frees the slot.
  // (the same row without the assertion is UNKNOWN: it refuses as `unresolved`, and only a PROVEN row frees the key)
  assert.deepEqual(classifyPriorAttempts([{ ...settled, settlementBasis: null }]), { kind: 'unresolved', syncLogId: 'log_settled' })
  assert.deepEqual(classifyPriorAttempts([{ ...settled, settlementBasis: null, abandonedBeforeRemoteCall: true }]), { kind: 'none' })
})

test('[o3d-f709 M11, D2] an operator-typed SYNCED id occupies the slot and the verdict says it is ASSERTED', () => {
  const asserted = row({ id: 'log_typed', status: 'SYNCED', externalTransactionId: 'TYPED-1', settlementBasis: 'OPERATOR_ASSERTION' })
  assert.deepEqual(classifyPriorAttempts([asserted]), { kind: 'live', syncLogId: 'log_typed', asserted: true, externalTransactionId: 'TYPED-1' })
  // ISOLATING ARM: the connector-confirmed twin is not flagged, so the flag is the assertion's.
  assert.deepEqual(
    classifyPriorAttempts([{ ...asserted, settlementBasis: null }]),
    { kind: 'live', syncLogId: 'log_typed', asserted: false, externalTransactionId: 'TYPED-1' },
  )
})

test('[o3d-f709 M11] a connector-backed occupant outranks an asserted one: the suppression then rests on evidence', () => {
  const verdict = classifyPriorAttempts([
    row({ id: 'log_typed', status: 'SYNCED', externalTransactionId: 'TYPED-1', settlementBasis: 'OPERATOR_ASSERTION' }),
    row({ id: 'log_real', status: 'PENDING' }),
  ])
  assert.deepEqual(verdict, { kind: 'live', syncLogId: 'log_real', asserted: false, externalTransactionId: null })
})

test('[o3d-f709 M11] a CANCELLED asserted-POSTED row (cancelled-sale settlement) is a posted document, flagged asserted', () => {
  const verdict = classifyPriorAttempts([
    row({ id: 'log_cs', status: 'CANCELLED', externalTransactionId: 'TYPED-2', settlementBasis: 'OPERATOR_ASSERTION' }),
  ])
  assert.deepEqual(verdict, { kind: 'posted', syncLogId: 'log_cs', externalTransactionId: 'TYPED-2', asserted: true })
})

test('[o3d-f709 M11] precedence: live/posted outrank blocked, blocked outranks unresolved', () => {
  const blocked = row({ id: 'log_b', status: 'CANCELLED', settlementBasis: 'OPERATOR_ASSERTION' })
  assert.equal(classifyPriorAttempts([blocked, row({ id: 'log_live', status: 'PENDING' })]).kind, 'live')
  assert.equal(classifyPriorAttempts([blocked, row({ id: 'log_p', status: 'FAILED', externalTransactionId: 'D-1' })]).kind, 'posted')
  assert.equal(classifyPriorAttempts([row({ id: 'log_f' }), blocked]).kind, 'blocked')
})

test('[o3d-f709 M11] the live set is the work-slot predicate, stated once', () => {
  assert.deepEqual([...PRIOR_ATTEMPT_LIVE_STATUSES], ['PENDING', 'PROCESSING', 'SYNCED'])
})

test('[o3d-d0pd] no rows at all is the ordinary path and still writes', () => {
  assert.deepEqual(classifyPriorAttempts([]), { kind: 'none' })
})

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

test('[o3d-d0pd] a live row beside a failed one means the work IS queued', () => {
  // The fourteen existing callers depend on this arm and none of them changes. A retry that raced an
  // earlier one must not be told "refused" while a PENDING row is standing.
  //
  // MUTATION ROUTE: order the arms unresolved-first and this fails — the enqueue would refuse
  // (leaving the obligation outstanding) over work that is on the queue right now.
  assert.deepEqual(
    classifyPriorAttempts([row({ id: 'log_failed' }), row({ id: 'log_live', status: 'PENDING' })]),
    { kind: 'live', syncLogId: 'log_live', asserted: false, externalTransactionId: null },
  )
  for (const status of PRIOR_ATTEMPT_LIVE_STATUSES) {
    assert.equal(classifyPriorAttempts([row({ id: 'x', status })]).kind, 'live', status)
  }
})

test('[o3d-d0pd] a posted row beats a failed one when nothing is live', () => {
  // MUTATION ROUTE: swap the `posted` and `unresolved` arms and this fails: the enqueue would refuse
  // a posting whose document it can point at, sending an operator to hunt for something already found.
  assert.deepEqual(
    classifyPriorAttempts([row({ id: 'log_failed' }), row({ id: 'log_posted', externalTransactionId: 'CN-9' })]),
    { kind: 'posted', syncLogId: 'log_posted', externalTransactionId: 'CN-9', asserted: false },
  )
})

// ---------------------------------------------------------------------------
// The query, and the columns the verdict is reached from
// ---------------------------------------------------------------------------

test('[o3d-d0pd] the prior-attempt query carries NO status filter — that absence is the fix', () => {
  const where = priorAttemptsWhere({
    connector: 'xero',
    type: 'COGS_REVERSAL',
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    idempotencyKey: 'sales-order-refund:refund-1:cogs-reversal',
  })
  // MUTATION ROUTE: put `status: { in: [...] }` back into the builder and this fails. Without it the
  // read cannot see the FAILED row at all and every verdict above is unreachable in production,
  // however correct the pure function is.
  assert.equal('status' in where, false, 'a status filter here makes the whole classification vacuous')
  assert.equal(where.connector, 'xero')
  assert.equal(where.referenceId, 'refund-1')
  assert.deepEqual(where.payload, {
    path: ['_idempotencyKey'],
    equals: 'sales-order-refund:refund-1:cogs-reversal',
  })
})

test('[o3d-d0pd] the select carries every column the verdict is reached from', () => {
  // MUTATION ROUTE: drop `externalTransactionId` from the select. The verdict then reads `undefined`
  // for every row and answers `unresolved` for a document that plainly exists — a guard that is not
  // wrong so much as answering about a row it cannot see.
  for (const column of ['id', 'status', 'externalTransactionId', 'settlementBasis', 'abandonedBeforeRemoteCall'] as const) {
    assert.equal(PRIOR_ATTEMPT_SELECT[column], true, `${column} must be selected`)
  }
})

test('[o3d-d0pd] the counterpart predicate has POSITIVE arms only', () => {
  // `NOT (a = $1 AND b IN (...))` is NULL for a NULL `b`, so a negated form would silently drop
  // exactly the rows with no document id — the population this whole module is about.
  //
  // MUTATION ROUTE: express either arm with `NOT` and this fails.
  assert.equal(JSON.stringify(PRIOR_ATTEMPT_COUNTERPART_EXISTS_OR).includes('"NOT"'), false)
  assert.deepEqual(PRIOR_ATTEMPT_COUNTERPART_EXISTS_OR[0], {
    status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
  })
})

test('[o3d-d0pd] the refusal names the ROW, because the remedy acts on the row', () => {
  const message = describeUnresolvedPriorAttempt({
    type: 'COGS_REVERSAL',
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    syncLogId: 'log_failed',
  })
  // MUTATION ROUTE: drop the row id and an operator is told to retry the thing that just refused,
  // which brings them straight back here.
  assert.ok(message.includes('log_failed'), 'the blocking row has to be nameable')
  assert.ok(message.startsWith('NOTHING WAS QUEUED.'), 'and the message must not read as success')
})
