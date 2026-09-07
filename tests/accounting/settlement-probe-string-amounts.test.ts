import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { probeQuickBooksSettlement, probeXeroSettlement } from '@/lib/connectors/accounting-settlement-probe'
import {
  decodeLedgerAmountText,
  ledgerAmountMagnitudeBound,
  ledgerDifferenceMagnitudeBound,
  parseLedgerAmount,
  readLedgerStatedAmount,
} from '@/lib/connectors/xero/invoice-delta'
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

  // o3d-mm51 (Codex HIGH 2) — THE QUICKBOOKS CASE THAT USED TO BE ASSERTED HERE HAS MOVED, AND IT
  // MOVED BECAUSE IT WAS WRONG. `probeBill({})` was asserted to be `{ ok: true, records: [] }` and
  // therefore `clear`. Skipping an arithmetic check that cannot be run is right; concluding from a
  // MISSING figure that nothing has settled the document is a positive claim on no evidence, and it
  // authorises a payment. See the section below, where the corrected behaviour is stated.
  //
  // WHAT STAYS TRUE HERE, AND IS THE REASON ABSENCE IS PERMISSIVE AT ALL: an absent figure SKIPS the
  // arithmetic, and every arm that has other evidence still answers with it.
  //
  // THE PRECONDITION: these bodies state NO total at all, so the arms below are genuinely reaching
  // the skip rather than passing an arithmetic check.
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


/* ------------------------------------------------------------------------------------------- *
 * 4. o3d-mm51 (Codex HIGH 1) — THE MAGNITUDE RULE IS INHERITED, THE SCALE RULE IS STILL NOT.
 *
 * o3d-obyd excluded `readLedgerStatedAmount`'s two extra rules TOGETHER. They are two judgements with
 * different premises: the SCALE rule asks whether a figure may be TRUSTED (and this check must read a
 * figure finer than the document's currency, which is the whole of o3d-r948's band), while the
 * MAGNITUDE rule asks whether the number can be READ AT ALL — a statement about what
 * `Response.json()` already destroyed, true of every reader of a decoded JSON number.
 * ------------------------------------------------------------------------------------------- */

test('[o3d-mm51] Codex\'s exact GBP pair is UNREADABLE, not a zero settlement', async () => {
  // ROUTE: probeQuickBooksSettlement's settlement accounting -> wireAmount(body.TotalAmt, 'GBP')
  //        NUMBER arm -> `Math.abs(value) >= ledgerDifferenceMagnitudeBound('GBP')` -> the unreadable
  //        reading -> completenessCannotRun -> ok:false -> classifyLedgerSettlement -> unknown.
  // MUTATION: delete the magnitude line from `wireAmount`'s number arm (which is exactly the reader
  //        as o3d-obyd shipped it) and this probe answers `{ ok: true, records: [] }` and the
  //        classifier answers `clear` — the verdict that authorises a SECOND payment.

  // THE PRECONDITION, AND IT IS THE FINDING. These are two DIFFERENT figures a penny apart, and JSON
  // hands both of them back as ONE double — so `TotalAmt - Balance` is an exact zero and a real
  // settlement has disappeared. Asserted through `JSON.parse` rather than written as literals,
  // because the collapse is a property of the transport and not of this file.
  const total = JSON.parse('70368744177664.02') as number
  const balance = JSON.parse('70368744177664.01') as number
  assert.equal(total, balance, 'the two tokens are one double: the settlement between them is gone')
  assert.equal(total - balance, 0, 'so the completeness arithmetic would read a settled document as unsettled')

  // AND THE DOCUMENT STATES THE CURRENCY THE FINDING NAMES. Without it the reader resolves through
  // `ledgerMinorUnits(null)` — the FINEST supported precision and therefore a much smaller bound — so
  // a test that asserted its precondition against GBP while the code used the null bound would be
  // proving something adjacent to what it claims.
  const probe = await probeBill({ CurrencyRef: { value: 'GBP' }, TotalAmt: total, Balance: balance })
  assert.equal(probe.ok, false, 'a figure IMS cannot read at this magnitude is not a clean, empty answer')
  assert.match(
    reasonOf(probe),
    /QuickBooks states TotalAmt 70368744177664\.02 on this bill, which IMS cannot read as an amount/,
    'and the sentence names the figure, so the hold does not read as "the bill is unpaid"',
  )

  const verdict = classifyLedgerSettlement(attemptFor('1200.00'), probe)
  assert.equal(verdict.outcome, 'unknown')
  assert.equal(verdict.outcome === 'unknown' && verdict.cause, 'probe-unreadable')
})

test('[o3d-mm51] the bound is the DIFFERENCE one: the amount bound alone still loses a settlement', async () => {
  // The magnitude rule has two spellings and only the halved one is wide enough for this decision.
  // `ledgerAmountMagnitudeBound` guarantees ONE WHOLE minor unit survives the decode; every check in
  // the probe decides at HALF of one, because `completenessBand` is `ledgerAmountEpsilon`. That gap
  // is o3d-psrx r16's, and this is it reached through the completeness arithmetic instead.
  //
  // ROUTE: as above, but at a magnitude the AMOUNT bound admits.
  // MUTATION: use `ledgerAmountMagnitudeBound` in `wireAmount` instead of
  //        `ledgerDifferenceMagnitudeBound` and this pair is admitted, `TotalAmt - Balance` reads as
  //        an exact zero, the probe answers ok:true over an empty record list, and that is `clear`.

  // THE PRECONDITION, both halves: the figure is BELOW the amount bound — so a guard written with
  // that bound would let it through — and at or above the difference bound, and the two tokens
  // collapse onto one double.
  const total = JSON.parse('35184372088832.0117') as number
  const balance = JSON.parse('35184372088832.0040') as number
  assert.ok(Math.abs(total) < ledgerAmountMagnitudeBound('GBP'), 'the amount bound would admit this')
  assert.ok(Math.abs(total) >= ledgerDifferenceMagnitudeBound('GBP'), 'the difference bound does not')
  assert.equal(total, balance, 'and they are one double, 0.0077 apart in truth')
  assert.ok(0.0077 > 0.005, 'which is above the GBP band, so the ledger really is holding a settlement')

  // THE PRECONDITION THAT MAKES THE TWO ABOVE MEAN ANYTHING: the document STATES GBP, so the bound
  // the reader applies is the one asserted against. An unstated currency resolves to the finest
  // supported precision, whose bound is four orders of magnitude smaller — both spellings would then
  // refuse this pair and the test would prove nothing about which one is load-bearing.
  const BODY = { CurrencyRef: { value: 'GBP' }, TotalAmt: total, Balance: balance }
  assert.equal(BODY.CurrencyRef.value, 'GBP', 'the document is stated in the currency the bounds are read for')

  const probe = await probeBill(BODY)
  assert.equal(probe.ok, false)
  assert.match(reasonOf(probe), /which IMS cannot read as an amount/)
  assert.notEqual(classifyLedgerSettlement(attemptFor('1200.00'), probe).outcome, 'clear')
})

test('[o3d-mm51] the SCALE rule is still not inherited: a finer-than-currency figure is READ', async () => {
  // THE REASON THE SCALE RULE WAS EXCLUDED, AND IT HAS TO SURVIVE THE MAGNITUDE ONE BEING ADDED. The
  // completeness question is "does the ledger's own total agree with the collection beside it?", and
  // its answer must not change because a figure was stated more finely than the document's currency.
  // Inheriting the scale rule would not merely round differently — it would make the figure
  // UNREADABLE, which under o3d-obyd's triple REFUSES the probe, so an ordinary document whose own
  // figures agree perfectly would stop being answerable at all.
  //
  // ROUTE: wireAmount -> the number arm's magnitude test ALONE -> toDecimal -> shortBy.
  // MUTATION: read these through `readLedgerStatedAmount` instead of `decodeLedgerAmountText` plus
  //        the bound — i.e. inherit the scale rule — and case (1) below flips from a positive answer
  //        to a refusal, and case (2)'s sentence stops naming the money and names the reading.

  // THE PRECONDITION: `10.001` is a figure the STRICT reader refuses for its scale on a two-decimal
  // document, so this is genuinely the excluded rule being exercised.
  assert.equal(readLedgerStatedAmount(10.001, 'GBP'), null, 'the strict reader refuses a GBP three-decimal figure')
  assert.ok(Math.abs(10.001) < ledgerDifferenceMagnitudeBound('GBP'), 'and it is nowhere near the bound that WAS inherited')

  // (1) THE COST OF INHERITING IT. Xero's own total and the collection beside it AGREE, both stated
  //     more finely than GBP — so the check runs, passes, and the probe answers. Under the mutation
  //     this document refuses instead, and an ordinary retry is held for a figure that is correct.
  const agreeing = await probeInvoice({
    CurrencyCode: 'GBP',
    AmountPaid: 10.001,
    Payments: [{ PaymentID: 'PAY-1', Date: '2026-08-01T00:00:00', Amount: 10.001 }],
  })
  assert.equal(agreeing.ok, true, 'a finely-stated document that adds up is still answerable')

  // (2) AND THE CHECK STILL MEASURES. The same total with nothing beside it is a shortfall, named at
  //     its own scale — not a reading failure.
  const short = await probeInvoice({ CurrencyCode: 'GBP', AmountPaid: 10.001 })
  assert.equal(short.ok, false)
  assert.match(reasonOf(short), /Xero reports 10\.001 paid against this document but returned no payments/)
  assert.doesNotMatch(reasonOf(short), /cannot read as an amount/, 'the figure was READ, and then measured')

  // (3) THE FIL ITSELF, on the currency whose minor unit makes it visible. `completenessBand` is half
  //     of one minor unit, so in KWD one fil is above the band and in GBP it is below it — which is
  //     the whole of o3d-r948, and the magnitude guard added beside it moves neither.
  const fil = await probeInvoice({ CurrencyCode: 'KWD', AmountPaid: 0.001 })
  assert.equal(fil.ok, false, 'one fil is a real payment in KWD and the check still sees it')
  assert.match(reasonOf(fil), /Xero reports 0\.001 paid against this document but returned no payments/)
  assert.notEqual(readLedgerStatedAmount(0.001, 'KWD'), null, 'and the strict reader admits it too — this is the BAND, not the scale')

  const belowBandInGbp = await probeInvoice({ CurrencyCode: 'GBP', AmountPaid: 0.001 })
  assert.equal(belowBandInGbp.ok, true, 'while in GBP the same figure is inside the band and states nothing')
})

test('[o3d-mm51] the STRING arm takes no bound, so o3d-psrx r15 and o3d-obyd both stand', async () => {
  // A string still carries its own digits: nothing was destroyed, so there is nothing for a size rule
  // to stand in for, and `parseLedgerAmount`'s round trip decides THIS value rather than values of
  // this size. That is o3d-psrx r15, and it is why QuickBooks' text `TotalAmt`/`Balance` — the whole
  // of o3d-obyd — is not undone by the guard added beside it.
  //
  // ROUTE: wireAmount's STRING arm -> decodeLedgerAmountText -> exact Decimals -> subtractMoney.
  // MUTATION: apply `ledgerDifferenceMagnitudeBound` to the string arm as well and this refuses
  //        instead of measuring — the exact one-penny settlement below stops being visible, and the
  //        reason changes from naming the money to naming the reading.

  // THE PRECONDITION: the identical figures as NUMBERS collapse (that is the test above), so this can
  // only pass because the string arm read the digits it was given.
  assert.equal(JSON.parse('70368744177664.02'), JSON.parse('70368744177664.01'), 'as numbers they are one double')

  const probe = await probeBill({
    CurrencyRef: { value: 'GBP' }, TotalAmt: '70368744177664.02', Balance: '70368744177664.01',
  })
  assert.equal(probe.ok, false, 'one penny applied and nothing accounts for it')
  assert.match(
    reasonOf(probe),
    /QuickBooks reports 0\.01 already applied to this bill/,
    'the settlement the double lost is measured exactly from the text',
  )
  assert.doesNotMatch(reasonOf(probe), /cannot read as an amount/, 'and it is not refused for its size')
})

test('[o3d-mm51] a payment LINE at the bound makes the payment unmeasurable, not the shortfall smaller', async () => {
  // `explained` is the side of `shortBy` that ACCOUNTS for money, and it is summed from the payment
  // lines. A line the decode can no longer hold half a minor unit of inflates that side and swallows
  // the shortfall it was measuring — the same defect as the document's own figures, one term over.
  //
  // ROUTE: qboAmountAppliedTo -> wireAmount(line.Amount, 'GBP') -> the exact term is null ->
  //        `explained` is null -> the `applied !== null` arm refuses.
  // MUTATION: build `exact` from `toDecimal(amount)` directly (the reader before o3d-mm51) and
  //        `explained` becomes 35184372088832, which is not short of the 1200 applied, so the probe
  //        answers ok:true with one record of 35184372088832 — and the classifier, comparing it with
  //        a 1200.00 attempt, answers `clear`.

  // THE PRECONDITION, AND IT IS WHY THE RECORD READER DOES NOT ALREADY COVER THIS: the strict reader
  // ADMITS this figure (it is below the AMOUNT bound and quantized), so `statedAmount` would hand it
  // back as a perfectly good record. Only the halved bound refuses it.
  const LINE = 35184372088832
  assert.notEqual(readLedgerStatedAmount(LINE, 'GBP'), null, 'the record reader admits this figure')
  assert.ok(Math.abs(LINE) >= ledgerDifferenceMagnitudeBound('GBP'), 'while the difference bound does not')

  const { get } = ledgerDouble({
    'bill/bill-1': {
      Bill: {
        CurrencyRef: { value: 'GBP' },
        TotalAmt: '1200.00',
        Balance: '0.00',
        LinkedTxn: [{ TxnId: 'bp-1', TxnType: 'BillPaymentCheck' }],
      },
    },
    'billpayment/bp-1': {
      BillPayment: {
        TxnDate: '2026-08-01',
        Line: [{ Amount: LINE, LinkedTxn: [{ TxnId: 'bill-1', TxnType: 'Bill' }] }],
      },
    },
  })
  const probe = await probeQuickBooksSettlement(
    { type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'bill-1' } }, get,
  )
  assert.equal(probe.ok, false, 'an unmeasurable payment line cannot be spent as an explanation')
  assert.match(reasonOf(probe), /IMS could not measure what the payments it links applied to it/)
  assert.notEqual(classifyLedgerSettlement(attemptFor('1200.00'), probe).outcome, 'clear')
})

/* ------------------------------------------------------------------------------------------- *
 * 5. o3d-mm51 (Codex HIGH 2) — A CHECK THAT CANNOT RUN CONTRIBUTES NO CONCLUSION IN EITHER
 *    DIRECTION, AND THE ORDINARY FIRST PAYMENT STILL POSTS.
 * ------------------------------------------------------------------------------------------- */

test('[o3d-mm51] a MISSING QuickBooks total draws no conclusion — it neither clears nor accuses', async () => {
  // ROUTE: probeQuickBooksSettlement -> `applied === null` -> no uncovered link -> `records.length
  //        === 0` -> ok:false -> classifyLedgerSettlement -> unknown/probe-unreadable.
  // MUTATION: delete the `records.length === 0` refusal and control falls through to
  //        `return { ok: true, records }` over an EMPTY list — which is `clear`, on no figure at all.

  // THE PRECONDITION: this body states neither figure, so the branch under test is genuinely reached
  // and nothing below is decided by an arithmetic check that ran.
  const BODY = {}
  assert.equal(Object.keys(BODY).length, 0, 'the document states no TotalAmt and no Balance')

  const probe = await probeBill(BODY)
  assert.equal(probe.ok, false, 'an empty answer here would be a claim, not a reading')
  assert.match(reasonOf(probe), /states no total or balance on this bill and IMS read no settlement against it/)

  // AND IT IS NOT A CONCLUSION IN THE OTHER DIRECTION EITHER. `unknown` withholds; it does not assert
  // that a settlement exists, and its sentence must not read as one.
  const verdict = classifyLedgerSettlement(attemptFor('1200.00'), probe)
  assert.equal(verdict.outcome, 'unknown')
  assert.equal(verdict.outcome === 'unknown' && verdict.cause, 'probe-unreadable')
  assert.notEqual(verdict.outcome, 'present')

  // AND ABSENCE STILL ONLY SKIPS WHERE THERE IS OTHER EVIDENCE. The same missing totals, with a
  // payment this probe actually READ, still answer — the verdict is then decided by comparing the
  // record, not by the absence.
  const { get } = ledgerDouble({
    'bill/bill-1': { Bill: { LinkedTxn: [{ TxnId: 'bp-1', TxnType: 'BillPaymentCheck' }] } },
    'billpayment/bp-1': {
      BillPayment: {
        TxnDate: `${DATE}T00:00:00`,
        Line: [{ Amount: 1200, LinkedTxn: [{ TxnId: 'bill-1', TxnType: 'Bill' }] }],
      },
    },
  })
  const withEvidence = await probeQuickBooksSettlement(
    { type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'bill-1' } }, get,
  )
  assert.equal(withEvidence.ok, true, 'a document with no totals whose settlement was READ still answers')
  assert.equal(classifyLedgerSettlement(attemptFor('1200.00'), withEvidence).outcome, 'present')
})

test('[o3d-mm51] an ORDINARY first payment still posts, and it is emptiness PROVED rather than assumed', async () => {
  // This is the reason absence was kept permissive, and it has to keep working. QuickBooks states
  // `TotalAmt` and `Balance` on every document that exists, and an UNPAID one states them EQUAL — so
  // the ordinary first payment proves emptiness with two stated figures rather than assuming it from
  // two missing ones.
  //
  // ROUTE: probeQuickBooksSettlement -> wireAmount reads both -> applied is exactly 0 ->
  //        statesAnything is false -> the check PASSES -> ok:true over an empty record list -> clear.
  // MUTATION: make the absent-total refusal unconditional (drop the `applied === null` guard around
  //        it, or refuse whenever `records` is empty) and every first payment in the system stops.

  // THE PRECONDITION: the two figures are STATED and EQUAL, which is what makes this a proof rather
  // than a skip — and it is asserted so this test cannot pass by the totals quietly going missing.
  const UNPAID = { TotalAmt: '1200.00', Balance: '1200.00' }
  assert.equal(UNPAID.TotalAmt, UNPAID.Balance, 'an unpaid bill states its total and balance equal')

  const probe = await probeBill(UNPAID)
  assert.deepEqual(probe, { ok: true, records: [] }, 'nothing settles it, and the document says so')
  assert.equal(classifyLedgerSettlement(attemptFor('1200.00'), probe).outcome, 'clear', 'so the payment posts')

  // The same document with the figures as JSON NUMBERS, because both spellings reach the money.
  const asNumbers = await probeBill({ TotalAmt: 1200, Balance: 1200 })
  assert.deepEqual(asNumbers, { ok: true, records: [] })
  assert.equal(classifyLedgerSettlement(attemptFor('1200.00'), asNumbers).outcome, 'clear')

  // AND THE INVOICE SIDE, which is the other document kind the same fence covers.
  const invoice = await probeQuickBooksSettlement(
    { type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-1' } },
    ledgerDouble({ 'invoice/inv-1': { Invoice: { TotalAmt: '40.00', Balance: '40.00' } } }).get,
  )
  assert.deepEqual(invoice, { ok: true, records: [] })
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), invoice).outcome, 'clear')
})


test('[o3d-mm51] the AmountPaid gate no longer excludes itself over a record the classifier CAN measure', async () => {
  // THE EXCLUSION-WIDTH AUDIT'S OWN FINDING, and this round is what opened it. The `AmountPaid` check
  // is EXCLUDED — not refused — when a payment amount cannot be read, and the entire justification
  // for that direction is that such a record already yields `unknown` in the classifier, so nothing
  // is lost by not running the check.
  //
  // That premise held while the completeness reader refused strictly less than the record reader. The
  // magnitude bound broke it: the completeness reader takes the HALVED bound and the record reader
  // takes the full one, so a GBP figure in [2^45, 2^46) is refused by one and admitted by the other.
  //
  // ROUTE: probeXeroSettlement -> wireDecimal(p.Amount, 'GBP') is null -> `unusablePaymentAt` -> every
  //        record measurable -> ok:false -> classifyLedgerSettlement -> unknown/probe-unreadable.
  // MUTATION: delete the `unusablePaymentAt` refusal and this document answers ok:true with one
  //        perfectly measurable record of 40000000000000, which does not match a 10.00 attempt — so
  //        the classifier answers `clear`, over a check that was silently dropped.

  // THE PRECONDITION, AND IT IS THE WHOLE FINDING: this one figure is refused by the completeness
  // reader and ADMITTED by the record reader. If the two bounds ever agree again this assertion says
  // so rather than letting the test pass for the wrong reason.
  const AMOUNT = 4e13
  assert.ok(Math.abs(AMOUNT) >= ledgerDifferenceMagnitudeBound('GBP'), 'the completeness reader refuses it')
  assert.ok(Math.abs(AMOUNT) < ledgerAmountMagnitudeBound('GBP'), 'and the record reader does not')
  assert.notEqual(readLedgerStatedAmount(AMOUNT, 'GBP'), null, 'so the record IS measurable — no `unknown` to rely on')

  const probe = await probeInvoice({
    CurrencyCode: 'GBP',
    Total: 100,
    AmountDue: 100,
    AmountPaid: 0,
    AmountCredited: 0,
    Payments: [{ PaymentID: 'PAY-1', Date: '2026-08-01T00:00:00', Amount: AMOUNT }],
  })
  assert.equal(probe.ok, false, 'a check that cannot run must not be dropped when the records can still clear')
  assert.match(reasonOf(probe), /Xero states 40000000000000 on a payment against this document/)

  const verdict = classifyLedgerSettlement(attemptFor('10.00'), probe)
  assert.equal(verdict.outcome, 'unknown')
  assert.equal(verdict.outcome === 'unknown' && verdict.cause, 'probe-unreadable')

  // AND THE EXCLUSION IS STILL THERE FOR THE CASE IT WAS JUSTIFIED BY. A payment amount the RECORD
  // reader also refuses yields an unmeasurable record, the classifier withholds on that, and the
  // check is excluded rather than refused — exactly as before, and the probe still answers.
  const alsoUnreadable = await probeInvoice({
    CurrencyCode: 'GBP',
    Total: 100,
    AmountDue: 100,
    AmountPaid: 0,
    AmountCredited: 0,
    Payments: [{ PaymentID: 'PAY-1', Date: '2026-08-01T00:00:00', Amount: 10.001 }],
  })
  assert.equal(readLedgerStatedAmount(10.001, 'GBP'), null, 'the precondition: this record is unmeasurable')
  assert.equal(alsoUnreadable.ok, true, 'so the exclusion still applies and the probe still answers')
  const held = classifyLedgerSettlement(attemptFor('10.00'), alsoUnreadable)
  assert.equal(held.outcome, 'unknown')
  assert.equal(held.outcome === 'unknown' && held.cause, 'record-unmeasurable', 'withheld by the record, as the gate assumed')
})
