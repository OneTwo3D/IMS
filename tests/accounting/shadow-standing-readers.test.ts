import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { unearnedReversalStandingReport } from '@/lib/domain/accounting/deferred-trueup'
import { ledgerStanding, mayHaveReachedLedger } from '@/lib/domain/accounting/ledger-standing'
import {
  describeAttemptUndecidedRefusal,
  registrationLedgerStanding,
  splitPaymentRegistrations,
  type PaymentRegistrationRow,
} from '@/lib/domain/accounting/payment-ledger-hold'
import { planBillPaymentSupersession } from '@/lib/domain/accounting/payment-reversal'
import { describeSyncRowStanding } from '@/lib/domain/accounting/posting-mark-handled'
import { unconditionalMoneySentences, unlicensedHistoryClaims } from '../helpers/unconditional-instruction'

/**
 * A SHADOW (HELD_SHADOW) IS NOT PROOF THE DOCUMENT IS ABSENT FROM THE LEDGER: EVERY READER FAMILY THAT DECIDES A DELETION,
 * A REVERSAL, A REFUND OR A RE-POST FROM "IS IT IN THE LEDGER" TREATS IT AS UNPROVEN.
 *
 * It proves only that IMS did not send it; the operation's real owner (Qoblex, Xeroom, an operator) may have posted the
 * document. The standing is therefore its own value (SHADOW_NOT_SENT_BY_IMS), never PROVEN_NOT_POSTED. One arm per reader
 * family, each with a CONTROL that is the orphan-sweep's PROVEN_NOT_POSTED row (same status, flag and no id, differing only in
 * the basis), so the arm is about the basis and not about the shape. The delete guard is in tests/sales-order-delete-guard.test.ts.
 *
 * Named mutations (shown red in the PR, restored from a copy, md5-verified):
 *  a  shadow-proven      truth-table row 5a answers PROVEN_NOT_POSTED again: every arm goes red
 *  b  payment-hold       registrationLedgerStanding maps the shadow to NOTHING: the payment-delete arms go red
 *  c  supersession       planBillPaymentSupersession ignores the shadow: the supersession arm goes red
 */

const shadow = { status: 'CANCELLED', externalTransactionId: null, abandonedBeforeRemoteCall: true, settlementBasis: 'HELD_SHADOW' }
const orphanSweep = { status: 'CANCELLED', externalTransactionId: null, abandonedBeforeRemoteCall: true, settlementBasis: null }

test('PRECONDITION: the shadow and the orphan-sweep row differ only in the basis, and have different standings', () => {
  console.log(`# shadow=${ledgerStanding(shadow)} orphan sweep=${ledgerStanding(orphanSweep)}`)
  assert.equal(ledgerStanding(shadow), 'SHADOW_NOT_SENT_BY_IMS')
  assert.equal(ledgerStanding(orphanSweep), 'PROVEN_NOT_POSTED')
  assert.equal(mayHaveReachedLedger(shadow), true)
  assert.equal(mayHaveReachedLedger(orphanSweep), false)
})

test('PAYMENT DELETION: a shadowed registration is UNDECIDED (never NOTHING), lands in the undecided bucket, and the refusal says what is true of a shadow', () => {
  assert.equal(registrationLedgerStanding(shadow), 'UNDECIDED')
  assert.equal(registrationLedgerStanding(orphanSweep), 'NOTHING', 'CONTROL: the proven-pre-call row is what may be erased over')
  const rows = [{ id: 'reg-shadow', connector: 'xero', ...shadow }] as PaymentRegistrationRow[]
  const split = splitPaymentRegistrations(rows)
  console.log(`# split: retirable=${split.retirable.length} ledgerHold=${split.ledgerHold.length} undecided=${split.undecided.length}`)
  assert.deepEqual([split.retirable.length, split.ledgerHold.length, split.undecided.length], [0, 0, 1])
  const control = splitPaymentRegistrations([{ id: 'reg-sweep', connector: 'xero', ...orphanSweep }] as PaymentRegistrationRow[])
  assert.deepEqual([control.retirable.length, control.ledgerHold.length, control.undecided.length], [0, 0, 0], 'CONTROL: nothing blocks the proven row')
  const refusal = describeAttemptUndecidedRefusal(split.undecided, 'order SO-1')
  assert.equal(refusal.code, 'registration_attempt_undecided')
  assert.match(refusal.message, /IMS did not register this receipt[\s\S]*SHADOW[\s\S]*may have posted a payment[\s\S]*Nothing was deleted/)
  assert.doesNotMatch(refusal.message, /attempt was recorded as FAILED|IMS tried to register/, 'a shadow is not an attempt by IMS')
  assert.deepEqual(unconditionalMoneySentences(refusal.message), [], refusal.message)
  assert.deepEqual(unlicensedHistoryClaims(refusal.message, /IMS did not (register|send)/i), [])
})

test('BILL PAYMENT SUPERSESSION: a shadowed supplier payment may have posted, so a second one is refused', () => {
  const plan = planBillPaymentSupersession([{ id: 'p1', type: 'BILL_PAYMENT', ...shadow } as never])
  assert.equal(plan.proceed, false)
  assert.ok(!plan.proceed && plan.refusal === 'PAYMENT_MAY_HAVE_POSTED')
  const control = planBillPaymentSupersession([{ id: 'p2', type: 'BILL_PAYMENT', ...orphanSweep } as never])
  assert.equal(control.proceed, true, 'CONTROL: the proven-pre-call row is ignored')
})

test('DEFERRED-REVENUE NETTING REPORT: a shadowed reversal row is named as unproven, a proven one is not', () => {
  const report = unearnedReversalStandingReport([
    { id: 'rev-shadow', referenceType: 'SalesOrder', referenceId: 'o', payload: {}, ...shadow },
    { id: 'rev-sweep', referenceType: 'SalesOrder', referenceId: 'o', payload: {}, ...orphanSweep },
  ] as never)
  assert.deepEqual(report.mayHavePostedNotCounted, ['rev-shadow'])
})

test('MARK-HANDLED / CLAIM: the row is described as a shadow, with no claim about the ledger', () => {
  const text = describeSyncRowStanding(shadow)
  assert.match(text, /recorded as a shadow \(IMS did not send it; whether the operation's owner posted it is not known\)/)
  assert.doesNotMatch(text, /never sent/i)
})

test('THE READER CENSUS: every module that switches on a ledger standing names the shadow, and none maps it to "nothing"', () => {
  // Modules that enumerate standings (not the ones that ask "!== PROVEN_NOT_POSTED", which are unproven by default).
  const modules = [
    'lib/domain/accounting/payment-ledger-hold.ts',
    'lib/domain/accounting/payment-reversal.ts',
    'lib/domain/sales/order-delete-guard.ts',
    'lib/domain/accounting/posting-mark-handled.ts',
    'lib/domain/accounting/ledger-standing-display.ts',
  ]
  let named = 0
  for (const file of modules) {
    const text = readFileSync(file, 'utf8')
    assert.ok(text.includes('SHADOW_NOT_SENT_BY_IMS'), `${file} must name the shadow standing`)
    named += 1
  }
  // The one reader whose mapping decides "NOTHING stands in the ledger" must not give the shadow that answer.
  const hold = readFileSync('lib/domain/accounting/payment-ledger-hold.ts', 'utf8')
  const nothingArm = hold.slice(hold.indexOf("case 'PROVEN_NOT_POSTED':"), hold.indexOf("case 'PROVEN_NOT_POSTED':") + 60)
  assert.doesNotMatch(nothingArm, /SHADOW/)
  console.log(`# reader modules naming the shadow standing: ${named}/${modules.length}`)
  assert.equal(named, modules.length)
})
