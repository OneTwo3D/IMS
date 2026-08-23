import assert from 'node:assert/strict'
import test from 'node:test'

import { AccountingSyncType } from '@/app/generated/prisma/enums'
import { BACK_REFERENCE_TYPES } from '@/lib/domain/accounting/back-reference'
import {
  COMPACTION_FOLLOW_UP_LOSS,
  buildCompactedFollowUpLossActivity,
  compactionDiscardedFollowUps,
  compactionFollowUpVerdict,
  isCompactedFollowUpEvidence,
  isCompactedFollowUpLoss,
} from '@/lib/domain/accounting/compacted-followup-loss'

// ---------------------------------------------------------------------------
// o3d-bqw7 / o3d-kemx — THE TABLE THAT SEPARATES "THE PAYLOAD IS GONE" FROM "SOMETHING WAS LOST".
//
// The discard warning used to fire on the compaction STAMP, which is set on every expired unresolved
// back-reference row whatever its type. The warning's claim is narrower: that this row's outstanding
// follow-ups can no longer be enqueued. These tests pin the difference, and pin the two directions
// the table is allowed to be wrong in — never silently under-reporting, and never inheriting an
// answer for a type nobody considered.
// ---------------------------------------------------------------------------

const COMPACTED = new Date('2026-01-05T00:00:00Z')

function row(type: string, compactedAt: Date | null = COMPACTED) {
  return {
    id: 'log-1',
    type: type as AccountingSyncType,
    referenceType: 'SalesOrder',
    referenceId: 'so-1',
    externalTransactionId: 'XINV-1',
    backReferenceEvidenceCompactedAt: compactedAt,
  }
}

test('[o3d-bqw7] every AccountingSyncType has a stated verdict — none inherits another type\'s', () => {
  // The Record type already forces this at compile time. This is the RUNTIME half: a member added to
  // the Prisma enum by a schema change that has not reached this file would resolve to `undefined`
  // here, and `undefined.discarded` would throw inside a warning path rather than fail a build.
  const enumMembers = Object.values(AccountingSyncType).sort()
  const tableKeys = Object.keys(COMPACTION_FOLLOW_UP_LOSS).sort()
  assert.deepEqual(tableKeys, enumMembers)
})

test('[o3d-bqw7] only the four back-reference types can ever carry the stamp, and each is answered deliberately', () => {
  // Read from the SHARED constant, not restated: `UNRESOLVED_BACK_REFERENCE_EVIDENCE_WHERE` — the one
  // predicate that both the retention delete and the compaction pass are built from — filters on
  // `type in BACK_REFERENCE_TYPES`, so no other type can reach a tombstone today. That is why the
  // remaining entries are defensive rather than dead: they answer for a predicate in another file
  // that could widen.
  assert.deepEqual([...BACK_REFERENCE_TYPES].sort(), ['CREDIT_NOTE', 'PURCHASE_CREDIT_NOTE', 'PURCHASE_INVOICE', 'SALES_INVOICE'])
  assert.deepEqual(compactionFollowUpVerdict('SALES_INVOICE'), {
    discarded: ['the payment registration'],
    rebuilt: ['the invoice PDF'],
  })
  assert.deepEqual(compactionFollowUpVerdict('PURCHASE_INVOICE'), { discarded: ['the supplier invoice attachment'], rebuilt: [] })
  assert.deepEqual(compactionFollowUpVerdict('PURCHASE_CREDIT_NOTE'), { discarded: ['the supplier credit-note allocation'], rebuilt: [] })
  // The whole of the live false-alarm population: a sales credit note IS compacted and owes nothing.
  assert.deepEqual(compactionFollowUpVerdict('CREDIT_NOTE'), { discarded: [], rebuilt: [] })
})

test('[o3d-bqw7] a type the table does not recognise WARNS — the error direction is deliberate', () => {
  // Under-reporting loses a payment in silence; over-reporting is noise. A row carrying an enum
  // member this file has never seen is the "unsure" case, and it must land on the noisy side.
  const unknown = compactionFollowUpVerdict('SOMETHING_MERGED_LATER' as AccountingSyncType)
  assert.ok(unknown.discarded.length > 0, 'an unrecognised type must not read as "nothing was lost"')
  assert.ok(isCompactedFollowUpLoss(row('SOMETHING_MERGED_LATER')))
})

test('[o3d-bqw7] the loss still requires the STAMP — an intact row of a losing type lost nothing', () => {
  // The r3 property, unchanged by the narrowing: `payload: {}` and a compacted payload are the same
  // JSON, so the stamp is what decides whether anything was thrown away at all. The type only
  // decides whether what was thrown away mattered.
  assert.equal(isCompactedFollowUpEvidence(row('SALES_INVOICE', null)), false)
  assert.deepEqual(compactionDiscardedFollowUps(row('SALES_INVOICE', null)), [])
  assert.deepEqual(compactionDiscardedFollowUps(row('SALES_INVOICE')), ['the payment registration'])
})

test('[o3d-kemx] a tombstone that lost nothing is not a discard, so nothing gates its settle', () => {
  // Stated as the predicate the callers actually branch on. Both the processors and the sweep
  // release/settle only once the discard warning is persisted; if this answered true for a
  // CREDIT_NOTE, a failing activity log would hold an already-posted row for ever.
  assert.equal(isCompactedFollowUpLoss(row('CREDIT_NOTE')), false)
  assert.equal(isCompactedFollowUpLoss(row('PURCHASE_INVOICE')), true)
})

test('[o3d-bqw7] the warning quotes the table instead of listing everything a tombstone might owe', () => {
  const activity = buildCompactedFollowUpLossActivity({
    connectorLabel: 'Xero',
    activityActionPrefix: 'xero',
    row: { ...row('SALES_INVOICE'), type: 'SALES_INVOICE' },
    phase: 'repaired',
  })
  assert.equal(activity.level, 'WARNING')
  assert.match(activity.description, /the payment registration can no longer be enqueued/)
  assert.match(activity.description, /The invoice PDF is built from columns compaction keeps/)
  assert.deepEqual(activity.metadata.discardedFollowUps, ['the payment registration'])
  assert.deepEqual(activity.metadata.rebuiltFollowUps, ['the invoice PDF'])
})
