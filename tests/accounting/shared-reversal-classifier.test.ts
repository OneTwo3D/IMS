import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyRegisteredPayment,
  classifyRegisteredPaymentAgainstListing,
  databaseLedgerFence,
  listedLedgerPaymentIds,
  zeroPaidIsProvenReversal,
  type RegisteredPaymentRow,
  type XeroInvoice,
} from '@/lib/connectors/xero/invoice-delta'
import { qboWithheldReversalReason } from '@/lib/connectors/quickbooks/payment-poller'

/**
 * o3d-psrx r3 (Codex HIGH) — ONE CASE TABLE, BOTH ENTRY POINTS.
 *
 * Codex's first instruction was to reuse the Xero decision path rather than write a second one, and
 * to say — if the two cannot literally be one function — how they are kept in agreement. They CAN be:
 * `classifyRegisteredPayment` is now `classifyRegisteredPaymentAgainstListing` plus the one line that
 * reads a Xero invoice's `Payments[]`. So agreement is not maintained by discipline, it is maintained
 * by there being one implementation — and this file is the proof of that claim rather than a
 * restatement of it.
 *
 * THE TABLE BELOW IS DRIVEN THROUGH BOTH DOORS and asserted EQUAL, case by case. If somebody re-inlines
 * the decision into the Xero entry point, the two can diverge and this is what notices — the same
 * technique that kept the two bill-payment fences in step on o3d-batch-ret.
 *
 * THE QUICKBOOKS COLUMN is the second half. QuickBooks' reversal read enumerates no payments at all, so
 * its listing is always NULL — and null is "absence cannot be established", never "no payments". Every
 * case therefore states what the SAME evidence decides for a connector that cannot enumerate, which is
 * exactly what `gateQboReversalsOnProvenance` acts on.
 */

const READ_AT = databaseLedgerFence(new Date('2026-08-20T12:00:00.000Z'))
const BEFORE_READ = new Date('2026-08-20T11:00:00.000Z')
const AFTER_READ = new Date('2026-08-20T12:00:01.000Z')

const registration = (overrides: Partial<RegisteredPaymentRow> = {}): RegisteredPaymentRow => {
  const row = { id: 'log_1', status: 'SYNCED', externalTransactionId: 'PAY-1', syncedAt: BEFORE_READ, ...overrides }
  return { syncedAtDatabaseClock: row.syncedAt, ...row }
}

/** A sales invoice the ledger says holds NOTHING, listing its (empty) payments. */
const zeroPaidListing = (payments: string[] = []): XeroInvoice => ({
  InvoiceID: 'inv_1',
  Type: 'ACCREC',
  Status: 'AUTHORISED',
  AmountPaid: 0,
  AmountDue: 100,
  Payments: payments.map((PaymentID) => ({ PaymentID })),
})

type Case = {
  name: string
  invoice: XeroInvoice
  registrations: RegisteredPaymentRow[]
  unregisteredReceiptIds: string[]
  paidWithoutLedgerReceipt: boolean
  /** What Xero — which CAN enumerate the payments — concludes. */
  xero: string
  /** What QuickBooks — which cannot — concludes from the same IMS-side evidence. */
  quickbooks: string
  /** Does that QuickBooks verdict permit the reversal? */
  quickbooksReverses: boolean
}

const CASES: Case[] = [
  {
    name: 'THE DEFECT: paid by an operator or a channel, nothing registered, no receipt',
    invoice: zeroPaidListing(),
    registrations: [],
    unregisteredReceiptIds: [],
    paidWithoutLedgerReceipt: true,
    xero: 'PAID_WITHOUT_LEDGER_RECEIPT',
    quickbooks: 'PAID_WITHOUT_LEDGER_RECEIPT',
    quickbooksReverses: false,
  },
  {
    name: 'THE CONTROL: the same absence of evidence, but the paid flag came from the ledger',
    invoice: zeroPaidListing(),
    registrations: [],
    unregisteredReceiptIds: [],
    paidWithoutLedgerReceipt: false,
    xero: 'NOTHING_REGISTERED',
    quickbooks: 'NOTHING_REGISTERED',
    quickbooksReverses: true,
  },
  {
    name: 'a local receipt IMS has not registered yet (the addPayment window)',
    invoice: zeroPaidListing(),
    registrations: [],
    unregisteredReceiptIds: ['pay_1'],
    paidWithoutLedgerReceipt: true,
    xero: 'RECEIPT_NOT_REGISTERED',
    quickbooks: 'RECEIPT_NOT_REGISTERED',
    quickbooksReverses: false,
  },
  {
    name: 'a registration this read cannot speak for (PENDING)',
    invoice: zeroPaidListing(),
    registrations: [registration({ status: 'PENDING' })],
    unregisteredReceiptIds: [],
    paidWithoutLedgerReceipt: true,
    xero: 'REGISTRATION_UNDECIDED',
    quickbooks: 'REGISTRATION_UNDECIDED',
    quickbooksReverses: false,
  },
  {
    name: 'a registration that SYNCED after the ledger was read',
    invoice: zeroPaidListing(),
    registrations: [registration({ syncedAt: AFTER_READ })],
    unregisteredReceiptIds: [],
    paidWithoutLedgerReceipt: false,
    xero: 'REGISTRATION_UNDECIDED',
    quickbooks: 'REGISTRATION_UNDECIDED',
    quickbooksReverses: false,
  },
  {
    name: 'THE GENUINE CHARGEBACK: our payment posted before the read and the ledger no longer lists it',
    invoice: zeroPaidListing(),
    registrations: [registration()],
    unregisteredReceiptIds: [],
    paidWithoutLedgerReceipt: true,
    // Xero can enumerate, so it proves the identity is gone.
    xero: 'GONE',
    // QuickBooks cannot enumerate — but it still reverses, which is the point: the marker is
    // SELF-DISCHARGING. Once a registration is proved to have reached the ledger, the ledger decides.
    quickbooks: 'LEDGER_DID_NOT_LIST_PAYMENTS',
    quickbooksReverses: true,
  },
  {
    name: 'our payment posted and the ledger STILL lists it',
    invoice: zeroPaidListing(['PAY-1']),
    registrations: [registration()],
    unregisteredReceiptIds: [],
    paidWithoutLedgerReceipt: false,
    xero: 'STILL_HELD',
    // Unreachable from QuickBooks: with no listing there is nothing to be still held in.
    quickbooks: 'LEDGER_DID_NOT_LIST_PAYMENTS',
    quickbooksReverses: true,
  },
]

for (const c of CASES) {
  test(`[o3d-psrx r3] both entry points agree — ${c.name}`, () => {
    const throughXeroDoor = classifyRegisteredPayment(
      c.invoice, c.registrations, READ_AT, c.unregisteredReceiptIds, c.paidWithoutLedgerReceipt,
    )
    const throughSharedDoor = classifyRegisteredPaymentAgainstListing(
      listedLedgerPaymentIds(c.invoice), c.registrations, READ_AT, c.unregisteredReceiptIds, c.paidWithoutLedgerReceipt,
    )
    // AGREEMENT IS THE ASSERTION, not "both are correct" — that is what makes it survive a future
    // change to what the verdict SHOULD be while still catching the two implementations parting.
    assert.deepEqual(throughXeroDoor, throughSharedDoor,
      'the Xero entry point must be the shared core plus a listing, not a second decision')
    assert.equal(throughXeroDoor.verdict, c.xero)
  })

  test(`[o3d-psrx r3] QuickBooks, which enumerates nothing — ${c.name}`, () => {
    // NULL listing, which is what gateQboReversalsOnProvenance passes for every document.
    const verdict = classifyRegisteredPaymentAgainstListing(
      null, c.registrations, READ_AT, c.unregisteredReceiptIds, c.paidWithoutLedgerReceipt,
    )
    assert.equal(verdict.verdict, c.quickbooks)
    assert.equal(zeroPaidIsProvenReversal(verdict), c.quickbooksReverses,
      c.quickbooksReverses
        ? 'this reversal must still happen — withholding everything would disable the pass'
        : 'this reversal must be withheld — admitting it raises a chargeback against a paid sale')
  })
}

test('[o3d-psrx r3] a null listing is "cannot establish absence", never "no payments"', () => {
  // The distinction the whole QuickBooks arm rests on. An EMPTY listing is a real answer (the ledger
  // enumerated its payments and there are none) and proves our posted payment GONE; a NULL listing
  // enumerated nothing and proves only that this read cannot say.
  const posted = [registration()]
  assert.deepEqual(
    classifyRegisteredPaymentAgainstListing(new Set<string>(), posted, READ_AT),
    { verdict: 'GONE', paymentIds: ['PAY-1'] },
  )
  assert.deepEqual(
    classifyRegisteredPaymentAgainstListing(null, posted, READ_AT),
    { verdict: 'LEDGER_DID_NOT_LIST_PAYMENTS' },
  )
})

test('[o3d-psrx r3] a null fence decides nothing, on either door', () => {
  const invoice = zeroPaidListing()
  const rows = [registration()]
  assert.deepEqual(
    classifyRegisteredPayment(invoice, rows, null, [], true),
    classifyRegisteredPaymentAgainstListing(null, rows, null, [], true),
  )
  assert.equal(classifyRegisteredPaymentAgainstListing(null, rows, null).verdict, 'REGISTRATION_UNDECIDED')
})

test('[o3d-psrx r3] every withheld verdict can tell an operator what to do about it', () => {
  // A withheld reversal leaves `paidAt` set and raises no credit note. The audit entry is the ONLY
  // durable record that a human has to look at it — a generic sentence there is a lost reversal.
  const withheld = [
    { verdict: 'PAID_WITHOUT_LEDGER_RECEIPT' as const },
    { verdict: 'RECEIPT_NOT_REGISTERED' as const, paymentIds: ['pay_1'] },
    { verdict: 'REGISTRATION_UNDECIDED' as const, entryIds: ['log_1'] },
    { verdict: 'STILL_HELD' as const, paymentIds: ['PAY-1'] },
  ]
  const reasons = withheld.map((v) => qboWithheldReversalReason(v))
  for (const reason of reasons) {
    assert.ok(reason.length > 80, `too terse to act on: ${reason}`)
    assert.ok(/paidAt was LEFT SET/i.test(reason), `must say the flag was kept: ${reason}`)
  }
  assert.equal(new Set(reasons).size, reasons.length, 'each withheld state needs its OWN explanation')
  // And it names the rows an operator would go and look at.
  assert.match(reasons[1], /pay_1/)
  assert.match(reasons[2], /log_1/)
})

// ---------------------------------------------------------------------------
// o3d-psrx r4 (Codex HIGH) — THE BINDING, THROUGH THE DOOR THE DEFECT CAME IN BY.
//
// Codex's route is QuickBooks: it enumerates no payments, so a stale registration that reaches
// `posted` lands on LEDGER_DID_NOT_LIST_PAYMENTS, which `zeroPaidIsProvenReversal` ADMITS. The
// pure-function cases below are that route with nothing else in the way; the wiring — that the
// evidence read actually supplies the binding off real rows — is proved against a real database in
// tests/concurrency/paid-provenance-reversal.concurrent.test.ts.
// ---------------------------------------------------------------------------

/** The paid state a document is in NOW: which ledger document, and (sales) when this episode began. */
const paidState = (accountingInvoiceId: string | null, unregisteredPaidAt: Date | null = null) =>
  ({ accountingInvoiceId, unregisteredPaidAt })

const EPISODE_2_BEGAN = new Date('2026-08-20T11:30:00.000Z')

test('[o3d-psrx r4] a registration from an EARLIER paid episode leaves the marker standing', () => {
  // Posted at 11:00, this paid state entered at 11:30, ledger read at 12:00. Everything about the row
  // is impeccable — SYNCED, database-stamped, a real ledger payment id, before the fence, and against
  // THIS document. It is simply about a payment that was taken away before this flag was set.
  const stale = registration({ registeredAgainstInvoiceId: 'inv_1', syncedAt: BEFORE_READ })
  assert.deepEqual(
    classifyRegisteredPaymentAgainstListing(null, [stale], READ_AT, [], true, paidState('inv_1', EPISODE_2_BEGAN)),
    { verdict: 'PAID_WITHOUT_LEDGER_RECEIPT' },
    'the marker says this paid state was never going to have a ledger receipt; a row from the '
    + 'PREVIOUS one cannot contradict it',
  )
  // WITHOUT the binding this is the exact defect: admitted, and a chargeback credit note raised.
  const unbound = classifyRegisteredPaymentAgainstListing(null, [stale], READ_AT, [], true)
  assert.equal(unbound.verdict, 'LEDGER_DID_NOT_LIST_PAYMENTS')
  assert.equal(zeroPaidIsProvenReversal(unbound), true,
    'stated so the danger is visible: with no binding the stale row makes this an ADMITTED reversal')
})

test('[o3d-psrx r4] a registration raised DURING this paid state still discharges the marker', () => {
  // The control for the case above, and the reason the marker is self-discharging at all (6oyu.6): a
  // WooCommerce chargeback on an order IMS did register must still reverse.
  const current = registration({ registeredAgainstInvoiceId: 'inv_1', syncedAt: new Date('2026-08-20T11:45:00.000Z') })
  assert.deepEqual(
    classifyRegisteredPaymentAgainstListing(
      new Set<string>(), [current], READ_AT, [], true, paidState('inv_1', EPISODE_2_BEGAN),
    ),
    { verdict: 'GONE', paymentIds: ['PAY-1'] },
  )
})

test('[o3d-psrx r4] a registration against a document this one replaced is UNDECIDED, not absent', () => {
  const stranded = registration({ id: 'log_old', registeredAgainstInvoiceId: 'inv_deleted' })
  const verdict = classifyRegisteredPaymentAgainstListing(null, [stranded], READ_AT, [], false, paidState('inv_1'))
  assert.deepEqual(verdict, { verdict: 'REGISTRATION_UNDECIDED', entryIds: ['log_old'] })
  assert.equal(zeroPaidIsProvenReversal(verdict), false)
  // NOT `NOTHING_REGISTERED`. Dropping the row would be the opposite mistake and a worse one: the
  // ledger may still be holding that payment, and NOTHING_REGISTERED is an ADMITTED reversal.
  assert.notEqual(verdict.verdict, 'NOTHING_REGISTERED')
})

test('[o3d-psrx r4] a registration that names NO document binds to nothing (legacy and compacted rows)', () => {
  // A row from before the payload carried `accountingInvoiceId`, or one retention-compacted to `{}`
  // (o3d-m5qk). "We cannot tell which document this was about" is not "it was about this one".
  for (const registeredAgainstInvoiceId of [null, undefined, '', '   ']) {
    const legacy = registration({ id: 'log_legacy', registeredAgainstInvoiceId })
    assert.deepEqual(
      classifyRegisteredPaymentAgainstListing(null, [legacy], READ_AT, [], false, paidState('inv_1')),
      { verdict: 'REGISTRATION_UNDECIDED', entryIds: ['log_legacy'] },
      `registeredAgainstInvoiceId=${JSON.stringify(registeredAgainstInvoiceId)}`,
    )
  }
})

test('[o3d-psrx r4] a caller that supplies no binding decides exactly what it decided before', () => {
  // Every existing caller — `classifyRegisteredPayment` and its tests above — passes no binding, and
  // this is what makes that safe to say rather than to assume.
  const rows = [registration({ registeredAgainstInvoiceId: 'inv_whatever' })]
  for (const listing of [null, new Set<string>(), new Set(['pay-1'])]) {
    assert.deepEqual(
      classifyRegisteredPaymentAgainstListing(listing, rows, READ_AT, [], true),
      classifyRegisteredPaymentAgainstListing(listing, rows, READ_AT, [], true, null),
    )
  }
})

test('[o3d-psrx r4] the binding narrows the evidence; it never admits a reversal on its own', () => {
  // The whole safety argument, over the case table above: a binding that REJECTS every registration
  // can only move a verdict from ADMITTED to WITHHELD, never the reverse. That is what makes r4 safe
  // to ship without re-arguing each of the earlier rounds' verdicts.
  assert.ok(CASES.length >= 5, `the table must actually have cases in it, found ${CASES.length}`)
  let changed = 0
  for (const c of CASES) {
    const withBinding = classifyRegisteredPaymentAgainstListing(
      null, c.registrations.map((r) => ({ ...r, registeredAgainstInvoiceId: 'inv_someone_else' })),
      READ_AT, c.unregisteredReceiptIds, c.paidWithoutLedgerReceipt, paidState('inv_1'),
    )
    if (withBinding.verdict !== c.quickbooks) changed++
    assert.ok(!zeroPaidIsProvenReversal(withBinding) || c.quickbooksReverses,
      `${c.name}: rejecting every registration turned a WITHHELD verdict into an ADMITTED one`)
  }
  // Non-vacuity: if rejecting every registration changed nothing anywhere, the loop above proved
  // nothing about the binding and would keep passing with the binding deleted.
  assert.ok(changed > 0,
    'rejecting every registration must actually change some verdict, or this test is examining nothing')
})
