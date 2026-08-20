import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LEDGER_HELD_REGISTRATION_STATUSES,
  buildVerifiedReversalData,
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

test('a FAILED or CANCELLED row with no document id holds nothing and needs no action', () => {
  const split = splitPaymentRegistrations([
    reg({ id: 'a', status: 'FAILED' }),
    reg({ id: 'b', status: 'CANCELLED' }),
  ])
  assert.deepEqual(split.retirable, [])
  assert.deepEqual(split.ledgerHold, [])
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
