import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { probeQuickBooksSettlement, probeXeroSettlement } from '@/lib/connectors/accounting-settlement-probe'
import { decodeLedgerAmountText, parseLedgerAmount } from '@/lib/connectors/xero/invoice-delta'
import {
  classifyLedgerSettlement,
  type AttemptDescription,
  type LedgerSettlementProbe,
} from '@/lib/domain/accounting/ledger-settlement-evidence'
import { toDecimal } from '@/lib/domain/math/decimal'

/**
 * o3d-obyd — A STRING `TotalAmt` SKIPPED THE COMPLETENESS CROSS-CHECK, AND A SKIPPED CHECK WAS BEING
 * SPENT AS A PASSED ONE.
 *
 * THE DEFECT. `wireDecimal` in `accounting-settlement-probe.ts` accepted only `typeof value ===
 * 'number'`. Every completeness cross-check in that file is guarded by `figure !== null`, so a
 * ledger figure the reader refused did not FAIL the check — it removed it. With nothing uncovered
 * linked, control then fell through to `return { ok: true, records }` over an EMPTY record list,
 * `classifyLedgerSettlement` reads that as `clear`, and `clear` is what authorises a money post.
 *
 * WHY IT IS REACHABLE RATHER THAN THEORETICAL. QuickBooks serialises `TotalAmt` and `Balance` as
 * JSON STRINGS. That is o3d-psrx r10's HIGH, recorded in this same connector's payment poller, where
 * `typeof row.Balance === 'number'` failed on a real `Balance` of `"50.00"` and the poller was moved
 * onto `parseLedgerAmount` — a reader that admits numeric text. The PROBE was not moved with it. One
 * rule, two readers, one of them fixed; the unfixed one is the one that authorises money.
 *
 * So the same bill read two ways:
 *   `TotalAmt: 1200, Balance: 0`       -> applied 1200, explained 0, shortfall -> ok:false. Correct.
 *   `TotalAmt: "1200.00", "0.00"`      -> applied null -> check skipped -> ok:true, records []
 *                                      -> clear -> a SECOND payment against a fully settled bill.
 *
 * WHAT THE FIX IS, IN TWO PARTS, AND BOTH ARE TESTED HERE.
 *   1. THE READING. The probe decodes text through `decodeLedgerAmountText`, which is the string arm
 *      of `readLedgerStatedAmount` and therefore the function the poller's own `parseLedgerAmount`
 *      reading is built out of. Not a second spelling of the same grammar — the same function.
 *   2. THE DIRECTION. A figure the ledger STATED that the probe cannot read now REFUSES the probe
 *      instead of excusing the check that would have used it. An ABSENT figure still skips, because
 *      "Xero omitted `Total`" is a response shape this module has a documented fallback for and
 *      turning it into a refusal would fail the ordinary unsettled document.
 *
 * All three arms are covered — the Xero credit-note check, both of the Xero invoice checks, and the
 * QuickBooks one — because the finding cites one and the file holds three of the same shape.
 *
 * Every test states the PRECONDITION it turns on, so none can pass by the property under test
 * quietly ceasing to hold.
 */

const DATE = '2026-08-01'

type Call = { path: string }
function ledgerDouble(responses: Record<string, unknown>) {
  const calls: Call[] = []
  const get = async <T>(path: string) => {
    calls.push({ path })
    const body = responses[path]
    if (body === undefined) return { ok: false, status: 404, error: 'not stubbed' }
    return { ok: true, status: 200, data: body as T }
  }
  return { get, calls }
}

const reasonOf = (probe: LedgerSettlementProbe) => (probe.ok === false ? probe.reason : '')

/** An attempt stated directly rather than built from a payload: this file is about the LEDGER half. */
const attemptFor = (amount: string): AttemptDescription =>
  ({ amount: toDecimal(amount), currency: 'GBP', date: DATE, marker: null })

/* --- the three arms, each driven by its own document body. --- */

/** ARM 3: the QuickBooks `TotalAmt - Balance` settlement accounting. */
const probeBill = (body: Record<string, unknown>) => probeQuickBooksSettlement(
  { type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'bill-1' } },
  ledgerDouble({ 'bill/bill-1': { Bill: body } }).get,
)

/** ARM 2: the Xero invoice's `AmountPaid` and `Total - AmountDue` checks. */
const probeInvoice = (body: Record<string, unknown>) => probeXeroSettlement(
  { type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-1' } },
  ledgerDouble({ 'Invoices/inv-1': { Invoices: [{ InvoiceID: 'inv-1', ...body }] } }).get,
)

/** ARM 1: the Xero credit note's `Total - RemainingCredit` against its Allocations collection. */
const probeNote = (body: Record<string, unknown>) => probeXeroSettlement(
  { type: 'PURCHASE_CREDIT_NOTE_ALLOCATION', payload: { accountingInvoiceId: 'inv-1', creditNoteId: 'cn-1' } },
  ledgerDouble({ 'CreditNotes/cn-1': { CreditNotes: [{ CreditNoteID: 'cn-1', ...body }] } }).get,
)

/* ------------------------------------------------------------------------------------------- *
 * 1. THE FINDING, END TO END: A STRING `TotalAmt` IS READ, THE CHECK RUNS ON IT, AND THE `clear`
 *    THAT WAS BEING BUILT OUT OF NOT HAVING LOOKED IS GONE.
 * ------------------------------------------------------------------------------------------- */

test('[o3d-obyd] a STRING TotalAmt/Balance is read, and the completeness check runs on it', async () => {
  // ROUTE: probeQuickBooksSettlement's settlement accounting -> wireAmount(body.TotalAmt) ->
  //        decodeLedgerAmountText -> shortBy -> ok:false -> classifyLedgerSettlement.
  // MUTATION: drop the string arm of `wireAmount` (return the absent reading for a string, which is
  //        exactly what the old `typeof value === 'number'` reader did) and this probe answers
  //        ok:true with an EMPTY record list, and the classifier below answers `clear`.

  // THE PRECONDITION, both halves. These fields really are text — the shape the old reader answered
  // null to — and the poller's reader has admitted exactly this text since o3d-psrx r10.
  const STRING_BODY = { TotalAmt: '1200.00', Balance: '0.00' }
  assert.equal(typeof STRING_BODY.TotalAmt, 'string', 'QuickBooks states these as text')
  assert.equal(typeof STRING_BODY.Balance, 'string')
  assert.equal(parseLedgerAmount('1200.00', 'GBP'), 1200, 'and the POLLER has read that text since r10')

  const probe = await probeBill(STRING_BODY)
  assert.equal(probe.ok, false, 'a bill QuickBooks reports fully settled is not a clear')
  assert.match(
    reasonOf(probe),
    /QuickBooks reports 1200\.00 already applied to this bill but only 0\.00 of it is accounted for/,
  )

  // ...and the end the finding is about. `clear` authorises the money post; it must not be reachable
  // over a record list no completeness check ever measured.
  const verdict = classifyLedgerSettlement(attemptFor('1200.00'), probe)
  assert.equal(verdict.outcome, 'unknown')
  assert.equal(verdict.outcome === 'unknown' && verdict.cause, 'probe-unreadable')

  // THE DISCRIMINATING HALF: the identical figures as JSON NUMBERS have always refused, and still do.
  // The string reading is a new route to the SAME verdict, not a new verdict.
  const asNumbers = await probeBill({ TotalAmt: 1200, Balance: 0 })
  assert.equal(asNumbers.ok, false)
  assert.equal(reasonOf(asNumbers), reasonOf(probe), 'both spellings of the same bill say the same thing')
})

test('[o3d-obyd] all THREE arms read a string figure, and each one\'s check then runs', async () => {
  // The finding cites the QuickBooks arm; the file holds three of the same shape, and a string left
  // unread in any of them leaves the same false `clear` reachable through a different document.
  //
  // Each case below states figures that are a plain shortfall — the ledger's own total against a
  // collection it did not send — so the ONLY thing that can decide it is whether the total was read.
  // MUTATION (any one): make `wireAmount` refuse strings again and that arm answers ok:true.

  // THE PRECONDITION for all four: every token below is text the old reader answered null to and the
  // poller's reader admits.
  for (const token of ['10.00', '0.00', '100.00', '1200.00']) {
    assert.equal(typeof token, 'string')
    assert.notEqual(parseLedgerAmount(token, 'GBP'), null, `the poller admits ${token}`)
  }

  // (1) ARM 1 — the credit note. `Total - RemainingCredit` says the whole credit is applied, and the
  //     Allocations collection is ABSENT. Skipping this check is verbatim the defect it was added
  //     for: a fully applied credit note read as unallocated, then allocated to the bill again.
  const note = await probeNote({ CurrencyCode: 'GBP', Total: '10.00', RemainingCredit: '0.00' })
  assert.equal(note.ok, false)
  assert.match(reasonOf(note), /Xero reports 10\.00 of this credit note already applied but returned no allocations/)

  // (2) ARM 2, first check — the invoice's `AmountPaid` against the Payments collection it sent.
  const paid = await probeInvoice({ CurrencyCode: 'GBP', AmountPaid: '100.00' })
  assert.equal(paid.ok, false)
  assert.match(reasonOf(paid), /Xero reports 100\.00 paid against this document but returned no payments/)

  // (3) ARM 2, second check — the shape-independent `Total - AmountDue` accounting. `AmountPaid`
  //     agrees with the (empty) collection here, so the first check passes and ONLY this one can fire.
  const settled = await probeInvoice({
    CurrencyCode: 'GBP', Total: '100.00', AmountDue: '0.00', AmountPaid: '0.00', AmountCredited: '0.00',
    Payments: [],
  })
  assert.equal(settled.ok, false)
  assert.match(
    reasonOf(settled),
    /Xero reports 100\.00 already settled against this document but only 0\.00 of it is accounted for/,
  )

  // (4) ARM 3 — QuickBooks, the arm the finding cites.
  const bill = await probeBill({ TotalAmt: '1200.00', Balance: '0.00' })
  assert.equal(bill.ok, false)
  assert.match(reasonOf(bill), /QuickBooks reports 1200\.00 already applied to this bill/)

  // None of the four may be read as permission to move money again.
  for (const probe of [note, paid, settled, bill]) {
    assert.notEqual(classifyLedgerSettlement(attemptFor('10.00'), probe).outcome, 'clear')
  }
})

/* ------------------------------------------------------------------------------------------- *
 * 2. AN AMOUNT THAT GENUINELY CANNOT BE READ REFUSES. IT DOES NOT SKIP.
 *
 * Reading the string removes the reachable CAUSE. This removes the SHAPE, which is the part that can
 * come back: the guard was `figure !== null`, and any future reason a figure reads as null would
 * silently delete the check again rather than fail it.
 * ------------------------------------------------------------------------------------------- */

test('[o3d-obyd] a figure the ledger STATED but IMS cannot read refuses each arm, and never skips it', async () => {
  // ROUTE: `wireAmount` -> unreadable -> `completenessCannotRun` -> ok:false, in all three arms.
  // MUTATION: return the ABSENT reading instead of an unreadable one for a non-decimal value (i.e.
  //        collapse the triple back to `Decimal | null`) and all three of these answer ok:true with
  //        an empty record list, which the classifier reads as `clear`.

  // THE PRECONDITION, and it is why this is not merely tidiness. `Number()` reads `"0x64"` as 100 —
  // a `Balance` of `"0x64"` taken at face value STEERS a settlement verdict — so the reader must
  // refuse it, and the poller's reader does. A refusal that is then spent as permission is worse than
  // no reader at all.
  assert.equal(Number('0x64'), 100, 'the language would read this as a hundred')
  assert.equal(decodeLedgerAmountText('0x64'), null, 'the shared decode refuses it')
  assert.equal(parseLedgerAmount('0x64', 'GBP'), null, 'so does the poller')

  // (1) ARM 1.
  const note = await probeNote({ CurrencyCode: 'GBP', Total: '0x64', RemainingCredit: '0.00' })
  assert.equal(note.ok, false, 'a credit note whose Total cannot be read is not a clean, empty answer')
  assert.match(reasonOf(note), /Xero states Total 0x64 on this credit note, which IMS cannot read as an amount/)

  // (2) ARM 2. A thousands separator is the ordinary malformation, and `Number` refuses it too — the
  //     point is not that it is exotic, it is that the check must FAIL rather than vanish.
  const invoice = await probeInvoice({ CurrencyCode: 'GBP', AmountPaid: '1,200.00' })
  assert.equal(invoice.ok, false)
  assert.match(reasonOf(invoice), /Xero states AmountPaid 1,200\.00 on this document, which IMS cannot read/)

  // (3) ARM 3, with the two shapes that are not text at all.
  const bill = await probeBill({ TotalAmt: 1200, Balance: true })
  assert.equal(bill.ok, false)
  assert.match(reasonOf(bill), /QuickBooks states Balance boolean on this bill, which IMS cannot read/)
  const notFinite = await probeBill({ TotalAmt: Number.NaN, Balance: '0.00' })
  assert.equal(notFinite.ok, false)
  assert.match(reasonOf(notFinite), /QuickBooks states TotalAmt NaN on this bill, which IMS cannot read/)

  // THE END THAT MATTERS: not one of them is permission to post.
  for (const probe of [note, invoice, bill, notFinite]) {
    const verdict = classifyLedgerSettlement(attemptFor('10.00'), probe)
    assert.equal(verdict.outcome, 'unknown')
    assert.equal(verdict.outcome === 'unknown' && verdict.cause, 'probe-unreadable')
  }
})

test('[o3d-obyd] an ABSENT figure is still a skip, and the ordinary document still clears', async () => {
  // The guard must not be vacuous in the other direction either. "The ledger stated nothing here" is
  // not "the ledger stated something I cannot read": the `settled` fallback EXISTS for a response
  // that omits `Total` and `AmountDue`, and an ordinary unsettled document has to keep reading as
  // the positive, empty answer this probe is for. Turning absence into a refusal would fail every
  // first payment in the system.
  //
  // ROUTE: `wireAmount(undefined)` -> the absent reading -> `completenessCannotRun` answers null.
  // MUTATION: treat an absent field as unreadable and all three of these refuse — which is how one
  //        would "fix" this defect by breaking every ordinary post.

  // THE PRECONDITION: these bodies state NO total at all, so the arms below are genuinely reaching
  // the skip rather than passing an arithmetic check.
  const bill = await probeBill({})
  assert.deepEqual(bill, { ok: true, records: [] }, 'a bill with no TotalAmt and no links is a clean answer')
  assert.equal(classifyLedgerSettlement(attemptFor('1200.00'), bill).outcome, 'clear')

  const invoice = await probeInvoice({ CurrencyCode: 'GBP', AmountPaid: 0 })
  assert.deepEqual(invoice, { ok: true, records: [] })
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), invoice).outcome, 'clear')

  const note = await probeNote({ CurrencyCode: 'GBP', Total: 10, RemainingCredit: 10, Allocations: [] })
  assert.deepEqual(note, { ok: true, records: [] }, 'an unapplied credit note is still positively unapplied')
})

/* ------------------------------------------------------------------------------------------- *
 * 3. ONE READER, SO THE TWO CANNOT DIVERGE AGAIN.
 *
 * The defect is not "the probe had a bug". It is that the probe and the poller each carried their own
 * answer to "what does a ledger amount look like on the wire?", and only one of them was corrected.
 * ------------------------------------------------------------------------------------------- */

test('[o3d-obyd] the probe admits exactly the text the poller admits, and refuses exactly what it refuses', async () => {
  // ROUTE: both readings run through `decodeLedgerAmountText` — the probe directly, the poller via
  //        `readLedgerStatedAmount`'s string arm inside `parseLedgerAmount`.
  // MUTATION: give the probe its own grammar (`Number(value)`, or a re-spelt regex) and the
  //        `Number`-only tokens below stop refusing — `"1e3"` reads as a thousand and `"0x64"` as a
  //        hundred, both of which would then STEER a settlement verdict rather than refuse one.

  // THE PRECONDITION for the refused half: every one of these is a token the LANGUAGE would read and
  // the poller will not. That gap is the whole reason the grammar exists, and it is what a second
  // spelling in the probe would have re-opened.
  const REFUSED = ['0x64', '1e3', 'Infinity', '1,200.00', '', ' ', '12.5.1', 'abc', '.5']
  for (const token of REFUSED) {
    assert.equal(parseLedgerAmount(token, 'GBP'), null, `the poller refuses ${JSON.stringify(token)}`)
    assert.equal(decodeLedgerAmountText(token), null, `and so does the shared decode`)
    const probe = await probeBill({ TotalAmt: token, Balance: '0.00' })
    assert.equal(probe.ok, false, `the probe must refuse ${JSON.stringify(token)} rather than skip on it`)
    assert.match(reasonOf(probe), /which IMS cannot read as an amount/)
  }

  // ...and the admitted half reads the SAME FIGURE, printed at its own scale rather than re-derived.
  for (const token of ['1200.00', '0.50', '1234.56', '9.99']) {
    assert.notEqual(parseLedgerAmount(token, 'GBP'), null, `the precondition: the poller admits ${token}`)
    const probe = await probeBill({ TotalAmt: token, Balance: '0.00' })
    assert.equal(probe.ok, false, 'the whole of it is applied and nothing accounts for it')
    assert.ok(
      reasonOf(probe).includes(`QuickBooks reports ${token} already applied`),
      `the probe read ${token} as the figure the ledger stated, and said so: ${reasonOf(probe)}`,
    )
  }
})

// Asserted on the SOURCE because "there is only one reader" is a claim about the code, not about any
// one value: a re-spelt grammar would agree with `decodeLedgerAmountText` on every token anybody
// thought to write down here, and diverge on the next one somebody adds to only one of them.
test('[o3d-obyd] the probe spells no money grammar of its own', async () => {
  const source = await readFile(
    path.join(process.cwd(), 'lib/connectors/accounting-settlement-probe.ts'), 'utf8',
  )
  // THE PRECONDITION: this test read the file it means to police, and the reader it requires is
  // actually named in it.
  assert.ok(source.length > 1000, 'the probe source was read')
  assert.match(source, /decodeLedgerAmountText/, 'the shared decode is what the probe reads text with')

  const code = source
    // Comments in this file quote `Number()`, `parseFloat` and the grammar while explaining them, so
    // the claim is made about the CODE and the block comments are removed before it is checked.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
  // The module contains exactly ONE `Number(...)` and it converts a DATE's epoch milliseconds, not a
  // money figure. It is LOCATED rather than merely excluded, so this cannot be satisfied by a second
  // `Number()` appearing somewhere that does read an amount.
  const numberCalls = [...code.matchAll(/Number\s*\(/g)].map((m) => m.index)
  assert.equal(numberCalls.length, 1, 'exactly one Number() conversion in the whole module')
  const dateReaderAt = code.indexOf('function normaliseXeroSettlementDate')
  assert.notEqual(dateReaderAt, -1, 'the date normaliser is still where this test expects it')
  const afterDateReader = code.indexOf('\nfunction ', dateReaderAt)
  assert.ok(afterDateReader > dateReaderAt, 'and the function after it was found, so the span is real')
  assert.ok(
    numberCalls[0]! > dateReaderAt && numberCalls[0]! < afterDateReader,
    'and the one conversion is the DATE reader, not a ledger amount',
  )
  assert.doesNotMatch(code, /parseFloat|parseInt/, 'no parseFloat/parseInt either')
  assert.doesNotMatch(code, /\[\+-\]\?/, 'and no second copy of the money grammar')
})
