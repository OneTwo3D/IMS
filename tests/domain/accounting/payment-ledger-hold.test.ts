import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LEDGER_HELD_REGISTRATION_STATUSES,
  READABLE_REGISTRATION_STATUSES,
  UNDECIDED_ATTEMPT_REVERSAL_REFUSAL,
  UNDECIDED_REGISTRATION_STATUSES,
  buildVerifiedReversalData,
  describeAttemptUndecidedRefusal,
  describeLedgerHoldRefusal,
  hasPostEvidence,
  isReversedInLedger,
  ledgerReversalNote,
  refuseLedgerLookupFailure,
  refuseLedgerStillHolds,
  refuseUnverifiableConnector,
  splitPaymentRegistrations,
  type PaymentRegistrationRow,
} from '@/lib/domain/accounting/payment-ledger-hold'

// o3d-1vuv — WHICH registrations stop a receipt being deleted, and what a verified reversal writes.
//
// The classification is the whole safety property: a row put in `retirable` by mistake is a payment
// silently abandoned in a real ledger, and a row put in `ledgerHold` by mistake is a delete an
// operator cannot perform.

function reg(over: Partial<PaymentRegistrationRow> = {}): PaymentRegistrationRow {
  return { id: 'log-1', connector: 'xero', status: 'PENDING', externalTransactionId: null, ...over }
}

test('the held statuses are exactly the ones settlementStatus reads as held by the ledger', () => {
  // Kept in step with lib/domain/accounting/settlement-status.ts on purpose: these are the rows whose
  // disappearance would turn a real LEDGER_UNMATCHED discrepancy into a plain, undiscrepant UNPAID.
  assert.deepEqual([...LEDGER_HELD_REGISTRATION_STATUSES], ['PENDING', 'PROCESSING', 'SYNCED'])
})

test('only a PENDING row with no document id can be retired without asking anyone', () => {
  const split = splitPaymentRegistrations([reg({ id: 'a', status: 'PENDING' })])
  assert.deepEqual(split.retirable.map((r) => r.id), ['a'])
  assert.deepEqual(split.ledgerHold, [])
  assert.deepEqual(split.undecided, [])
})

test('a PROCESSING or SYNCED registration holds the ledger and blocks the delete', () => {
  for (const status of ['PROCESSING', 'SYNCED']) {
    const split = splitPaymentRegistrations([reg({ id: 'a', status })])
    assert.deepEqual(split.retirable, [], status)
    assert.deepEqual(split.ledgerHold.map((r) => r.id), ['a'], status)
  }
})

test('post evidence outranks status: a FAILED row that names a document still holds the ledger', () => {
  // o3d-ju8t: the remote call happens BEFORE the result is written back, so a FAILED registration can
  // sit in front of a real payment in Xero. Reading FAILED as "nothing posted" is what stranded them.
  const split = splitPaymentRegistrations([reg({ id: 'a', status: 'FAILED', externalTransactionId: 'PAY-1' })])
  assert.deepEqual(split.retirable, [])
  assert.deepEqual(split.ledgerHold.map((r) => r.id), ['a'])
})

test('a PENDING row that somehow carries a document id is a hold, not something to retire', () => {
  const split = splitPaymentRegistrations([reg({ id: 'a', status: 'PENDING', externalTransactionId: 'PAY-1' })])
  assert.deepEqual(split.retirable, [])
  assert.deepEqual(split.ledgerHold.map((r) => r.id), ['a'])
})

test('a FAILED row with no document id is UNDECIDED — an attempt nobody can speak for', () => {
  // THE CORRECTION. This used to fall through every branch and be classified as nothing at all, so
  // deletePayment removed the receipt while a payment the attempt may well have created stayed in
  // the ledger. A FAILED row is not proof that nothing posted: the processor calls the accounting
  // system BEFORE it writes the result down, so a lost response is recorded as a failure in front
  // of a real payment. It is not `ledgerHold` either — nothing establishes that a payment exists —
  // which is exactly why it needs a bucket of its own.
  const split = splitPaymentRegistrations([reg({ id: 'a', status: 'FAILED' })])
  assert.deepEqual(split.retirable, [])
  assert.deepEqual(split.ledgerHold, [])
  assert.deepEqual(split.undecided.map((r) => r.id), ['a'])
})

test('a CANCELLED row with no document id holds nothing and needs no action', () => {
  // CANCELLED is the one status IMS only ever writes where "nothing was sent" has ALREADY been
  // established, so unlike FAILED it asserts something rather than merely recording an outcome.
  const split = splitPaymentRegistrations([reg({ id: 'b', status: 'CANCELLED' })])
  assert.deepEqual(split.retirable, [])
  assert.deepEqual(split.ledgerHold, [])
  assert.deepEqual(split.undecided, [])
})

test('post evidence still wins over undecided: a FAILED row naming a document is a HOLD', () => {
  // The two FAILED cases must not collapse into one. A document id makes the payment checkable, and
  // the checkable one gets the refusal that has a verified remedy behind it.
  const split = splitPaymentRegistrations([
    reg({ id: 'a', status: 'FAILED', externalTransactionId: 'PAY-1' }),
    reg({ id: 'b', status: 'FAILED' }),
  ])
  assert.deepEqual(split.ledgerHold.map((r) => r.id), ['a'])
  assert.deepEqual(split.undecided.map((r) => r.id), ['b'])
})

test('the undecided statuses are FAILED, and CANCELLED is deliberately not one of them', () => {
  assert.deepEqual([...UNDECIDED_REGISTRATION_STATUSES], ['FAILED'])
  assert.ok(!(UNDECIDED_REGISTRATION_STATUSES as readonly string[]).includes('CANCELLED'))
})

test('every status the splitter can classify is one the query is told to read', () => {
  // The drift this pins is silent and one-directional: a status the QUERY omits never reaches the
  // splitter, so it is classified as "no registration exists" — the permissive answer, and the one
  // that deleted receipts over FAILED rows. Both lists live in this module so they move together.
  for (const status of [...LEDGER_HELD_REGISTRATION_STATUSES, ...UNDECIDED_REGISTRATION_STATUSES]) {
    assert.ok(
      (READABLE_REGISTRATION_STATUSES as readonly string[]).includes(status),
      `${status} is classified but would never be read`,
    )
  }
})

test('the delete refusal names the document and points at the remedy, not at a warning', () => {
  const refusal = describeLedgerHoldRefusal([reg({ status: 'SYNCED', externalTransactionId: 'PAY-9' })], 'SO-1001')
  assert.equal(refusal.code, 'ledger_holds_payment')
  assert.match(refusal.message, /SO-1001/)
  assert.match(refusal.message, /payment PAY-9/)
  assert.match(refusal.message, /Nothing was deleted/)
  // The remedy is a thing the operator can do, and IMS says it will CHECK rather than believe them.
  assert.match(refusal.message, /Reverse in ledger and delete/)
  assert.match(refusal.message, /check with the accounting system/)
})

test('a hold with no document id is called out separately, because it cannot be checked', () => {
  const refusal = describeLedgerHoldRefusal([reg({ status: 'PROCESSING' })], 'SO-1001')
  assert.match(refusal.message, /still in flight and has no document id/)
})

test('the undecided refusal states what is UNKNOWN, and never that a payment exists', () => {
  const refusal = describeAttemptUndecidedRefusal([reg({ id: 'log-7', status: 'FAILED' })], 'SO-1001')
  assert.equal(refusal.code, 'registration_attempt_undecided')
  assert.match(refusal.message, /SO-1001/)
  assert.match(refusal.message, /Nothing was deleted/)
  // The reasoning, not just the verdict — this is the sentence that stops the next reader
  // "simplifying" a FAILED row back into "nothing posted".
  assert.match(refusal.message, /A failure is not proof that nothing was posted/)
  assert.match(refusal.message, /called BEFORE the result is written down/)
  // It names the entry, so the operator can find it rather than hunt for it.
  assert.match(refusal.message, /log-7/)
  // And a remedy in two branches, because which branch applies is the fact that is missing.
  assert.match(refusal.message, /look at the payments on it/)
  assert.match(refusal.message, /retry the registration under Sync → Xero/)
  // It must NOT claim a payment id it does not have, nor point at the verified-reversal button:
  // there is nothing for that button to check, and offering it would invite the unchecked delete.
  assert.ok(!/payment PAY-/.test(refusal.message))
  assert.ok(!/Reverse in ledger and delete/.test(refusal.message))
})

test('the reversal refuses an undecided attempt too, so the remedy is not a way round the refusal', () => {
  // "I have reversed it — check and delete" promises IMS checked. Against an entry with no document
  // id there is nothing to check, so honouring it would delete the receipt on the operator's word.
  assert.equal(UNDECIDED_ATTEMPT_REVERSAL_REFUSAL.code, 'attempt_undecided')
  assert.match(UNDECIDED_ATTEMPT_REVERSAL_REFUSAL.message, /names no payment reference/)
  assert.match(UNDECIDED_ATTEMPT_REVERSAL_REFUSAL.message, /Nothing was changed/)
  assert.match(UNDECIDED_ATTEMPT_REVERSAL_REFUSAL.message, /will not delete a receipt on an unchecked claim/)
})

test('only Xero DELETED counts as reversed; anything else is the ledger still holding it', () => {
  assert.equal(isReversedInLedger('DELETED'), true)
  assert.equal(isReversedInLedger('deleted'), true)
  assert.equal(isReversedInLedger('AUTHORISED'), false)
  assert.equal(isReversedInLedger(''), false)
  assert.equal(isReversedInLedger(null), false)
  assert.equal(isReversedInLedger(undefined), false)
})

test('a ledger that still holds the payment is refused with the status it actually reported', () => {
  const refusal = refuseLedgerStillHolds('PAY-9', 'AUTHORISED')
  assert.equal(refusal.code, 'ledger_still_holds_payment')
  assert.match(refusal.message, /PAY-9 \(status AUTHORISED\)/)
  assert.match(refusal.message, /nothing was changed/)
})

test('a lookup failure refuses rather than falling through to the delete', () => {
  const refusal = refuseLedgerLookupFailure('PAY-9', 'Not connected to Xero')
  assert.equal(refusal.code, 'ledger_lookup_failed')
  assert.match(refusal.message, /Not connected to Xero/)
  assert.match(refusal.message, /will not delete a receipt the ledger may still hold/)
})

test('a connector this check cannot ask is refused rather than trusted', () => {
  const refusal = refuseUnverifiableConnector('quickbooks')
  assert.equal(refusal.code, 'connector_not_supported')
  assert.match(refusal.message, /quickbooks/)
  assert.match(refusal.message, /unchecked claim/)
})

test('a verified reversal cancels the row but NEVER clears the document id', () => {
  const note = ledgerReversalNote(['PAY-9'], new Date('2026-08-20T09:00:00.000Z'))
  const data = buildVerifiedReversalData(note)
  assert.equal(data.status, 'CANCELLED')
  // externalTransactionId is ABSENT, not null: a CANCELLED row that still names PAY-9 is a complete
  // account of a payment that existed and was undone. Clearing it would erase the evidence that the
  // reversal was ever necessary.
  assert.ok(!('externalTransactionId' in data))
  assert.match(data.errorMessage, /IMS confirmed it \(PAY-9\) was DELETED there at 2026-08-20T09:00:00\.000Z/)
})

test('hasPostEvidence ignores whitespace-only ids', () => {
  assert.equal(hasPostEvidence(reg({ externalTransactionId: '   ' })), false)
  assert.equal(hasPostEvidence(reg({ externalTransactionId: 'PAY-9' })), true)
})
