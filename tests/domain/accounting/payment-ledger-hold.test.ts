import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LEDGER_HELD_REGISTRATION_STATUSES,
  READABLE_REGISTRATION_STATUSES,
  UNDECIDED_ATTEMPTS_AMBIGUOUS_REFUSAL,
  UNDECIDED_ATTEMPT_REVERSAL_REFUSAL,
  UNDECIDED_REGISTRATION_STATUSES,
  assertedReversalNote,
  buildAssertedReversalData,
  buildVerifiedReversalData,
  canonicalCurrencyCode,
  canonicalLedgerAmount,
  describeAttemptUndecidedRefusal,
  describeLedgerHoldRefusal,
  hasPostEvidence,
  isReversedInLedger,
  ledgerReversalNote,
  normalizeAssertedPaymentReference,
  refuseAssertedPaymentAmountMismatch,
  refuseAssertedPaymentCurrencyMismatch,
  refuseAssertedPaymentNotOnInvoice,
  refuseAssertedPaymentStillOnInvoice,
  refuseAssertedPaymentUnattributable,
  refuseLedgerLookupFailure,
  refuseLedgerStillHolds,
  refuseUnverifiableConnector,
  registrationLedgerStanding,
  sameLedgerAmount,
  sameLedgerCurrency,
  sameLedgerIdentifier,
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
  // BOTH BRANCHES MUST LEAD SOMEWHERE. The "a payment IS there" branch used to say "reverse it
  // there, then delete this receipt" — and that delete lands on this very refusal again, because
  // reversing a payment in Xero changes nothing about a FAILED row that names no document. A
  // remedy that returns the operator to the refusal it came from is a dead end with a door painted
  // on it. It now ends in a check IMS can actually perform on a reference only they can supply.
  assert.match(refusal.message, /Check that payment and delete/)
  assert.match(refusal.message, /copy its payment reference/)
  assert.match(refusal.message, /belongs to this invoice/)
  // It must NOT claim a payment id it does not have, nor point at the verified-reversal button:
  // there is nothing for that button to check, and offering it would invite the unchecked delete.
  assert.ok(!/payment PAY-/.test(refusal.message))
  assert.ok(!/Reverse in ledger and delete/.test(refusal.message))
})

// ---------------------------------------------------------------------------
// ONE CLASSIFIER, so the delete and the settlement verdict cannot answer differently
// ---------------------------------------------------------------------------

test('registrationLedgerStanding gives the three answers, and CANCELLED is NOTHING even with a document id', () => {
  // The drift this closes: the delete grew a third answer for a FAILED row naming no document while
  // the settlement verdict kept two, so the row one module refused to touch was shown by the other
  // as a plainly unpaid order needing no attention.
  assert.equal(registrationLedgerStanding({ status: 'SYNCED', externalTransactionId: 'PAY-1' }), 'HELD')
  assert.equal(registrationLedgerStanding({ status: 'PENDING', externalTransactionId: null }), 'HELD')
  assert.equal(registrationLedgerStanding({ status: 'PROCESSING', externalTransactionId: null }), 'HELD')
  // Post evidence outranks status...
  assert.equal(registrationLedgerStanding({ status: 'FAILED', externalTransactionId: 'PAY-1' }), 'HELD')
  assert.equal(registrationLedgerStanding({ status: 'FAILED', externalTransactionId: null }), 'UNDECIDED')
  // ...except against CANCELLED, the one status written only where "nothing stands there" is already
  // established. A verified reversal KEEPS the document id on purpose, so reading it as a live hold
  // would make the fix alarm for ever.
  assert.equal(registrationLedgerStanding({ status: 'CANCELLED', externalTransactionId: 'PAY-1' }), 'NOTHING')
  assert.equal(registrationLedgerStanding({ status: 'CANCELLED', externalTransactionId: null }), 'NOTHING')
})

test('the splitter is expressed in those same answers, so it cannot classify a row differently', () => {
  const rows = [
    reg({ id: 'held', status: 'SYNCED', externalTransactionId: 'PAY-1' }),
    reg({ id: 'queued', status: 'PENDING' }),
    reg({ id: 'unknown', status: 'FAILED' }),
    reg({ id: 'reversed', status: 'CANCELLED', externalTransactionId: 'PAY-2' }),
  ]
  const split = splitPaymentRegistrations(rows)
  assert.deepEqual(split.ledgerHold.map((r) => r.id), ['held'])
  assert.deepEqual(split.retirable.map((r) => r.id), ['queued'])
  assert.deepEqual(split.undecided.map((r) => r.id), ['unknown'])
  for (const row of rows) {
    const standing = registrationLedgerStanding(row)
    const bucketed = split.ledgerHold.includes(row) || split.retirable.includes(row) || split.undecided.includes(row)
    assert.equal(bucketed, standing !== 'NOTHING', `${row.id} must be bucketed exactly when it stands for something`)
  }
})

// ---------------------------------------------------------------------------
// THE UNDECIDED ATTEMPT'S OWN REMEDY: asserted reference, verified answer
// ---------------------------------------------------------------------------

test('an empty or oversized reference is the same as supplying none', () => {
  // An empty box must land on "there is nothing to check", not on a lookup for the empty string —
  // which addresses Xero's WHOLE payment collection rather than one payment.
  assert.equal(normalizeAssertedPaymentReference(''), null)
  assert.equal(normalizeAssertedPaymentReference('   '), null)
  assert.equal(normalizeAssertedPaymentReference(undefined), null)
  assert.equal(normalizeAssertedPaymentReference(42), null)
  assert.equal(normalizeAssertedPaymentReference('x'.repeat(101)), null)
  assert.equal(normalizeAssertedPaymentReference('  PAY-9  '), 'PAY-9')
})

test('a payment on somebody else\'s invoice is refused by name, and says whose', () => {
  // Without the invoice check, "any deleted payment in the tenant" would authorise the delete — and
  // a Xero tenant is full of deleted payments.
  const refusal = refuseAssertedPaymentNotOnInvoice('PAY-9', 'SO-1001', 'INV-abc')
  assert.equal(refusal.code, 'asserted_payment_not_on_invoice')
  assert.match(refusal.message, /PAY-9 is not on the invoice for SO-1001/)
  assert.match(refusal.message, /belongs to invoice INV-abc/)
  assert.match(refusal.message, /Nothing was changed/)
})

test('a payment for the wrong amount is refused, because an invoice can carry several', () => {
  const refusal = refuseAssertedPaymentAmountMismatch('PAY-9', '40', '100')
  assert.equal(refusal.code, 'asserted_payment_amount_mismatch')
  assert.match(refusal.message, /for 40 and this receipt is for 100/)
})

// ---------------------------------------------------------------------------
// AMOUNTS ARE COMPARED EXACTLY, AND AN AMOUNT IS NOT AN IDENTITY (round 4)
// ---------------------------------------------------------------------------

test('the same amount in different renderings compares equal, to the last digit either side states', () => {
  // The receipt is a Decimal(18, 4) and Xero states a JSON number; both have to reduce to one text.
  assert.equal(canonicalLedgerAmount('100.0000'), '100')
  assert.equal(canonicalLedgerAmount(100), '100')
  assert.equal(canonicalLedgerAmount('0100.10'), '100.1')
  assert.equal(canonicalLedgerAmount('-0.00'), '0', 'minus zero is zero')
  assert.equal(canonicalLedgerAmount('-40.5000'), '-40.5')
  assert.ok(sameLedgerAmount('100.0000', 100))
  assert.ok(sameLedgerAmount({ toString: () => '100.00' }, '100'))
})

test('an amount a tolerance would have swallowed is a DIFFERENT amount', () => {
  // `Math.abs(a - b) > 0.005` admitted every one of these. Each is a different sum of money.
  assert.ok(!sameLedgerAmount(100.004, 100))
  assert.ok(!sameLedgerAmount(99.9955, 100))
  assert.ok(!sameLedgerAmount('100.005', '100.00'))
})

test('anything that is not plain decimal text is unreadable, never zero', () => {
  // Every caller has to treat null as "cannot be matched". Read as 0 instead, `sameLedgerAmount`
  // would make two unreadable amounts agree — which is how a refusal becomes a delete.
  for (const value of [NaN, Infinity, -Infinity, '', '  ', 'abc', '1e21', 1e21, '+100', '1,000', null, undefined, {}, []]) {
    assert.equal(canonicalLedgerAmount(value), null, `${String(value)} must be unreadable`)
  }
  assert.ok(!sameLedgerAmount(NaN, NaN), 'and two unreadable amounts are not "the same amount"')
})

// ---------------------------------------------------------------------------
// AND AN AMOUNT IS NOT A UNIT EITHER (round 5)
// ---------------------------------------------------------------------------

test('the same currency written differently is one currency', () => {
  assert.equal(canonicalCurrencyCode('gbp'), 'GBP')
  assert.equal(canonicalCurrencyCode(' GBP '), 'GBP')
  assert.ok(sameLedgerCurrency('gbp', 'GBP'))
})

test('anything that is not a three-letter code is unreadable, never the base currency', () => {
  // Read as a default instead, two receipts with no currency would "agree" — which is how a
  // comparison of numbers becomes a comparison of money that was never checked.
  for (const value of ['', '  ', 'GB', 'GBPX', '£', '826', 826, null, undefined, {}, ['GBP']]) {
    assert.equal(canonicalCurrencyCode(value), null, `${String(value)} must be unreadable`)
  }
  assert.ok(!sameLedgerCurrency(null, null), 'and two unknowns are not "the same currency"')
  assert.ok(!sameLedgerCurrency('', ''), 'nor two blanks')
})

test('two currencies that differ are not the same money, whatever the numbers say', () => {
  assert.ok(!sameLedgerCurrency('GBP', 'EUR'))
  // The point of the whole check, stated as an assertion: the amounts agree and the money does not.
  assert.ok(sameLedgerAmount('100.00', 100), 'the NUMBERS are equal')
  assert.ok(!sameLedgerCurrency('GBP', 'EUR'), 'and that says nothing about whether the MONEY is')
})

test('a ledger holding this money in another currency refuses, and names both sides', () => {
  const refusal = refuseAssertedPaymentCurrencyMismatch('PAY-9', 'SO-1001', 'EUR', 'GBP')
  assert.equal(refusal.code, 'asserted_payment_currency_mismatch')
  assert.match(refusal.message, /holds the invoice for SO-1001 in EUR, and this receipt is recorded in GBP/)
  assert.match(refusal.message, /the same figure in two currencies is not the same money/)
  assert.match(refusal.message, /Nothing was changed, and nothing was deleted/)
})

test('a payment still standing on the invoice for this amount refuses, and says which one', () => {
  // The amount was only ever a filter. The proof that the named payment is THIS receipt's cannot come
  // from a value two payments can share — so a standing payment for that value refuses by name.
  const refusal = refuseAssertedPaymentStillOnInvoice('PAY-9', 'SO-1001', 'PAY-77', '100')
  assert.equal(refusal.code, 'asserted_payment_amount_ambiguous')
  assert.match(refusal.message, /invoice for SO-1001 STILL carries a payment for 100 \(PAY-77\)/)
  assert.match(refusal.message, /payment PAY-9 was for that same amount/)
  assert.match(refusal.message, /Nothing was changed, and nothing was deleted/)
  // Both ways out, because a refusal without one is where round 1 went wrong.
  assert.match(refusal.message, /reverse THAT payment in the accounting system and name it here/)
  assert.match(refusal.message, /Sync → Xero/)
})

test('with no ledger invoice recorded there is nothing to attribute the payment to, so it refuses', () => {
  const refusal = refuseAssertedPaymentUnattributable('SO-1001')
  assert.equal(refusal.code, 'asserted_payment_unattributable')
  assert.match(refusal.message, /no accounting invoice recorded for SO-1001/)
})

test('two undecided attempts cannot be settled by one reference', () => {
  assert.equal(UNDECIDED_ATTEMPTS_AMBIGUOUS_REFUSAL.code, 'attempt_undecided_ambiguous')
  assert.match(UNDECIDED_ATTEMPTS_AMBIGUOUS_REFUSAL.message, /MORE THAN ONE/)
  assert.match(UNDECIDED_ATTEMPTS_AMBIGUOUS_REFUSAL.message, /Nothing was changed/)
})

test('an asserted reversal DECIDES the row: it writes the reference on, and says where it came from', () => {
  // The opposite of buildVerifiedReversalData, deliberately. That one must never CLEAR an id it was
  // given; this one must ADD the id the processor never wrote down — that is the whole value of the
  // path, because the row stops saying "an attempt, outcome unknown" for ever.
  const note = assertedReversalNote('PAY-9', 'INV-abc', new Date('2026-08-21T09:00:00.000Z'))
  const data = buildAssertedReversalData('  PAY-9 ', note)
  assert.equal(data.status, 'CANCELLED')
  assert.equal(data.externalTransactionId, 'PAY-9')
  assert.match(data.errorMessage, /an operator identified this failed attempt as payment PAY-9/)
  assert.match(data.errorMessage, /IMS confirmed .* it was on invoice INV-abc and was DELETED there/)
  assert.match(data.errorMessage, /2026-08-21T09:00:00\.000Z/)
})

test('ledger identifiers compare without case, and never match on emptiness', () => {
  assert.equal(sameLedgerIdentifier('ABC-1', 'abc-1'), true)
  assert.equal(sameLedgerIdentifier(' abc-1 ', 'ABC-1'), true)
  assert.equal(sameLedgerIdentifier(null, null), false, 'two unknowns are not a match')
  assert.equal(sameLedgerIdentifier('', ''), false)
  assert.equal(sameLedgerIdentifier('abc-1', 'abc-2'), false)
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

// ---------------------------------------------------------------------------
// o3d-anu8 — TWO WRITERS, ONE ROW SHAPE, OPPOSITE FACTS.
//
// `buildVerifiedReversalData` writes { CANCELLED, externalTransactionId, errorMessage } after asking
// Xero and being told the payment is DELETED. `buildCancelledSaleSettlementData` writes
// { CANCELLED, externalTransactionId, errorMessage } because an operator typed a document id in and
// the sale is cancelled. The first is a VERIFIED ABSENCE; the second is an UNVERIFIED CLAIM THAT THE
// DOCUMENT EXISTS. They differ in exactly one column.
// ---------------------------------------------------------------------------

test('[o3d-anu8] a CANCELLED registration an OPERATOR asserted still HOLDS — only a verified reversal is NOTHING', () => {
  // The verified reversal, unchanged: Xero was asked and answered.
  assert.equal(
    registrationLedgerStanding({ status: 'CANCELLED', externalTransactionId: 'PAY-1', settlementBasis: null }),
    'NOTHING',
  )
  // The assertion. Reading this as NOTHING lets deletePayment destroy the last local record of a
  // payment that may be standing in a real ledger.
  assert.equal(
    registrationLedgerStanding({ status: 'CANCELLED', externalTransactionId: 'PAY-1', settlementBasis: 'OPERATOR_ASSERTION' }),
    'HELD',
  )
  // ...and the NOT_POSTED settlement, which names no document, still frees the receipt. That
  // assertion IS "nothing posted", it is audited with a person's name on it, and giving a stranded
  // receipt a way out is what the settlement action exists for.
  assert.equal(
    registrationLedgerStanding({ status: 'CANCELLED', externalTransactionId: null, settlementBasis: 'OPERATOR_ASSERTION' }),
    'NOTHING',
  )
})

test('[o3d-anu8] the delete split routes the asserted cancellation into ledgerHold, not into no bucket at all', () => {
  const split = splitPaymentRegistrations([
    { id: 'r1', connector: 'xero', status: 'CANCELLED', externalTransactionId: 'PAY-1', settlementBasis: 'OPERATOR_ASSERTION' },
  ])
  assert.deepEqual(split.ledgerHold.map((row) => row.id), ['r1'])
  assert.deepEqual(split.retirable, [])
  assert.deepEqual(split.undecided, [])
})
