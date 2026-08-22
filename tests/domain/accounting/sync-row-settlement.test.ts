import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DAILY_BATCH_SYNC_TYPE_PREFIX,
  SETTLEABLE_ACCOUNTING_SYNC_STATUSES,
  OPERATOR_ASSERTION_SETTLEMENT_BASIS,
  buildCancelledSaleSettlementData,
  buildSettlementData,
  describeSettlementCaveat,
  describeSettlementUniqueConflict,
  describeSyncRowSettleability,
  describeUnsettleableStatus,
  findMirrorOwnershipConflict,
  isFencedAttemptRevision,
  isSettleableAccountingSyncStatus,
  isSettleableAccountingSyncType,
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
  assert.match(s.settlementCaveat ?? '', /while quickbooks is not the active connector/)
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

test('adoption never overrides the TYPE gate — a DAILY_BATCH row is unsettleable at any revision', () => {
  const s = describeSyncRowSettleability({
    status: 'FAILED', type: 'DAILY_BATCH_GROUP_B', attemptRevision: 0, unclaimable: true, connector: 'quickbooks',
  })
  assert.equal(s.settleable, false)
  assert.equal(s.requiresAttemptAdoption, false)
  assert.match(s.notSettleableReason ?? '', /DAILY BATCH row/)
})

test('adoption never overrides the STATUS gate — a PENDING stranded row is still the sweeps\' work', () => {
  const s = describeSyncRowSettleability({
    status: 'PENDING', type: 'SALES_INVOICE', attemptRevision: 0, unclaimable: true, connector: 'quickbooks',
  })
  assert.equal(s.settleable, false)
  assert.match(s.notSettleableReason ?? '', /nothing has been sent/)
})
