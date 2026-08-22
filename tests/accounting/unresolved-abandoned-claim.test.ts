import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  UNRESOLVED_ABANDONED_CLAIM_WHERE,
  abandonmentProvesNoRemoteCall,
} from '@/lib/domain/accounting/unresolved-abandoned-claim'

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
 * TWO SPELLINGS OF ONE RULE IS HOW THE HOLE REOPENS. Retention asks the question as a Prisma
 * predicate and the recreate verdict asks it as a row filter, so this file drives BOTH against the
 * same rows and asserts they never disagree — which is the property, rather than a grep for an
 * import name.
 */

/** Enough Prisma `where` semantics to evaluate the constant, with the null cases spelled out. */
type Row = { status: string; abandonedBeforeRemoteCall: boolean | null; externalTransactionId: string | null }

function matchesUnresolvedAbandonedClaim(row: Row): boolean {
  const where = UNRESOLVED_ABANDONED_CLAIM_WHERE as {
    status: string
    OR: Array<{ abandonedBeforeRemoteCall?: boolean | null; externalTransactionId?: { not: null } }>
  }
  if (row.status !== where.status) return false
  return where.OR.some((clause) => {
    if ('abandonedBeforeRemoteCall' in clause) return row.abandonedBeforeRemoteCall === clause.abandonedBeforeRemoteCall
    if (clause.externalTransactionId) return row.externalTransactionId !== null
    throw new Error('unmodelled clause in UNRESOLVED_ABANDONED_CLAIM_WHERE')
  })
}

const CANCELLED_ROWS: Row[] = [
  { status: 'CANCELLED', abandonedBeforeRemoteCall: null, externalTransactionId: null },
  { status: 'CANCELLED', abandonedBeforeRemoteCall: null, externalTransactionId: 'XINV-1' },
  { status: 'CANCELLED', abandonedBeforeRemoteCall: false, externalTransactionId: null },
  { status: 'CANCELLED', abandonedBeforeRemoteCall: false, externalTransactionId: 'XINV-1' },
  { status: 'CANCELLED', abandonedBeforeRemoteCall: true, externalTransactionId: null },
  { status: 'CANCELLED', abandonedBeforeRemoteCall: true, externalTransactionId: 'XINV-1' },
]

test('[o3d-nepa] only a PROVED pre-call abandonment that names no document is resolved', async () => {
  assert.deepEqual(
    CANCELLED_ROWS.map(matchesUnresolvedAbandonedClaim),
    [true, true, true, true, false, true],
    'null and false are both "not on record"; and a row naming a document is kept whatever the flag says, '
    + "because an external id is the ledger's own receipt and outranks an abandonment written over it",
  )
})

test('[o3d-nepa] the retention predicate and the recreate verdict are the SAME rule, row for row', async () => {
  // The anti-drift property, asserted behaviourally. If either side is edited alone — a `not: true`
  // that silently drops nulls on one, an extra arm on the other — these disagree and this fails.
  for (const row of CANCELLED_ROWS) {
    assert.equal(
      matchesUnresolvedAbandonedClaim(row),
      !abandonmentProvesNoRemoteCall(row),
      `retention keeps exactly the rows the recreate verdict calls unproved: ${JSON.stringify(row)}`,
    )
  }
})

test('[o3d-nepa] SYNCED is an outcome and is never held back by this clause', async () => {
  // The bound. Without this, "keep everything terminal" would satisfy the tests above and quietly
  // disable retention for the whole table.
  for (const abandonedBeforeRemoteCall of [null, false, true] as const) {
    assert.equal(
      matchesUnresolvedAbandonedClaim({ status: 'SYNCED', abandonedBeforeRemoteCall, externalTransactionId: 'XINV-1' }),
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

  const dailySync = await readFile(path.join(process.cwd(), 'lib/connectors/xero/daily-sync.ts'), 'utf8')
  assert.match(dailySync, /abandonmentProvesNoRemoteCall/, 'the recreate verdict reads the shared rule')
  assert.doesNotMatch(dailySync, /row\.abandonedBeforeRemoteCall !== true/,
    'the hand-written copy of the rule is gone, not merely shadowed')
})
