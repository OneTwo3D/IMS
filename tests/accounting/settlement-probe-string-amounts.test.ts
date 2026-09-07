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
import { ledgerAmountEpsilon, toDecimal } from '@/lib/domain/math/decimal'

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
  // o3d-obyd r31 (Codex HIGH 2): the 100 that `Total - AmountDue` reports settled is now stated as
  // `AmountCredited`, so the two derivations of that one figure agree. It said `AmountCredited: 0.00`
  // before, which made them say 100.00 and 0.00 about the same quantity — the contradiction the probe
  // now refuses on, which would have replaced the shortfall this test is about. `AmountPaid` still
  // agrees with the empty collection, so the first check still passes and only this one can fire.
  const settled = await probeInvoice({
    CurrencyCode: 'GBP', Total: '100.00', AmountDue: '0.00', AmountPaid: '0.00', AmountCredited: '100.00',
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
  // MOVED BECAUSE IT WAS WRONG. `probeBill({})` was asserted to be `{ ok: true, provedComplete: true, records: [] }` and
  // therefore `clear`. Skipping an arithmetic check that cannot be run is right; concluding from a
  // MISSING figure that nothing has settled the document is a positive claim on no evidence, and it
  // authorises a payment. See the section below, where the corrected behaviour is stated.
  //
  // WHAT STAYS TRUE HERE, AND IS THE REASON ABSENCE IS PERMISSIVE AT ALL: an absent figure SKIPS the
  // arithmetic, and every arm that has other evidence still answers with it.
  //
  // o3d-nk5n — AND THE XERO CASE ASSERTED HERE HAS MOVED FOR THE SAME REASON THE QUICKBOOKS ONE DID.
  //
  // `probeInvoice({ CurrencyCode: 'GBP', AmountPaid: 0 })` was asserted `{ ok: true, provedComplete: true, records: [] }`
  // and therefore `clear`. That body states too little for EITHER form of the settlement figure —
  // no `Total`/`AmountDue` pair, and no `AmountPaid`/`AmountCredited` fallback pair — so no check ran
  // and the clear was drawn from having read nothing, which is the same positive claim on no evidence
  // the paragraph above records as wrong on the other connector. Both arms now refuse it, and the
  // rule is one function (`settlementAnswer`) rather than one per connector.
  //
  // WHAT STAYS TRUE, AND IS STILL THE SUBJECT OF THIS TEST: an absent figure SKIPS the arithmetic it
  // is an operand of, and it does not refuse. `AmountCredited` is absent on every body below and none
  // of them is refused for it — a genuine skip. Absence is permissive; it just may not also be the
  // whole of the answer.

  // THE PRECONDITION: these bodies state NO `AmountCredited` at all, so the skip is genuinely being
  // reached rather than an arithmetic check being passed on a figure that is there.
  const invoice = await probeInvoice({ CurrencyCode: 'GBP', Total: 40, AmountDue: 40, AmountPaid: 0 })
  assert.deepEqual(invoice, { ok: true, provedComplete: true, records: [] })
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), invoice).outcome, 'clear')

  const note = await probeNote({ CurrencyCode: 'GBP', Total: 10, RemainingCredit: 10, Allocations: [] })
  assert.deepEqual(note, { ok: true, provedComplete: true, records: [] }, 'an unapplied credit note is still positively unapplied')

  // AND THE MOVED CASE, STATED WHERE IT USED TO BE ASSERTED, so a reader of this test cannot come
  // away thinking a figureless Xero document still clears.
  const figureless = await probeInvoice({ CurrencyCode: 'GBP', AmountPaid: 0 })
  assert.equal(figureless.ok, false, 'o3d-nk5n: an unproved empty answer is a refusal, not a clear')
  assert.notEqual(classifyLedgerSettlement(attemptFor('40.00'), figureless).outcome, 'clear')
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
  //        as o3d-obyd shipped it) and this probe answers `{ ok: true, provedComplete: true, records: [] }` and the
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

  // o3d-nk5n: the totals are stated, and stated consistently with the `AmountPaid` beside them, so
  // the positive answer below is the BAND's and not the unproved empty this round closed.
  const belowBandInGbp = await probeInvoice({ CurrencyCode: 'GBP', Total: 40, AmountDue: 39.999, AmountPaid: 0.001 })
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
  assert.deepEqual(probe, { ok: true, provedComplete: true, records: [] }, 'nothing settles it, and the document says so')
  assert.equal(classifyLedgerSettlement(attemptFor('1200.00'), probe).outcome, 'clear', 'so the payment posts')

  // The same document with the figures as JSON NUMBERS, because both spellings reach the money.
  const asNumbers = await probeBill({ TotalAmt: 1200, Balance: 1200 })
  assert.deepEqual(asNumbers, { ok: true, provedComplete: true, records: [] })
  assert.equal(classifyLedgerSettlement(attemptFor('1200.00'), asNumbers).outcome, 'clear')

  // AND THE INVOICE SIDE, which is the other document kind the same fence covers.
  const invoice = await probeQuickBooksSettlement(
    { type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-1' } },
    ledgerDouble({ 'invoice/inv-1': { Invoice: { TotalAmt: '40.00', Balance: '40.00' } } }).get,
  )
  assert.deepEqual(invoice, { ok: true, provedComplete: true, records: [] })
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

/* ------------------------------------------------------------------------------------------- *
 * 6. o3d-nk5n (Codex HIGH, round 29) — THE SAME RULE ON THE XERO SIDE: AN EMPTY RECORD LIST IS A
 *    POSITIVE CLAIM ABOUT MONEY, AND IT NEEDS A FIGURE BEHIND IT.
 *
 * o3d-mm51 closed this on the QuickBooks arm (section 5) and FILED it on both Xero arms, because 25
 * fixtures modelled an ordinary first payment as a figureless stub Xero does not send. The fixtures
 * now state what Xero states, so the rule is one function — `settlementAnswer` — reached by all
 * three arms rather than one connector's own sentence.
 *
 * Every test below states the PRECONDITION it turns on, so none can pass by the shape under test
 * quietly ceasing to be reached.
 * ------------------------------------------------------------------------------------------- */

test('[o3d-nk5n] an INCOMPLETE Xero invoice cannot classify as clear', async () => {
  // THE FINDING, END TO END. `xeroGet` does `res.json() as T` with no runtime shape validation and
  // every figure on the response type is optional, so a sparse, truncated or schema-degraded HTTP 200
  // reaches this reader stating nothing. Both completeness cross-checks are guarded on a figure being
  // present, so neither ran, and control fell through to `return { ok: true, records }` over an EMPTY
  // list — which `classifyLedgerSettlement` reads as `clear`, and `clear` authorises a SECOND payment.
  //
  // ROUTE: probeXeroSettlement's invoice arm -> `amountPaid`/`settled` both null -> both checks
  //        skipped -> `settlementAnswer(settled, records, ...)` -> ok:false ->
  //        classifyLedgerSettlement -> unknown/probe-unreadable.
  // MUTATION: delete the `settlementAnswer` refusal at the end of the invoice arm and every one
  //        of the bodies below answers ok:true with an EMPTY record list, and each classifies `clear`.

  // THE PRECONDITION, AND IT IS WHAT THE TEST TURNS ON: none of these bodies states enough for EITHER
  // form of the settlement figure — the `Total`/`AmountDue` pair or the `AmountPaid`/`AmountCredited`
  // fallback pair — and none carries a payment, so the record list really is empty and the refusal is
  // genuinely being reached rather than an arithmetic check being failed.
  const INCOMPLETE: Array<[string, Record<string, unknown>]> = [
    ['a body with no fields at all', {}],
    ['a body that states only the currency', { CurrencyCode: 'GBP' }],
    ['an empty Payments collection and nothing else', { CurrencyCode: 'GBP', Payments: [] }],
    ['HALF the primary pair — Total without AmountDue', { CurrencyCode: 'GBP', Total: 40 }],
    ['the other half — AmountDue without Total', { CurrencyCode: 'GBP', AmountDue: 40 }],
    ['HALF the fallback tuple — AmountPaid without AmountCredited', { CurrencyCode: 'GBP', AmountPaid: 0 }],
    ['the other half — AmountCredited without AmountPaid', { CurrencyCode: 'GBP', AmountCredited: 0 }],
  ]
  for (const [label, body] of INCOMPLETE) {
    assert.ok(
      !('Total' in body && 'AmountDue' in body) && !('AmountPaid' in body && 'AmountCredited' in body),
      `the precondition for ${label}: neither figure pair is complete`,
    )
    assert.ok(
      !Array.isArray(body.Payments) || body.Payments.length === 0,
      `the precondition for ${label}: no payment, so the record list is empty`,
    )

    const probe = await probeInvoice(body)
    assert.equal(probe.ok, false, `${label} must not answer positively`)
    assert.match(
      reasonOf(probe),
      /states no total, amount due, amount paid or amount credited on this document and IMS read no payment against it/,
      `and it must say WHY, for ${label}`,
    )

    const verdict = classifyLedgerSettlement(attemptFor('40.00'), probe)
    assert.notEqual(verdict.outcome, 'clear', `${label} must not authorise a payment`)
    assert.equal(verdict.outcome, 'unknown')
    assert.equal(verdict.outcome === 'unknown' && verdict.cause, 'probe-unreadable')
  }

  // AND ABSENCE STILL ONLY SKIPS WHERE THERE IS OTHER EVIDENCE, exactly as on the QuickBooks arm. A
  // figureless invoice whose payment this probe actually READ is not refused: the record is evidence
  // in its own right and the verdict is decided by comparing it, not by the absence.
  const withEvidence = await probeInvoice({
    CurrencyCode: 'GBP',
    Payments: [{ PaymentID: 'PAY-1', Date: `${DATE}T00:00:00`, Amount: 40 }],
  })
  assert.equal(withEvidence.ok, true, 'a figureless document whose settlement was READ still answers')
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), withEvidence).outcome, 'present')
})

test('[o3d-nk5n] an INCOMPLETE Xero credit note cannot classify as clear', async () => {
  // THE SECOND XERO ARM, which the finding names explicitly: "The credit-note branch has the same
  // repeat-allocation failure at its unconditional return." `Total - RemainingCredit` is Xero's own
  // account of how much of the credit has been used; with neither figure stated it is null, the
  // completeness check is skipped, and an absent `Allocations` collection then makes the record list
  // empty. That is `clear`, and `clear` allocates the same credit to the same bill a SECOND time.
  //
  // ROUTE: probeXeroSettlement's PURCHASE_CREDIT_NOTE_ALLOCATION arm -> `applied` null -> the
  //        allocation check skipped -> `settlementAnswer(applied, records, ...)` -> ok:false.
  // MUTATION: delete the `settlementAnswer` refusal in the credit-note arm and each body below
  //        answers ok:true with an EMPTY record list, which classifies `clear`.

  // THE PRECONDITION: none of these states BOTH figures, and none carries an allocation to this bill,
  // so the record list is empty and the refusal is genuinely reached.
  const INCOMPLETE: Array<[string, Record<string, unknown>]> = [
    ['a body with no fields at all', {}],
    ['an empty Allocations collection and nothing else', { CurrencyCode: 'GBP', Allocations: [] }],
    ['Total without RemainingCredit', { CurrencyCode: 'GBP', Total: 40 }],
    ['RemainingCredit without Total', { CurrencyCode: 'GBP', RemainingCredit: 40 }],
    [
      'both figures missing while the credit is allocated ELSEWHERE',
      { CurrencyCode: 'GBP', Allocations: [{ Amount: 40, Date: DATE, Invoice: { InvoiceID: 'other-bill' } }] },
    ],
  ]
  for (const [label, body] of INCOMPLETE) {
    assert.ok(!('Total' in body && 'RemainingCredit' in body), `the precondition for ${label}: the pair is incomplete`)
    const allocations = (body.Allocations ?? []) as Array<{ Invoice?: { InvoiceID?: string } }>
    assert.equal(
      allocations.filter((a) => a.Invoice?.InvoiceID === 'inv-1').length, 0,
      `the precondition for ${label}: nothing is allocated to THIS bill, so the record list is empty`,
    )

    const probe = await probeNote(body)
    assert.equal(probe.ok, false, `${label} must not answer positively`)
    assert.match(
      reasonOf(probe),
      /states no total or remaining credit on this credit note and IMS read no allocation of it to this bill/,
      `and it must say WHY, for ${label}`,
    )
    assert.notEqual(
      classifyLedgerSettlement(attemptFor('40.00'), probe).outcome, 'clear',
      `${label} must not authorise a re-allocation`,
    )
  }

  // AND THE SAME EXCEPTION HOLDS HERE: a figureless note whose allocation to THIS bill was read still
  // answers, because the record is evidence rather than an absence.
  const withEvidence = await probeNote({
    CurrencyCode: 'GBP',
    Allocations: [{ Amount: 40, Date: DATE, Invoice: { InvoiceID: 'inv-1' } }],
  })
  assert.equal(withEvidence.ok, true, 'a figureless note whose allocation was READ still answers')
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), withEvidence).outcome, 'present')
})

test('[o3d-nk5n] a Xero document stating EQUAL readable totals proves zero settlement, and the payment posts', async () => {
  // THE OTHER SIDE OF THE RULE, AND THE ONE THAT MUST NOT BE BROKEN BY IT. Closing the fall-through
  // is only correct if the ordinary FIRST payment still proceeds — and it does, because Xero states
  // these figures on every document that exists and an UNPAID one states them EQUAL. That is
  // emptiness PROVED by two stated figures rather than assumed from four missing ones, which is the
  // same sentence the QuickBooks arm has carried since o3d-mm51.
  //
  // ROUTE: probeXeroSettlement -> wireAmount reads both -> `settled` is exactly 0 -> statesAnything
  //        false -> the check PASSES -> `settlementAnswer` is false because `settled` is a
  //        figure -> ok:true over an empty record list -> classifyLedgerSettlement -> clear.
  // MUTATION: drop the `settled === null` half of `settlementAnswer` (refuse whenever `records`
  //        is empty) and every Xero first payment in the system stops — all four cases below fail.

  // (1) THE PRIMARY PAIR. THE PRECONDITION: the two figures are STATED and EQUAL, asserted so this
  //     cannot pass by the totals quietly going missing and taking the proof with them.
  const UNPAID = { CurrencyCode: 'GBP', Total: 40, AmountDue: 40, AmountPaid: 0, Payments: [] }
  assert.equal(UNPAID.Total, UNPAID.AmountDue, 'an unpaid invoice states its total and amount due equal')
  const probe = await probeInvoice(UNPAID)
  assert.deepEqual(probe, { ok: true, provedComplete: true, records: [] }, 'nothing settles it, and the document says so')
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), probe).outcome, 'clear', 'so the payment posts')

  // (2) A COMPLETE ZERO-VALUED FALLBACK TUPLE, which is the other proof the rule accepts and the one
  //     the `settled` fallback exists for. THE PRECONDITION: the primary pair is genuinely absent, so
  //     this case is carried by the fallback and not by the check above.
  const FALLBACK = { CurrencyCode: 'GBP', AmountPaid: 0, AmountCredited: 0, Payments: [] }
  assert.ok(!('Total' in FALLBACK) && !('AmountDue' in FALLBACK), 'the primary pair is not what proves this one')
  const viaFallback = await probeInvoice(FALLBACK)
  assert.deepEqual(viaFallback, { ok: true, provedComplete: true, records: [] })
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), viaFallback).outcome, 'clear')

  // (3) A PART-PAID INVOICE STILL ANSWERS. The rule is about an UNPROVED empty answer, not about
  //     emptiness — a document whose stated settlement is fully explained by the payments beside it
  //     is answerable however much has come off it.
  const partPaid = await probeInvoice({
    CurrencyCode: 'GBP', Total: 40, AmountDue: 30, AmountPaid: 10, AmountCredited: 0,
    Payments: [{ PaymentID: 'PAY-1', Date: `${DATE}T00:00:00`, Amount: 10 }],
  })
  assert.equal(partPaid.ok, true, 'a stated settlement that is fully explained is not a refusal')

  // (4) THE CREDIT-NOTE ARM'S OWN PROOF: a wholly unapplied credit states `Total` and
  //     `RemainingCredit` EQUAL, so `applied` is exactly zero and the empty answer is the ledger's.
  const UNAPPLIED = { CurrencyCode: 'GBP', Total: 40, RemainingCredit: 40, Allocations: [] }
  assert.equal(UNAPPLIED.Total, UNAPPLIED.RemainingCredit, 'an unapplied credit note states them equal')
  const note = await probeNote(UNAPPLIED)
  assert.deepEqual(note, { ok: true, provedComplete: true, records: [] }, 'positively unapplied, on the note\'s own figures')
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), note).outcome, 'clear')
})

test('[o3d-nk5n] the rule is ONE function, and all three arms reach it', async () => {
  // NOT A SECOND SPELLING. The QuickBooks arm has required a proved empty answer since o3d-mm51; the
  // Xero arms were closed by CALLING that same condition rather than by restating it, so a change to
  // the rule cannot reach one connector and miss the other. Both halves are checked: that the source
  // has one definition and three call sites, and that all three arms actually behave that way.
  //
  // o3d-obyd r31: the function is `settlementAnswer` and it is no longer a PREDICATE each arm
  // consults before building its own `{ ok: true, records }` — it BUILDS the answer. That is what
  // this test's own premise now buys: because every arm leaves through it, r31 changed what all
  // three report about their collection's completeness by changing one function, and there is no
  // route by which an arm could construct a successful probe without handing over the document
  // figure that decides it.

  const source = await readFile(
    path.join(process.cwd(), 'lib/connectors/accounting-settlement-probe.ts'), 'utf8',
  )
  // THE PRECONDITION: this test read the file it means to police, and the function it requires is
  // actually named in it — so it cannot pass by reading nothing.
  assert.ok(source.length > 1000, 'the probe source was read')
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
  assert.match(code, /function settlementAnswer/, 'the shared rule is defined in the module')

  const definitions = [...code.matchAll(/function settlementAnswer/g)]
  assert.equal(definitions.length, 1, 'exactly ONE definition, so there is one rule to change')
  const callSites = [...code.matchAll(/settlementAnswer\s*\(/g)].map((m) => m.index!)
  assert.equal(callSites.length, 4, 'the definition plus one call from each of the three arms')

  // LOCATED, not merely counted: one call inside each probe, so this cannot be satisfied by three
  // calls piled into one arm while another re-spells the condition.
  const xeroAt = code.indexOf('export async function probeXeroSettlement')
  const qboAt = code.indexOf('export async function probeQuickBooksSettlement')
  assert.ok(xeroAt > 0 && qboAt > xeroAt, 'both probes were found, in the order this test assumes')
  assert.equal(callSites.filter((i) => i > xeroAt && i < qboAt).length, 2, 'both Xero arms call it')
  assert.equal(callSites.filter((i) => i > qboAt).length, 1, 'and the QuickBooks arm calls it')

  // AND THE BEHAVIOURAL HALF, which is what actually protects the money: the same figureless shape
  // refuses on all three arms. A source-shaped assertion alone would pass over a call whose result
  // was discarded.
  const invoice = await probeInvoice({ CurrencyCode: 'GBP' })
  const note = await probeNote({ CurrencyCode: 'GBP' })
  const bill = await probeBill({})
  for (const [label, probe] of [['Xero invoice', invoice], ['Xero credit note', note], ['QuickBooks bill', bill]] as const) {
    assert.equal(probe.ok, false, `${label}: a figureless document refuses`)
    assert.match(reasonOf(probe), /it has nothing to tell from/, `${label}: and for the same reason`)
    assert.notEqual(classifyLedgerSettlement(attemptFor('40.00'), probe).outcome, 'clear', `${label}: no clear`)
  }
})

/* ------------------------------------------------------------------------------------------- *
 * 5. o3d-obyd r31 (Codex HIGH 1) — A RECORD IS EVIDENCE ABOUT ITSELF, NOT ABOUT ITS COLLECTION.
 *
 * The rule above ("an empty record list is a positive claim, so it needs a figure behind it")
 * refused the figureless response ONLY when its record list was empty, on the stated reasoning that
 * "a non-empty record list still answers — records are evidence in their own right". That sentence
 * is true of a MATCH and false of a NON-MATCH, and the two conclusions are not symmetric:
 *
 *   A MATCHING RECORD proves the attempt settled. It is there, this code read it, and nothing the
 *   response omitted can unmake it. Truncation is irrelevant to a positive find.
 *
 *   A NON-MATCHING RECORD proves only that SOME OTHER settlement exists. Concluding `clear` from it
 *   means concluding something about the COLLECTION — "no settlement matching this attempt is in the
 *   ledger" — which needs the list to be all of them. A returned record is not evidence of that.
 *
 * So a truncated response that omits the document totals, returns one unrelated settlement and omits
 * the attempted one satisfied the old predicate on every arm, answered ok:true, matched nothing, and
 * reached `clear` — which authorises a second payment. The probe now reports whether the collection
 * is PROVED COMPLETE (from the document's own settled figure, never from the records), and the
 * classifier spends that on the non-match alone.
 * ------------------------------------------------------------------------------------------- */

/** The truncated shape, per arm: a document stating no settled figure, holding ONE unrelated record. */
const TRUNCATED = {
  /** ARM 2. No Total/AmountDue/AmountPaid/AmountCredited; one payment that is not the attempt. */
  invoice: () => probeInvoice({
    CurrencyCode: 'GBP',
    Payments: [{ PaymentID: 'PAY-SOMEONE-ELSE', Date: '2026-06-01T00:00:00', Amount: 99 }],
  }),
  /** ARM 1. No Total/RemainingCredit; one allocation to this bill that is not the attempt. */
  note: () => probeNote({
    CurrencyCode: 'GBP',
    Allocations: [{ Amount: 99, Date: '/Date(1780272000000+0000)/', Invoice: { InvoiceID: 'inv-1' } }],
  }),
  /** ARM 3. No TotalAmt/Balance; one linked bill payment that is not the attempt. */
  bill: () => probeQuickBooksSettlement(
    { type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'bill-1' } },
    ledgerDouble({
      'bill/bill-1': { Bill: { LinkedTxn: [{ TxnId: '77', TxnType: 'BillPaymentCheck' }] } },
      'billpayment/77': {
        BillPayment: { TxnDate: '2026-06-01', Line: [{ Amount: 99, LinkedTxn: [{ TxnId: 'bill-1', TxnType: 'Bill' }] }] },
      },
    }).get,
  ),
}

test('[o3d-obyd r31] a truncated response holding ONE UNRELATED record does not authorise a post', async () => {
  // ROUTE: each arm -> its document figures are ABSENT so `settled`/`applied` is null -> the
  //        shortfall cross-check is skipped (nothing to compare against) -> `settlementAnswer` sees
  //        a NON-EMPTY record list, so it does not refuse, and reports `provedComplete: false` ->
  //        `classifyLedgerSettlement` walks the records, matches none, and reaches the terminal
  //        `clear` gate, which now answers `unknown` / `collection-unproved`.
  // MUTATION: in `settlementAnswer`, return `provedComplete: true` unconditionally (or delete the
  //        `!probe.provedComplete` gate at the end of `classifyLedgerSettlement`). Every arm below
  //        then answers `clear`, which is what authorises the second payment — measured.

  // THE ATTEMPT this response is being asked about: 40.00 on 2026-08-01.
  const attempt = attemptFor('40.00')
  assert.equal(attempt.amount?.toFixed(2), '40.00', 'the attempt states a figure to look for')
  assert.equal(attempt.date, DATE)

  for (const [label, run] of Object.entries(TRUNCATED)) {
    const probe = await run()

    // PRECONDITION 1 — the probe ANSWERED. This is not the already-covered refusal of a figureless
    // EMPTY response; the arm got far enough to report records, which is the whole difficulty.
    assert.equal(probe.ok, true, `${label}: the truncated response is an ANSWER, not a refusal`)

    // PRECONDITION 2 — the list really is non-empty, and really does NOT hold the attempt. Without
    // both, this test would be re-testing the empty case or the matching case.
    assert.equal(probe.ok === true ? probe.records.length : 0, 1, `${label}: exactly one record came back`)
    const only = probe.ok === true ? probe.records[0]! : null
    assert.equal(only?.amount?.toFixed(2), '99.00', `${label}: and it is a settlement of 99.00...`)
    assert.equal(only?.date, '2026-06-01', `${label}: ...on a different day from the attempt`)
    assert.notEqual(only?.date, attempt.date, `${label}: so no amount-and-date match is available`)

    // PRECONDITION 3 — nothing established the collection. This is the fact the verdict turns on,
    // asserted directly so the test cannot pass because the arm happened to prove completeness.
    assert.equal(probe.ok === true ? probe.provedComplete : null, false,
      `${label}: the document stated no settled figure, so nothing measured this list`)

    // THE VERDICT. Not `clear`, and for the right reason.
    const verdict = classifyLedgerSettlement(attempt, probe)
    assert.equal(verdict.outcome, 'unknown', `${label}: "not among these" is not "not in the ledger"`)
    assert.equal(verdict.outcome === 'unknown' ? verdict.cause : null, 'collection-unproved', label)
  }
})

test('[o3d-obyd r31] a MATCHING record still yields present with no document totals', async () => {
  // The other half of the asymmetry, and the reason the gate sits AFTER both match passes rather
  // than at the top of the classifier. `present` is what resolves the row and writes the matched id
  // back; a probe whose collection is unproved must still be allowed to recognise our own payment.
  //
  // ROUTE: `settlementAnswer` reports `provedComplete: false` exactly as above -> the amount+date
  //        pass (and, separately, the marker pass) returns `present` BEFORE the terminal gate is
  //        reached.
  // MUTATION: move the `!probe.provedComplete` refusal to the TOP of `classifyLedgerSettlement`
  //        (before the marker pass). Both assertions below become `unknown`, and a payment IMS can
  //        see in the ledger stops being recognised as its own.

  const MARK = 'IMS-abc123abc123'

  // (a) THE AMOUNT-AND-DATE MATCH, on a response that states no figures at all.
  const matched = await probeInvoice({
    CurrencyCode: 'GBP',
    Payments: [{ PaymentID: 'PAY-OURS', Date: `${DATE}T00:00:00`, Amount: 40 }],
  })
  // PRECONDITION: unproved, so this really is the same shape the test above refuses on — the ONLY
  // difference between them is whether the record matches.
  assert.equal(matched.ok, true)
  assert.equal(matched.ok === true ? matched.provedComplete : null, false,
    'the same figureless response: nothing proved this collection whole')
  const byFigures = classifyLedgerSettlement(attemptFor('40.00'), matched)
  assert.equal(byFigures.outcome, 'present', 'a record that IS the attempt proves the attempt settled')
  assert.equal(byFigures.outcome === 'present' ? byFigures.matchedId : null, 'PAY-OURS',
    'and the id is carried, which is what a reconciliation writes back')

  // (b) THE MARK, which survives an edit to the amount and the date — the case the pair cannot see.
  const marked = await probeInvoice({
    CurrencyCode: 'GBP',
    Payments: [{ PaymentID: 'PAY-MARKED', Date: '2020-01-01T00:00:00', Amount: 999, Reference: MARK }],
  })
  assert.equal(marked.ok === true ? marked.provedComplete : null, false, 'unproved here too')
  const byMark = classifyLedgerSettlement(
    { amount: toDecimal('40.00'), currency: 'GBP', date: DATE, marker: MARK },
    marked,
  )
  assert.equal(byMark.outcome, 'present', 'neither figure matches, and it is still our own payment')

  // THE DISCRIMINATING HALF: the identical unproved probe, asked about an attempt it does NOT hold,
  // withholds. Without this, "present" could be coming from a classifier that had stopped comparing.
  assert.equal(classifyLedgerSettlement(attemptFor('12.34'), matched).outcome, 'unknown',
    'the same probe still refuses to clear an attempt it cannot find')
})

test('[o3d-obyd r31] the ordinary first payment still posts, and the ordinary part-payment still clears', async () => {
  // WHAT THE RULE COSTS THE ORDINARY DOCUMENT: nothing. Xero and QuickBooks state these figures on
  // every document they return, so `provedComplete` is true for every real response and the
  // non-match still clears. The refusals above are reachable only by a response that omits them.
  //
  // ROUTE: `settled`/`applied` computable -> the shortfall check passes -> `settlementAnswer`
  //        reports `provedComplete: true` -> the classifier reaches `clear` as it always did.
  // MUTATION: invert `provedComplete` in `settlementAnswer` (report `settled === null`). Every
  //          assertion below flips to `unknown`, which is the visible cost of getting this backwards.

  // (a) THE FIRST PAYMENT: an unsettled invoice states Total and AmountDue EQUAL, so the settled
  //     figure is exactly zero and the EMPTY list is the ledger's own answer.
  const unpaid = await probeInvoice({
    CurrencyCode: 'GBP', Total: 40, AmountDue: 40, AmountPaid: 0, AmountCredited: 0, Payments: [],
  })
  assert.equal(unpaid.ok, true)
  assert.equal(unpaid.ok === true ? unpaid.provedComplete : null, true,
    'PRECONDITION: emptiness PROVED by the document\'s own figures, not assumed from missing ones')
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), unpaid).outcome, 'clear',
    'the ordinary first payment still posts')

  // (b) THE PART-PAYMENT, which is the non-match this rule is about — a real other settlement, on a
  //     document that accounts for it. The list is measured, so "this attempt is not among them" is
  //     the ledger's answer and not this code's silence.
  const partPaid = await probeInvoice({
    CurrencyCode: 'GBP', Total: 100, AmountDue: 90, AmountPaid: 10, AmountCredited: 0,
    Payments: [{ PaymentID: 'PAY-1', Date: '2026-06-01T00:00:00', Amount: 10 }],
  })
  assert.equal(partPaid.ok, true)
  assert.equal(partPaid.ok === true ? partPaid.records.length : 0, 1,
    'PRECONDITION: a real, non-matching settlement is on the document...')
  assert.equal(partPaid.ok === true ? partPaid.provedComplete : null, true,
    '...and the invoice\'s own figures account for it, so the collection is proved whole')
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), partPaid).outcome, 'clear',
    'a second instalment against a part-paid invoice is still sendable')

  // (c) AND THE SAME PART-PAYMENT WITH THE FIGURES REMOVED is the truncated shape, which does not
  //     clear. This is the pair that isolates the variable: identical records, identical attempt,
  //     and the ONLY difference is whether the document stated what settles it.
  const sameRecordsNoFigures = await probeInvoice({
    CurrencyCode: 'GBP',
    Payments: [{ PaymentID: 'PAY-1', Date: '2026-06-01T00:00:00', Amount: 10 }],
  })
  assert.deepEqual(
    sameRecordsNoFigures.ok === true ? sameRecordsNoFigures.records : null,
    partPaid.ok === true ? partPaid.records : undefined,
    'PRECONDITION: the two responses carry the SAME record list',
  )
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), sameRecordsNoFigures).outcome, 'unknown',
    'and the same records answer differently only because one collection is proved and the other is not')
})

/* ------------------------------------------------------------------------------------------- *
 * 6. o3d-obyd r31 (Codex HIGH 2) — TWO FORMS OF ONE FIGURE THAT DISAGREE ARE NOT A FIGURE.
 *
 * `AmountDue = Total - AmountPaid - AmountCredited` is Xero's own definition, so `Total - AmountDue`
 * and `AmountPaid + AmountCredited` are the SAME quantity rearranged. The fallback exists for a
 * response that omits the totals, not because the two ask different questions. Preferring the first
 * unconditionally let a response state both a proved ZERO and a stated credit at the same time.
 * ------------------------------------------------------------------------------------------- */

test('[o3d-obyd r31] contradictory settled figures refuse, rather than the zero one forging a clear', async () => {
  // ROUTE: probeXeroSettlement's invoice arm -> both figure pairs are computable -> they differ by
  //        more than `completenessBand` -> ok:false, before `settled` is used for anything.
  // MUTATION: restore `const settled = settledFromTotals ?? settledFromComponents` and delete the
  //        agreement check. The probe then answers ok:true over an EMPTY record list with a settled
  //        figure of exactly zero, and `classifyLedgerSettlement` answers `clear` — measured.

  // CODEX'S SHAPE, VERBATIM. Xero says the invoice is wholly outstanding AND that 10 was credited.
  const CONTRADICTORY = {
    CurrencyCode: 'GBP', Total: 100, AmountDue: 100, AmountPaid: 0, AmountCredited: 10, Payments: [],
  }

  // PRECONDITION 1 — the two derivations really do disagree, by arithmetic stated here rather than
  // taken on trust from the probe.
  assert.equal(CONTRADICTORY.Total - CONTRADICTORY.AmountDue, 0, 'Total less AmountDue says nothing settled')
  assert.equal(CONTRADICTORY.AmountPaid + CONTRADICTORY.AmountCredited, 10, 'the component pair says 10 did')

  // PRECONDITION 2 — the FIRST of those is exactly zero, which is why the old code could not catch
  // this any other way: a zero settled figure makes `statesAnything` false, so the shortfall check
  // passes over an empty collection without measuring anything. The contradiction is the ONLY
  // evidence in the response that something is wrong.
  assert.equal(CONTRADICTORY.Total - CONTRADICTORY.AmountDue, 0,
    'a PROVED zero is what the preferred pair forges, and a proved zero clears')
  assert.equal(CONTRADICTORY.Payments.length, 0, 'and there is no record to fall over instead')

  const probe = await probeInvoice(CONTRADICTORY)
  assert.equal(probe.ok, false, 'an incoherent response is refused, not resolved in either direction')
  assert.match(reasonOf(probe), /two amounts settled against this document that do not agree/)
  assert.match(reasonOf(probe), /0\.00 by Total less AmountDue/, 'and it names both, so an operator can look')
  assert.match(reasonOf(probe), /10\.00 by AmountPaid plus AmountCredited/)

  // THE END THIS PROTECTS: `clear` authorises the money post.
  assert.notEqual(classifyLedgerSettlement(attemptFor('40.00'), probe).outcome, 'clear')

  // THE DISCRIMINATING HALF, and it is the ORDINARY unsettled invoice: the same response made
  // COHERENT still clears. Nothing about a real first payment moved — only the contradiction is new.
  const coherent = await probeInvoice({ ...CONTRADICTORY, AmountCredited: 0 })
  assert.equal(coherent.ok, true, 'a document whose two derivations agree at zero is still an answer')
  assert.equal(coherent.ok === true ? coherent.provedComplete : null, true)
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), coherent).outcome, 'clear',
    'and the payment posts, which is what the fallback pair exists to allow')

  // AND THE OTHER DIRECTION OF THE SAME CONTRADICTION, so this is not a rule about zero: a response
  // whose component pair is the SMALLER one is equally incoherent and equally refused.
  const inverted = await probeInvoice({
    CurrencyCode: 'GBP', Total: 100, AmountDue: 40, AmountPaid: 10, AmountCredited: 0,
    Payments: [{ PaymentID: 'PAY-1', Date: `${DATE}T00:00:00`, Amount: 10 }],
  })
  assert.equal(inverted.ok, false, '60 by one derivation and 10 by the other is still two answers')
  assert.match(reasonOf(inverted), /60\.00 by Total less AmountDue and 10\.00 by AmountPaid plus AmountCredited/)

  // AND A RESPONSE STATING ONLY ONE PAIR IS NOT A CONTRADICTION. The fallback still works: this is
  // the shape it was added for, and refusing it would fail every response that omits the totals.
  const componentsOnly = await probeInvoice({
    CurrencyCode: 'GBP', AmountPaid: 10, AmountCredited: 0,
    Payments: [{ PaymentID: 'PAY-1', Date: '2026-06-01T00:00:00', Amount: 10 }],
  })
  assert.equal(componentsOnly.ok, true, 'one stated pair is one figure, and one figure cannot disagree')
  assert.equal(componentsOnly.ok === true ? componentsOnly.provedComplete : null, true,
    'and it proves the collection just as the totals pair does')
})

/* ------------------------------------------------------------------------------------------- *
 * 6b. o3d-acctmoney (Codex HIGH) — THE IDENTITY HAS FOUR TERMS, AND THE MISSING ONE REFUSED A
 *     DOCUMENT XERO SENDS CORRECTLY.
 *
 * `AmountDue = Total - CISDeduction - AmountPaid - AmountCredited`. Under the UK Construction
 * Industry Scheme a contractor withholds `CISDeduction` from a subcontractor and pays it to HMRC:
 * it comes off `AmountDue` and it is in NO payment, NO credit note, NO prepayment and NO
 * overpayment. The three-term identity therefore read every CIS invoice as self-contradictory, and
 * the shortfall check would have read the deduction as settlement nobody could account for.
 *
 * These are the first tests on this branch about a document that is RIGHT. Everything above them
 * refuses something malformed; these pin what must keep working, which is the ordinary first
 * payment against a UK construction invoice.
 * ------------------------------------------------------------------------------------------- */

/** Codex's shape, verbatim, before anything has been paid against it. */
const CIS_UNPAID = {
  CurrencyCode: 'GBP', Total: 400, CISDeduction: 80, AmountDue: 320,
  AmountPaid: 0, AmountCredited: 0, Payments: [],
}

test('[o3d-acctmoney] Codex\'s CIS invoice is coherent UNPAID, and the first payment still posts', async () => {
  // ROUTE: probeXeroSettlement's invoice arm -> wireAmount(invoice.CISDeduction) -> settledFromTotals
  //        = Total - AmountDue - CISDeduction -> agreement check -> settled/explained shortfall ->
  //        settlementAnswer -> classifyLedgerSettlement.
  // MUTATION: drop the third term (`subtractMoney(total, amountDue)` alone, which is what stood
  //        before this commit). Measured: ok:false, "two amounts settled ... 80.00 by Total less
  //        AmountDue and 0.00 by AmountPaid plus AmountCredited" — the finding, exactly.

  // PRECONDITION 1 — the THREE-term identity really does fail on this document, stated as arithmetic
  // here rather than taken on trust from the probe. If Xero ever stopped reducing AmountDue by the
  // deduction this would become 0 and the test would be examining nothing.
  assert.equal(CIS_UNPAID.Total - CIS_UNPAID.AmountDue, 80,
    'PRECONDITION: the three-term derivation says 80 has settled...')
  assert.equal(CIS_UNPAID.AmountPaid + CIS_UNPAID.AmountCredited, 0,
    '...while the component pair says nothing has, which is the disagreement that refused it')
  // PRECONDITION 2 — and the FOUR-term identity is the one that holds.
  assert.equal(CIS_UNPAID.Total - CIS_UNPAID.AmountDue - CIS_UNPAID.CISDeduction, 0,
    'PRECONDITION: with the deduction taken off, the two derivations agree at zero')
  assert.equal(CIS_UNPAID.Payments.length, 0, 'and there is no record that could carry the answer instead')

  const probe = await probeInvoice(CIS_UNPAID)
  assert.equal(probe.ok, true, 'a correct UK construction invoice is not an incoherent response')
  assert.equal(probe.ok === true ? probe.records.length : null, 0,
    'nothing has settled it, and the ledger says so in its own numbers')
  assert.equal(probe.ok === true ? probe.provedComplete : null, true,
    'the emptiness is PROVED by the four-term identity, not assumed from a missing figure')

  // THE END THIS PROTECTS, and it is the ordinary operation: `clear` is what authorises the post.
  assert.equal(classifyLedgerSettlement(attemptFor('320.00'), probe).outcome, 'clear',
    'the first payment against a CIS invoice must post, not queue for a human')
})

test('[o3d-acctmoney] the SAME CIS invoice once PAID accounts for itself, and does not clear again', async () => {
  // ROUTE: as above, with the deduction now sitting between a zero AmountDue and a Total the
  //        payment does not reach: settled = 400 - 0 - 80 = 320, explained = the 320 payment.
  // MUTATION: drop the third term. settled becomes 400, explained stays 320, and the probe answers
  //        ok:false "Xero reports 400.00 already settled ... but only 320.00 of it is accounted
  //        for" — measured. The retry of a CIS payment is refused as malformed.

  const CIS_PAID = {
    CurrencyCode: 'GBP', Total: 400, CISDeduction: 80, AmountDue: 0,
    AmountPaid: 320, AmountCredited: 0,
    Payments: [{ PaymentID: 'PAY-1', Date: `${DATE}T00:00:00`, Amount: 320, Reference: 'IMS-abc123abc123' }],
  }

  // PRECONDITION — the subcontractor is paid 320 and HMRC gets 80, so the document is FULLY settled
  // at an AmountDue of zero while `AmountPaid` is 80 short of `Total`. That gap is the deduction,
  // and it is exactly what no collection on this response can ever explain.
  assert.equal(CIS_PAID.Total - CIS_PAID.AmountPaid, 80, 'PRECONDITION: Total exceeds what was paid...')
  assert.equal(CIS_PAID.AmountDue, 0, '...and yet nothing is still due, because the rest went to HMRC')
  assert.equal(CIS_PAID.Total - CIS_PAID.AmountDue - CIS_PAID.CISDeduction,
    CIS_PAID.AmountPaid + CIS_PAID.AmountCredited,
    'PRECONDITION: the four-term identity holds on the paid invoice too')

  const probe = await probeInvoice(CIS_PAID)
  assert.equal(probe.ok, true)
  assert.equal(probe.ok === true ? probe.provedComplete : null, true,
    'the payment list is measured against a figure the deduction no longer inflates')
  assert.deepEqual(probe.ok === true ? probe.records : null, [
    { amount: toDecimal(320), date: DATE, id: 'PAY-1', reference: 'IMS-abc123abc123' },
  ])

  // AND THE POINT OF READING IT AT ALL: the payment that is already there is FOUND, so a retry is
  // told it is present rather than being told the document is clear.
  const again = classifyLedgerSettlement(attemptFor('320.00'), probe)
  assert.equal(again.outcome, 'present',
    'the settlement IMS already made is visible, which is what stops the second one')
  assert.notEqual(again.outcome, 'clear')
})

test('[o3d-acctmoney] a non-CIS invoice is untouched: an ABSENT deduction is a zero, not a skip', async () => {
  // ROUTE: `cisDeductionRead.value ?? toDecimal(0)` -> settledFromTotals -> settlementAnswer.
  // MUTATION: make an ABSENT deduction refuse the way an unreadable one does (hand
  //        completenessCannotRun an `unreadable: '(absent)'` reading when the field is missing).
  //        Measured: this test fails, and so do 19 others — every ordinary Xero invoice in the file,
  //        because outside the scheme nothing states the field. Fail-closed on absence is the
  //        plausible wrong answer here, and it is the one this pins.
  // NOT A MUTATION, STATED SO NOBODY SPENDS AN AFTERNOON ON IT: guarding the subtraction on the
  //        figure being stated (`cis !== null ? T - D - cis : T - D`) is EQUIVALENT to `T - D -
  //        (cis ?? 0)` and no test can distinguish it. It is a refactor of this line, not a defect
  //        in it, which is why the assertion below is an EQUIVALENCE against the explicit zero
  //        rather than a claim about how the zero is spelled.

  // The ordinary part-paid invoice, with no such field anywhere in the response.
  const NO_FIELD = {
    CurrencyCode: 'GBP', Total: 100, AmountDue: 90, AmountPaid: 10, AmountCredited: 0,
    Payments: [{ PaymentID: 'PAY-1', Date: `${DATE}T00:00:00`, Amount: 10 }],
  }
  assert.equal('CISDeduction' in NO_FIELD, false, 'PRECONDITION: the field is absent, not zero')

  const absent = await probeInvoice(NO_FIELD)
  const explicitZero = await probeInvoice({ ...NO_FIELD, CISDeduction: 0 })

  assert.equal(absent.ok, true, 'an invoice outside the scheme still answers')
  assert.deepEqual(absent, explicitZero,
    'and it answers IDENTICALLY to the same invoice that states a zero deduction — same records, '
    + 'same provedComplete, same everything')
  assert.equal(classifyLedgerSettlement(attemptFor('90.00'), absent).outcome, 'clear',
    'the ordinary second instalment is unaffected by any of this')
})

test('[o3d-acctmoney] an UNREADABLE CISDeduction refuses, and does not quietly become a zero', async () => {
  // ROUTE: wireAmount -> `unreadable` -> completenessCannotRun -> ok:false, before any arithmetic.
  // MUTATION: remove `['CISDeduction', cisDeductionRead]` from the completenessCannotRun list. The
  //        reading then falls through `?? toDecimal(0)`, the figures below agree at 80, and the
  //        probe answers ok:true with provedComplete — measured. A figure Xero STATED and IMS
  //        could not read would have been spent as permission, which is o3d-obyd's whole finding
  //        reintroduced through the new field.

  // The shape is chosen so the mutation is SILENT rather than merely differently-worded: with the
  // deduction read as zero these four figures are coherent and the payment list is whole.
  const COHERENT_IF_ZERO = {
    CurrencyCode: 'GBP', Total: 400, AmountDue: 320, AmountPaid: 80, AmountCredited: 0,
    Payments: [{ PaymentID: 'PAY-1', Date: `${DATE}T00:00:00`, Amount: 80 }],
  }
  const control = await probeInvoice(COHERENT_IF_ZERO)
  assert.equal(control.ok, true,
    'PRECONDITION: with NO deduction stated this document is accepted, so nothing else can be doing the refusing')
  assert.equal(control.ok === true ? control.provedComplete : null, true)

  for (const [stated, named] of [['eighty', 'eighty'], ['', '(blank)'], [{ Amount: 80 }, 'object']] as const) {
    const probe = await probeInvoice({ ...COHERENT_IF_ZERO, CISDeduction: stated })
    assert.equal(probe.ok, false, `a CISDeduction of ${JSON.stringify(stated)} is not a figure IMS may ignore`)
    assert.match(reasonOf(probe), new RegExp(`CISDeduction ${named.replace(/[()]/g, '\\$&')}`),
      'and the refusal NAMES it, so an operator is told which figure could not be read')
    assert.match(reasonOf(probe), /cannot read as an amount/)
    assert.notEqual(classifyLedgerSettlement(attemptFor('320.00'), probe).outcome, 'clear')
  }

  // AND THE MAGNITUDE RULE IS INHERITED TOO, which is the other half of "the same discipline as
  // every other figure": a JSON number too large to hold half a minor unit is a figure whose token
  // `Response.json()` has already destroyed, and it is refused rather than read.
  const overBound = await probeInvoice({
    ...COHERENT_IF_ZERO, CISDeduction: ledgerDifferenceMagnitudeBound('GBP'),
  })
  assert.equal(overBound.ok, false,
    'a deduction at the difference bound cannot be subtracted to within half a penny, so it is not subtracted')
  assert.match(reasonOf(overBound), /CISDeduction /)

  // A NUMERIC STRING IS THE ORDINARY CASE AND IS READ, not refused — same decoder as every other
  // money figure this file admits.
  const asText = await probeInvoice({ ...CIS_UNPAID, CISDeduction: '80.00' })
  assert.equal(asText.ok, true, 'text is how one of these two ledgers states its money')
  assert.equal(asText.ok === true ? asText.provedComplete : null, true)
  assert.equal(classifyLedgerSettlement(attemptFor('320.00'), asText).outcome, 'clear')
})

test('[o3d-acctmoney] the contradiction check still catches a real contradiction, deduction and all', async () => {
  // ROUTE: settledFromTotals (four-term) vs settledFromComponents -> they differ -> ok:false.
  // MUTATION: delete the agreement check and restore `settled = settledFromTotals ?? …`. The probe
  //        then answers ok:true over an EMPTY record list with a settled figure of exactly zero and
  //        the classifier says `clear` — measured. This is o3d-obyd r31's finding, re-run on a
  //        document that now goes through the CIS term, so widening the identity did not widen the
  //        hole it closed.

  // Codex's invoice with a credit Xero also says nothing was: the four-term derivation says zero has
  // come off, the component pair says 10 has.
  const CIS_CONTRADICTORY = { ...CIS_UNPAID, AmountCredited: 10 }
  assert.equal(
    CIS_CONTRADICTORY.Total - CIS_CONTRADICTORY.AmountDue - CIS_CONTRADICTORY.CISDeduction, 0,
    'PRECONDITION: the corrected derivation still says nothing has settled...')
  assert.equal(CIS_CONTRADICTORY.AmountPaid + CIS_CONTRADICTORY.AmountCredited, 10,
    '...and the component pair still says 10 has, so this is a genuine disagreement and not the CIS gap')

  const probe = await probeInvoice(CIS_CONTRADICTORY)
  assert.equal(probe.ok, false, 'a proved zero must not be forged out of two figures that cannot both be true')
  assert.match(reasonOf(probe), /two amounts settled against this document that do not agree/)
  assert.match(reasonOf(probe), /0\.00 by Total less AmountDue less the 80\.00 CIS deduction/,
    'and the sentence names the third term it took off, or an operator cannot check the arithmetic')
  assert.match(reasonOf(probe), /10\.00 by AmountPaid plus AmountCredited/)
  assert.notEqual(classifyLedgerSettlement(attemptFor('320.00'), probe).outcome, 'clear')

  // THE DISCRIMINATING HALF: the same document without the spurious credit is the CIS invoice that
  // must keep working, so this test cannot pass by refusing everything with a deduction on it.
  const coherent = await probeInvoice(CIS_UNPAID)
  assert.equal(coherent.ok, true)
  assert.equal(classifyLedgerSettlement(attemptFor('320.00'), coherent).outcome, 'clear')
})

test('[o3d-obyd r31 / o3d-zo4j] the FIGURELESS unproved answer carries records — and the EXCESS one does not', async () => {
  // WHY THIS EXISTS. `authoriseMoneyPost`'s undescribable-attempt branch is the one place outside
  // `classifyLedgerSettlement` that draws a conclusion from a record list directly, and it draws the
  // strongest one: an empty list means "nothing here could be confused with this attempt", and the
  // row POSTS.
  //
  // r31 SHOWED THAT WAS SOUND on the only unproved shape there then was: `settlementAnswer` refuses a
  // response that states no settled figure AND carries no record, so `ok && !provedComplete` implied
  // `records.length > 0` and the gate's length test caught every one. That half is still true and is
  // still asserted below, unchanged — it is what keeps the figureless arm of the gate honest.
  //
  // o3d-zo4j ENDED THE UNIVERSAL VERSION OF IT. A collection that EXCEEDS the figure certifying it is
  // unproved too, and it is reached with the figure STATED — so nothing refuses it, and its record
  // list can be empty. r31 removed `|| !probe.provedComplete` from the post gate as unfalsifiable;
  // that arm is back, with inputs, and the counterexample is built here so this test names the gate
  // it protects rather than pinning a premise that has stopped holding.
  //
  // ROUTE: `settlementAnswer(settled, exceeds, records, ...)` -> `settled === null &&
  //        records.length === 0` -> ok:false, which is the figureless half; and `settled` stated with
  //        an excess -> `ok: true, provedComplete: false, records: []`, which is the new half.
  // MUTATION: drop the `records.length === 0` half of that condition (return the ok answer whenever
  //        `settled === null`). The first loop below then reports answers instead of refusals.

  // Each arm, driven with a document that states NO settled figure and holds NO settlement.
  const figurelessAndEmpty = {
    'Xero invoice': () => probeInvoice({ CurrencyCode: 'GBP', Payments: [] }),
    'Xero credit note': () => probeNote({ CurrencyCode: 'GBP', Allocations: [] }),
    'QuickBooks bill': () => probeBill({ LinkedTxn: [] }),
  }
  for (const [label, run] of Object.entries(figurelessAndEmpty)) {
    const probe = await run()
    // THE PRECONDITION this test would be worthless without: the document really does state no
    // settled figure. If it stated one the answer would be proved and the invariant untested.
    assert.equal(probe.ok, false, `${label}: a figureless EMPTY answer is refused, never reported`)
    assert.match(reasonOf(probe), /it has nothing to tell from/, `${label}: and for that reason`)
  }

  // AND THE INVARIANT ITSELF, stated over the answers the arms DO give: every probe that answers
  // without proving its collection carries at least one record.
  const answers = [
    await TRUNCATED.invoice(), await TRUNCATED.note(), await TRUNCATED.bill(),
    await probeInvoice({ CurrencyCode: 'GBP', Total: 40, AmountDue: 40, AmountPaid: 0, AmountCredited: 0, Payments: [] }),
  ]
  // PRECONDITION: the sample is not vacuous — at least one of these really is an unproved answer, so
  // the loop below has something to check rather than passing over an empty set.
  const unproved = answers.filter((p) => p.ok === true && !p.provedComplete)
  assert.equal(unproved.length, 3, 'all three truncated arms answered, and answered unproved')
  for (const probe of unproved) {
    assert.ok(probe.ok === true && probe.records.length > 0,
      'an unproved answer always has a record — which is what makes the post gate\'s length test '
      + 'sufficient, and what a future arm answering an unproved EMPTY probe would break')
  }

  // o3d-zo4j — AND HERE IS THAT FUTURE ARM, WHICH IS WHY THE GATE NOW READS `provedComplete` TOO.
  // Every assertion above stands: on the FIGURELESS route an unproved answer still always carries a
  // record. What has changed is that the figureless route is no longer the only unproved one.
  const excessAndEmpty = {
    // A credit note contradicting its own RemainingCredit with an allocation to ANOTHER invoice.
    'Xero credit note': () => probeNote({
      CurrencyCode: 'GBP', Total: 40, RemainingCredit: 40,
      Allocations: [{ Amount: 40, Date: '2026-06-01T00:00:00', Invoice: { InvoiceID: 'other-inv' } }],
    }),
    // An invoice stating nothing settled while itemising 30 of credit applied.
    'Xero invoice': () => probeInvoice({
      CurrencyCode: 'GBP', Total: 100, AmountDue: 100, AmountPaid: 0, AmountCredited: 0,
      Payments: [], CreditNotes: [{ AppliedAmount: 30 }],
    }),
  }
  for (const [label, run] of Object.entries(excessAndEmpty)) {
    const probe = await run()
    assert.equal(probe.ok, true, `${label}: the figure is stated, so nothing refuses it`)
    assert.equal(probe.ok === true ? probe.provedComplete : null, false, `${label}: and it is unproved`)
    assert.equal(probe.ok === true ? probe.records.length : -1, 0,
      `${label}: with an EMPTY list — the exact input r31 argued could not exist, which is why the `
      + 'post gate\'s length test is no longer sufficient on its own')
  }
})

/* ------------------------------------------------------------------------------------------- *
 * 7. o3d-zo4j (Codex HIGH) — A COLLECTION THAT EXCEEDS THE FIGURE CERTIFYING IT HAS CONTRADICTED
 *    THAT FIGURE, SO THE FIGURE IS NO LONGER PROOF OF THE COLLECTION.
 *
 * `provedComplete` was `settled !== null`: the figure being STATED taken as the figure being BORNE
 * OUT. Every check above it rejects a SHORTFALL — the collection explaining LESS than the figure —
 * which is one of the two ways the two can fail to agree. The other went unmeasured.
 *
 * THE SHAPE, AND IT IS THE ONE FILED ON THIS ISSUE: a Xero credit note reading `Total 40 /
 * RemainingCredit 40` — a PROVED ZERO, so `statesAnything` is false and the shortfall check passes
 * over nothing — whose `Allocations` show 40 already used. The note says none of the credit has been
 * applied and simultaneously shows all of it applied. The zero was believed.
 *
 * WHAT THE RULE IS, AND WHAT IT DELIBERATELY IS NOT. It WITHHOLDS the proof; it does not refuse the
 * probe. Refusing would need this code to decide whether a particular excess is legitimate — a
 * reversed-but-listed payment, a draft credit note — and that question does not have to be answered
 * to stop treating a contradicted figure as proof. So the whole effect is `clear` -> `unknown` on a
 * NON-match: a match is still `present`, a shortfall still escalates to `ok: false`, and the ordinary
 * first payment still posts.
 *
 * FOUR PAIRS TAKE IT, and each test below names which:
 *   1  Xero credit note   `Total - RemainingCredit`  vs  SUM(Allocations)          identity
 *   2  Xero invoice       `AmountPaid`               vs  SUM(Payments)             identity
 *   3  Xero invoice       `Total - AmountDue`        vs  SUM(Payments + applied)   composed identity
 *   4  QuickBooks         `TotalAmt - Balance`       vs  SUM(payment lines)        one-sided bound
 * ------------------------------------------------------------------------------------------- */

/** The band both directions are measured on — `completenessBand` is `ledgerAmountEpsilon`. */
const BAND_GBP = ledgerAmountEpsilon('GBP')

test('[o3d-zo4j] PAIR 1: a credit note whose allocations exceed its own RemainingCredit does not clear', async () => {
  // THE LOAD-BEARING CASE, verbatim: `Total 40 / RemainingCredit 40` with 40 already allocated.
  //
  // ROUTE: probeXeroSettlement's credit-note arm -> `applied` = 40 - 40 = 0 -> `statesAnything(0)`
  //        is FALSE so the shortfall check passes without measuring -> `allocated` = 40 ->
  //        `exceeds(40, 0)` -> `settlementAnswer(0, true, [], ...)` -> `provedComplete: false` ->
  //        `classifyLedgerSettlement` walks an empty list and reaches its terminal gate -> `unknown`.
  // MUTATION: in `settlementAnswer`, restore `provedComplete: settled !== null` (drop the
  //        `&& !collectionDoesNotBearOut`). The verdict below becomes `clear`, which is what
  //        authorises allocating a credit that is already spent — measured.
  const OVER_ALLOCATED = {
    CurrencyCode: 'GBP',
    Total: 40,
    RemainingCredit: 40,
    // The credit legitimately offsets other documents, which is why the record list is filtered and
    // why the COLLECTION's completeness is what has to be tested rather than this bill's share of it.
    Allocations: [{ Amount: 40, Date: '2026-06-01T00:00:00', Invoice: { InvoiceID: 'other-inv' } }],
  }

  // PRECONDITION 1 — the certifying figure really is a PROVED ZERO. This is why no existing check
  // could catch it: a zero settled figure makes `statesAnything` false, so the shortfall check
  // passes over the collection without comparing anything to it.
  assert.equal(OVER_ALLOCATED.Total - OVER_ALLOCATED.RemainingCredit, 0,
    'Total less RemainingCredit says NONE of this credit has been applied')
  // PRECONDITION 2 — and the collection says all of it has. The contradiction is the only evidence
  // in the response that something is wrong.
  assert.equal(OVER_ALLOCATED.Allocations.reduce((s, a) => s + a.Amount, 0), 40,
    'while the allocations show the whole 40 already used')

  const probe = await probeNote(OVER_ALLOCATED)

  // PRECONDITION 3 — it WITHHELD rather than refusing. If this were `ok: false` the test would be
  // about a refusal, which is explicitly not the shape of this rule.
  assert.equal(probe.ok, true, 'an excess withholds the proof; it does not refuse the probe')
  // PRECONDITION 4 — the record list really is empty, so nothing but `provedComplete` can stop the
  // classifier reaching `clear`.
  assert.equal(probe.ok === true ? probe.records.length : -1, 0,
    'the allocation belongs to another invoice, so this bill\'s filtered list is empty')
  assert.equal(probe.ok === true ? probe.provedComplete : null, false,
    'and the figure that would have proved that emptiness has been contradicted by the collection')

  const verdict = classifyLedgerSettlement(attemptFor('40.00'), probe)
  assert.equal(verdict.outcome, 'unknown', 'so an empty list is not proof that nothing is there')
  assert.equal(verdict.outcome === 'unknown' ? verdict.cause : null, 'collection-unproved')
})

test('[o3d-zo4j] PAIR 1: a MATCH on that same contradicted document still yields present', async () => {
  // THE HALF THAT WITHHOLDING BUYS AND REFUSING WOULD THROW AWAY. `present` is what RESOLVES the row
  // — a probe that refused on the excess would leave a row IMS can see its own allocation for stuck
  // forever, which is strictly worse than the state before this rule.
  //
  // ROUTE: identical to the test above except that the allocation names THIS bill and matches the
  //        attempt, so `classifyLedgerSettlement`'s amount-and-date pass returns `present` BEFORE
  //        the terminal `provedComplete` gate is reached.
  // MUTATION: make the credit-note arm REFUSE on the excess (`if (allocationsDoNotProve) return { ok: false,
  //        reason: ... }`) instead of routing it through `settlementAnswer`. The verdict below stops
  //        being `present`, and the row can no longer be resolved by the settlement it can see.
  const OVER_ALLOCATED_TO_US = {
    CurrencyCode: 'GBP',
    Total: 40,
    RemainingCredit: 40,
    Allocations: [{ Amount: 40, Date: `${DATE}T00:00:00`, Invoice: { InvoiceID: 'inv-1' } }],
  }
  const probe = await probeNote(OVER_ALLOCATED_TO_US)

  // PRECONDITION — it is the SAME contradiction as the test above: still a proved zero, still
  // unproved. Without this the test could be passing on an ordinary coherent document.
  assert.equal(probe.ok, true)
  assert.equal(probe.ok === true ? probe.provedComplete : null, false,
    'PRECONDITION: the collection contradicts the figure here too — only the filter differs')
  assert.equal(probe.ok === true ? probe.records.length : -1, 1,
    'PRECONDITION: and this time the allocation IS against our bill, so there is a record to match')

  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), probe).outcome, 'present',
    'a record that IS the attempt proves the attempt settled, whatever else the response contradicts')

  // THE DISCRIMINATING HALF: the identical probe asked about an attempt it does NOT hold still
  // withholds. Without this, `present` could be coming from a classifier that stopped comparing.
  assert.equal(classifyLedgerSettlement(attemptFor('12.34'), probe).outcome, 'unknown',
    'and the same contradicted document still refuses to clear an attempt it cannot find')
})

test('[o3d-zo4j] an excess WITHIN the agreement band is noise, not a contradiction', async () => {
  // THE BAND IS THE SHORTFALL'S BAND. `exceeds` is `shortBy` with its operands swapped, so both
  // directions are `completenessBand` — the document's own half-minor-unit — and neither is a bare
  // comparison against zero. Two exact decimals read off a real ledger agree to the penny; a rule
  // that treated any positive difference as a contradiction would unprove ordinary documents.
  //
  // ROUTE: the credit-note arm again -> `applied` 0, `allocated` at and then just over the band ->
  //        `exceeds` false, then true -> `provedComplete` true, then false.
  // MUTATION: in `exceeds`, compare the difference against zero instead of delegating to `shortBy`
  //        (`compareDecimal(subtractMoney(accounted, stated), toDecimal(0)) > 0`). The within-band
  //        case below flips to `unknown`, and with it every document whose figures round differently.

  // PRECONDITION — the two fixtures really do straddle the band, stated here rather than taken on
  // trust from the probe. 0.005 is exactly it; 0.006 is over.
  assert.equal(BAND_GBP.toFixed(3), '0.005', 'the GBP completeness band')
  assert.equal(BAND_GBP.cmp(toDecimal('0.005')), 0, 'the within-band fixture sits exactly ON it')
  assert.equal(BAND_GBP.cmp(toDecimal('0.006')) < 0, true, 'and the other one sits above it')

  const noteWithExcessOf = (amount: number) => probeNote({
    CurrencyCode: 'GBP',
    Total: 40,
    RemainingCredit: 40,
    Allocations: [{ Amount: amount, Date: '2026-06-01T00:00:00', Invoice: { InvoiceID: 'other-inv' } }],
  })

  const withinBand = await noteWithExcessOf(0.005)
  assert.equal(withinBand.ok, true)
  assert.equal(withinBand.ok === true ? withinBand.provedComplete : null, true,
    'an excess of exactly one band is agreement, so the figure still proves the collection')
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), withinBand).outcome, 'clear',
    'and the post still goes out')

  const beyondBand = await noteWithExcessOf(0.006)
  assert.equal(beyondBand.ok, true)
  assert.equal(beyondBand.ok === true ? beyondBand.provedComplete : null, false,
    'one thousandth over the band is a contradiction, on the same band the shortfall uses')
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), beyondBand).outcome, 'unknown')
})

test('[o3d-zo4j] a SHORTFALL still escalates to a refusal, on all three arms, unchanged', async () => {
  // THE DIRECTION THAT ALREADY WORKED MUST KEEP WORKING, AND KEEP BEING A REFUSAL. A shortfall is
  // money off the document that this probe cannot see at all, which is a different and worse fact
  // than a collection that overruns: it says `ok: false` and the row fails visibly. Downgrading it
  // to "unproved" would be a silent widening of what can still post.
  //
  // ROUTE: each arm's existing `shortBy` check -> `ok: false` before `settlementAnswer` is reached.
  // MUTATION: swap the operands of the shortfall checks (`shortBy(allocated, applied, ...)`,
  //        `shortBy(seen, amountPaid, ...)`, `shortBy(explained, applied, ...)`) so the shortfall is
  //        measured in the excess direction. All three refusals below become answers.

  // ARM 1 — a credit note reporting 40 applied and returning no allocations.
  const note = await probeNote({ CurrencyCode: 'GBP', Total: 40, RemainingCredit: 0, Allocations: [] })
  assert.equal(note.ok, false, 'the credit-note shortfall still refuses')
  assert.match(reasonOf(note), /40\.00 of this credit note already applied but returned no allocations/)

  // ARM 2 — an invoice reporting 60 paid and returning no payments.
  const invoice = await probeInvoice({
    CurrencyCode: 'GBP', Total: 100, AmountDue: 40, AmountPaid: 60, AmountCredited: 0, Payments: [],
  })
  assert.equal(invoice.ok, false, 'the invoice shortfall still refuses')
  assert.match(reasonOf(invoice), /60\.00 paid against this document but returned no payments/)

  // ARM 3 — a bill reporting 100 applied and linking nothing.
  const bill = await probeBill({ CurrencyRef: { value: 'GBP' }, TotalAmt: '100.00', Balance: '0.00' })
  assert.equal(bill.ok, false, 'the QuickBooks shortfall still refuses')
  assert.match(reasonOf(bill), /100\.00 already applied to this bill/)

  // AND A REFUSAL IS NOT A CLEAR, which is the end all three protect.
  for (const [label, probe] of [['note', note], ['invoice', invoice], ['bill', bill]] as const) {
    assert.notEqual(classifyLedgerSettlement(attemptFor('40.00'), probe).outcome, 'clear', label)
  }
})

test('[o3d-zo4j] the ordinary first payment still posts, and the ordinary part-credited invoice still clears', async () => {
  // WHAT THE RULE COSTS THE ORDINARY DOCUMENT: nothing. A real document's collection sums to exactly
  // the figure that certifies it, so the excess is zero and zero is inside the band.
  //
  // ROUTE: each arm computes an excess of exactly 0 -> `exceeds` false -> `provedComplete` stays
  //        `settled !== null` -> the classifier clears as it always did.
  // MUTATION: invert the new term in `settlementAnswer` (`settled !== null && collectionDoesNotBearOut`).
  //        Every assertion below flips to `unknown`, which is the visible cost of getting the
  //        direction backwards.

  const firstPayment = {
    // ARM 2/3 — an unsettled invoice states Total and AmountDue EQUAL.
    'Xero invoice': () => probeInvoice({
      CurrencyCode: 'GBP', Total: 40, AmountDue: 40, AmountPaid: 0, AmountCredited: 0, Payments: [],
    }),
    // ARM 1 — a wholly unapplied credit note states Total and RemainingCredit EQUAL.
    'Xero credit note': () => probeNote({ CurrencyCode: 'GBP', Total: 40, RemainingCredit: 40, Allocations: [] }),
    // ARM 4 — an unpaid bill states TotalAmt and Balance EQUAL, as strings.
    'QuickBooks bill': () => probeBill({ CurrencyRef: { value: 'GBP' }, TotalAmt: '1200.00', Balance: '1200.00' }),
  }
  for (const [label, run] of Object.entries(firstPayment)) {
    const probe = await run()
    assert.equal(probe.ok, true, `${label}: still an answer`)
    assert.equal(probe.ok === true ? probe.provedComplete : null, true,
      `${label}: PRECONDITION — emptiness proved by the document's own figures, and not contradicted`)
    assert.equal(classifyLedgerSettlement(attemptFor('40.00'), probe).outcome, 'clear',
      `${label}: the ordinary first payment still posts`)
  }

  // AND THE DOCUMENT THE `explained` SUM EXISTS FOR: a part-paid, part-credited invoice whose credit
  // IS itemised. `settled` is 40 and `explained` is 10 + 30 = 40 — equal, so no excess — which is the
  // documented promise that a credit which explains itself changes no verdict.
  const partCredited = await probeInvoice({
    CurrencyCode: 'GBP', Total: 100, AmountDue: 60, AmountPaid: 10, AmountCredited: 30,
    Payments: [{ PaymentID: 'PAY-1', Date: '2026-06-01T00:00:00', Amount: 10 }],
    CreditNotes: [{ AppliedAmount: 30 }],
  })
  assert.equal(partCredited.ok, true)
  assert.equal(partCredited.ok === true ? partCredited.records.length : -1, 1,
    'PRECONDITION: a real, non-matching settlement is on the document')
  assert.equal(partCredited.ok === true ? partCredited.provedComplete : null, true,
    'PRECONDITION: and the itemised credit accounts for the rest exactly, so nothing overruns')
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), partCredited).outcome, 'clear',
    'a further instalment against a part-credited invoice is still sendable')
})

test('[o3d-zo4j] PAIR 2: the payment total is measured separately, or an excess hides inside a matching sum', async () => {
  // WHY PAIR 2 IS NOT LEFT TO PAIR 3. They straddle: `AmountPaid` vs `SUM(Payments)` is one identity,
  // and `Total - AmountDue` vs `SUM(Payments) + SUM(applied)` is another that CONTAINS it. A response
  // can satisfy the wider one exactly while the narrower one overruns, because the credit half
  // absorbs the difference.
  //
  // ROUTE: the invoice arm -> `amountPaid` 10, `seen` 30 -> `shortBy(10, 30)` false ->
  //        `exceeds(30, 10)` TRUE -> and separately `settled` 30, `explained` 30, so pair 3 agrees
  //        exactly -> `settlementAnswer(30, true, records, ...)` -> `provedComplete: false`.
  // MUTATION: pass only `settlementsDoNotProve` to `settlementAnswer` (drop `paymentsExceedTotal ||`).
  //        The verdict below becomes `clear` — pair 3 alone cannot see this.
  const STRADDLED = {
    CurrencyCode: 'GBP', Total: 100, AmountDue: 70, AmountPaid: 10, AmountCredited: 20,
    Payments: [
      { PaymentID: 'PAY-1', Date: '2026-06-01T00:00:00', Amount: 20 },
      { PaymentID: 'PAY-2', Date: '2026-06-02T00:00:00', Amount: 10 },
    ],
  }

  // PRECONDITION 1 — the two derivations of the SETTLED figure agree, so the r31 contradiction check
  // does not fire and this test really is about the payment pair.
  assert.equal(STRADDLED.Total - STRADDLED.AmountDue, 30, 'Total less AmountDue')
  assert.equal(STRADDLED.AmountPaid + STRADDLED.AmountCredited, 30, '...and the component pair agree')
  // PRECONDITION 2 — pair 3 agrees EXACTLY: `explained` is the payments plus an absent credit
  // collection, which sums to zero, so 30 against 30. Nothing overruns at that pair.
  assert.equal(STRADDLED.Payments.reduce((s, p) => s + p.Amount, 0), 30,
    'the payments alone already account for the whole settled figure')
  // PRECONDITION 3 — and pair 2 overruns by 20, which is the only thing wrong with this response.
  assert.equal(STRADDLED.Payments.reduce((s, p) => s + p.Amount, 0) - STRADDLED.AmountPaid, 20,
    'while AmountPaid says only 10 of it was paid')

  const probe = await probeInvoice(STRADDLED)
  assert.equal(probe.ok, true, 'it withholds rather than refusing, as everywhere else')
  assert.equal(probe.ok === true ? probe.records.length : -1, 2, 'both payments came back')
  assert.equal(probe.ok === true ? probe.provedComplete : null, false,
    'and the payment collection has contradicted the total that summarises it')
  const verdict = classifyLedgerSettlement(attemptFor('40.00'), probe)
  assert.equal(verdict.outcome, 'unknown')
  assert.equal(verdict.outcome === 'unknown' ? verdict.cause : null, 'collection-unproved')
})

test('[o3d-zo4j] PAIR 4: a QuickBooks document reporting nothing settled while linking a payment of 20', async () => {
  // CODEX'S QUICKBOOKS SHAPE. `TotalAmt 100 / Balance 100` is the proved zero — `statesAnything`
  // false, shortfall check passing over nothing — and a linked BillPayment applied 20 to the very
  // same bill. On this arm the honest relation is `explained <= applied` (the document's own figure
  // also counts vendor credits and journals this probe cannot read), so an excess is a contradiction
  // outright rather than merely a mismatch.
  //
  // ROUTE: probeQuickBooksSettlement -> `applied` = 100 - 100 = 0 -> `explained` = 20 ->
  //        `exceeds(20, 0)` -> `provedComplete: false` -> the record does not match the attempt ->
  //        the classifier's terminal gate -> `unknown`.
  // MUTATION: in `settlementAnswer`, restore `provedComplete: settled !== null`. The verdict below
  //        becomes `clear`, and a second payment goes out against a bill whose figures are incoherent.
  const probe = await probeQuickBooksSettlement(
    { type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'bill-1' } },
    ledgerDouble({
      'bill/bill-1': {
        Bill: {
          CurrencyRef: { value: 'GBP' },
          TotalAmt: '100.00',
          Balance: '100.00',
          LinkedTxn: [{ TxnId: '77', TxnType: 'BillPaymentCheck' }],
        },
      },
      'billpayment/77': {
        BillPayment: { TxnDate: '2026-06-01', Line: [{ Amount: 20, LinkedTxn: [{ TxnId: 'bill-1', TxnType: 'Bill' }] }] },
      },
    }).get,
  )

  // PRECONDITION 1 — the certifying figure is a proved zero, which is why nothing else catches this.
  // Asserted through the probe's own reading: a settled figure above the band would have made the
  // shortfall check the thing under test instead.
  assert.equal(probe.ok, true, 'PRECONDITION: it answered — this is not the shortfall refusal')
  // PRECONDITION 2 — the payment really was read, and really is not the attempt.
  assert.equal(probe.ok === true ? probe.records.length : -1, 1, 'PRECONDITION: one payment came back')
  assert.equal(probe.ok === true ? probe.records[0]?.amount?.toFixed(2) : null, '20.00',
    'PRECONDITION: applying 20 to a bill the document says nothing has come off')
  assert.equal(probe.ok === true ? probe.records[0]?.date : null, '2026-06-01',
    'PRECONDITION: on a different day from the attempt, so no match is available')

  assert.equal(probe.ok === true ? probe.provedComplete : null, false,
    'the linked payments account for more than the bill says has come off it')
  const verdict = classifyLedgerSettlement(attemptFor('40.00'), probe)
  assert.equal(verdict.outcome, 'unknown', '"not among these" is not "not in the ledger"')
  assert.equal(verdict.outcome === 'unknown' ? verdict.cause : null, 'collection-unproved')
})

test('[o3d-zo4j] PAIR 3: an itemised credit that exceeds what the invoice says has come off it', async () => {
  // THE COMPOSED IDENTITY. `Total - AmountDue` is `AmountPaid + AmountCredited` by Xero's own
  // definition, and `AmountCredited` is what the applied credit-note / prepayment / overpayment
  // collections total — so `settled` and `explained` are one quantity through two identities. This
  // response states a settled figure of ZERO and simultaneously itemises 30 of credit applied.
  //
  // AND IT IS THE SHAPE THAT BREAKS THE OLD POST-GATE INVARIANT: unproved with an EMPTY record list.
  //
  // ROUTE: the invoice arm -> `settledFromTotals` 0 and `settledFromComponents` 0 AGREE, so the r31
  //        contradiction check does not fire -> `amountPaid` 0 and `seen` 0, so pair 2 does not fire
  //        -> `explained` = 0 payments + 30 applied -> `exceeds(30, 0)` -> `provedComplete: false`.
  // MUTATION: pass only `paymentsExceedTotal` to `settlementAnswer` (drop `|| settlementsDoNotProve`).
  //        The verdict below becomes `clear` — pair 2 alone cannot see this.
  const CREDIT_BEYOND_THE_FIGURE = {
    CurrencyCode: 'GBP', Total: 100, AmountDue: 100, AmountPaid: 0, AmountCredited: 0,
    Payments: [],
    CreditNotes: [{ AppliedAmount: 30 }],
  }

  // PRECONDITION 1 — the two derivations of the settled figure AGREE (both zero), so this is not the
  // r31 contradiction being retested under a new name.
  assert.equal(CREDIT_BEYOND_THE_FIGURE.Total - CREDIT_BEYOND_THE_FIGURE.AmountDue, 0)
  assert.equal(CREDIT_BEYOND_THE_FIGURE.AmountPaid + CREDIT_BEYOND_THE_FIGURE.AmountCredited, 0)
  // PRECONDITION 2 — and pair 2 agrees too: no payments, and AmountPaid says none.
  assert.equal(CREDIT_BEYOND_THE_FIGURE.Payments.length, 0)
  assert.equal(CREDIT_BEYOND_THE_FIGURE.AmountPaid, 0)
  // PRECONDITION 3 — the only disagreement is the itemised credit, which is pair 3's operand.
  assert.equal(CREDIT_BEYOND_THE_FIGURE.CreditNotes.reduce((s, c) => s + c.AppliedAmount, 0), 30)

  const probe = await probeInvoice(CREDIT_BEYOND_THE_FIGURE)
  assert.equal(probe.ok, true, 'it withholds rather than refusing')
  assert.equal(probe.ok === true ? probe.records.length : -1, 0,
    'PRECONDITION: and the record list is EMPTY, which is the shape the post gate must also handle')
  assert.equal(probe.ok === true ? probe.provedComplete : null, false)
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), probe).outcome, 'unknown')
})

/* ------------------------------------------------------------------------------------------- *
 * 8. o3d-zo4j, THE CLOSING AUDIT — A COMPARISON THAT DID NOT HAPPEN IS NOT A COMPARISON THAT
 *    AGREED.
 *
 * With the shortfall, the excess and the r31 contradiction all handled, one route to a wrong
 * `provedComplete: true` was left: the ACCOUNTED side of a pair being unmeasurable. Both directions
 * then decide nothing — the shortfall check because it is gated on `statesAnything`, which is false
 * for the proved zero, and the excess check because it has no operand — and the figure is believed
 * against a collection nothing measured.
 *
 * IT ONLY BITES WHERE THE UNMEASURABLE TERM LEAVES NO RECORD BEHIND. A payment IMS cannot read is
 * itself a record with a null amount, and `classifyLedgerSettlement` withholds on that record before
 * the completeness gate is reached — so the invoice's payment pair and the whole QuickBooks arm are
 * already covered, and a null arm on either would be a guard no input can reach. An ALLOCATION to
 * another invoice and an APPLIED CREDIT NOTE are not records here, and those two are the holes.
 * ------------------------------------------------------------------------------------------- */

test('[o3d-zo4j] an UNREADABLE allocation under a proved zero does not certify the credit note', async () => {
  // ROUTE: the credit-note arm -> `applied` = 40 - 40 = 0 -> `statesAnything(0)` false, so the
  //        shortfall check does not run -> the allocation states no `Amount`, so `allocated` is null
  //        and the excess cannot be computed either -> `allocationsDoNotProve` -> `provedComplete:
  //        false` -> the classifier's terminal gate -> `unknown`.
  // MUTATION: restore `allocated !== null &&` in place of `allocated === null ||`. The verdict below
  //        becomes `clear` over an empty list — measured before this was closed.
  const UNREADABLE_ALLOCATION = {
    CurrencyCode: 'GBP',
    Total: 40,
    RemainingCredit: 40,
    // No `Amount` at all, and against ANOTHER invoice — so it contributes nothing to the sum AND
    // leaves no record for the classifier to withhold on.
    Allocations: [{ Date: '2026-06-01T00:00:00', Invoice: { InvoiceID: 'other-inv' } }],
  }

  // PRECONDITION 1 — the certifying figure is a proved zero, so the shortfall check is skipped.
  assert.equal(UNREADABLE_ALLOCATION.Total - UNREADABLE_ALLOCATION.RemainingCredit, 0)
  // PRECONDITION 2 — there IS an allocation, so this is not the ordinary unapplied credit note. The
  // collection is non-empty and unmeasurable, which is the whole difference.
  assert.equal(UNREADABLE_ALLOCATION.Allocations.length, 1)
  assert.equal('Amount' in UNREADABLE_ALLOCATION.Allocations[0]!, false, 'and it states no amount')

  const probe = await probeNote(UNREADABLE_ALLOCATION)
  assert.equal(probe.ok, true, 'PRECONDITION: it answers — this is not a refusal path')
  assert.equal(probe.ok === true ? probe.records.length : -1, 0,
    'PRECONDITION: and leaves NO record, so nothing but provedComplete can stop a clear')
  assert.equal(probe.ok === true ? probe.provedComplete : null, false,
    'a collection that could not be measured has not borne out the figure certifying it')
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), probe).outcome, 'unknown')

  // THE DISCRIMINATING HALF: the SAME note with the amount readable and inside the band still
  // clears. Nothing about a legible collection moved.
  const readable = await probeNote({
    ...UNREADABLE_ALLOCATION,
    Allocations: [{ Amount: 0, Date: '2026-06-01T00:00:00', Invoice: { InvoiceID: 'other-inv' } }],
  })
  assert.equal(readable.ok === true ? readable.provedComplete : null, true)
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), readable).outcome, 'clear')
})

test('[o3d-zo4j] an UNREADABLE applied credit under a proved zero does not certify the invoice', async () => {
  // ROUTE: the invoice arm -> `settled` = 100 - 100 = 0 -> `statesAnything(0)` false, so the
  //        shortfall check does not run -> `sumApplied(CreditNotes)` is null because the entry states
  //        no `AppliedAmount`, so `explained` is null -> `settlementsDoNotProve` -> `provedComplete:
  //        false`.
  // MUTATION: restore `explained !== null &&` in place of `explained === null ||`. The verdict below
  //        becomes `clear` over an empty list — measured before this was closed.
  const UNREADABLE_CREDIT = {
    CurrencyCode: 'GBP', Total: 100, AmountDue: 100, AmountPaid: 0, AmountCredited: 0,
    Payments: [],
    // An applied credit note is never a RECORD on this arm, so an unreadable one is invisible to the
    // classifier — which is exactly why this needed closing and the payment pair did not.
    CreditNotes: [{}],
  }

  // PRECONDITION 1 — both derivations of the settled figure agree at zero, so neither the r31
  // contradiction check nor the shortfall check is what is being tested.
  assert.equal(UNREADABLE_CREDIT.Total - UNREADABLE_CREDIT.AmountDue, 0)
  assert.equal(UNREADABLE_CREDIT.AmountPaid + UNREADABLE_CREDIT.AmountCredited, 0)
  // PRECONDITION 2 — the credit collection is non-empty and states no readable amount.
  assert.equal(UNREADABLE_CREDIT.CreditNotes.length, 1)
  assert.equal('AppliedAmount' in UNREADABLE_CREDIT.CreditNotes[0]!, false)

  const probe = await probeInvoice(UNREADABLE_CREDIT)
  assert.equal(probe.ok, true, 'PRECONDITION: it answers')
  assert.equal(probe.ok === true ? probe.records.length : -1, 0, 'PRECONDITION: over an EMPTY list')
  assert.equal(probe.ok === true ? probe.provedComplete : null, false)
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), probe).outcome, 'unknown')

  // THE DISCRIMINATING HALF: an ABSENT `CreditNotes` collection is not an unmeasurable one — it sums
  // to zero, which is the documented reading that keeps every ordinary invoice clearing.
  const noCollection = await probeInvoice({
    CurrencyCode: 'GBP', Total: 100, AmountDue: 100, AmountPaid: 0, AmountCredited: 0, Payments: [],
  })
  assert.equal(noCollection.ok === true ? noCollection.provedComplete : null, true,
    'an absent collection explains nothing and says so; it does not make the figure unmeasurable')
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), noCollection).outcome, 'clear')
})

test('[o3d-zo4j] the arms whose unmeasurable term IS a record are left alone, because a guard there could not fire', async () => {
  // THE OTHER HALF OF THE AUDIT, AND IT IS r31's LESSON APPLIED TO THIS ROUND'S OWN FIX. The two
  // pairs above got a null arm; the invoice's payment pair and the QuickBooks arm did NOT. The
  // difference is not taste: an unreadable PAYMENT is itself a record with a null amount, and the
  // classifier answers `record-unmeasurable` on it before the completeness gate is reached. A
  // `|| seen === null` there would be unfalsifiable — protection that reads as protection and cannot
  // be shown working.
  //
  // ROUTE: each shape below -> a record with `amount: null` -> `classifyLedgerSettlement` returns
  //        `unknown` / `record-unmeasurable` from the record loop.
  // MUTATION: this test is the PREMISE for an omission, so its mutation is on the classifier: delete
  //        the `record.amount === null` refusal in `classifyLedgerSettlement`. Every case below then
  //        reaches the completeness gate, and the omission stops being safe — which is the condition
  //        under which the null arm would have to be added to these arms too.
  const unmeasurableRecord = {
    'Xero invoice, absent payment amount': () => probeInvoice({
      CurrencyCode: 'GBP', Total: 100, AmountDue: 100, AmountPaid: 0, AmountCredited: 0,
      Payments: [{ PaymentID: 'P1', Date: '2026-06-01T00:00:00' }],
    }),
    'Xero invoice, blank payment amount': () => probeInvoice({
      CurrencyCode: 'GBP', Total: 100, AmountDue: 100, AmountPaid: 0, AmountCredited: 0,
      Payments: [{ PaymentID: 'P1', Date: '2026-06-01T00:00:00', Amount: '' }],
    }),
    'QuickBooks, a payment whose lines name another bill': () => probeQuickBooksSettlement(
      { type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'bill-1' } },
      ledgerDouble({
        'bill/bill-1': {
          Bill: {
            CurrencyRef: { value: 'GBP' }, TotalAmt: '100.00', Balance: '100.00',
            LinkedTxn: [{ TxnId: '77', TxnType: 'BillPaymentCheck' }],
          },
        },
        'billpayment/77': {
          BillPayment: { TxnDate: '2026-06-01', Line: [{ Amount: 20, LinkedTxn: [{ TxnId: 'other', TxnType: 'Bill' }] }] },
        },
      }).get,
    ),
  }
  for (const [label, run] of Object.entries(unmeasurableRecord)) {
    const probe = await run()
    // PRECONDITION — the unmeasurable term really did leave a record, which is the entire reason
    // these arms need no completeness arm of their own.
    assert.equal(probe.ok, true, `${label}: it answers`)
    assert.equal(probe.ok === true ? probe.records.length : -1, 1, `${label}: and carries one record`)
    assert.equal(probe.ok === true ? probe.records[0]?.amount : undefined, null,
      `${label}: whose amount is exactly what could not be measured`)

    const verdict = classifyLedgerSettlement(attemptFor('40.00'), probe)
    assert.equal(verdict.outcome, 'unknown', `${label}: so the classifier withholds on the record`)
    assert.equal(verdict.outcome === 'unknown' ? verdict.cause : null, 'record-unmeasurable',
      `${label}: BEFORE the completeness gate is reached — which is why no gate is needed here`)
  }
})


/* ------------------------------------------------------------------------------------------- *
 * o3d-jfhi — THE CREDIT-NOTE IDENTITY HAD TWO MISSING TERMS, NOT ONE, AND BOTH WERE IN THE
 * PUBLISHED CONTRACT ALL ALONG.
 *
 * THE DEFECT. The credit-note arm computed `applied = Total - RemainingCredit` and measured it
 * against `Allocations` alone. That asserts ALLOCATION IS THE ONLY THING THAT REDUCES A CREDIT NOTE.
 * The `CreditNote` schema says otherwise twice — `CISDeduction` ("CIS deduction for UK contractors")
 * and `Payments` (Xero records a refund of a credit note through the payments endpoint;
 * `Payment.PaymentType` enumerates `ARCREDITPAYMENT`/`APCREDITPAYMENT` for exactly that). So every
 * CIS credit note and every refunded credit note was REFUSED — the invoice arm's harm, on the arm
 * the previous round left, and on the FIRST allocation.
 *
 * The previous round declined to fix it, reasoning that it could not know whether a credit note
 * carries a deduction without a live CIS tenant. It could: a vendor's published schema is
 * documentation, not an API call. That is the finding underneath the finding, and it is why these
 * tests exist rather than a bd note.
 *
 * THE IDENTITY, and every test below turns on it:
 *
 *   RemainingCredit = Total - CISDeduction - SUM(Allocations.Amount) - SUM(Payments.Amount)
 *   allocationUsage = Total - RemainingCredit - CISDeduction - SUM(Payments.Amount)
 *
 * Every test states the PRECONDITION it turns on, so none can pass by the property under test
 * quietly ceasing to hold, and every one names the mutation that was measured to make it fail.
 * ------------------------------------------------------------------------------------------- */

/** Codex's CIS credit note: a supplier credit with 80 withheld under the scheme, nothing allocated. */
const CIS_NOTE = {
  CurrencyCode: 'GBP', Total: 400, CISDeduction: 80, RemainingCredit: 320, Allocations: [],
} as const

/** Codex's refunded credit note: 100 of the 400 taken in cash, 300 still allocatable. */
const REFUNDED_NOTE = {
  CurrencyCode: 'GBP',
  Total: 400,
  RemainingCredit: 300,
  Allocations: [],
  Payments: [{ PaymentID: 'PAY-R1', Amount: 100 }],
} as const

test('[o3d-jfhi] a CIS credit note classifies normally, and the first allocation still posts', async () => {
  // ROUTE: probeXeroSettlement's credit-note arm -> wireAmount(note.CISDeduction) ->
  //        completenessCannotRun (passes, it is readable) -> `applied` = Total - RemainingCredit -
  //        CISDeduction - SUM(Payments) = 0 -> statesAnything(0) false -> allocated = 0 ->
  //        exceeds(0, 0) false -> settlementAnswer(0, false, []) -> provedComplete:true ->
  //        classifyLedgerSettlement's terminal gate -> `clear`.
  // MUTATION: drop `noteCisDeduction` from the `applied` chain — i.e. restore
  //        `subtractMoney(creditTotal.value, remaining.value)`, which is what stood before this
  //        commit. Measured: ok:false, "Xero reports 80.00 of this credit note already applied but
  //        returned no allocations" — Codex's second shape, exactly.

  // PRECONDITION 1 — the TWO-term reading really does accuse this note, so there is something to
  // fail. If Xero ever stopped reducing RemainingCredit by the deduction this would be 0 and the
  // test would be examining nothing.
  assert.equal(CIS_NOTE.Total - CIS_NOTE.RemainingCredit, 80,
    'PRECONDITION: Total less RemainingCredit alone says 80 of the credit has been used...')
  assert.equal(CIS_NOTE.Allocations.length, 0,
    '...while the collection it would be measured against is empty, which is the refusal')
  // PRECONDITION 2 — and the FOUR-term identity is the one that holds on this document.
  assert.equal(CIS_NOTE.Total - CIS_NOTE.RemainingCredit - CIS_NOTE.CISDeduction, 0,
    'PRECONDITION: with the deduction taken off, nothing has been allocated and the note is coherent')

  const probe = await probeNote(CIS_NOTE)
  assert.equal(probe.ok, true, 'a correct UK construction credit note is not an incoherent response')
  assert.equal(probe.ok === true ? probe.records.length : -1, 0,
    'none of it has been allocated to this bill, and the ledger says so in its own numbers')
  assert.equal(probe.ok === true ? probe.provedComplete : null, true,
    'the emptiness is PROVED by the four-term identity, not assumed from a missing figure')

  // THE END THIS PROTECTS: `clear` is what authorises the allocation, and this is the FIRST one.
  assert.equal(classifyLedgerSettlement(attemptFor('320.00'), probe).outcome, 'clear',
    'the first allocation of a CIS supplier credit must post, not queue for a human')

  // AND THE SAME NOTE STATED AS TEXT reads identically — one decoder for every money figure here.
  const asText = await probeNote({ ...CIS_NOTE, CISDeduction: '80.00' })
  assert.equal(classifyLedgerSettlement(attemptFor('320.00'), asText).outcome, 'clear')
})

test('[o3d-jfhi] a partially REFUNDED credit note classifies normally, and the rest stays allocatable', async () => {
  // ROUTE: as above, through `refundReadings` -> `refunded` = 100 -> `applied` = 400 - 300 - 0 -
  //        100 = 0 -> the same proved-zero path -> `clear`.
  // MUTATION: drop `refunded` from the `applied` chain. Measured: ok:false, "Xero reports 100.00 of
  //        this credit note already applied but returned no allocations" — Codex's first shape,
  //        verbatim, over a note with 300 legitimately left to allocate.

  // PRECONDITION 1 — the refund is the ONLY thing that could explain the difference; there is no
  // allocation in the response to be measured instead.
  assert.equal(REFUNDED_NOTE.Total - REFUNDED_NOTE.RemainingCredit, 100,
    'PRECONDITION: Total less RemainingCredit says 100 has come off...')
  assert.equal(REFUNDED_NOTE.Allocations.length, 0, '...and the allocation collection is empty')
  assert.equal(REFUNDED_NOTE.Payments.reduce((sum, pay) => sum + pay.Amount, 0), 100,
    'while the payments collection accounts for every penny of it')

  const probe = await probeNote(REFUNDED_NOTE)
  assert.equal(probe.ok, true, 'a refunded credit note is not an incoherent response')
  assert.equal(probe.ok === true ? probe.provedComplete : null, true)
  assert.equal(classifyLedgerSettlement(attemptFor('300.00'), probe).outcome, 'clear',
    'the 300 that remains is allocatable, and this is the first allocation of it')

  // AND A NOTE THAT IS BOTH REFUNDED AND PART-ALLOCATED ELSEWHERE, because the two terms must add
  // rather than one masking the other: 400 face, 100 refunded, 100 allocated to another document.
  const MIXED = {
    CurrencyCode: 'GBP',
    Total: 400,
    RemainingCredit: 200,
    Allocations: [{ Amount: 100, Date: '2026-06-01T00:00:00', Invoice: { InvoiceID: 'other-inv' } }],
    Payments: [{ PaymentID: 'PAY-R1', Amount: 100 }],
  }
  // PRECONDITION 2 — the usage figure and the allocation collection agree ONLY once the refund is
  // taken off. Without it the figure is 200 against a collection of 100, which is a shortfall.
  assert.equal(MIXED.Total - MIXED.RemainingCredit, 200, 'PRECONDITION: the two-term figure is 200...')
  assert.equal(MIXED.Allocations[0]!.Amount, 100, '...against allocations of only 100')

  const mixed = await probeNote(MIXED)
  assert.equal(mixed.ok, true, 'once the refund is a term, the figure and the collection agree at 100')
  assert.equal(mixed.ok === true ? mixed.provedComplete : null, true,
    'so the collection is proved complete rather than contradicted')
  assert.equal(classifyLedgerSettlement(attemptFor('200.00'), mixed).outcome, 'clear')
})

test('[o3d-jfhi] an ORDINARY credit note is unaffected, in all three of its shapes', async () => {
  // ROUTE: the same arm with both new terms ABSENT -> `noteCisRead.value` null -> `?? toDecimal(0)`;
  //        `note.Payments` undefined -> `sumExact([])` = 0. The identity collapses to what it was.
  // MUTATION: turn either absence into a refusal — e.g. make `noteCisDeduction` require
  //        `noteCisRead.value !== null`, or make an absent `Payments` collection sum to null.
  //        Measured: the wholly-unapplied note below stops clearing, which is every ordinary first
  //        allocation in the system.

  // 1. WHOLLY UNAPPLIED. The proved-zero shape the whole rule is built to let through.
  const UNAPPLIED = { CurrencyCode: 'GBP', Total: 40, RemainingCredit: 40, Allocations: [] }
  // PRECONDITION — neither new field is stated, so this test is genuinely about the ABSENT path.
  assert.equal('CISDeduction' in UNAPPLIED, false, 'PRECONDITION: no deduction is stated')
  assert.equal('Payments' in UNAPPLIED, false, 'PRECONDITION: and no payments collection is sent')
  const unapplied = await probeNote(UNAPPLIED)
  assert.equal(unapplied.ok === true ? unapplied.provedComplete : null, true)
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), unapplied).outcome, 'clear',
    'an ordinary unapplied credit note still clears, exactly as before this commit')

  // 2. FULLY ALLOCATED TO THIS BILL. The record is found and the row resolves.
  const ALLOCATED = {
    CurrencyCode: 'GBP',
    Total: 40,
    RemainingCredit: 0,
    Allocations: [{ Amount: 40, Date: `${DATE}T00:00:00`, Invoice: { InvoiceID: 'inv-1' } }],
  }
  const allocated = await probeNote(ALLOCATED)
  assert.equal(allocated.ok === true ? allocated.records.length : -1, 1,
    'PRECONDITION: the allocation names THIS bill, so it survives the filter')
  assert.equal(classifyLedgerSettlement(attemptFor('40.00'), allocated).outcome, 'present',
    'an allocation IMS can see is still recognised as its own attempt')

  // 3. A GENUINE SHORTFALL STILL REFUSES. Widening the identity must not widen what it lets through:
  // 30 has been used by something and the response itemises none of it.
  const SHORT = { CurrencyCode: 'GBP', Total: 40, RemainingCredit: 10, Allocations: [] }
  assert.equal(SHORT.Total - SHORT.RemainingCredit, 30,
    'PRECONDITION: 30 of the credit is gone and no term of the identity explains it')
  const short = await probeNote(SHORT)
  assert.equal(short.ok, false, 'an unexplained shortfall is still a refusal, deduction and refunds and all')
  assert.match(reasonOf(short), /30\.00 of this credit note already applied but returned no allocations/)
})

test('[o3d-jfhi] an UNREADABLE new term refuses rather than passing, and names which one', async () => {
  // ROUTE (deduction): wireAmount -> `unreadable` -> completenessCannotRun -> ok:false, before any
  //        arithmetic runs.
  // ROUTE (refund):    wireAmount per payment -> `sumExact` null -> the explicit refusal, which
  //        exists because a refund is never a RECORD of this bill and so leaves nothing behind to
  //        make the classifier withhold on its own account (o3d-zo4j's lesson, applied forward).
  // MUTATION 1: remove `['CISDeduction', noteCisRead]` from the completenessCannotRun list. The
  //        reading falls through `?? toDecimal(0)`, the note below is coherent at zero, and the
  //        probe answers ok:true with provedComplete — `clear`. Measured.
  // MUTATION 2: replace the `refunded === null` refusal with `refunded ?? toDecimal(0)`. An
  //        unreadable refund is then treated as no refund, the figure and the empty collection
  //        agree at zero, and the probe clears. Measured.

  // The base shape is chosen so that reading the new term as ZERO is SILENT — the remaining figures
  // are coherent — which is what makes each mutation a false clear rather than a differently-worded
  // refusal.
  const COHERENT_IF_ZERO = { CurrencyCode: 'GBP', Total: 400, RemainingCredit: 400, Allocations: [] }
  const control = await probeNote(COHERENT_IF_ZERO)
  assert.equal(control.ok, true,
    'PRECONDITION: with neither new field stated this note is accepted, so nothing else does the refusing')
  assert.equal(classifyLedgerSettlement(attemptFor('400.00'), control).outcome, 'clear',
    'PRECONDITION: and it reaches clear, which is what the refusals below have to take away')

  for (const [stated, named] of [['eighty', 'eighty'], ['', '\\(blank\\)'], [{ Amount: 80 }, 'object']] as const) {
    const probe = await probeNote({ ...COHERENT_IF_ZERO, CISDeduction: stated })
    assert.equal(probe.ok, false, `a CISDeduction of ${JSON.stringify(stated)} is not a figure IMS may ignore`)
    assert.match(reasonOf(probe), new RegExp(`CISDeduction ${named}`),
      'and the refusal NAMES it, so an operator is told which figure could not be read')
    assert.match(reasonOf(probe), /cannot read as an amount/)
    assert.notEqual(classifyLedgerSettlement(attemptFor('400.00'), probe).outcome, 'clear')
  }

  // A REFUND WHOSE AMOUNT CANNOT BE READ.
  const badRefund = await probeNote({
    ...COHERENT_IF_ZERO, Payments: [{ PaymentID: 'PAY-R1', Amount: 'a hundred' }],
  })
  assert.equal(badRefund.ok, false, 'a stated refund IMS cannot measure is not the same as no refund')
  assert.match(reasonOf(badRefund), /a hundred on a payment against this credit note/)
  assert.notEqual(classifyLedgerSettlement(attemptFor('400.00'), badRefund).outcome, 'clear')

  // A REFUND ENTRY WITH NO AMOUNT AT ALL. Not the same as an ABSENT COLLECTION: the ledger has said
  // a payment exists, so "there are none" is not available as a reading of it.
  const amountlessRefund = await probeNote({ ...COHERENT_IF_ZERO, Payments: [{ PaymentID: 'PAY-R1' }] })
  assert.equal(amountlessRefund.ok, false,
    'a payment the ledger listed without an amount is a refund IMS cannot account for')
  assert.match(reasonOf(amountlessRefund), /payment against this credit note with no amount/)
  assert.notEqual(classifyLedgerSettlement(attemptFor('400.00'), amountlessRefund).outcome, 'clear')

  // AND THE MAGNITUDE RULE IS INHERITED BY BOTH NEW TERMS, like every other figure in this file: a
  // JSON number too large to hold half a minor unit is one whose token `Response.json()` has already
  // destroyed, and it is refused rather than read.
  const overBoundCis = await probeNote({
    ...COHERENT_IF_ZERO, CISDeduction: ledgerDifferenceMagnitudeBound('GBP'),
  })
  assert.equal(overBoundCis.ok, false, 'a deduction at the difference bound cannot be subtracted to half a penny')
  const overBoundRefund = await probeNote({
    ...COHERENT_IF_ZERO, Payments: [{ PaymentID: 'PAY-R1', Amount: ledgerDifferenceMagnitudeBound('GBP') }],
  })
  assert.equal(overBoundRefund.ok, false, 'and neither can a refund at it')
})

test('[o3d-jfhi] the contradiction checks still catch a genuine contradiction, both new terms and all', async () => {
  // TWO CONTRADICTIONS, and the second is what makes the two new terms safe to subtract on a reading
  // of the contract rather than on a live tenant.
  //
  // ROUTE (A): o3d-zo4j PAIR 1, unchanged — `applied` is a proved ZERO while the allocation
  //        collection shows the whole credit used -> `exceeds` -> provedComplete:false -> `unknown`.
  // ROUTE (B): `applied` comes out BELOW zero, which under the identity is impossible because it
  //        counts money allocated -> the explicit refusal beside the arithmetic.
  // MUTATION A: in `settlementAnswer`, restore `provedComplete: settled !== null`. Verdict A becomes
  //        `clear`, which authorises allocating a credit that is already spent. Measured.
  // MUTATION B: delete the `shortBy(toDecimal(0), applied, …)` guard. The probe then answers
  //        ok:true over an empty record list with `applied` of -100; `statesAnything(-100)` is
  //        false so no shortfall check runs, and only `exceeds(0, -100)` is left holding it —
  //        measured as `unknown`, i.e. still not a clear, but with no sentence naming the
  //        incoherence. The guard is what turns a silent hold into an answerable one.

  // A. THE GENUINE CONTRADICTION, on a document that now passes through both new terms as zeros.
  const OVER_ALLOCATED = {
    CurrencyCode: 'GBP',
    Total: 40,
    RemainingCredit: 40,
    Allocations: [{ Amount: 40, Date: '2026-06-01T00:00:00', Invoice: { InvoiceID: 'other-inv' } }],
  }
  assert.equal(OVER_ALLOCATED.Total - OVER_ALLOCATED.RemainingCredit, 0,
    'PRECONDITION: the note says NONE of the credit has been applied...')
  assert.equal(OVER_ALLOCATED.Allocations[0]!.Amount, 40, '...and its own collection says all of it has')
  const contradicted = await probeNote(OVER_ALLOCATED)
  assert.equal(contradicted.ok, true, 'an excess withholds the proof; it does not refuse the probe')
  assert.equal(contradicted.ok === true ? contradicted.provedComplete : null, false,
    'widening the identity did not widen the hole o3d-zo4j closed')
  const verdictA = classifyLedgerSettlement(attemptFor('40.00'), contradicted)
  assert.equal(verdictA.outcome, 'unknown')
  assert.equal(verdictA.outcome === 'unknown' ? verdictA.cause : null, 'collection-unproved')

  // B. THE IDENTITY REFUTED BY ITS OWN RESULT. This is the shape that would exist if Xero did NOT
  // net a refund out of `RemainingCredit` — i.e. the world in which subtracting it is wrong. The
  // subtraction is safe to make WITHOUT a live tenant precisely because that world is visible from
  // the response alone, and it refuses rather than forging a zero.
  const IMPOSSIBLE = {
    CurrencyCode: 'GBP',
    Total: 400,
    RemainingCredit: 400,
    Allocations: [],
    Payments: [{ PaymentID: 'PAY-R1', Amount: 100 }],
  }
  assert.equal(IMPOSSIBLE.Total - IMPOSSIBLE.RemainingCredit - IMPOSSIBLE.Payments[0]!.Amount, -100,
    'PRECONDITION: the identity yields a NEGATIVE allocation usage, which cannot be a count of money')
  const impossible = await probeNote(IMPOSSIBLE)
  assert.equal(impossible.ok, false, 'a response that refutes the identity is not one to certify a collection from')
  assert.match(reasonOf(impossible), /remaining credit is larger than its own total less what has been taken off it/)
  assert.match(reasonOf(impossible), /100\.00 refunded/,
    'and the sentence names the term that made it impossible, so an operator can act on it')
  assert.notEqual(classifyLedgerSettlement(attemptFor('400.00'), impossible).outcome, 'clear')
})
