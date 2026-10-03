import assert from 'node:assert/strict'
import test from 'node:test'

import { ledgerStanding, namesADocument, ownsMirroredEvent, type LedgerStandingRow } from '@/lib/domain/accounting/ledger-standing'
import {
  DAILY_BATCH_SYNC_TYPE_PREFIX,
  SETTLEABLE_ACCOUNTING_SYNC_STATUSES,
  OPERATOR_ASSERTION_SETTLEMENT_BASIS,
  buildCancelledSaleSettlementData,
  buildSettlementData,
  describeMirrorOwnershipSkip,
  describeSettlementCaveat,
  describeSettlementUniqueConflict,
  describeSyncRowSettleability,
  describeUnsettleableStatus,
  findMirrorOwnershipConflict,
  isFencedAttemptRevision,
  isSettleableAccountingSyncStatus,
  isDailyBatchSyncType,
  settleableSettlementOutcomes,
  isOperatorAssertedSettlement,
  isSaleScopedSettlementRow,
  refuseSettlement,
  refuseSettlementContradictedByMirror,
  settlementBasisOf,
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

test('DAILY_BATCH_* refuses NOT_POSTED on its TYPE, whatever its status — and the message names the batch race', () => {
  // The attempt fence does not help here: it fences the row against a competing WRITER, and this
  // race is between two OTHER readers of the row's status — the batch recreators and the order
  // delete guard — which is why the type gate survives o3d-e2mz.
  assert.equal(isDailyBatchSyncType(`${DAILY_BATCH_SYNC_TYPE_PREFIX}GROUP_B`), true)
  assert.equal(isDailyBatchSyncType('SALES_INVOICE'), false)
  assert.deepEqual(settleableSettlementOutcomes('DAILY_BATCH_GROUP_B'), ['POSTED'])
  assert.deepEqual(settleableSettlementOutcomes('SALES_INVOICE'), ['POSTED', 'NOT_POSTED'])
  for (const status of ['FAILED', 'PROCESSING']) {
    const refusal = refuseSettlement(row({ status, type: 'DAILY_BATCH_GROUP_B' }), NOT_POSTED)
    assert.equal(refusal?.code, 'daily_batch_not_settleable', status)
    assert.match(refusal?.message ?? '', /journal that still contains that order's value/)
  }
})

test('o3d-jit6 r1#3: DAILY_BATCH_* ADMITS the POSTED assertion — it is the only exit such a row has', () => {
  // CODEX ROUND 1, FINDING 3. The whole argument for refusing the family is an argument about
  // CANCELLED: it reads as "never posted" to the batch recreators and to the order delete guard.
  // SYNCED reads as "posted" to both, so recording the journal's id blocks the duplicate recreate and
  // keeps the staged orders protected — it is strictly safer than leaving the row where it was.
  //
  // And leaving it where it was is not neutral. o3d-jit6's dispatch fence refuses a batch journal
  // whose create is on record with no id; a FAILED batch row is revived to PENDING by
  // `resetFailedDailyBatchLogs` every daily run, so with no POSTED settlement it refuses, fails and
  // revives for ever while blocking its own batch's recreate. That is a refusal with no remedy.
  for (const status of ['FAILED', 'PROCESSING']) {
    assert.equal(
      refuseSettlement(row({ status, type: 'DAILY_BATCH_GROUP_B' }), { outcome: 'POSTED', externalTransactionId: 'MJ-1' }),
      null,
      status,
    )
  }
  // The other gates still apply to it exactly as they do to any row.
  assert.equal(
    refuseSettlement(row({ status: 'FAILED', type: 'DAILY_BATCH_GROUP_B' }), { outcome: 'POSTED', externalTransactionId: '  ' })?.code,
    'missing_external_id',
  )
  assert.equal(
    refuseSettlement(row({ status: 'PENDING', type: 'DAILY_BATCH_GROUP_B' }), { outcome: 'POSTED', externalTransactionId: 'MJ-1' })?.code,
    'pending_not_settleable',
  )
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
  // o3d-1e7sl (C1): the note is what the operator reads beside the row for ever, and it must not say
  // "nothing reached the accounting system" in IMS's voice - a person's NOT_POSTED is a claim, not proof.
  assert.match(String(data.errorMessage), /recorded as NOT POSTED/)
  assert.match(String(data.errorMessage), /UNPROVEN/)
  assert.doesNotMatch(String(data.errorMessage), /nothing reached|verified NOT POSTED/i)
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
  const note = settlementNote({ outcome: 'NOT_POSTED', reason: 'no matching invoice in the org' })
  assert.match(note, /^Settled by operator: recorded as NOT POSTED - an operator's assertion; IMS did not check the accounting system/)
  assert.match(note, /UNPROVEN\. no matching invoice in the org$/)
  assert.doesNotMatch(note, /nothing reached the accounting system/)
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

/**
 * o3d-1e7sl (G11): `findMirrorOwnershipConflict` no longer reads a status or an id: the CALLER decides whether
 * a sibling owns the mirror (`ownsMirroredEvent`, ledger-standing.ts) and hands the answer over, because this
 * module is the settlement LEAF and cannot import the standing module. So the table is driven through the
 * real `ownsMirroredEvent` over one row per standing - the same composition `settleAccountingSyncRow` runs.
 */
function candidate(row: Partial<LedgerStandingRow> & { id?: string }, mirrorKeys: string[]): {
  id: string; status: string; ownsMirror: boolean; posted: boolean; assertedDocument: boolean; mirrorKeys: string[]
} {
  const full: LedgerStandingRow = {
    status: 'PENDING', externalTransactionId: null, settlementBasis: null, abandonedBeforeRemoteCall: null, ...row,
  }
  return {
    id: row.id ?? 'other', status: full.status, ownsMirror: ownsMirroredEvent(full), posted: namesADocument(full),
    assertedDocument: ledgerStanding(full) === 'ASSERTED_POSTED', mirrorKeys,
  }
}

test('a live or already-posted sibling sharing a mirror key OWNS the mirror', () => {
  const mine = ['key-a', 'key-legacy']
  assert.equal(findMirrorOwnershipConflict(mine, [candidate({ status: 'PENDING' }, ['key-a'])])?.syncLogId, 'other')
  // A FAILED sibling with a document id is a document that exists (o3d-ju8t) — it owns its mirror.
  assert.equal(
    findMirrorOwnershipConflict(mine, [candidate({ status: 'FAILED', externalTransactionId: 'INV-7' }, ['key-legacy'])])?.posted,
    true,
  )
  // A dead sibling with no evidence owns nothing.
  assert.equal(findMirrorOwnershipConflict(mine, [candidate({ status: 'CANCELLED' }, ['key-a'])]), null)
  // No shared key means no conflict, whatever the sibling's status.
  assert.equal(findMirrorOwnershipConflict(mine, [candidate({ status: 'PENDING' }, ['key-z'])]), null)
  // Nothing to own when this row is not mirrored at all.
  assert.equal(findMirrorOwnershipConflict([], [candidate({ status: 'PENDING' }, ['key-a'])]), null)
})

test('[o3d-1e7sl G11] mirror ownership, one sibling per standing (existence: an asserted document owns its mirror too)', () => {
  const mine = ['key-a']
  const cases: Array<{ standing: string; row: Partial<LedgerStandingRow>; owns: boolean }> = [
    { standing: 'CONFIRMED_POSTED', row: { status: 'SYNCED', externalTransactionId: 'INV-1' }, owns: true },
    { standing: 'ASSERTED_POSTED', row: { status: 'SYNCED', externalTransactionId: 'TYPED', settlementBasis: 'OPERATOR_ASSERTION' }, owns: true },
    { standing: 'ASSERTED_NOT_POSTED', row: { status: 'CANCELLED', settlementBasis: 'OPERATOR_ASSERTION' }, owns: false },
    { standing: 'PROVEN_NOT_POSTED', row: { status: 'CANCELLED', abandonedBeforeRemoteCall: true }, owns: false },
    { standing: 'UNKNOWN', row: { status: 'FAILED' }, owns: false },
    { standing: 'LIVE_WORK', row: { status: 'PROCESSING' }, owns: true },
  ]
  let owning = 0
  for (const c of cases) {
    const full: LedgerStandingRow = { status: 'PENDING', externalTransactionId: null, settlementBasis: null, abandonedBeforeRemoteCall: null, ...c.row }
    assert.equal(ledgerStanding(full), c.standing, `precondition: ${c.standing}`)
    const conflict = findMirrorOwnershipConflict(mine, [candidate(c.row, ['key-a'])])
    assert.equal(conflict !== null, c.owns, c.standing)
    if (c.owns) owning += 1
  }
  console.log(`# G11 cases: ${cases.length}; sibling owns the mirror in ${owning}`)
  assert.ok(owning > 0 && owning < cases.length)
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

test('o3d-jit6 r1#3: a DAILY_BATCH row is offered the control NARROWED to POSTED, with the reason said out loud', () => {
  // The type no longer removes the control; it removes one of its two buttons and explains why. An
  // affordance that silently offered "It did NOT post" and then had the server refuse it would be the
  // dead end the settlement action was built to remove.
  const batch = describeSyncRowSettleability({ status: 'FAILED', type: 'DAILY_BATCH_GROUP_B', attemptRevision: 4 })
  assert.equal(batch.settleable, true)
  assert.equal(batch.notSettleableReason, null)
  assert.deepEqual(batch.settleableOutcomes, ['POSTED'])
  assert.match(batch.settlementCaveat ?? '', /cannot be settled as NOT POSTED/)
  assert.match(batch.settlementCaveat ?? '', /settle it POSTED with the journal id/)

  // An ordinary row keeps both, and says nothing about batches.
  const ordinary = describeSyncRowSettleability({ status: 'FAILED', type: 'SALES_INVOICE', attemptRevision: 4 })
  assert.deepEqual(ordinary.settleableOutcomes, ['POSTED', 'NOT_POSTED'])
  assert.doesNotMatch(ordinary.settlementCaveat ?? '', /DAILY BATCH/)

  // The STATUS gate still outranks it: a PENDING batch row has sent nothing to assert about.
  const pending = describeSyncRowSettleability({ status: 'PENDING', type: 'DAILY_BATCH_GROUP_B', attemptRevision: 4 })
  assert.equal(pending.settleable, false)
  assert.match(pending.notSettleableReason ?? '', /nothing has been sent/)
})

test('a status that admits no assertion says so on the status, not the attempt', () => {
  const pending = describeSyncRowSettleability({ status: 'PENDING', type: 'SALES_INVOICE', attemptRevision: 0 })
  assert.equal(pending.settleable, false)
  assert.match(pending.notSettleableReason ?? '', /nothing has been sent/)
  assert.equal(describeSettlementCaveat('PENDING'), null)
})

// ---------------------------------------------------------------------------
// r3, Codex finding 1 — THE SETTLEMENT BASIS MARKER.
//
// A settled POSTED row is status=SYNCED with an externalTransactionId, which is exactly what the
// connector's own writeback produces after a real call. Without a marker the two ARE the same row,
// and every reader that asks "did this post?" answers as though the ledger had confirmed it.
// ---------------------------------------------------------------------------

test('a POSTED assertion writes the OPERATOR_ASSERTION basis alongside the SYNCED status', () => {
  const data = buildSettlementData({ outcome: 'POSTED', externalTransactionId: ' INV-9001 ' }, NOW)
  assert.equal(data.status, 'SYNCED')
  assert.equal(data.externalTransactionId, 'INV-9001')
  // The marker is the whole point: without it this patch is indistinguishable from the connector's.
  assert.equal(data.settlementBasis, OPERATOR_ASSERTION_SETTLEMENT_BASIS)
})

test('a NOT_POSTED assertion carries the basis too — "a human looked" is weaker than "no id came back"', () => {
  const data = buildSettlementData({ outcome: 'NOT_POSTED' }, NOW)
  assert.equal(data.status, 'CANCELLED')
  assert.equal(data.settlementBasis, OPERATOR_ASSERTION_SETTLEMENT_BASIS)
})

test('the basis is read from the COLUMN, never from the settlement note', () => {
  // o3d-h2wx: errorMessage carries no provenance — both connectors overwrite it with the remote
  // system's own text — so a reader keying on the note would be keying on something a connector can
  // and does rewrite.
  assert.equal(settlementBasisOf(OPERATOR_ASSERTION_SETTLEMENT_BASIS), 'OPERATOR_ASSERTION')
  assert.equal(settlementBasisOf(null), 'CONNECTOR_CONFIRMED')
  assert.equal(settlementBasisOf(undefined), 'CONNECTOR_CONFIRMED')
  assert.equal(isOperatorAssertedSettlement('Settled by operator: verified POSTED as INV-1.'), false)
})

test('o3d-f709 (D4): an UNRECOGNISED non-null basis reads UNKNOWN, never CONNECTOR_CONFIRMED (it used to fail open)', () => {
  // Precondition printed: these are the four values the build writes or the connector leaves behind.
  assert.deepEqual(
    [null, undefined, 'OPERATOR_ASSERTION', 'OPERATOR_RELEASE', 'VERIFIED_REVERSAL'].map((b) => settlementBasisOf(b)),
    ['CONNECTOR_CONFIRMED', 'CONNECTOR_CONFIRMED', 'OPERATOR_ASSERTION', 'OPERATOR_RELEASE', 'VERIFIED_REVERSAL'],
  )
  for (const unknown of ['CONNECTOR_CONFIRMED', 'verified_reversal', '', ' ', 'OPERATOR_ASSERTION ', 'SOMETHING_NEWER']) {
    // 'CONNECTOR_CONFIRMED' is in the list on purpose: it is the TYPE's name for NULL, never a value
    // anything writes, so a row carrying that literal is a hand edit and must not read as confirmed.
    assert.equal(settlementBasisOf(unknown), 'UNKNOWN', `"${unknown}" must fail closed`)
  }
})

// ---------------------------------------------------------------------------
// r3, Codex finding 2 — A CONTRADICTED ASSERTION IS REFUSED, NOT ANNOTATED.
// ---------------------------------------------------------------------------

test('asserting POSTED as one document over a mirror naming a DIFFERENT one is refused, and names BOTH ids', () => {
  const refusal = refuseSettlementContradictedByMirror(
    { outcome: 'POSTED', externalTransactionId: 'INV-9001' },
    { status: 'POSTED', externalId: 'INV-7777' },
  )
  assert.equal(refusal?.code, 'contradicts_mirrored_document')
  assert.match(refusal?.message ?? '', /already names document INV-7777/)
  assert.match(refusal?.message ?? '', /asserts INV-9001/)
  // A refusal needs a remedy the operator can perform.
  assert.match(refusal?.message ?? '', /reverse it there before recording the other/)
})

test('re-asserting the SAME document over the mirror is idempotent, not a contradiction', () => {
  // A retried click or a lost response must not become a refusal; the guard declines only because
  // there is nothing left to write.
  assert.equal(
    refuseSettlementContradictedByMirror(
      { outcome: 'POSTED', externalTransactionId: ' INV-9001 ' },
      { status: 'POSTED', externalId: 'INV-9001' },
    ),
    null,
  )
})

test('asserting NOT_POSTED over a mirror that NAMES a document is refused as a contradiction', () => {
  const refusal = refuseSettlementContradictedByMirror({ outcome: 'NOT_POSTED' }, { status: 'POSTED', externalId: 'INV-9001' })
  assert.equal(refusal?.code, 'contradicts_mirrored_document')
  assert.match(refusal?.message ?? '', /already names document INV-9001/)
  assert.match(refusal?.message ?? '', /Settle this row as POSTED with that id/)
})

test('asserting NOT_POSTED over a mirror recorded POSTED with no id is still refused', () => {
  const refusal = refuseSettlementContradictedByMirror({ outcome: 'NOT_POSTED' }, { status: 'POSTED', externalId: null })
  assert.equal(refusal?.code, 'contradicts_mirrored_document')
  assert.match(refusal?.message ?? '', /already recorded as POSTED/)
})

test('a mirror with NO document on it contradicts nothing — a VOID event does not outrank an assertion', () => {
  // The line is a DOCUMENT, on either side: the same line refuseSettlement already draws for the
  // row's own externalTransactionId. Nothing on a VOID event outranks anything.
  assert.equal(refuseSettlementContradictedByMirror({ outcome: 'NOT_POSTED' }, { status: 'VOID', externalId: null }), null)
  assert.equal(
    refuseSettlementContradictedByMirror({ outcome: 'POSTED', externalTransactionId: 'INV-9001' }, { status: 'VOID', externalId: null }),
    null,
  )
})

// ---------------------------------------------------------------------------
// r3, Codex finding 4 — A POSTED ASSERTION ON A CANCELLED SALE MUST NOT ENTER THE SWEEP'S SHAPE.
// ---------------------------------------------------------------------------

test('a POSTED assertion on a cancelled sale records the document but leaves the row CANCELLED', () => {
  const data = buildCancelledSaleSettlementData({ outcome: 'POSTED', externalTransactionId: 'INV-9001' }, NOW)
  // The document id is REAL evidence — the delete guard reads it whatever the status — so it is kept.
  assert.equal(data.externalTransactionId, 'INV-9001')
  // But `SYNCED` + an id + no backReferenceCheckedAt IS repairXeroBackReferences' candidate shape,
  // and handing the sweep that shape for a cancelled order restarts its work: back-reference, PDF,
  // email, storefront note, PAYMENT. CANCELLED is outside the shape.
  assert.equal(data.status, 'CANCELLED')
  assert.equal(data.syncedAt, null)
  assert.equal(data.settlementBasis, OPERATOR_ASSERTION_SETTLEMENT_BASIS)
  assert.match(String(data.errorMessage), /THE SALE THIS ROW BELONGS TO IS CANCELLED/)
})

test('only SalesOrder rows are gated on the sale — a refund credit note is the cancellation\'s own document', () => {
  assert.equal(isSaleScopedSettlementRow('SalesOrder'), true)
  // Gating these would strand exactly the document a cancellation creates: crediting a cancelled
  // sale is right, invoicing it is wrong (o3d-e2mz r8).
  assert.equal(isSaleScopedSettlementRow('SalesOrderRefund'), false)
  assert.equal(isSaleScopedSettlementRow('PurchaseInvoice'), false)
})

// ---------------------------------------------------------------------------
// r3, Codex finding 3 — ADOPTION, so the rows that motivated this branch can reach the remedy.
// ---------------------------------------------------------------------------

test('a revision-0 row that NOTHING can ever claim is settleable by adoption, with the minting said out loud', () => {
  // This is EVERY o3d-osl8 stranded row: on a retired connector, so no processor will ever claim it,
  // so its revision never leaves 0. Refusing it for ever means the per-row remedy does not exist for
  // the population it was built for.
  const s = describeSyncRowSettleability({
    status: 'FAILED', type: 'SALES_INVOICE', attemptRevision: UNCLAIMED_ATTEMPT_REVISION,
    unclaimable: true, connector: 'quickbooks',
  })
  assert.equal(s.settleable, true)
  assert.equal(s.requiresAttemptAdoption, true)
  assert.equal(s.notSettleableReason, null)
  assert.match(s.settlementCaveat ?? '', /MINTS one/)
  // Round 5: the caveat now states the WHOLE precondition rather than half of it — the manual Sync
  // button gates on the connector's own toggle and never asks which connector is active.
  assert.match(s.settlementCaveat ?? '', /neither the active connector nor sync-enabled/)
  assert.match(s.settlementCaveat ?? '', /not the manual Sync button/)
  // The status caveat is still carried: a FAILED row is not proof that nothing posted.
  assert.match(s.settlementCaveat ?? '', /NOT proof that nothing posted/)
})

test('a revision-0 row on the ACTIVE connector is still refused — and told the route it already has', () => {
  // Not adopted, because it HAS a route: retry it, the fence-aware processor claims it and stamps
  // attempt 1. A second way to do what the system does correctly by itself is the same objection
  // that keeps PENDING unsettleable. The refusal is not a dead end, which is why it names the route.
  const s = describeSyncRowSettleability({ status: 'FAILED', type: 'SALES_INVOICE', attemptRevision: 0 })
  assert.equal(s.settleable, false)
  assert.equal(s.requiresAttemptAdoption, false)
  assert.match(s.notSettleableReason ?? '', /retry the row, and settle it once it shows an attempt/)
})

test('adoption carries the TYPE narrowing with it — an adopted DAILY_BATCH row is still POSTED-only', () => {
  const s = describeSyncRowSettleability({
    status: 'FAILED', type: 'DAILY_BATCH_GROUP_B', attemptRevision: 0, unclaimable: true, connector: 'quickbooks',
  })
  assert.equal(s.settleable, true)
  assert.equal(s.requiresAttemptAdoption, true)
  assert.deepEqual(s.settleableOutcomes, ['POSTED'])
  assert.match(s.settlementCaveat ?? '', /cannot be settled as NOT POSTED/)
  assert.match(s.settlementCaveat ?? '', /MINTS one/, 'and the adoption is still said out loud')
})

test('adoption never overrides the STATUS gate — a PENDING stranded row is still the sweeps\' work', () => {
  const s = describeSyncRowSettleability({
    status: 'PENDING', type: 'SALES_INVOICE', attemptRevision: 0, unclaimable: true, connector: 'quickbooks',
  })
  assert.equal(s.settleable, false)
  assert.match(s.notSettleableReason ?? '', /nothing has been sent/)
})

test('[o3d-1e7sl AE4] a NOT_POSTED assertion against a POSTED mirror says whose word the mirror rests on', () => {
  // The mirror carries `postBasis`: CONNECTOR/SYNC_LOG_BACKFILL = the ledger answered; OPERATOR_ASSERTION = a
  // person typed the id; NULL = nobody recorded. "evidence it DID post" and "a posting IMS has already
  // written down" are true of the first only. Each still REFUSES (two assertions cannot both stand).
  const cases: Array<{ name: string; postBasis: string | null | undefined; says: RegExp; never: RegExp }> = [
    { name: 'CONNECTOR', postBasis: 'CONNECTOR', says: /which is evidence it DID post/, never: /assertion IMS never read/ },
    { name: 'SYNC_LOG_BACKFILL', postBasis: 'SYNC_LOG_BACKFILL', says: /which is evidence it DID post/, never: /assertion IMS never read/ },
    { name: 'OPERATOR_ASSERTION', postBasis: 'OPERATOR_ASSERTION', says: /an OPERATOR earlier recorded as posted \(an assertion IMS never read from the ledger, not a confirmation\)/, never: /evidence it DID post/ },
    { name: 'NULL (unrecorded)', postBasis: null, says: /basis was never recorded/, never: /evidence it DID post/ },
    { name: 'absent (caller did not say)', postBasis: undefined, says: /basis was never recorded/, never: /evidence it DID post/ },
  ]
  for (const c of cases) {
    const view = { status: 'POSTED', externalId: 'INV-9001', ...(c.postBasis === undefined ? {} : { postBasis: c.postBasis }) }
    const refusal = refuseSettlementContradictedByMirror({ outcome: 'NOT_POSTED' }, view)
    console.log(`# AE4 precondition: ${c.name}: refused=${refusal !== null}`)
    assert.equal(refusal?.code, 'contradicts_mirrored_document', c.name)
    assert.match(refusal!.message, c.says, c.name)
    assert.doesNotMatch(refusal!.message, c.never, c.name)
  }
  // The id-less POSTED mirror: the sentence must not claim IMS "wrote down" a posting when a person told it.
  const asserted = refuseSettlementContradictedByMirror({ outcome: 'NOT_POSTED' }, { status: 'POSTED', externalId: null, postBasis: 'OPERATOR_ASSERTION' })
  assert.match(asserted!.message, /on an operator's earlier assertion/)
  assert.doesNotMatch(asserted!.message, /a posting IMS has already written down/)
  const confirmed = refuseSettlementContradictedByMirror({ outcome: 'NOT_POSTED' }, { status: 'POSTED', externalId: null, postBasis: 'CONNECTOR' })
  assert.match(confirmed!.message, /already recorded as POSTED, so asserting that nothing posted contradicts that record/)
})

test('[o3d-1e7sl D11] the mirror-ownership audit note says whose id the owning sibling carries', () => {
  const mine = ['key-a']
  const confirmed = findMirrorOwnershipConflict(mine, [candidate({ status: 'SYNCED', externalTransactionId: 'INV-1' }, ['key-a'])])!
  const asserted = findMirrorOwnershipConflict(mine, [candidate({ status: 'SYNCED', externalTransactionId: 'TYPED', settlementBasis: 'OPERATOR_ASSERTION' }, ['key-a'])])!
  const live = findMirrorOwnershipConflict(mine, [candidate({ status: 'PENDING' }, ['key-a'])])!
  assert.equal(confirmed.assertedDocument, false)
  assert.equal(asserted.assertedDocument, true)
  assert.match(describeMirrorOwnershipSkip(confirmed), /\(SYNCED, carries post evidence\) maps to the same mirrored event/)
  assert.match(describeMirrorOwnershipSkip(asserted), /\(SYNCED, names a document an operator typed in - an assertion, never read from the ledger\) maps to the same mirrored event/)
  assert.doesNotMatch(describeMirrorOwnershipSkip(asserted), /carries post evidence/)
  assert.match(describeMirrorOwnershipSkip(live), /\(PENDING\) maps to the same mirrored event/)
})
