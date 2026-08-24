import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  UNRESOLVED_ABANDONED_CLAIM_WHERE,
  cancelledClaimIsResolved,
} from '@/lib/domain/accounting/unresolved-abandoned-claim'
import {
  OPERATOR_ASSERTION_SETTLEMENT_BASIS,
  isSettleableAccountingSyncType,
} from '@/lib/domain/accounting/sync-row-settlement'

/**
 * o3d-nepa — AGE IS NOT EVIDENCE THAT A THING IS FINISHED.
 *
 * Retention released a sync row the moment it left the postable statuses, which leaves two deletable
 * statuses — and only SYNCED is an outcome. CANCELLED is an ABANDONMENT, written by the orphan sweep,
 * by the post-time retirement of a CLAIMED row, and by an operator, none of whom can see whether the
 * remote call had already landed. So an unresolved abandoned claim aged out and disappeared, and no
 * reader FAILED when it did: the daily-batch recreate verdict read "no row at all" as "the journal
 * never posted" and re-raised a duplicate, and the money-retry guard read a scope one CANCELLED
 * sibling short as unambiguous.
 *
 * ROUND 4 (Codex MEDIUM) — AND THEN IT KEPT EVERYTHING FOR EVER. "Resolved" was keyed SOLELY on
 * `abandonedBeforeRemoteCall`, which exactly one writer ever sets. An operator who explicitly settled
 * a row NOT_POSTED — a human who opened the ledger and put their name on it — stamped
 * `settlementBasis = OPERATOR_ASSERTION` and was still retained for ever as a compacted tombstone,
 * and so was every row the ordinary cancellation and post-time retirement paths wrote unflagged. The
 * new arm is asserted here in both spellings, and so is the bound that keeps it away from the one
 * reader that moves money.
 *
 * TWO SPELLINGS OF ONE RULE IS HOW THE HOLE REOPENS. Retention asks the question as a Prisma
 * predicate and the recreate verdict asks it as a row filter, so this file drives BOTH against the
 * same rows and asserts they never disagree — which is the property, rather than a grep for an
 * import name.
 */

/** Enough Prisma `where` semantics to evaluate the constant, with the null cases spelled out. */
type Row = {
  status: string
  abandonedBeforeRemoteCall: boolean | null
  externalTransactionId: string | null
  settlementBasis: string | null
}

/**
 * A general evaluator over AND / OR / NOT / `{ not: null }` / scalar equality, rather than a
 * hand-modelled shape. The predicate grew a nested AND in round 4, and an evaluator that only
 * understood the OLD shape would have gone on passing while asserting nothing about the new arm —
 * so anything it does not understand throws instead.
 */
function evaluate(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') return (condition as Record<string, unknown>[]).every((c) => evaluate(row, c))
    if (key === 'OR') return (condition as Record<string, unknown>[]).some((c) => evaluate(row, c))
    if (key === 'NOT') return !evaluate(row, condition as Record<string, unknown>)
    if (condition !== null && typeof condition === 'object') {
      const ops = Object.entries(condition as Record<string, unknown>)
      return ops.every(([op, operand]) => {
        if (op === 'not') return operand === null ? row[key] !== null : row[key] !== operand
        throw new Error(`unmodelled operator ${op} in UNRESOLVED_ABANDONED_CLAIM_WHERE`)
      })
    }
    return row[key] === condition
  })
}

function matchesUnresolvedAbandonedClaim(row: Row): boolean {
  return evaluate(
    row as unknown as Record<string, unknown>,
    UNRESOLVED_ABANDONED_CLAIM_WHERE as unknown as Record<string, unknown>,
  )
}

function cancelled(over: Partial<Row> = {}): Row {
  return {
    status: 'CANCELLED',
    abandonedBeforeRemoteCall: null,
    externalTransactionId: null,
    settlementBasis: null,
    ...over,
  }
}

/** Every combination of the three columns the rule reads. */
const CANCELLED_ROWS: Row[] = [
  cancelled(),
  cancelled({ externalTransactionId: 'XINV-1' }),
  cancelled({ abandonedBeforeRemoteCall: false }),
  cancelled({ abandonedBeforeRemoteCall: false, externalTransactionId: 'XINV-1' }),
  cancelled({ abandonedBeforeRemoteCall: true }),
  cancelled({ abandonedBeforeRemoteCall: true, externalTransactionId: 'XINV-1' }),
  // Round 4 — the operator-settled rows.
  cancelled({ settlementBasis: OPERATOR_ASSERTION_SETTLEMENT_BASIS }),
  cancelled({ settlementBasis: OPERATOR_ASSERTION_SETTLEMENT_BASIS, externalTransactionId: 'XINV-1' }),
  cancelled({ settlementBasis: 'CONNECTOR_CONFIRMED' }),
]

test('[o3d-nepa] a proved pre-call abandonment OR an operator assertion resolves a cancelled row', async () => {
  assert.deepEqual(
    CANCELLED_ROWS.map(matchesUnresolvedAbandonedClaim),
    [
      true, // nothing on record at all
      true, // ...and a document id keeps it whatever else is true
      true, // "false" is still "not on record"
      true,
      false, // the orphan sweep's own pre-call proof
      true, // ...unless the row names a document, which outranks it
      false, // ROUND 4: a human looked in the ledger and asserted NOT_POSTED
      true, // ...unless the row names a document (buildCancelledSaleSettlementData's shape)
      true, // a CONNECTOR_CONFIRMED basis is not an assertion about an abandonment
    ],
    'null and false are both "not on record"; and a row naming a document is kept whatever else says, '
    + "because an external id is the ledger's own receipt and outranks anything written over it",
  )
})

test('[o3d-nepa round 4] an operator-settled NOT_POSTED row is DELETABLE, not an immortal tombstone', async () => {
  // The defect, stated as the single row it was about. Before round 4 this was `true` — retained for
  // ever, compacted, and unexplainable — even though the operator had explicitly resolved it.
  const settled = cancelled({ settlementBasis: OPERATOR_ASSERTION_SETTLEMENT_BASIS })
  assert.equal(matchesUnresolvedAbandonedClaim(settled), false, 'retention no longer holds it back')
  assert.equal(cancelledClaimIsResolved(settled), true, 'and the shared rule calls it resolved')

  // The bound that stops this becoming "delete every cancelled row": an unsettled one still stays.
  assert.equal(matchesUnresolvedAbandonedClaim(cancelled()), true)
})

test('[o3d-nepa] the retention predicate and the recreate verdict are the SAME rule, row for row', async () => {
  // The anti-drift property, asserted behaviourally. If either side is edited alone — a `not: true`
  // that silently drops nulls on one, an extra arm on the other — these disagree and this fails.
  for (const row of CANCELLED_ROWS) {
    assert.equal(
      matchesUnresolvedAbandonedClaim(row),
      !cancelledClaimIsResolved(row),
      `retention keeps exactly the rows the recreate verdict calls unproved: ${JSON.stringify(row)}`,
    )
  }
})

test('[o3d-nepa round 4] the new arm cannot reach the daily-batch recreate verdict', async () => {
  // The one reader here that MOVES MONEY. It is safe from the operator-assertion arm only because a
  // DAILY_BATCH row can never carry an operator settlement — so that invariant is asserted rather
  // than assumed, and this fails the day the settlement action starts accepting batch rows.
  for (const type of ['DAILY_BATCH_REVENUE_DEFERRAL', 'DAILY_BATCH_INVENTORY_ALLOC', 'DAILY_BATCH_GROUP_B']) {
    assert.equal(isSettleableAccountingSyncType(type), false, `${type} must stay unsettleable by hand`)
  }
  // And the verdict must actually SELECT the column the shared rule now reads: handing a shared
  // predicate a row with the field missing turns `undefined` into a verdict.
  const dailySync = await readFile(path.join(process.cwd(), 'lib/connectors/xero/daily-sync.ts'), 'utf8')
  const select = dailySync.slice(dailySync.indexOf('async function dailyBatchRecreateVerdict'))
  assert.match(select.slice(0, select.indexOf('rows.length === 0')), /settlementBasis: true/)
})

test('[o3d-nepa] SYNCED is an outcome and is never held back by this clause', async () => {
  // The bound. Without this, "keep everything terminal" would satisfy the tests above and quietly
  // disable retention for the whole table.
  for (const abandonedBeforeRemoteCall of [null, false, true] as const) {
    assert.equal(
      matchesUnresolvedAbandonedClaim({
        status: 'SYNCED',
        abandonedBeforeRemoteCall,
        externalTransactionId: 'XINV-1',
        settlementBasis: null,
      }),
      false,
    )
  }
})

test('[o3d-nepa] retention and the daily-batch recreate verdict both READ the rule rather than restating it', async () => {
  const retention = await readFile(path.join(process.cwd(), 'lib/data-retention.ts'), 'utf8')
  assert.match(retention, /UNRESOLVED_ABANDONED_CLAIM_WHERE/, 'retention names the record via the shared constant')
  const deletePredicate = retention.slice(
    retention.indexOf('db.accountingSyncLog.deleteMany'),
    retention.indexOf('syncLogsDeleted = wc.count'),
  )
  assert.doesNotMatch(deletePredicate, /abandonedBeforeRemoteCall/,
    'and does not spell the column out locally, which is how the two sides drift')
  assert.doesNotMatch(deletePredicate, /settlementBasis/, 'nor the round-4 column')

  const dailySync = await readFile(path.join(process.cwd(), 'lib/connectors/xero/daily-sync.ts'), 'utf8')
  assert.match(dailySync, /cancelledClaimIsResolved/, 'the recreate verdict reads the shared rule')
  assert.doesNotMatch(dailySync, /row\.abandonedBeforeRemoteCall !== true/,
    'the hand-written copy of the rule is gone, not merely shadowed')
})
