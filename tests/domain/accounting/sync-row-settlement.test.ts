import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DAILY_BATCH_SYNC_TYPE_PREFIX,
  SETTLEABLE_ACCOUNTING_SYNC_STATUSES,
  buildSettlementData,
  describeSettlementCaveat,
  describeSettlementUniqueConflict,
  describeSyncRowSettleability,
  describeUnsettleableStatus,
  findMirrorOwnershipConflict,
  isFencedAttemptRevision,
  isSettleableAccountingSyncStatus,
  isSettleableAccountingSyncType,
  refuseSettlement,
  settlementMirrorExternalId,
  settlementMirrorGuard,
  settlementMirrorStatus,
  settlementNote,
  type SettlementAssertion,
} from '@/lib/domain/accounting/sync-row-settlement'
import { UNCLAIMED_ATTEMPT_REVISION } from '@/lib/domain/accounting/sync-log-attempt'

// o3d-nf9i + o3d-osl8 item 2 — the DECISION content of operator settlement, with no database.
// What may be asserted about a row, what the assertion writes, and what the operator is told when it
// cannot be made. Which ATTEMPT a decision lands on is NOT tested here: that belongs to
// applyFencedAttemptDecision (o3d-e2mz) and is exercised through the action.

const NOW = new Date('2026-08-20T12:00:00.000Z')

const NOT_POSTED: SettlementAssertion = { outcome: 'NOT_POSTED' }
const POSTED: SettlementAssertion = { outcome: 'POSTED', externalTransactionId: 'INV-9001' }

function row(over: Partial<{ status: string; type: string; externalTransactionId: string | null }> = {}) {
  return { status: 'FAILED', type: 'SALES_INVOICE', externalTransactionId: null, ...over }
}

// ---------------------------------------------------------------------------
// Which rows admit an assertion at all
// ---------------------------------------------------------------------------

test('FAILED and PROCESSING are the settleable statuses — and nothing else is', () => {
  // PROCESSING is here DELIBERATELY, having been excluded twice before. It is settleable now
  // because o3d-e2mz fences the decision to one attempt AND the Xero processor records a document
  // id even when its writeback loses the fence, so an operator who guesses wrong is contradicted by
  // evidence rather than silently believed. See the module comment.
  assert.deepEqual([...SETTLEABLE_ACCOUNTING_SYNC_STATUSES], ['FAILED', 'PROCESSING'])
  assert.equal(isSettleableAccountingSyncStatus('FAILED'), true)
  assert.equal(isSettleableAccountingSyncStatus('PROCESSING'), true)
  assert.equal(isSettleableAccountingSyncStatus('PENDING'), false)
  assert.equal(isSettleableAccountingSyncStatus('SYNCED'), false)
  assert.equal(isSettleableAccountingSyncStatus('CANCELLED'), false)
})

test('PENDING is refused because nothing was sent, not because it is uninteresting', () => {
  const refusal = refuseSettlement(row({ status: 'PENDING' }), NOT_POSTED)
  assert.equal(refusal?.code, 'pending_not_settleable')
  assert.match(refusal?.message ?? '', /nothing has been sent/)
})

test('a recorded outcome can never be re-settled', () => {
  for (const status of ['SYNCED', 'CANCELLED']) {
    const refusal = refuseSettlement(row({ status }), NOT_POSTED)
    assert.equal(refusal?.code, 'already_terminal', status)
    assert.match(refusal?.message ?? '', new RegExp(`already ${status}`))
  }
})

test('a status outside the vocabulary is refused, not silently allowed', () => {
  const refusal = refuseSettlement(row({ status: 'WHATEVER' }), NOT_POSTED)
  assert.equal(refusal?.code, 'status_not_settleable')
  assert.match(describeUnsettleableStatus('WHATEVER'), /Only FAILED and PROCESSING rows can/)
})

test('DAILY_BATCH_* is refused on its TYPE, whatever its status — and the message names the batch race', () => {
  // The attempt fence does not help here: it fences the row against a competing WRITER, and this
  // race is between two OTHER readers of the row's status — the batch recreators and the order
  // delete guard — which is why the type gate survives o3d-e2mz.
  assert.equal(isSettleableAccountingSyncType(`${DAILY_BATCH_SYNC_TYPE_PREFIX}GROUP_B`), false)
  assert.equal(isSettleableAccountingSyncType('SALES_INVOICE'), true)
  for (const status of ['FAILED', 'PROCESSING']) {
    const refusal = refuseSettlement(row({ status, type: 'DAILY_BATCH_GROUP_B' }), NOT_POSTED)
    assert.equal(refusal?.code, 'daily_batch_not_settleable', status)
    assert.match(refusal?.message ?? '', /journal that still contains that order's value/)
  }
})

// ---------------------------------------------------------------------------
// Post evidence outranks the assertion
// ---------------------------------------------------------------------------

test('NOT_POSTED against a row that already names a document is refused as a contradiction', () => {
  const refusal = refuseSettlement(row({ externalTransactionId: 'INV-9001' }), NOT_POSTED)
  assert.equal(refusal?.code, 'contradicts_post_evidence')
  assert.match(refusal?.message ?? '', /evidence it DID post/)
})

test('POSTED needs the document id, and cannot overwrite a different one', () => {
  const missing = refuseSettlement(row(), { outcome: 'POSTED', externalTransactionId: '   ' })
  assert.equal(missing?.code, 'missing_external_id')

  const conflict = refuseSettlement(row({ externalTransactionId: 'INV-1' }), POSTED)
  assert.equal(conflict?.code, 'external_id_conflict')
  assert.match(conflict?.message ?? '', /already carries external id INV-1/)

  // Re-asserting the SAME id is idempotent — a retried click must not become a refusal.
  assert.equal(refuseSettlement(row({ externalTransactionId: 'INV-9001' }), POSTED), null)
  assert.equal(refuseSettlement(row({ externalTransactionId: ' INV-9001 ' }), POSTED), null)
})

test('a settleable row with a valid assertion is not refused', () => {
  assert.equal(refuseSettlement(row(), NOT_POSTED), null)
  assert.equal(refuseSettlement(row({ status: 'PROCESSING' }), NOT_POSTED), null)
  assert.equal(refuseSettlement(row(), POSTED), null)
})

// ---------------------------------------------------------------------------
// What the assertion writes
// ---------------------------------------------------------------------------

test('NOT_POSTED cancels the row and NEVER touches externalTransactionId', () => {
  const data = buildSettlementData(NOT_POSTED, NOW) as Record<string, unknown>
  assert.equal(data.status, 'CANCELLED')
  // Absent, not null. Writing null would destroy post evidence; writing an id would keep the order
  // blocked. refuseSettlement has already established the row carries none, so leaving the column
  // untouched leaves it NULL — and leaves it free for the connector's fence-loss evidence write.
  assert.equal('externalTransactionId' in data, false)
  assert.equal(data.processingStartedAt, null)
  assert.match(String(data.errorMessage), /verified NOT POSTED/)
})

test('POSTED records the document id, stamps syncedAt and clears the claim', () => {
  const data = buildSettlementData(POSTED, NOW) as Record<string, unknown>
  assert.equal(data.status, 'SYNCED')
  assert.equal(data.externalTransactionId, 'INV-9001')
  assert.equal(data.syncedAt, NOW)
  assert.equal(data.processingStartedAt, null)
  assert.match(String(data.errorMessage), /verified POSTED as INV-9001/)
})

test('the patch never carries attemptRevision — the fence owns it', () => {
  // A patch that set it would let a caller forge an attempt identity, which is the one thing
  // applyFencedAttemptDecision must be able to guarantee it decides.
  for (const assertion of [POSTED, NOT_POSTED]) {
    assert.equal('attemptRevision' in (buildSettlementData(assertion, NOW) as Record<string, unknown>), false)
  }
})

test('the settlement note records WHOSE claim it is, and any reason given', () => {
  assert.match(settlementNote(POSTED), /^Settled by operator: verified POSTED as INV-9001\./)
  assert.equal(
    settlementNote({ outcome: 'NOT_POSTED', reason: 'no matching invoice in the org' }),
    'Settled by operator: verified NOT POSTED — nothing reached the accounting system. no matching invoice in the org',
  )
})

// ---------------------------------------------------------------------------
// The mirrored accounting event
// ---------------------------------------------------------------------------

test('the mirror follows the outcome, and NOT_POSTED writes no external id', () => {
  assert.equal(settlementMirrorStatus('POSTED'), 'POSTED')
  assert.equal(settlementMirrorStatus('NOT_POSTED'), 'VOID')
  assert.equal(settlementMirrorExternalId(POSTED), 'INV-9001')
  assert.equal(settlementMirrorExternalId(NOT_POSTED), null)
})

test('the mirror write is compare-and-swapped, so a sibling that posts first keeps its record', () => {
  // ROUND 2, FINDING 2. The ownership read below is not a lock — a sibling can commit between the
  // read and the write. Guarding the WRITE makes both interleavings safe without serialising every
  // queue path on the mirror key.
  const guard = settlementMirrorGuard()
  assert.deepEqual([...guard.statusIn], ['PENDING', 'FAILED'])
  assert.equal(guard.requireExternalIdNull, true)
})

test('a live or already-posted sibling sharing a mirror key OWNS the mirror', () => {
  const mine = ['key-a', 'key-legacy']
  assert.equal(
    findMirrorOwnershipConflict(mine, [
      { id: 'other', status: 'PENDING', externalTransactionId: null, mirrorKeys: ['key-a'] },
    ])?.syncLogId,
    'other',
  )
  // A FAILED sibling with a document id is a document that exists (o3d-ju8t) — it owns its mirror.
  assert.equal(
    findMirrorOwnershipConflict(mine, [
      { id: 'other', status: 'FAILED', externalTransactionId: 'INV-7', mirrorKeys: ['key-legacy'] },
    ])?.posted,
    true,
  )
  // A dead sibling with no evidence owns nothing.
  assert.equal(
    findMirrorOwnershipConflict(mine, [
      { id: 'other', status: 'CANCELLED', externalTransactionId: null, mirrorKeys: ['key-a'] },
    ]),
    null,
  )
  // No shared key means no conflict, whatever the sibling's status.
  assert.equal(
    findMirrorOwnershipConflict(mine, [
      { id: 'other', status: 'PENDING', externalTransactionId: null, mirrorKeys: ['key-z'] },
    ]),
    null,
  )
  // Nothing to own when this row is not mirrored at all.
  assert.equal(
    findMirrorOwnershipConflict([], [
      { id: 'other', status: 'PENDING', externalTransactionId: null, mirrorKeys: ['key-a'] },
    ]),
    null,
  )
})

// ---------------------------------------------------------------------------
// Unique-index collisions — two causes, two remedies
// ---------------------------------------------------------------------------

function p2002(target: string[] | string) {
  return { code: 'P2002', meta: { target }, message: 'Unique constraint failed' }
}

test('a live sibling holding this row\'s identity is reported as a live-row conflict', () => {
  const conflict = describeSettlementUniqueConflict(p2002('accounting_sync_logs_idempotency_key_uq'))
  assert.equal(conflict?.kind, 'live_row_conflict')
  assert.match(conflict?.message ?? '', /Another LIVE sync row/)
  assert.match(conflict?.message ?? '', /will not cancel it for you/)
  assert.equal(
    describeSettlementUniqueConflict(p2002('accounting_sync_logs_followup_live_unique'))?.kind,
    'live_row_conflict',
  )
})

test('a document id already mirrored elsewhere gets its OWN cause and remedy (round 2, finding 3)', () => {
  // The previous attempt reported ONE message for every P2002 in the transaction, so an operator
  // asserting a document id already mapped to another AccountingEvent was told a LIVE SYNC ROW held
  // their identity — the wrong cause, with a remedy that cannot fix a duplicate event mapping.
  const conflict = describeSettlementUniqueConflict(p2002(['externalSystem', 'externalId']))
  assert.equal(conflict?.kind, 'external_id_already_mirrored')
  assert.match(conflict?.message ?? '', /already recorded against a DIFFERENT accounting event/)
  assert.doesNotMatch(conflict?.message ?? '', /LIVE sync row/)
})

test('an unrecognised unique violation is NOT dressed up as either — the caller rethrows', () => {
  assert.equal(describeSettlementUniqueConflict(p2002(['some_other_unique_index'])), null)
  assert.equal(describeSettlementUniqueConflict({ code: 'P2002' }), null)
  assert.equal(describeSettlementUniqueConflict(new Error('boom')), null)
})

// ---------------------------------------------------------------------------
// What the UI is told
// ---------------------------------------------------------------------------

test('revision 0 is not an attempt, so it is not fenceable', () => {
  assert.equal(isFencedAttemptRevision(UNCLAIMED_ATTEMPT_REVISION), false)
  assert.equal(isFencedAttemptRevision(0), false)
  assert.equal(isFencedAttemptRevision(1), true)
  assert.equal(isFencedAttemptRevision(undefined), false)
  assert.equal(isFencedAttemptRevision(null), false)
})

test('the control is offered only where an assertion could actually land', () => {
  const ok = describeSyncRowSettleability({ status: 'FAILED', type: 'SALES_INVOICE', attemptRevision: 4 })
  assert.deepEqual(
    { settleable: ok.settleable, reason: ok.notSettleableReason },
    { settleable: true, reason: null },
  )
  assert.match(ok.settlementCaveat ?? '', /NOT proof that nothing posted/)

  const processing = describeSyncRowSettleability({ status: 'PROCESSING', type: 'SALES_INVOICE', attemptRevision: 2 })
  assert.equal(processing.settleable, true)
  assert.match(processing.settlementCaveat ?? '', /may never have returned/)
  assert.match(processing.settlementCaveat ?? '', /records the document id on this row anyway/)
})

test('a row with no attempt is disabled WITH the reason, not silently omitted', () => {
  // Every QuickBooks row is permanently here: that processor stamps no attempt revision, so its
  // rows stay at 0 and applyFencedAttemptDecision would refuse them as UNFENCED_ATTEMPT. Offering a
  // button whose only possible answer is a refusal is worse than offering none.
  const unfenced = describeSyncRowSettleability({ status: 'FAILED', type: 'SALES_INVOICE', attemptRevision: 0 })
  assert.equal(unfenced.settleable, false)
  assert.match(unfenced.notSettleableReason ?? '', /carries no attempt revision/)
  assert.equal(unfenced.settlementCaveat, null)
})

test('a DAILY_BATCH row is refused on its type BEFORE its attempt — it can never be settled at any revision', () => {
  // Order matters: telling an operator to wait for an attempt on a row that can never be settled
  // would be a false promise.
  const batch = describeSyncRowSettleability({ status: 'FAILED', type: 'DAILY_BATCH_GROUP_B', attemptRevision: 0 })
  assert.equal(batch.settleable, false)
  assert.match(batch.notSettleableReason ?? '', /DAILY BATCH row and cannot be settled by hand at any attempt/)
  assert.doesNotMatch(batch.notSettleableReason ?? '', /carries no attempt revision/)
})

test('a status that admits no assertion says so on the status, not the attempt', () => {
  const pending = describeSyncRowSettleability({ status: 'PENDING', type: 'SALES_INVOICE', attemptRevision: 0 })
  assert.equal(pending.settleable, false)
  assert.match(pending.notSettleableReason ?? '', /nothing has been sent/)
  assert.equal(describeSettlementCaveat('PENDING'), null)
})
