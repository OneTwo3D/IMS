/**
 * o3d-0m56 — read what a connector's ledger ALREADY holds against a document, so a money-moving
 * row that has been attempted once is never re-posted on the strength of remote deduplication
 * alone (see ledger-settlement-evidence.ts for why that strength is imaginary).
 *
 * READ-ONLY by construction: every call here is a GET. It is used at two decision points — the
 * operator's manual retry, and the automatic re-enqueue of a FAILED money row — and both treat
 * anything other than a positive `ok: true` as a refusal, so a probe that cannot answer must say
 * so rather than guess.
 *
 * The connector-specific part is only "where does this ledger record settlements against this
 * kind of document"; the comparison itself is pure and lives in the domain module.
 */

import type { AccountingSyncType } from '@/app/generated/prisma/client'
// o3d-78rq: the SAME reader both connectors' amount readings already go through, answering with the
// Decimal rather than the double. It lives beside `parseLedgerAmount` in the Xero module because that
// is where `ledgerAmountMagnitudeBound` is, and this is the import direction QuickBooks' own payment
// poller already takes for exactly the same rule.
// o3d-obyd: and `decodeLedgerAmountText` is the string arm of that same reader, which is how the
// completeness arithmetic below reads a numeric STRING without also inheriting the currency and
// magnitude judgements that belong to a decision which withholds. One decode, two callers.
// o3d-mm51: and `ledgerDifferenceMagnitudeBound` is the OTHER rule that reader applies to a decoded
// JSON number -- the one about whether the number can be READ AT ALL rather than about whether the
// figure may be trusted. See `wireAmount`, which inherits it and still does not inherit the scale.
import {
  decodeLedgerAmountText,
  ledgerCurrencyCode,
  ledgerDifferenceMagnitudeBound,
  readLedgerStatedAmount,
} from '@/lib/connectors/xero/invoice-delta'
// o3d-r948: the completeness refusals print figures, and a KWD shortfall of one fil is `0.00` at two
// places. The rule for showing a money figure without rounding away what the verdict turned on is
// already written down for the classifier's own sentences, so it is the same function.
import { formatLedgerMoney } from '@/lib/domain/accounting/ledger-settlement-evidence'
import type { LedgerSettlementProbe, LedgerSettlementRecord } from '@/lib/domain/accounting/ledger-settlement-evidence'
import {
  addMoney,
  compareDecimal,
  ledgerAmountEpsilon,
  subtractMoney,
  toDecimal,
  type Decimal,
} from '@/lib/domain/math/decimal'
import { settlementDocumentAnchorFilters, settlementDocumentKey } from '@/lib/domain/accounting/money-post-document'
import type { MoneyPostLock } from '@/lib/domain/accounting/money-post-lock'

export type SettlementProbeTarget = {
  type: string
  payload: unknown
}

function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/* ------------------------------------------------------------------------------------------- *
 * o3d-r948 — THE COMPLETENESS CROSS-CHECKS, IN DECIMAL, AT THIS DOCUMENT'S OWN MINOR UNIT.
 * ------------------------------------------------------------------------------------------- */

/**
 * HOW FAR A LEDGER'S OWN TOTAL MAY EXCEED THE COLLECTION IT SENT BEFORE THE PICTURE IS INCOMPLETE.
 *
 * THE DEFECT (o3d-78rq's ninth site, filed rather than folded in; Codex HIGH 1). All four checks
 * below carried a flat `0.005` and did their arithmetic in `number`, while o3d-6yho had already made
 * the classifier's band a fraction of the document's own minor unit and o3d-78rq had made both of the
 * classifier's operands exact. A flat half-penny is FIVE whole minor units in a Gulf dinar and fifty
 * in CLF. So a KWD invoice reporting `AmountPaid` 0.001 — one fil, a real payment — with an omitted
 * `Payments` collection had its whole shortfall swallowed: the completeness question answers
 * "everything is accounted for", the probe returns `ok: true` with an EMPTY record list, and
 * `classifyLedgerSettlement` builds `clear` out of it. `clear` is what authorises a money post, so
 * the cost of the swallowed fil is a SECOND payment.
 *
 * THE BAND IS `ledgerAmountEpsilon` — HALF ONE MINOR UNIT OF THE DOCUMENT'S OWN CURRENCY.
 *
 * Codex asked for a tolerance "strictly below one minor unit", not for half of one, and half of one
 * is the value chosen anyway. The reason is what a band is FOR: it absorbs representation noise in
 * figures the ledger has already quantized to its own minor unit, and it must never absorb a real
 * omission. Every genuine settlement is a whole multiple of that unit, so the smallest shortfall that
 * can exist is ONE unit and any band strictly below one unit refuses it. Within that constraint the
 * choice is between two failure directions, and they are not symmetric here:
 *
 *   TOO WIDE    a real omission is swallowed, the record list is short, and a `clear` is built from
 *               it. That is a duplicate payment — irreversible.
 *   TOO NARROW  a document whose figures differ by a sliver refuses, the row fails visibly, and a
 *               human resolves it. A workflow cost.
 *
 * So the narrower of the two available answers is taken, and `ledgerAmountEpsilon` — "how small an
 * amount counts as NOTHING", which is the same question this asks of a shortfall — is that answer,
 * already written down for both connectors. It is 0.005 exactly in every two-decimal currency, so
 * nothing about the ordinary Xero or QuickBooks document moves; it is 0.0005 in a Gulf dinar, where
 * the fil that was being swallowed now refuses.
 *
 * AN UNSTATED CURRENCY TAKES THE STRICTEST BAND, which is `ledgerAmountEpsilon`'s documented
 * direction and the right one here for the same reason: too large a band hides an omission behind a
 * clear. This is NOT `ledgerMatchEpsilon`, whose null arm deliberately widens — that rule's danger is
 * failing to RECOGNISE our own payment, and this one's is failing to notice a missing one.
 */
function completenessBand(currency: string | null): Decimal {
  return ledgerAmountEpsilon(currency)
}

/**
 * o3d-obyd — A WIRE FIGURE, AND WHICH OF THE TWO KINDS OF NOTHING IT IS WHEN IT IS NOT ONE.
 *
 * `null` used to be the whole answer here and it was answering two different questions at once: the
 * ledger stated NO figure, and the ledger stated a figure THIS CODE COULD NOT READ. The completeness
 * checks below skip on the first — correctly, an omitted total is nothing to compare against — and
 * they were therefore skipping on the second too, which is the defect (see the header on
 * `completenessCannotRun`). So the reading is a triple, and the two nothings are told apart:
 *
 *   `{ value: Decimal }`   the ledger stated this figure.
 *   `{ value: null, unreadable: null }`   the ledger stated nothing here — the field is absent.
 *   `{ value: null, unreadable: <text> }`   the ledger stated something that is not a decimal
 *                                            amount. Naming it is what makes the refusal below
 *                                            actionable rather than mysterious.
 *
 * WHAT COUNTS AS STATED. A finite JSON number, or TEXT that `decodeLedgerAmountText` — the very
 * function the QuickBooks poller's own `parseLedgerAmount` reading is built out of — admits.
 * QuickBooks serialises `TotalAmt` and `Balance` as strings (o3d-psrx r10, which moved the poller and
 * left this module behind), so a string here is the ordinary case and not an exotic one.
 *
 * DELIBERATELY NOT `readLedgerStatedAmount` ITSELF. That reader additionally refuses a figure finer
 * than its currency or above the magnitude bound, and those refusals belong to a decision that
 * WITHHOLDS a payment. The question these checks ask is "does the ledger's own total agree with the
 * collection it sent me?", and its answer must not change because a figure was too finely stated to
 * compare — a KWD `AmountPaid` of one fil is precisely the figure the whole o3d-r948 band exists to
 * measure, and refusing to read it would put the check back where it started. So the DECODE is
 * shared and the JUDGEMENT is not, which is the split `decodeLedgerAmountText` is documented for.
 * What the exact reading buys the arithmetic is unchanged: each figure is taken at its own exact
 * decimal value and added without rounding, so the sum contributes no error on top of the terms.
 *
 * o3d-mm51 (Codex HIGH 1) -- AND THE HALF OF THAT JUDGEMENT WHICH IS NOT A JUDGEMENT AT ALL.
 *
 * The paragraph above splits DECODE from JUDGEMENT correctly and then excludes
 * `readLedgerStatedAmount`'s two extra rules TOGETHER, as though the judgement were one thing. It is
 * two, their premises differ, and only one of them was rightly excluded:
 *
 *   THE SCALE RULE -- "is this figure quantized to its currency's minor unit?" -- STAYS EXCLUDED, for
 *   exactly the reason given above. It asks whether a figure may be TRUSTED, and this check must read
 *   a figure stated more finely than the document's own currency: a KWD `AmountPaid` of one fil, or a
 *   GBP `AmountCredited` of `0.001`, is precisely the shortfall `completenessBand` exists to measure,
 *   and refusing to read it puts the check back where o3d-r948 found it.
 *
 *   THE MAGNITUDE RULE -- "can a double even hold two figures this large one minor unit apart?" -- IS
 *   INHERITED. That is not a question about the figure at all. It is the statement that
 *   `Response.json()` has ALREADY destroyed the token and that no test applied to the double
 *   afterwards can see the loss (see `ledgerAmountMagnitudeBound`), and its premise -- the evidence is
 *   gone -- holds for EVERY reader of a decoded JSON number, including one that withholds nothing.
 *   Codex's pair is the demonstration: GBP `TotalAmt 70368744177664.02` with `Balance
 *   70368744177664.01` is ONE double twice over, `TotalAmt - Balance` is an exact zero, and the probe
 *   answered `ok: true` over an EMPTY record list -- a real one-penny settlement read as no
 *   settlement, which `classifyLedgerSettlement` reads as `clear`, and `clear` authorises a SECOND
 *   payment.
 *
 * AND IT IS THE DIFFERENCE BOUND, NOT THE AMOUNT ONE. `ledgerAmountMagnitudeBound` guarantees that
 * ONE WHOLE MINOR UNIT survives the decode; every decision these figures feed turns on HALF of one,
 * because `completenessBand` is `ledgerAmountEpsilon`. That is the same gap o3d-psrx r16 derived
 * `ledgerDifferenceMagnitudeBound` for, and it is measured rather than argued: in GBP at 2^45 --
 * BELOW the amount bound -- `35184372088832.0117` and `35184372088832.0040` are 0.0077 apart, which
 * is above the band, and they are one double. So the halved bound is REUSED here rather than
 * re-derived, and it applies to every figure this reader answers, because there is no figure here
 * that is read alone: `Total - RemainingCredit`, `AmountPaid` against its collection, `Total -
 * AmountDue`, `TotalAmt - Balance`, and every `shortBy` and `statesAnything` besides, are all decided
 * at one half of a minor unit.
 *
 * THE STRING ARM TAKES NO BOUND, which is o3d-psrx r15 and is deliberately unchanged. A string still
 * carries its own digits, so nothing was destroyed and there is nothing for a size rule to stand in
 * for. That is also why this does not undo o3d-obyd: QuickBooks states `TotalAmt` and `Balance` as
 * TEXT, and text is read exactly as it was.
 *
 * A REFUSED NUMBER IS UNREADABLE, NOT ABSENT. It is a figure the ledger STATED, so it takes the
 * direction the triple exists for -- `completenessCannotRun` refuses the probe rather than excusing
 * the check that would have used it.
 */
type WireAmount = { value: Decimal | null; unreadable: string | null }

function wireAmount(value: unknown, currency: string | null): WireAmount {
  // The ledger stated nothing. Not a refusal: an omitted collection or total is a shape both ledgers
  // send routinely, and the checks below already treat "no figure to compare against" as no check.
  if (value === undefined || value === null) return { value: null, unreadable: null }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { value: null, unreadable: String(value) }
    // o3d-mm51: the token is already gone, so the only question left is one about its SIZE. At or
    // above this bound the decode can no longer keep two figures HALF a minor unit apart, which is
    // the granularity every check below decides at, so the number is refused rather than read.
    if (Math.abs(value) >= ledgerDifferenceMagnitudeBound(currency)) {
      return { value: null, unreadable: String(value) }
    }
    return { value: toDecimal(value), unreadable: null }
  }
  if (typeof value === 'string') {
    const decoded = decodeLedgerAmountText(value)
    if (decoded !== null) return { value: decoded, unreadable: null }
    // `''` is reported as a blank rather than as an empty quotation, so the sentence still names
    // something. It is NOT read as absent: a field that is present and empty is a field whose figure
    // this code cannot account for, and the fail-closed direction is the whole point of the triple.
    return { value: null, unreadable: value.trim() === '' ? '(blank)' : value.trim() }
  }
  return { value: null, unreadable: typeof value }
}

/**
 * The same reading, for the COLLECTION terms, where the two nothings already fail the same way.
 *
 * An allocation, payment or applied amount that is absent and one that is unreadable both make their
 * `sumExact` null, and a null sum is already refused everywhere it can explain anything — so these
 * terms need no triple. The DOCUMENT's own totals do, because a null there decided whether the check
 * ran at all.
 */
function wireDecimal(value: unknown, currency: string | null): Decimal | null {
  return wireAmount(value, currency).value
}

/**
 * o3d-obyd — A COMPLETENESS CHECK THAT CANNOT BE RUN MUST NOT READ AS ONE THAT PASSED.
 *
 * THE DEFECT. Every completeness cross-check in this file is guarded by `figure !== null`, and every
 * figure came from a reader that answered `null` to a numeric STRING. QuickBooks sends `TotalAmt` and
 * `Balance` as strings. So on the ordinary QuickBooks bill the guard was false, the check did not
 * run, control fell through to `return { ok: true, records }` — and with nothing uncovered linked,
 * `records` is EMPTY. `classifyLedgerSettlement` reads an ok probe with an empty record list as
 * `clear`, `clear` is what authorises a money post, and the money post is a SECOND payment against a
 * bill QuickBooks is reporting as fully settled. The refusal was being spent as permission.
 *
 * Reading the string (above) removes the reachable cause. This removes the SHAPE, which is the part
 * that can come back: a figure the ledger stated and this code cannot read now REFUSES the probe
 * instead of quietly excusing the check that would have used it. That is the direction every other
 * unreadable thing in this module already takes — `statedAmount` withholds, a null `explained`
 * refuses, an unclassified link type refuses — and the one place it was inverted is the one place a
 * `clear` could be built out of not having looked.
 *
 * AN ABSENT FIELD IS STILL NOT A REFUSAL. "Xero omitted `Total` and `AmountDue`" is a response shape
 * this module already has a documented fallback for, and turning it into a refusal would fail the
 * ordinary unsettled document rather than the malformed one. The rule is about what the ledger SAID,
 * not about what it left out: it is exactly the distinction `statedAmount` has always drawn between
 * `amount: null` and `unreadableAmount`, now drawn on the document's own figures too.
 */
function completenessCannotRun(figures: Array<readonly [string, WireAmount]>): string | null {
  for (const [name, reading] of figures) {
    if (reading.unreadable !== null) return `${name} ${reading.unreadable}`
  }
  return null
}

/** Does the ledger claim anything at all here — more than one band above zero? */
function statesAnything(value: Decimal, currency: string | null): boolean {
  return compareDecimal(value, completenessBand(currency)) > 0
}

/** Is `stated` more than one band above what `accounted` explains? Exact on both operands. */
function shortBy(stated: Decimal, accounted: Decimal, currency: string | null): boolean {
  return compareDecimal(subtractMoney(stated, accounted), completenessBand(currency)) > 0
}

/**
 * o3d-zo4j — THE OTHER DIRECTION OF THE SAME COMPARISON, ON THE SAME BAND.
 *
 * `shortBy` asks whether the certifying figure is bigger than the collection it certifies; this asks
 * whether the COLLECTION is bigger than the figure. It is literally `shortBy` with the operands
 * swapped, and it is written that way ON PURPOSE: the band is `completenessBand` because it is the
 * SAME comparison, and reusing the function is the only spelling that cannot drift from it. An excess
 * WITHIN the band is two exact decimals agreeing to the document's own minor unit — noise, which is
 * the whole reason the shortfall direction is not a bare `<` either.
 */
function exceeds(accounted: Decimal, stated: Decimal, currency: string | null): boolean {
  return shortBy(accounted, stated, currency)
}

/**
 * o3d-nk5n — AN EMPTY RECORD LIST IS A POSITIVE CLAIM ABOUT MONEY, SO IT NEEDS A FIGURE BEHIND IT.
 *
 * THE RULE, IN ONE PLACE, FOR BOTH CONNECTORS AND ALL THREE DOCUMENT ARMS.
 *
 * `{ ok: true, records: [] }` is not "I could not tell". `classifyLedgerSettlement` reads it as
 * `clear`, and `clear` is what AUTHORISES a money post — so the empty answer asserts "nothing has
 * settled this document", which is the strongest claim this probe can make and the one that spends a
 * second payment when it is wrong. Every completeness cross-check in this file is guarded on a figure
 * being present, so a response that states NO usable figure runs no check at all and falls through to
 * that assertion having looked at nothing.
 *
 * THE ASYMMETRY IS THE WHOLE POINT, AND IT IS BETWEEN TWO KINDS OF EMPTY:
 *
 *   PROVED EMPTY     the document states the figures its own settlement arithmetic is made of, and
 *                    that arithmetic comes out at nothing. An unpaid Xero invoice states `Total` and
 *                    `AmountDue` EQUAL, so `Total - AmountDue` is exactly zero: the ledger has said,
 *                    in its own numbers, that nothing has come off this document. The ordinary first
 *                    payment is this shape, and it still posts.
 *   ASSUMED EMPTY    the document states none of them. `settled` is null, no check ran, and the empty
 *                    record list is a conclusion drawn from having nothing to read. It refuses.
 *
 * This is the QuickBooks arm's rule, not a second spelling of it: `probeQuickBooksSettlement` has
 * required exactly this since o3d-mm51 — emptiness PROVED by two stated figures rather than assumed
 * from two missing ones — and the function is shared so the two can never drift. What each arm passes
 * as `settled` is its own ledger's account of how much has come off the document by ANY means:
 * `Total - AmountDue` (or the `AmountPaid + AmountCredited` fallback) on a Xero invoice,
 * `Total - RemainingCredit` on a Xero credit note, `TotalAmt - Balance` on a QuickBooks document. In
 * every case it is null exactly when the ledger stated too little for the figure to be computed.
 *
 * A NON-EMPTY RECORD LIST STILL ANSWERS — AND o3d-obyd r31 IS WHAT "ANSWERS" MEANS. This paragraph
 * used to say records are evidence in their own right and stop there, and Codex found the half of
 * that sentence which is false. It is TRUE OF A MATCH and FALSE OF A NON-MATCH. A record that matches
 * the attempt proves the attempt settled, whatever else the response left out. A record that does not
 * match is a statement about ONE OTHER settlement and says nothing about whether the attempted one is
 * also in the collection — so a truncated response that omits the document figures, returns one
 * unrelated settlement and omits ours cleared all three arms. The list is therefore no longer
 * reported as a bare answer: it is reported WITH whether it is proved complete, and the classifier
 * spends that on the non-match alone (see `LedgerSettlementProbe.provedComplete`).
 *
 * AND AN UNREADABLE FIGURE IS ALREADY HANDLED ELSEWHERE — `completenessCannotRun` refuses before this
 * is reached. What is left here is ABSENCE, which correctly skips arithmetic it cannot do and must
 * not also be allowed to contribute a conclusion.
 *
 * o3d-zo4j — AND THE FIGURE IS NOT PROOF OF A COLLECTION THAT CONTRADICTS IT.
 *
 * THE DEFECT. `provedComplete` was `settled !== null`: the figure being STATED was taken as the
 * figure being BORNE OUT. Every check above it rejects a SHORTFALL — the collection explaining less
 * than the figure — and that is one of the two ways a collection can fail to agree with the figure
 * certifying it. The other is an EXCESS, and it went unmeasured, so a response could state a figure
 * its own collection refutes and still have that figure believed. Codex's shape and the one filed on
 * this issue are the same: a credit note stating `Total 40 / RemainingCredit 40` — a PROVED ZERO,
 * `statesAnything` false, the shortfall check passing over nothing — whose `Allocations` show 40
 * already used. The note says none of the credit has been applied and simultaneously shows all of it
 * applied. The zero was believed, an allocation to some OTHER invoice left this bill's filtered record
 * list empty, and `classifyLedgerSettlement` read that as `clear` — which authorises a second
 * allocation of a credit that is already spent.
 *
 * WHY IT WITHHOLDS RATHER THAN REFUSES, WHICH IS THE WHOLE SHAPE OF THE FIX. Refusing would require
 * knowing whether THIS excess is legitimate — is a listed-but-reversed payment, or a draft credit
 * note, a real overrun? — and that is a question about live ledger shapes nobody here has settled. It
 * does not have to be answered. A collection that exceeds the figure certifying it has CONTRADICTED
 * that figure whatever the reason, and the only thing this code needs from that is to stop treating
 * the figure as PROOF. So `provedComplete` becomes false and nothing else changes: the effect is
 * confined to `clear` -> `unknown` on a NON-match, a match still yields `present` through the passes
 * that run before the classifier's terminal gate, and a shortfall still escalates to `ok: false`
 * exactly as it does today. The ordinary first payment — `Total 40, AmountDue 40, Payments: []`,
 * `TotalAmt "1200.00"` with `Balance "1200.00"` — has an excess of exactly zero and still posts.
 *
 * THE BAND IS THE SHORTFALL'S BAND, not a bare `>`. See `exceeds`, which IS `shortBy` with its
 * operands swapped so that the two directions cannot come to be measured differently. Both operands
 * are exact decimals read from what the ledger stated, so a real document agrees to its own minor
 * unit and only a genuine overrun clears the band.
 *
 * WHY IT IS ONE FUNCTION THAT BUILDS THE WHOLE ANSWER. `emptyAnswerIsUnproved` was a PREDICATE each
 * arm called before its own `return { ok: true, records }`, so the two halves of the rule — refuse
 * the figureless empty answer, and mark the figureless non-empty one unproved — could be applied in
 * one arm and forgotten in another. They cannot drift now: there is no way to build a successful
 * answer without handing over the document's own settled figure, and what that figure is null-or-not
 * decides both halves in one place.
 */
function settlementAnswer(
  /** The ledger's OWN account of how much has come off this document, or null when it stated too
   * little to compute one. This is the sole evidence of completeness — never the records. */
  settled: Decimal | null,
  /**
   * o3d-zo4j — AND WHETHER THE COLLECTION THAT FIGURE CERTIFIES CONTRADICTS IT BY EXCEEDING IT.
   *
   * Required rather than optional, and for the same reason `provedComplete` is: a permissive DEFAULT
   * reached by an arm that forgot to compute it is how every fail-open in this module arrived. An arm
   * that does not say whether its collection overran does not compile.
   */
  collectionExceedsFigure: boolean,
  records: LedgerSettlementRecord[],
  /** What to say when the document states no figure AND this probe read no settlement of it. */
  figurelessAndEmpty: string,
): LedgerSettlementProbe {
  if (settled === null && records.length === 0) return { ok: false, reason: figurelessAndEmpty }
  return { ok: true, records, provedComplete: settled !== null && !collectionExceedsFigure }
}

/** Sum exact readings, or null the moment one of them is unreadable. */
function sumExact(values: Array<Decimal | null>, seed: Decimal | null = toDecimal(0)): Decimal | null {
  return values.reduce<Decimal | null>(
    (sum, value) => (sum === null || value === null ? null : sum.add(value)),
    seed,
  )
}

/**
 * o3d-78rq — A SETTLEMENT'S AMOUNT, AS THE FIGURE THE LEDGER STATED OR NOT AT ALL.
 *
 * The record list this builds is the ledger operand of `classifyLedgerSettlement`, which decides
 * whether a money row that has already been attempted may be sent again. It used to be `num()` — the
 * wire double, unbounded and unquantized — measured against our payload's double with `-`, so at a
 * magnitude where the double spacing exceeds the match band the comparison decided nothing the band
 * said, in the direction that posts a SECOND payment.
 *
 * `readLedgerStatedAmount` is the rule `parseLedgerAmount` already applies to every other ledger
 * amount either connector reads: a magnitude bound, and the currency's own minor-unit scale. What it
 * returns is a Decimal that is PROVABLY the figure the ledger stated. What it refuses is a figure this
 * code cannot say that about — and a refusal here WITHHOLDS the payment rather than clearing it,
 * which is the direction this rule's asymmetry demands.
 *
 * THIS READER IS DELIBERATELY NOT USED BY THE COMPLETENESS ARITHMETIC BELOW, AND o3d-r948 DID NOT
 * CHANGE THAT. The cross-check asks a different question — "does Xero's own total of what settles this
 * document agree with the collection it sent me?" — and its answer must not change because a figure
 * was too finely stated to compare. A refusal there would SKIP the check, which is the lenient
 * direction and the opposite of what that rule's asymmetry demands. So the completeness terms go
 * through `wireDecimal`, which reads every stated number at its own exact decimal value and refuses
 * nothing; what o3d-r948 changed is the ARITHMETIC (exact, not `+`) and the BAND (the document's own
 * minor unit, not a flat half-penny). See `completenessBand`.
 */
function statedAmount(raw: unknown, currency: string | null): Pick<LedgerSettlementRecord, 'amount' | 'unreadableAmount'> {
  const amount = readLedgerStatedAmount(raw, currency)
  if (amount !== null) return { amount }
  // The ledger stating NOTHING and the ledger stating something unreadable are both `null` and both
  // withhold; only the second can name a figure, and naming it is what stops an operator reading the
  // hold as "this document is unpaid". A non-number, non-string is reported by its type — there is no
  // figure to quote.
  if (raw === undefined || raw === null) return { amount: null }
  return {
    amount: null,
    unreadableAmount: typeof raw === 'number' || typeof raw === 'string' ? String(raw) : typeof raw,
  }
}

/**
 * Xero serialises dates BOTH ways depending on the field and endpoint: `/Date(1750000000000+0000)/`
 * on most transaction reads, plain ISO on a few. Anything else reads as null, which the classifier
 * turns into `unknown` rather than a silent non-match.
 */
export function normaliseXeroSettlementDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  // An ISO date is taken VERBATIM rather than parsed. `2026-07-01T00:00:00` carries no zone, so
  // Date.parse reads it as local time and toISOString can then move it to the previous day — a
  // settlement that no longer matches the attempt that created it, on nothing but the server's
  // timezone.
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim())
  if (iso) return iso[1]!
  const dotNet = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(value.trim())
  if (!dotNet) return null
  const ms = Number(dotNet[1])
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * A collection Xero reports on an invoice for money taken off it by something that is NOT a
 * payment. Each entry says how much of that document was APPLIED here, which is all this probe
 * needs from it: never a candidate settlement (IMS posts payments, not these), only an
 * explanation for an `AmountCredited`/`AmountDue` movement the payments do not account for.
 */
type XeroAppliedCollection = Array<{ AppliedAmount?: number }>

/** The document a settlement probe reads, per money-moving type. */
type XeroPaymentsResponse = {
  Invoices?: Array<{
    InvoiceID?: string
    /**
     * The currency every amount on this document is stated in (o3d-78rq). It sizes the minor-unit
     * scale rule and the magnitude bound the settlement amounts are admitted by; absent, both
     * resolve through `ledgerMinorUnits(null)` exactly as they do everywhere else in this repository.
     */
    CurrencyCode?: string
    /**
     * Xero's own total of the payments applied to this document. Read as a CROSS-CHECK on the
     * collection below, never as a record in its own right — see the completeness note in
     * `probeXeroSettlement`.
     */
    AmountPaid?: number
    /**
     * Money taken off this document by CREDIT NOTES, prepayments and overpayments. It is NOT part
     * of `AmountPaid` — that is the whole of Codex round 6 finding 3 — so an invoice settled
     * entirely by an allocation reports `AmountPaid: 0` with an empty `Payments` collection, and
     * a probe reading only those two answered "positively nothing settles this document".
     */
    AmountCredited?: number
    /** The document's face value and what is still owed on it — the shape-independent cross-check. */
    Total?: number
    AmountDue?: number
    Payments?: Array<{ PaymentID?: string; Date?: string; Amount?: number; Reference?: string }>
    CreditNotes?: XeroAppliedCollection
    Prepayments?: XeroAppliedCollection
    Overpayments?: XeroAppliedCollection
  }>
}
type XeroCreditNoteResponse = {
  CreditNotes?: Array<{
    CreditNoteID?: string
    /** o3d-78rq: as on an invoice — what the allocation amounts below are stated in. */
    CurrencyCode?: string
    /** The credit's face value and what is left of it — how much of it has been allocated. */
    Total?: number
    RemainingCredit?: number
    Allocations?: Array<{ Amount?: number; Date?: string; Invoice?: { InvoiceID?: string } }>
  }>
}

/**
 * Sum a collection's `AppliedAmount`s, or null the moment one of them cannot be read.
 *
 * An absent collection sums to ZERO rather than to null: "Xero sent no credit notes" has to be
 * able to mean "there are none", or every ordinary invoice would refuse. What stops that reading
 * being a hole is that the arithmetic it feeds is directional — an absent collection explains
 * nothing, so an `AmountCredited` it should have accounted for shows up as an unexplained
 * shortfall and refuses.
 */
function sumApplied(collection: XeroAppliedCollection | undefined, currency: string | null): Decimal | null {
  // o3d-r948: exact, like every other term of the completeness arithmetic.
  // o3d-mm51: and sized by the document's own currency, like every other term of it.
  return sumExact((collection ?? []).map((entry) => wireDecimal(entry.AppliedAmount, currency)))
}

/** The shape of the connector read each probe needs, so both can be driven without a network. */
export type XeroFetcher = <T>(path: string) => Promise<{ ok: boolean; status: number; data?: T; error?: string }>
export type QboFetcher = <T>(path: string) => Promise<{ ok: boolean; status: number; data?: T; error?: string }>

export async function probeXeroSettlement(
  target: SettlementProbeTarget,
  xeroGet: XeroFetcher,
): Promise<LedgerSettlementProbe> {
  const payload = asRecord(target.payload)
  const invoiceId = str(payload.accountingInvoiceId)

  if (target.type === 'PURCHASE_CREDIT_NOTE_ALLOCATION') {
    const creditNoteId = str(payload.creditNoteId)
    if (!creditNoteId || !invoiceId) {
      return { ok: false, reason: 'the row records no credit note and invoice to check' }
    }
    const res = await xeroGet<XeroCreditNoteResponse>(`CreditNotes/${encodeURIComponent(creditNoteId)}`)
    if (!res.ok) return { ok: false, reason: res.error ?? `HTTP ${res.status}` }
    const note = res.data?.CreditNotes?.[0]
    if (!note) return { ok: false, reason: 'Xero returned no credit note for that id' }
    const allocations = note.Allocations ?? []
    // o3d-r948: hoisted, because the completeness arithmetic below is sized by it too — the note's
    // OWN currency, which is what its allocation amounts are stated in.
    const noteCurrency = ledgerCurrencyCode(note.CurrencyCode)
    // Only allocations against THIS bill: the same credit note legitimately offsets others.
    const records: LedgerSettlementRecord[] = allocations
      .filter((a) => str(a.Invoice?.InvoiceID).toLowerCase() === invoiceId.toLowerCase())
      // No reference field exists on a Xero credit-note allocation, so this type has no mark to
      // match and falls back to amount and date alone. Stated rather than left to be inferred from
      // a missing property.
      .map((a) => ({
        ...statedAmount(a.Amount, noteCurrency),
        date: normaliseXeroSettlementDate(a.Date),
        reference: null,
      }))

    // COMPLETENESS, CHECKED RATHER THAN ASSUMED (Codex round 6, finding 3). This branch had NO
    // cross-check at all, so `Allocations` absent and `Allocations` empty were the same value —
    // and the difference between them is the difference between "this credit has been applied to
    // nothing" and "Xero did not send us the collection". A fully applied credit note read as the
    // first is a positive CLEAR, and the fence allocates it to the bill a second time.
    //
    // `Total - RemainingCredit` is Xero's OWN account of how much of this credit has been used, by
    // any means, so it is the thing the returned collection has to add up to. ALL allocations
    // count here, not only this bill's: the credit legitimately offsets other documents, and it is
    // the COLLECTION's completeness being tested, not this bill's share of it.
    //
    // o3d-obyd — ARM 1 OF 3. An unreadable `Total` or `RemainingCredit` used to make `applied` null,
    // which skipped this check entirely; an absent `Allocations` collection then gave `records: []`,
    // and that is a `clear` over the credit note this check was added to protect.
    const creditTotal = wireAmount(note.Total, noteCurrency)
    const remaining = wireAmount(note.RemainingCredit, noteCurrency)
    const cannotRun = completenessCannotRun([['Total', creditTotal], ['RemainingCredit', remaining]])
    if (cannotRun !== null) {
      return {
        ok: false,
        reason: `Xero states ${cannotRun} on this credit note, which IMS cannot read as an amount, so it `
          + 'cannot tell how much of the credit is already allocated',
      }
    }
    const applied = creditTotal.value !== null && remaining.value !== null
      ? subtractMoney(creditTotal.value, remaining.value)
      : null
    const allocated = sumExact(allocations.map((a) => wireDecimal(a.Amount, noteCurrency)))
    if (applied !== null && statesAnything(applied, noteCurrency)
      && (allocated === null || shortBy(applied, allocated, noteCurrency))) {
      return {
        ok: false,
        reason: `Xero reports ${formatLedgerMoney(applied)} of this credit note already applied but returned `
          + (allocated === null
            ? 'an allocation whose amount could not be read'
            : allocations.length === 0
              ? 'no allocations'
              : `allocations totalling ${formatLedgerMoney(allocated)}`),
      }
    }
    // o3d-nk5n — AND HERE IT IS CLOSED. o3d-mm51 filed this instance rather than fixing it because
    // the fixtures modelled the figureless stub as an ordinary credit note; they now state what Xero
    // states, so the rule can be the same one on both connectors.
    //
    // `applied` is this arm's `settled`: `Total - RemainingCredit` is Xero's own account of how much
    // of the credit has been used. Null means the note stated neither figure, so nothing was checked
    // — and with no allocation to THIS bill, the empty record list would assert "none of this credit
    // has been applied to this bill" on the strength of not having looked. A note that DOES state
    // them proves its own emptiness: a wholly unapplied credit reads `Total 40, RemainingCredit 40`,
    // `applied` is exactly zero, and the empty answer is the ledger's, not this code's.
    //
    // o3d-obyd r31: and `applied` is also what proves the ALLOCATION LIST COMPLETE, which is the same
    // fact used for a different conclusion. When it is stated, the shortfall check above has measured
    // the collection against a figure outside it; when it is null, the allocations went unmeasured,
    // and a non-matching allocation must not be allowed to say this credit was never applied to us.
    // o3d-zo4j — PAIR 1 OF 4, AND IT IS AN IDENTITY. `RemainingCredit = Total - SUM(Allocations)` is
    // Xero's own construction of the field, so `applied` and `allocated` are ONE quantity written two
    // ways. The shortfall check above already reads them that way; measuring the other direction adds
    // no assumption it does not already make. An excess means the note's `RemainingCredit` and its own
    // allocation list cannot both be true, and there is no shape of a live Xero credit note in which
    // they legitimately differ — a deleted allocation LEAVES the collection rather than staying in it
    // with a reversing sign, and a reversing sign would push this into the shortfall direction anyway.
    const overAllocated = applied !== null && allocated !== null && exceeds(allocated, applied, noteCurrency)
    return settlementAnswer(applied, overAllocated, records,
      'Xero states no total or remaining credit on this credit note and IMS read no allocation '
      + 'of it to this bill, so it has nothing to tell from — an empty answer here would say that '
      + 'none of the credit has been allocated rather than report what has')
  }

  if (!invoiceId) return { ok: false, reason: 'the row records no document id to check' }
  // Single-document GET, not the list endpoint: Xero omits the Payments collection from a
  // multi-invoice response, and an empty Payments array read from a summary would be indistinguishable
  // from a document with no payments at all — the exact false CLEAR this probe exists to prevent.
  const res = await xeroGet<XeroPaymentsResponse>(`Invoices/${encodeURIComponent(invoiceId)}`)
  if (!res.ok) return { ok: false, reason: res.error ?? `HTTP ${res.status}` }
  const invoice = res.data?.Invoices?.[0]
  if (!invoice) return { ok: false, reason: 'Xero returned no document for that id' }
  const invoiceCurrency = ledgerCurrencyCode(invoice.CurrencyCode)
  // o3d-78rq: the wire figures, kept for the completeness arithmetic below and for NOTHING ELSE. That
  // cross-check asks whether the COLLECTION is complete, not whether a figure in it can be compared
  // exactly, so it goes on ADMITTING exactly what it admitted before — see `statedAmount`.
  // o3d-r948: read as exact decimals rather than doubles, and summed without rounding.
  const wireAmounts = (invoice.Payments ?? []).map((p) => wireDecimal(p.Amount, invoiceCurrency))
  const records: LedgerSettlementRecord[] = (invoice.Payments ?? []).map((p) => ({
    ...statedAmount(p.Amount, invoiceCurrency),
    date: normaliseXeroSettlementDate(p.Date),
    id: str(p.PaymentID) || null,
    // Where IMS writes its own mark; matching it identifies the attempt whatever has since been
    // done to the amount or the date.
    reference: str(p.Reference) || null,
  }))
  // COMPLETENESS, CHECKED RATHER THAN ASSUMED (Codex round 4, finding 1 generalised). `Payments`
  // being absent and `Payments` being empty are the same value in JavaScript, and the difference
  // between them is the difference between "nothing settles this document" and "we asked the
  // wrong endpoint". `AmountPaid` is Xero's OWN total of the same collection, so the two must
  // agree; when the collection is short of it, the probe has an incomplete picture and says so
  // rather than reporting a clear built from it.
  //
  // Directional on purpose — only a SHORTFALL escalates. A record whose amount is unreadable
  // already yields `unknown` in the classifier, so it is excluded here rather than counted as
  // zero (which would fake a shortfall).
  //
  // o3d-obyd — ARM 2 OF 3, AND ITS SECOND CHECK IS ARM 3's SIBLING. All four of this arm's document
  // figures are read HERE, before either check, and a figure Xero STATED that IMS cannot read as an
  // amount refuses the probe rather than excusing the check that would have used it. Both checks are
  // guarded on `!== null`, so an unreadable `AmountPaid` skipped the first and an unreadable `Total`
  // or `AmountDue` skipped the second — and a skipped check over a `Payments` collection Xero did not
  // send is `ok: true` with an empty record list, which is a `clear`.
  //
  // Absent stays a skip on purpose: the `settled` fallback below EXISTS for a response that omits
  // `Total` and `AmountDue`, and an ordinary unsettled invoice that states no `AmountCredited` must
  // keep reading as the positive, empty answer it is.
  const amountPaidRead = wireAmount(invoice.AmountPaid, invoiceCurrency)
  const totalRead = wireAmount(invoice.Total, invoiceCurrency)
  const amountDueRead = wireAmount(invoice.AmountDue, invoiceCurrency)
  const amountCreditedRead = wireAmount(invoice.AmountCredited, invoiceCurrency)
  const cannotRun = completenessCannotRun([
    ['AmountPaid', amountPaidRead],
    ['Total', totalRead],
    ['AmountDue', amountDueRead],
    ['AmountCredited', amountCreditedRead],
  ])
  if (cannotRun !== null) {
    return {
      ok: false,
      reason: `Xero states ${cannotRun} on this document, which IMS cannot read as an amount, so it `
        + 'cannot tell how much of it is already settled',
    }
  }
  const amountPaid = amountPaidRead.value
  // The `every` gate is kept EXACTLY as it was: an unreadable payment amount excludes this check
  // rather than refusing it, because such a record already yields `unknown` in the classifier and
  // counting it as zero here would fake a shortfall. Only the arithmetic and the band have changed.
  const seen = wireAmounts.every((a) => a !== null) ? sumExact(wireAmounts) : null
  // o3d-mm51 — THE GATE'S PREMISE IS NOW CHECKED INSTEAD OF ASSUMED, because this round is what made
  // it stop being true. The gate EXCLUDES this check rather than refusing it, and the whole
  // justification for that direction is the sentence above: "such a record already yields `unknown`
  // in the classifier", so nothing is lost by not running it.
  //
  // That held while `wireDecimal` refused strictly less than `readLedgerStatedAmount` did — every
  // figure the completeness reader could not read was one the RECORD reader could not read either.
  // The magnitude bound broke it: the completeness reader takes the HALVED bound and the record
  // reader takes the full one, so a GBP payment amount in [2^45, 2^46) is refused HERE and ADMITTED
  // there. The check is then excluded, the record is perfectly measurable, and a document whose
  // records simply do not match the attempt answers `clear` — measured end to end before this was
  // added.
  //
  // So the exclusion is kept exactly as wide as its justification: if every record IS measurable, the
  // classifier can reach `clear` and the skipped check is a hole rather than a saving, and the probe
  // refuses instead. Naming the figure is what stops the refusal reading as "this document is unpaid".
  const unusablePaymentAt = wireAmounts.findIndex((a) => a === null)
  if (unusablePaymentAt !== -1 && records.every((r) => r.amount !== null)) {
    return {
      ok: false,
      reason: `Xero states ${String((invoice.Payments ?? [])[unusablePaymentAt]?.Amount)} on a payment against `
        + 'this document, which IMS cannot use to check the collection against the total Xero reports '
        + 'paid, so it cannot tell how much of the document is already settled',
    }
  }
  if (amountPaid !== null && seen !== null && shortBy(amountPaid, seen, invoiceCurrency)) {
    return {
      ok: false,
      reason: `Xero reports ${formatLedgerMoney(amountPaid)} paid against this document but returned `
        + `${records.length === 0 ? 'no payments' : `payments totalling ${formatLedgerMoney(seen)}`}`,
    }
  }
  // o3d-zo4j — PAIR 2 OF 4, AND IT IS THE OTHER IDENTITY. `AmountPaid` is Xero's own total of THIS
  // collection — the comment above says so, and the shortfall check is built on it — so the two are
  // one quantity and an excess is the collection refuting the total that summarises it.
  //
  // IT NEEDS ITS OWN MEASUREMENT rather than being left to pair 3, which straddles it. `AmountPaid 10`
  // with `Payments` totalling 30, `AmountCredited 20` and an unsent `CreditNotes` collection makes
  // `settled` 30 and `explained` 30: pair 3 agrees exactly while the payment list overruns the
  // payment total by 20. One pair per identity, or an excess hides inside a matching sum.
  const paymentsExceedTotal = amountPaid !== null && seen !== null && exceeds(seen, amountPaid, invoiceCurrency)

  // THE SHAPE-INDEPENDENT SETTLEMENT ACCOUNTING (Codex round 6, finding 3) — the same arithmetic
  // the QuickBooks probe already does, for the same reason, because `AmountPaid` is not the whole
  // of what settles a Xero document.
  //
  // WHAT XERO CAN AND CANNOT SEE FROM HERE. A credit note allocated to this invoice reduces
  // `AmountCredited`, NOT `AmountPaid`, and does not appear in `Payments` at all. So an invoice a
  // human has settled entirely with a credit note reads as `AmountPaid: 0, Payments: []` — the
  // strongest answer this probe can give, "positively nothing settles this document", and false.
  // Prepayment and overpayment allocations are the same shape.
  //
  // So the question asked here is arithmetic, not vocabulary: `Total - AmountDue` is Xero's own
  // account of how much of this document has been settled BY ANY MEANS, and every penny of it has
  // to be explained by something this probe actually read — a payment, or an applied credit /
  // prepayment / overpayment. Whatever is left over is money off the document by a shape IMS
  // cannot see, and a `clear` built on the payment list alone would be a claim that list cannot
  // support.
  //
  // WHAT THIS COSTS, STATED. An invoice whose credit is reported in `AmountCredited` while the
  // `CreditNotes` collection is missing or short can no longer be posted to automatically; the row
  // fails visibly and a human resolves it. A credit that IS itemised explains itself and changes
  // no verdict, so the ordinary part-credited invoice still pays automatically — which is the
  // difference between reading the collections and simply refusing on `AmountCredited > 0`.
  // o3d-obyd: read at the top of this arm, with the refusal that a stated-but-unreadable one now
  // takes. What is left here is only which of them this check uses.
  const total = totalRead.value
  const amountDue = amountDueRead.value
  const amountCredited = amountCreditedRead.value
  // o3d-obyd r31 (Codex HIGH 2) — TWO FORMS OF ONE FIGURE, AND THEY MUST AGREE OR NEITHER IS BELIEVED.
  //
  // THEY ARE ONE FIGURE, BY XERO'S OWN DEFINITION. `AmountDue = Total - AmountPaid - AmountCredited`,
  // so `Total - AmountDue` and `AmountPaid + AmountCredited` are the SAME quantity — how much has
  // come off this document — rearranged. The fallback exists because a response may omit the totals,
  // not because the two are different questions.
  //
  // THE DEFECT. The code took `Total - AmountDue` unconditionally whenever the pair was present and
  // never looked at the other. So `Total 100, AmountDue 100, AmountPaid 0, AmountCredited 10,
  // Payments: []` produced a settled value of EXACTLY ZERO — `statesAnything` false, the shortfall
  // check passes on nothing, the empty list is "proved", and the classifier answers `clear` — while
  // the same response simultaneously states that 10 was credited. A proved zero forged out of two
  // figures that contradict each other, and `clear` is what authorises a second payment.
  //
  // THE PREVIOUS ROUND MET THIS EXACT SHAPE AND ONLY CORRECTED THE FIXTURE — a test invoice whose
  // `Total - AmountDue` said 60 had settled while `AmountPaid + AmountCredited` said 50. Removing the
  // contradiction from the test data left production still accepting it, which is why it is a code
  // path now and not a comment.
  //
  // WHY REFUSE RATHER THAN PREFER THE LARGER. Taking whichever figure is safer would be picking a
  // winner between two statements that cannot both be true, which is a guess about WHICH ONE Xero
  // meant. When two derivations of one quantity disagree, the RESPONSE is incoherent — stale, partial
  // or malformed — and nothing else read out of it is trustworthy either, including the collections
  // the shortfall check is about to measure. So the probe refuses, the row holds visibly, and a human
  // looks at a document Xero is describing inconsistently.
  //
  // THE BAND IS `completenessBand`, the same fraction of the document's own minor unit every other
  // completeness comparison in this file uses — not equality, because both sides are read from stated
  // decimals and the ordinary document agrees to the penny.
  const settledFromTotals = total !== null && amountDue !== null ? subtractMoney(total, amountDue) : null
  // Fallback for a response that omits the totals: the two component fields, which is still
  // strictly more than `AmountPaid` alone was.
  const settledFromComponents = amountPaid !== null && amountCredited !== null
    ? addMoney(amountPaid, amountCredited)
    : null
  if (settledFromTotals !== null && settledFromComponents !== null
    && compareDecimal(subtractMoney(settledFromTotals, settledFromComponents).abs(),
      completenessBand(invoiceCurrency)) > 0) {
    return {
      ok: false,
      reason: `Xero states two amounts settled against this document that do not agree — `
        + `${formatLedgerMoney(settledFromTotals)} by Total less AmountDue and `
        + `${formatLedgerMoney(settledFromComponents)} by AmountPaid plus AmountCredited. These are `
        + 'the same figure in Xero\'s own arithmetic, so the response is inconsistent and IMS cannot '
        + 'tell how much of the document is already settled from either of them',
    }
  }
  const settled = settledFromTotals ?? settledFromComponents
  const applied = sumExact([
    sumApplied(invoice.CreditNotes, invoiceCurrency),
    sumApplied(invoice.Prepayments, invoiceCurrency),
    sumApplied(invoice.Overpayments, invoiceCurrency),
  ])
  // Null the moment any read settlement is unmeasurable: an unknown addend makes the whole sum
  // unknown, and an unknown sum must not be allowed to "explain" anything.
  const explained = sumExact(wireAmounts, applied)
  if (settled !== null && statesAnything(settled, invoiceCurrency)
    && (explained === null || shortBy(settled, explained, invoiceCurrency))) {
    return {
      ok: false,
      reason: `Xero reports ${formatLedgerMoney(settled)} already settled against this document but `
        + (explained === null
          ? 'IMS could not measure what it holds against it'
          : `only ${formatLedgerMoney(explained)} of it is accounted for by settlements IMS can read`)
        + (amountCredited !== null && statesAnything(amountCredited, invoiceCurrency)
          ? ` (${formatLedgerMoney(amountCredited)} of it credited, not paid)`
          : ''),
    }
  }

  // o3d-nk5n — AND HERE IT IS CLOSED, WHERE o3d-mm51 FILED IT.
  //
  // THE DEFECT, AS IT STOOD. An invoice that states NO usable figure — no `Total`/`AmountDue` pair
  // and no `AmountPaid`/`AmountCredited` fallback pair — runs NEITHER check above and fell through to
  // `ok: true` over whatever `records` holds. With an absent or empty `Payments` collection that is
  // an EMPTY list, which `classifyLedgerSettlement` reads as `clear`: the same positive claim on no
  // evidence the QuickBooks arm was refused for. The exclusion the paragraphs above justify is about
  // two shapes — a response that omits `Total`/`AmountDue` (the `settled` fallback exists for it) and
  // an unsettled invoice that states no `AmountCredited` — and in BOTH of those the fallback's OTHER
  // operand is stated, so `settled` is computable and the check runs. Stating too little for EITHER
  // form was wider than that justification, and the width was the whole finding.
  //
  // WHY THE PREVIOUS ROUND FILED IT INSTEAD. Not the code: 25 fixtures across
  // `money-post-authorisation.test.ts` and `settlement-probe.test.ts` modelled an ordinary FIRST
  // payment as the figureless stub `{ InvoiceID: 'inv-1', Payments: [] }`, so closing it failed six
  // money-post fence tests whose subject is that a first payment proceeds. That is a false model of
  // Xero, not a cost of the rule — `XeroInvoice` in `xero/invoice-delta.ts` records that Xero returns
  // these figures "on every invoice", and says in as many words that their optionality exists only
  // "because the fixtures predate them". The fixtures now state what Xero states, and the ordinary
  // first payment proves its own emptiness instead of being excused from having to.
  //
  // WHAT THE ORDINARY FIRST PAYMENT DOES NOW. An unpaid invoice states `Total` and `AmountDue` EQUAL,
  // so `settled` is exactly zero, `statesAnything` is false, the check above PASSES, and the probe
  // answers `ok: true` with an empty record list — `clear`, and the payment posts. Emptiness proved
  // by two stated figures rather than assumed from four missing ones, which is the same sentence the
  // QuickBooks arm has carried since o3d-mm51 and now the same FUNCTION.
  //
  // o3d-obyd r31: and the SECOND thing `settled` decides here is whether the `Payments` list is
  // proved whole. It is the identical fact — a stated figure the collection was measured against —
  // spent on the other half of Codex's asymmetry, so both leave through one function.
  // o3d-zo4j — PAIR 3 OF 4, AND IT IS THE COMPOSED IDENTITY. `settled` is `Total - AmountDue`, which
  // is `AmountPaid + AmountCredited` by Xero's own definition; `explained` is `SUM(Payments) +
  // SUM(applied credit notes, prepayments, overpayments)`, and those two sums are what `AmountPaid`
  // and `AmountCredited` respectively total. So the pair is one quantity again, by two of Xero's
  // identities composed rather than one.
  //
  // THE ONE PAIR WHERE AN EXCESS COULD CONCEIVABLY BE INNOCENT, stated rather than glossed: it
  // requires a settlement to be reported in BOTH `Payments` and one of the applied collections, and
  // nothing observed says Xero does that. If it ever did, the cost is bounded to exactly what this
  // rule spends — a non-matching probe holds visibly instead of clearing, a matching one is still
  // `present`, and no money post is refused outright — which is why the rule withholds proof rather
  // than refusing the probe. The reverse mistake is a second payment.
  const settlementsExceedFigure = settled !== null && explained !== null
    && exceeds(explained, settled, invoiceCurrency)
  return settlementAnswer(settled, paymentsExceedTotal || settlementsExceedFigure, records,
    'Xero states no total, amount due, amount paid or amount credited on this document and IMS '
    + 'read no payment against it, so it has nothing to tell from — an empty answer here would say '
    + 'that nothing has settled the document rather than report what does')
}

// o3d-r948 — `XERO_AMOUNT_EPSILON` AND `QBO_AMOUNT_EPSILON` WERE HERE, BOTH `0.005`, AND BOTH ARE
// GONE. They were the ninth site of o3d-78rq's enumeration: two flat half-pennies measuring wire
// doubles, in a file whose classifier operand had already become exact and whose band had already
// become a fraction of the document's own minor unit. The direction they failed in was TOO WIDE,
// which is the direction that lets a `clear` be built from an incomplete list — see
// `completenessBand`, which is now the single answer for all four checks and both connectors.

type QboLinkedTxn = { TxnId?: string; TxnType?: string }
type QboPaymentLine = { Amount?: number; LinkedTxn?: QboLinkedTxn[] }
type QboDocumentBody = {
  LinkedTxn?: QboLinkedTxn[]
  /**
   * The document's face value and what is still owed on it — the shape-independent cross-check.
   *
   * o3d-obyd: `number | string`, and the string is not a defensive maybe. QuickBooks serialises these
   * as JSON STRINGS — `"1200.00"`, `"0.00"` — which is o3d-psrx r10's finding on this same connector,
   * where `typeof row.Balance === 'number'` failed on a real `Balance` and the payment poller moved to
   * `parseLedgerAmount`. Declaring them as `number` is what made a reader that only accepted numbers
   * look correct beside them; the type now says what the wire says.
   */
  TotalAmt?: number | string
  Balance?: number | string
  /**
   * o3d-78rq — the currency the applied amounts below are stated in. QuickBooks OMITS this whenever
   * multicurrency is off, which is the ordinary single-currency company, so `null` is the common case
   * and not an error: `ledgerMinorUnits(null)` answers it exactly as it answers every other unstated
   * currency in this repository.
   */
  CurrencyRef?: { value?: string }
}

/**
 * WHAT QUICKBOOKS ACTUALLY WRITES INTO `LinkedTxn.TxnType` (Codex round 4, finding 1).
 *
 * The entity you POST is `BillPayment`. The link QuickBooks then records on the Bill is NOT
 * `BillPayment` — it is `BillPaymentCheck` or `BillPaymentCreditCard`, named after the PayType.
 * IMS posts `PayType: 'Check'`, so every bill payment this system has ever made is recorded as
 * `BillPaymentCheck`, and a probe matching on `BillPayment` found NONE of them. It reported
 * `records: []`, the classifier read that as `clear`, and the fence treated "I looked and there
 * is nothing" as permission to pay the bill again. A probe that cannot see a real settlement is
 * worse than no probe at all, because the fence claims a coverage it does not have.
 *
 * Hence three rules, not one:
 *
 *  1. PAYMENT links — the shape IMS itself posts — are enumerated and READ. Both bill-payment
 *     spellings, plus the bare entity name defensively, because a name that has changed once can
 *     change again and the cost of accepting an extra alias is nil.
 *  2. Links that are KNOWN not to be that shape are ignored, and which ones they are is written
 *     down (below) instead of being left to a silent `filter`.
 *  3. Anything else FAILS THE PROBE. An unclassified link type is exactly the state this bug was
 *     in for a whole release: a settlement the probe cannot account for, silently dropped. It is
 *     now an `unknown`, which every caller treats as a refusal.
 */
const QBO_PAYMENT_LINK_TYPES: Record<'Bill' | 'Invoice', ReadonlySet<string>> = {
  // Read from /billpayment/{id} whichever of the three names the link carries.
  Bill: new Set(['BillPaymentCheck', 'BillPaymentCreditCard', 'BillPayment']),
  // Customer payments keep the plain entity name on the invoice's link.
  Invoice: new Set(['Payment']),
}

/**
 * RECOGNISED, AND NOT THEREFORE HARMLESS (Codex round 5, finding 3).
 *
 * These links take money off the document by a shape IMS neither posts nor reads. Round 4 lumped
 * them in with the links that take NO money off it and ignored both, so a bill an operator had
 * settled with a vendor credit or a journal entry came back from this probe as `records: []` —
 * which the classifier reads as `clear` and the fence acts on. "Recognised" was doing the work of
 * "accounted for", and they are not the same claim: an unrecognised type fails closed, while a
 * recognised-but-uncovered one was reported as a positive clear. That is a lie about money.
 *
 * They are still not fetched — none of them can BE an IMS attempt, and reading five more entity
 * shapes to measure them is a bigger change than this fence should carry. What they do instead is
 * make the document's own arithmetic decide: see the settlement accounting at the end of
 * `probeQuickBooksSettlement`. A linked vendor credit that has taken nothing off the balance
 * changes no verdict; one that has taken money off leaves an amount no readable payment explains,
 * and the probe then refuses instead of reporting a clear it cannot support.
 */
const QBO_UNCOVERED_SETTLEMENT_LINK_TYPES: ReadonlySet<string> = new Set([
  'CreditMemo', 'VendorCredit', 'Deposit', 'JournalEntry', 'Refund', 'RefundReceipt',
  'Check', 'Expense', 'Purchase', 'Transfer', 'CreditCardCredit', 'CreditCardPayment',
  // The other document kind's payment link. Treated as a settlement rather than as noise: it is
  // payment-shaped money movement, and its appearing on a document this probe does not read it
  // for means the reasoning about which endpoint holds the settlements is already off.
  'Payment', 'BillPayment', 'BillPaymentCheck', 'BillPaymentCreditCard',
])

/**
 * Links that carry no money off the document at all: what it was raised FROM, and what was billed
 * ONTO it. These genuinely are noise, and ignoring them is what stops the probe refusing every
 * bill that came from a purchase order.
 */
const QBO_NON_SETTLING_LINK_TYPES: ReadonlySet<string> = new Set([
  'Estimate', 'PurchaseOrder', 'SalesReceipt', 'TimeActivity', 'ReimburseCharge', 'Charge',
  'Invoice', 'Bill', 'InventoryQuantityAdjustment',
])

/**
 * The amount a QuickBooks payment applied to ONE document.
 *
 * Not TotalAmt: a payment can settle several invoices at once, and IMS's own attempt posts a single
 * line for a single document. Summing the lines linked to this document is what compares like with
 * like. A payment with no readable line for it yields null, which reads as `unknown`.
 */
function qboAmountAppliedTo(
  lines: QboPaymentLine[] | undefined,
  documentId: string,
  txnType: string,
  currency: string | null,
): { wire: number | null; exact: Decimal | null } {
  if (!lines) return { wire: null, exact: null }
  let wire: number | null = null
  let exact: Decimal | null = null
  for (const line of lines) {
    const linked = (line.LinkedTxn ?? []).some(
      (t) => str(t.TxnId) === documentId && str(t.TxnType) === txnType,
    )
    if (!linked) continue
    const amount = num(line.Amount)
    if (amount === null) return { wire: null, exact: null }
    // o3d-mm51: the EXACT term takes the same magnitude reading the document's own figures now do.
    // `explained` is the side of `shortBy` that ACCOUNTS for money, so a decode that can no longer
    // hold half a minor unit inflates it and swallows the very shortfall it was measuring. The `wire`
    // term is deliberately left as the untouched double: `statedAmount` judges THAT one with the rule
    // its own decision needs (`readLedgerStatedAmount`, the full amount bound plus the scale), and a
    // line this reading refuses makes the whole payment unmeasurable, which withholds.
    const reading = wireAmount(amount, currency)
    if (reading.value === null) return { wire: null, exact: null }
    // TWO READINGS OF THE SAME LINES, FROM ONE WALK (o3d-r948).
    //
    // `wire` is the double sum, UNCHANGED, and it is what `statedAmount` is asked about — the record's
    // amount must be a figure `readLedgerStatedAmount` can prove the ledger stated, and a summed
    // double is exactly the shape that rule exists to judge (o3d-78rq).
    //
    // `exact` is the same lines added as decimals, for the completeness arithmetic, which asks a
    // different question and must not lose a minor unit in its own addition. They are returned
    // together so nothing can ever sum a DIFFERENT set of lines for the two answers.
    wire = (wire ?? 0) + amount
    exact = (exact ?? toDecimal(0)).add(reading.value)
  }
  return { wire, exact }
}

export async function probeQuickBooksSettlement(
  target: SettlementProbeTarget,
  qboGet: QboFetcher,
): Promise<LedgerSettlementProbe> {
  const payload = asRecord(target.payload)
  const documentId = str(payload.accountingInvoiceId)
  if (target.type === 'PURCHASE_CREDIT_NOTE_ALLOCATION') {
    // The QuickBooks processor has no branch for this type, so a row of it cannot have posted here
    // — but "cannot have posted" is a claim about code, and this module's contract is evidence.
    return { ok: false, reason: 'QuickBooks does not post credit-note allocations, so IMS cannot read one back' }
  }
  if (!documentId) return { ok: false, reason: 'the row records no document id to check' }

  const isBill = target.type === 'BILL_PAYMENT'
  const documentPath = isBill ? 'bill' : 'invoice'
  const documentKey = isBill ? 'Bill' : 'Invoice'
  const settlementPath = isBill ? 'billpayment' : 'payment'
  // The entity NAME a payment is read back under, which is not the same string as the LINK type
  // the document carries — see QBO_PAYMENT_LINK_TYPES.
  const settlementKey = isBill ? 'BillPayment' : 'Payment'
  const linkedType = isBill ? 'Bill' : 'Invoice'
  const paymentLinkTypes = QBO_PAYMENT_LINK_TYPES[documentKey]

  const doc = await qboGet<Record<string, QboDocumentBody | undefined>>(
    `${documentPath}/${encodeURIComponent(documentId)}`,
  )
  if (!doc.ok) return { ok: false, reason: doc.error ?? `HTTP ${doc.status}` }
  const body = doc.data?.[documentKey]
  if (!body) return { ok: false, reason: `QuickBooks returned no ${documentKey.toLowerCase()} for that id` }

  const links = body.LinkedTxn ?? []
  // Rule 3 first, so an unclassified link cannot be quietly outvoted by classified ones.
  //
  // A link with NO READABLE TYPE counts as unclassified (Codex round 5, finding 4, escape one).
  // Round 4 excluded `type !== ''` from this filter, so a link whose TxnType was absent, blank or
  // not a string was matched by nothing: not a payment, so never read; not unclassified, so never
  // refused. It is the same "a settlement the probe cannot account for, silently dropped" this
  // rule exists to stop, wearing a missing field instead of a new name.
  const unclassified = [...new Set(links.map((t) => str(t.TxnType) || '(untyped)').filter(
    (type) => !paymentLinkTypes.has(type) && !QBO_UNCOVERED_SETTLEMENT_LINK_TYPES.has(type)
      && !QBO_NON_SETTLING_LINK_TYPES.has(type),
  ))]
  if (unclassified.length > 0) {
    return {
      ok: false,
      reason: `QuickBooks linked ${unclassified.join(', ')} to this ${documentKey.toLowerCase()} and this `
        + 'probe cannot tell whether that settles it',
    }
  }

  const paymentLinks = links.filter((t) => paymentLinkTypes.has(str(t.TxnType)))
  // A PAYMENT LINK WITH NO ID cannot be fetched, and dropping it is the second escape (Codex
  // round 5, finding 4). `.filter(Boolean)` removed it silently, leaving a settlement this probe
  // KNOWS exists out of the record list it then reports as complete — the same shape as the
  // unreadable-settlement refusal below, and it must fail the same way.
  if (paymentLinks.some((t) => str(t.TxnId) === '')) {
    return {
      ok: false,
      reason: `QuickBooks linked a ${settlementKey} to this ${documentKey.toLowerCase()} with no id, `
        + 'so IMS cannot read what it settled',
    }
  }
  const settlementIds = paymentLinks.map((t) => str(t.TxnId))

  const documentCurrency = ledgerCurrencyCode(body.CurrencyRef?.value)
  const records: LedgerSettlementRecord[] = []
  // o3d-78rq: as on the Xero side, the applied figures are kept for the completeness arithmetic and
  // the records carry the ones `readLedgerStatedAmount` will vouch for. `qboAmountAppliedTo` SUMS a
  // payment's lines, and a sum of doubles is exactly where a figure stops being the one the ledger
  // stated — which is why the record's reading is asked of that sum rather than assumed of it.
  //
  // o3d-r948: and the completeness term is the SAME lines added exactly. Two readings, one walk.
  const wireApplied: Array<Decimal | null> = []
  for (const id of settlementIds) {
    const res = await qboGet<Record<string, { TxnDate?: string; PrivateNote?: string; Line?: QboPaymentLine[] } | undefined>>(
      `${settlementPath}/${encodeURIComponent(id)}`,
    )
    // A settlement we know EXISTS but cannot read is the most dangerous shape of all: dropping it
    // would leave a clear verdict built from an incomplete list.
    if (!res.ok) return { ok: false, reason: `could not read ${settlementKey} ${id}: ${res.error ?? `HTTP ${res.status}`}` }
    const settlement = res.data?.[settlementKey]
    if (!settlement) return { ok: false, reason: `QuickBooks returned no ${settlementKey} ${id}` }
    const date = str(settlement.TxnDate)
    const applied = qboAmountAppliedTo(settlement.Line, documentId, linkedType, documentCurrency)
    wireApplied.push(applied.exact)
    records.push({
      ...statedAmount(applied.wire, documentCurrency),
      date: date.length >= 10 ? date.slice(0, 10) : null,
      id,
      // PrivateNote is where IMS writes its mark on this connector.
      reference: str(settlement.PrivateNote) || null,
    })
  }

  // THE SHAPE-INDEPENDENT SETTLEMENT ACCOUNTING. Everything above depends on a list of type names
  // being right, and the bug this replaces was a list of type names being wrong. `TotalAmt` and
  // `Balance` are not names — they are the document's own account of how much of it has been
  // settled, by any means whatsoever. So the question asked here is arithmetic, not vocabulary:
  // is every penny that has come off this document explained by a settlement this probe actually
  // READ? Whatever is not is money moved by something the record list below does not contain, and
  // a `clear` built from that list would be a claim the list cannot support.
  //
  // Round 4 asked this only when NOTHING was linked, which is why finding 3 was possible: a
  // vendor credit or a journal entry appears as a link, was "recognised", and so suppressed the
  // only check that could have noticed it had taken money off the bill.
  //
  // WHAT THIS COSTS, STATED. A document part-settled by a shape IMS does not read — a vendor
  // credit, a deposit, a manual journal — can no longer be posted to automatically; the row fails
  // visibly and a human resolves it. That is a real cost and it is the right way round: the
  // alternative is the fence being told the document is clear when an operator has already
  // settled it. Restoring automatic coverage means READING those entities (each has its own line
  // and link shape), which is a bigger change than this fence should carry — tracked separately.
  //
  // o3d-obyd — ARM 3 OF 3, AND THE ONE THE FINDING IS ABOUT. QuickBooks sends these two as STRINGS —
  // that is o3d-psrx r10, recorded in this connector's own payment poller, which is why the poller
  // reads them through `parseLedgerAmount`. This probe was not moved with it, so `TotalAmt: "1200.00"`
  // with `Balance: "0.00"` read as no figures at all, `applied` was null, and with nothing uncovered
  // linked the check below did not run: `ok: true` over an EMPTY record list, `clear`, and a second
  // payment against a bill QuickBooks reports as fully settled.
  const totalRead = wireAmount(body.TotalAmt, documentCurrency)
  const balanceRead = wireAmount(body.Balance, documentCurrency)
  const cannotRun = completenessCannotRun([['TotalAmt', totalRead], ['Balance', balanceRead]])
  if (cannotRun !== null) {
    return {
      ok: false,
      reason: `QuickBooks states ${cannotRun} on this ${documentKey.toLowerCase()}, which IMS cannot read `
        + 'as an amount, so it cannot tell how much of it is already settled',
    }
  }
  const total = totalRead.value
  const balance = balanceRead.value
  const applied = total !== null && balance !== null ? subtractMoney(total, balance) : null
  // Null the moment any read settlement's applied amount is unreadable: an unknown addend makes
  // the whole sum unknown, and an unknown sum must not be allowed to "explain" anything.
  const explained = sumExact(wireApplied)
  // `Payment` and the bill-payment spellings appear in BOTH tables — they are the covered shape on
  // one document kind and an uncovered one on the other — so the payment table wins first, or a
  // settlement this probe has just READ would be counted as one it cannot account for.
  const uncovered = [...new Set(links.map((t) => str(t.TxnType)).filter(
    (type) => !paymentLinkTypes.has(type) && QBO_UNCOVERED_SETTLEMENT_LINK_TYPES.has(type),
  ))]
  if (applied === null) {
    // The document's own numbers are missing, so nothing can be reconciled against them. Only a
    // problem when a settlement IMS cannot measure is linked — otherwise the read payments are
    // the whole picture and the classifier judges them on their own terms.
    if (uncovered.length > 0) {
      return {
        ok: false,
        reason: `QuickBooks links ${uncovered.join(', ')} to this ${documentKey.toLowerCase()} and reports no `
          + 'total or balance, so IMS cannot tell how much of it is already settled',
      }
    }
    // o3d-mm51 (Codex HIGH 2) — AND ABSENCE MUST NOT DO MORE THAN SKIP.
    //
    // THE DEFECT. o3d-obyd drew ABSENT apart from UNREADABLE and was right to: a check that cannot be
    // run must not FAIL, or every ordinary document would refuse. What it then let absence do is more
    // than skip. With no `TotalAmt` and no `Balance`, `applied` is null, the arithmetic above is
    // skipped, and control fell through to `return { ok: true, records }` — over an EMPTY record
    // list, which `classifyLedgerSettlement` reads as `clear`. That is not the ABSENCE of a
    // conclusion, it is the POSITIVE conclusion "nothing has settled this document" drawn from having
    // no figure to read, and `clear` is what authorises a money post. A sparse or schema-degraded
    // `{ Bill: {} }` could buy a second payment with it.
    //
    // SO THE TWO ARE SEPARATED. Skipping arithmetic that cannot be done stays — that part was right.
    // CONTRIBUTING A CONCLUSION does not: when the document states neither figure AND this probe read
    // no settlement of its own, it has nothing to answer from in EITHER direction, and it says so
    // rather than answering in the permissive one.
    //
    // WHAT AN ORDINARY FIRST PAYMENT DOES — which is what absence was kept permissive FOR, and it
    // still works. QuickBooks states `TotalAmt` and `Balance` on every bill and invoice that exists,
    // and an unpaid one states them EQUAL. So the ordinary first payment reads `TotalAmt "1200.00"`
    // with `Balance "1200.00"`, `applied` is exactly 0, `statesAnything` is false, the check PASSES,
    // and the probe answers `ok: true` with an empty record list — `clear`, and the payment posts.
    // That is emptiness PROVED by two stated figures rather than assumed from two missing ones, which
    // is the whole difference. The refusal below is reachable only by a document that states neither,
    // and that is not a shape QuickBooks sends for a document that is there.
    //
    // AND A DOCUMENT WITH NO FIGURES WHOSE SETTLEMENTS THIS PROBE DID READ still answers — but
    // o3d-obyd r31 corrected WHAT it answers. This paragraph used to end "`records` is then evidence
    // in its own right and the verdict is decided by comparing it", and that is true only of a
    // COMPARISON THAT MATCHES. With no `TotalAmt` and no `Balance` nothing measured the link list, so
    // a linked payment that is not ours does not show that ours is absent — QuickBooks may simply not
    // have sent it. Such an answer is now marked unproved and a non-match yields `unknown`; a match
    // still yields `present`. See `settlementAnswer` and `LedgerSettlementProbe.provedComplete`.
    //
    // o3d-nk5n: and this rule is the SHARED one rather than this arm's own. Both Xero arms reached
    // the same fall-through and were closed by routing through the same function — `applied` is this
    // arm's `settled`. Shared rather than re-spelled so that a change to the rule cannot reach one
    // connector and miss the other; r31 is that guarantee being cashed, since it changed the rule for
    // all three arms by changing one function.
  } else if (statesAnything(applied, documentCurrency)
    && (explained === null || shortBy(applied, explained, documentCurrency))) {
    return {
      ok: false,
      reason: `QuickBooks reports ${formatLedgerMoney(applied)} already applied to this ${documentKey.toLowerCase()} but `
        + (explained === null
          ? 'IMS could not measure what the payments it links applied to it'
          : `only ${formatLedgerMoney(explained)} of it is accounted for by payments IMS can read`)
        + (uncovered.length > 0
          ? ` (${uncovered.join(', ')} linked)`
          : links.length === 0 ? ' and links no transaction that accounts for it' : ''),
    }
  }
  // o3d-zo4j — PAIR 4 OF 4, AND IT IS THE ONE THAT IS A BOUND RATHER THAN AN IDENTITY — WHICH IS WHY
  // IT TAKES THE EXCESS RULE AND NOT THE MIRROR OF THE SHORTFALL ONE.
  //
  // `TotalAmt - Balance` counts money off this document by ANY means, including the vendor credits,
  // deposits and journals this probe does not read; `explained` counts only the payment lines it did.
  // So the honest relation is `explained <= applied`, not equality — that inequality is exactly why
  // the shortfall check above is a real check and not a tautology. It also makes an EXCESS a
  // contradiction outright: every payment line linked to this document reduces its `Balance` by the
  // amount of that line, so the read payments can never account for MORE than the document says has
  // come off it. A voided QuickBooks payment states a zero line and an unapplied one is not linked,
  // so neither reaches this sum; the one shape that could produce an excess innocently is a payment
  // AMENDED between the document read and the payment read, and a picture assembled across an edit is
  // not one to certify a collection from either.
  const paymentsExceedApplied = applied !== null && explained !== null
    && exceeds(explained, applied, documentCurrency)
  return settlementAnswer(applied, paymentsExceedApplied, records,
    `QuickBooks states no total or balance on this ${documentKey.toLowerCase()} and IMS read no `
    + 'settlement against it, so it has nothing to tell from — an empty answer here would say '
    + 'that nothing has settled the document rather than report what does')
}

/**
 * Ask a connector what it already holds against the document this row targets.
 *
 * Never throws: a thrown probe would be caught by the caller's outer try and reported as a generic
 * action failure, which reads to an operator as "try again" — the opposite of the intended refusal.
 */
export async function probeLedgerSettlement(
  connector: 'xero' | 'quickbooks',
  target: SettlementProbeTarget,
): Promise<LedgerSettlementProbe> {
  // o3d-r948 r6 — THE TWO-SNAPSHOT PROVENANCE READ WAS HERE, AND IS GONE.
  //
  // r5 read the active token before and after the fetch and reported the value when the two agreed,
  // so a caller could tell whether the ids it held belonged to the organisation that answered. Two
  // reads of one value prove nothing about the interval between them: an A→B→A reconnect across the
  // remote call makes both say A while B served it, and the records would then be labelled A.
  //
  // Nothing consumes the answer now — `classifyLedgerSettlement` excludes no record on any identity
  // — so the unsound reading is removed rather than left standing beside a caller that might trust
  // it. A sound version is REQUEST-BOUND, not snapshot-bound: propagate the `tenantId` `XeroResponse`
  // already carries and the `realmId` `qboFetch` resolves and drops, and refuse a multi-fetch probe
  // whose responses disagree. bd o3d-llyw has the estimate.
  try {
    return connector === 'xero'
      ? await (async () => {
        const { xeroGet } = await import('./xero/api')
        return await probeXeroSettlement(target, xeroGet as XeroFetcher)
      })()
      : await (async () => {
        const { qboGet } = await import('./quickbooks/api')
        return await probeQuickBooksSettlement(target, qboGet as QboFetcher)
      })()
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * The document a probe answers about, so several rows targeting the same one share a single read.
 *
 * Delegates to the SAME key the money-post lock is taken on (round 6, Codex CRITICAL #2): the
 * document the verdict covers and the document the probe reads must not be able to be two
 * different things.
 */
export function settlementProbeKey(target: SettlementProbeTarget): string {
  return settlementDocumentKey(target.type, target.payload)
}

/**
 * o3d-0m56 — the AUTOMATIC counterpart of the manual retry's settlement rule.
 *
 * `planFollowUpEnqueue` revives a FAILED money row under the token that row's attempt used, on the
 * same reasoning the manual retry used to rely on: the remote will recognise the repeat. It will
 * not, once its deduplication window has closed, and a re-enqueue happens whenever the connector
 * next runs — which for a row that failed hours ago is far outside that window. So the automatic
 * path has to establish the same thing the operator-facing one does: that this attempt is not
 * already in the ledger.
 *
 * Only for a PINNED token: a rotated one means the planner already established that no surviving
 * attempt could have committed this document, so there is nothing to have happened twice.
 */
export async function ledgerClearsFollowUpRevival(params: {
  connector: 'xero' | 'quickbooks'
  type: string
  payload: unknown
  tokenDisposition: 'pinned' | 'rotated'
  /** The row being revived, so its own mark can be looked for. */
  syncLogId?: string
}): Promise<{ clear: true } | { clear: false; reason: string }> {
  const { isMoneyMovingSyncType, effectiveTokenFor } = await import('@/lib/domain/accounting/followup-retry-guard')
  if (params.tokenDisposition !== 'pinned' || !isMoneyMovingSyncType(params.type)) return { clear: true }

  const { classifyLedgerSettlement, describeAttempt, settlementMarkerFor } = await import('@/lib/domain/accounting/ledger-settlement-evidence')
  const probe = await probeLedgerSettlement(params.connector, { type: params.type, payload: params.payload })
  const marker = settlementMarkerFor(effectiveTokenFor(params.connector, { id: params.syncLogId ?? '', payload: params.payload }))
  // o3d-r948 r6 — AN UNMEASURABLE SETTLEMENT HOLDS THIS REVIVAL BACK, AND NOW THAT IS THE ONLY RULE.
  //
  // r3 to r5 this gate carried a note explaining why it passed no `settlementsOfOtherAttempts`: it
  // is handed ONE row and no siblings, so it held no ids to exclude with, and it accepted the
  // resulting hold as the cost of the rule rather than a gap in it. r6 removed the option outright
  // (see `classifyLedgerSettlement`), so every caller is now in the position this one was always in
  // — and the note is kept only so the next reader knows the omission here was deliberate before it
  // was mandatory.
  const verdict = classifyLedgerSettlement(describeAttempt(params.type, params.payload, marker), probe)
  if (verdict.outcome === 'clear') return { clear: true }
  return {
    clear: false,
    reason: verdict.outcome === 'present'
      ? `the ledger already holds a settlement of ${verdict.detail} matching this attempt`
      : verdict.reason,
  }
}

/**
 * o3d-0m56 round 2 (Codex) — THE CHECK THAT ACTUALLY AUTHORISES A MONEY POST.
 *
 * Everything above runs at RETRY or ENQUEUE time, which is early enough to tell an operator why
 * their click was refused and far too early to be the thing money depends on. Two gaps proved it:
 *
 *   - A failed money row does not go straight to FAILED. It returns to PENDING for up to five
 *     attempts, and each of those attempts posts again with no ledger read at all — the revival
 *     guard only ever saw terminal rows.
 *   - A verdict taken before a lock is a verdict about the past. Between reading the ledger and
 *     writing PENDING, something else can post the very attempt that was just declared absent.
 *
 * Both close the same way: the reading that permits a POST is taken in the same code path as the
 * POST, immediately before it. `remoteAttemptedAt` is what makes that possible — it is set once,
 * before the first call, and survives every retryCount reset, so a row can always answer "have I
 * been sent before?".
 *
 * Round 4 removed the last exemption. A first attempt in a scope nothing has been sent from used
 * to skip the ledger read entirely; it no longer does, because the settlement such a row cannot
 * know about is the one a HUMAN entered, and that is the case a first attempt is least equipped
 * to reason about and most likely to pay twice. Every money post now pays for one GET.
 *
 * "Everything else" is wider than this row's own history, and that is round 3: the fence judges
 * this attempt AND every rival attempt in the same scope, each against its own mark. A rival's
 * committed payment carries the rival's mark, so it is invisible to this row's — and invisible to
 * the amount-and-date fallback as soon as the two receipts differ.
 *
 * Returns the refusal as an ERROR rather than a silent skip: the caller reports it exactly like a
 * remote rejection, so the row retries a bounded number of times and then ends FAILED — visible,
 * and (correctly) un-revivable while the ledger still holds the payment.
 */
export type MoneyPostFenceParams = {
  connector: 'xero' | 'quickbooks'
  entryId: string
  type: string
  referenceType: string
  referenceId: string
  payload: unknown
  /**
   * THE DATE THIS POST IS SENDING — resolved ONCE, by the caller, and carried (Codex round 7,
   * HIGH #1).
   *
   * Round 6 gave the processor and the fence one shared function and called the mirror gone. It
   * was not: `moneyPostDateToSend`'s wall-clock arm answers about the `Date` it is handed, and the
   * two sides handed it two different instants. Astride a UTC midnight those are different days,
   * so the probe went looking for a settlement dated the 19th while the post created one dated the
   * 18th — and a human's payment on the 18th was therefore not matched. A weakened match is not a
   * conservative failure here; it is precisely how a real settlement goes unseen and a second
   * payment is authorised.
   *
   * REQUIRED, not defaulted: a fence that could fall back to a clock of its own is a fence that
   * still has a second resolution site in it. The value is the exact string the branch puts on the
   * wire, so the date this authorisation was taken against and the date the ledger will hold are
   * the same value by construction, not by agreement.
   */
  postingDate: string
  /** Injected so the guard is testable without a database. */
  db: {
    accountingSyncLog: {
      updateMany: (args: { where: { id: string; remoteAttemptedAt: null }; data: { remoteAttemptedAt: Date } }) => Promise<{ count: number }>
      findMany: (args: {
        where: {
          connector: string
          type: AccountingSyncType
          remoteAttemptedAt: { not: null }
          id: { not: string }
          /**
           * BOTH KEYS, IN A DEFINED ORDER (round 6, Codex CRITICAL #2): the local scope this row
           * sits in, then the external document it names — one arm per anchor THIS TYPE is
           * identified by (round 9, HIGH #1), each a CASE-INSENSITIVE match, because `equals` on a
           * JSON path is byte-exact and an enumeration of spellings cannot cover mixed case
           * (round 8, HIGH #1). See the query below.
           */
          OR: Array<
            | { referenceType: string; referenceId: string }
            | { payload: { path: string[]; string_contains: string; mode: 'insensitive' } }
          >
        }
        select: { id: true; payload: true }
      }) => Promise<Array<{ id: string; payload: unknown }>>
    }
  }
  /**
   * The clock for the ATTEMPT STAMP only, injected so the write is testable.
   *
   * Deliberately NOT the source of the posting date any more (round 7, Codex HIGH #1) — that
   * arrives as `postingDate`, already resolved. Two clocks on one path is exactly how the fence
   * ended up authorising a different day from the one it was authorising for.
   */
  now?: () => Date
}

export async function authoriseMoneyPost(
  params: MoneyPostFenceParams,
): Promise<{ proceed: true } | { proceed: false; error: string }> {
  const { isMoneyMovingSyncType } = await import('@/lib/domain/accounting/followup-retry-guard')
  if (!isMoneyMovingSyncType(params.type)) return { proceed: true }

  // ONE conditional write decides it, with no read first — and the absence of the read is the
  // point. "Has this been sent before?" asked as a SELECT is a question about the past: two
  // workers can both read `remoteAttemptedAt: null` and both conclude they are the first. Claiming
  // the stamp is the same question asked as a WRITE, which exactly one caller can win.
  //
  // count 1 — this call claimed the first attempt. Nothing can have been posted from this row
  //           before, so there is nothing to duplicate and nothing to check.
  // count 0 — the stamp is already set (a previous attempt), or the row is GONE (retention, a
  //           connector switch), or another worker claimed it a moment ago. All three mean the
  //           same thing here: IMS cannot say this row has never been sent, and unknown must
  //           never read as "first time".
  const now = params.now ?? (() => new Date())
  const claimed = await params.db.accountingSyncLog.updateMany({
    where: { id: params.entryId, remoteAttemptedAt: null },
    data: { remoteAttemptedAt: now() },
  })
  // This ROW may be new — but the DOCUMENT may not be (Codex round 3). A receipt recorded beside an
  // older failed attempt queues a brand-new row, and that row's first post would otherwise go out on
  // the strength of a reading taken before it was even created. So: every OTHER row that has ever
  // been sent and could have settled this document, whatever became of it.
  //
  // KEYED ON THE DOCUMENT AS WELL AS THE SCOPE (round 6, Codex CRITICAL #2). Round 5 asked only
  // about `(referenceType, referenceId)` — where the row lives in IMS. A rival row for the SAME
  // `accountingInvoiceId` filed under another scope (a re-raised purchase invoice, a payment row
  // re-created against a replacement order, a bill payment queued against the PO in one release
  // and the invoice in the next) was invisible to it, and invisible to the lock for the same
  // reason. The probe reads the document, so the rival's committed payment IS in the reading —
  // but it carries the RIVAL's mark, and the amount-and-date fallback loses it the moment the two
  // receipts differ. Nothing then refuses, and the document is paid twice.
  //
  // Both arms, in a defined order. The scope arm is first and is unconditional: it is indexed, and
  // it keeps a row with NO recorded anchor a contender of its own scope, which is what
  // `attemptCouldBeTheSameDocument` has always treated as "possibly this document". The document
  // arms follow, one per anchor THIS TYPE is identified by that this row actually names — with no
  // id there is nothing to match, and the probe below refuses such a post outright anyway.
  //
  // AND THE ARMS ARE THE TYPE'S OWN ANCHORS (round 9, Codex HIGH #1). They come from
  // `documentAnchorFields`, the same definition the lock key, the probe cache key and the contender
  // comparison use — so a type identified by something other than `accountingInvoiceId` cannot
  // leave this pre-filter looking somewhere the decision does not. They are OR'd, not AND'd: a row
  // that really is this document matches EVERY anchor and so matches the OR, whereas an AND would
  // drop a rival whose payload merely omits one of them. Over-fetching is free here and
  // under-fetching is the double post.
  //
  // AND CASE-FOLDED — FOR EVERY CASING, NOT THREE OF THEM (round 8, Codex HIGH #1). `equals` on a
  // JSON path is byte-exact in PostgreSQL, so a rival row holding the SAME Xero GUID in another
  // case was matched by neither arm: the scope arm because it sits elsewhere, the document arm
  // because `4D8A…` is not `4d8a…`. Round 7 answered that with three spellings — as-stored, lower,
  // upper — which a MIXED-case id is outside all of, leaving the identical cross-scope double post
  // one spelling further along. Enumerating spellings can never be complete; the fold has to be in
  // the predicate, so the arm is a case-insensitive match the database performs
  // (`LOWER(payload#>>…) LIKE LOWER(…)`, verified against the dev database — see
  // settlementDocumentAnchorFilters). The returned rows are still put through
  // `attemptCouldBeTheSameDocument` below, which folds case the same way, so this pre-filter can
  // only add contenders and never decides anything on its own.
  //
  // NOTHING IN THE TYPES CHECKS THIS ARM, and it was worth finding out: `db` is a structural shape
  // so the call sites never compare it with the real client, and Prisma's own `payload` filter type
  // admits any JSON object, so a misspelt filter key type-checks either way (both tried; `tsc
  // --noEmit` stayed silent across the repo for `string_contains_bogus`). A wrong key here would
  // therefore fail at runtime, inside the money-post lock. What pins it instead is the pair of
  // checks that can: this exact filter was run against the dev database, and the tests assert the
  // arm's shape literally.
  const documentFilters = settlementDocumentAnchorFilters(params.type, params.payload)
  const attemptedSiblings = await params.db.accountingSyncLog.findMany({
    where: {
      connector: params.connector,
      type: params.type as AccountingSyncType,
      remoteAttemptedAt: { not: null },
      id: { not: params.entryId },
      OR: [
        { referenceType: params.referenceType, referenceId: params.referenceId },
        ...documentFilters.map((filter) => ({ payload: filter })),
      ],
    },
    select: { id: true, payload: true },
  })
  const { classifyLedgerSettlement, comparableAttemptDate, describeAttempt, settlementMarkerFor } = await import('@/lib/domain/accounting/ledger-settlement-evidence')
  const { effectiveTokenFor, attemptCouldHaveReachedTheLedger, attemptCouldBeTheSameDocument } = await import('@/lib/domain/accounting/followup-retry-guard')

  // EVERY CONTENDER, EACH BY ITS OWN MARK — this row and every rival that could have settled the
  // same document (Codex round 3 follow-up). Judging only this row's own attempt was the hole the
  // mark was invented to close, reopened one level down: the sibling that made this post suspicious
  // in the first place was never asked about. Its payment carries ITS token's mark, not this one's,
  // so a settlement it committed is invisible to this row's marker — and invisible to the amount-
  // and-date fallback too the moment the second receipt is entered for a different day or amount,
  // which is exactly what an operator re-recording a lost payment does.
  //
  // This row is a contender only when it did NOT claim the stamp. Winning the claim is proof that
  // no remote call has ever left this row, so its own attempt cannot be in the ledger; judging it
  // anyway would refuse a fresh receipt whenever some unrelated payment happened to share its
  // amount and date, and leave the row pointing at a settlement that was never its own.
  const contenders: Array<{ id: string; payload: unknown; own: boolean }> = [
    ...(claimed.count > 0 ? [] : [{ id: params.entryId, payload: params.payload, own: true }]),
    ...attemptedSiblings.map((row) => ({ id: row.id, payload: row.payload, own: false })),
  ]
    // Filtered the same two ways `planManualRetry` filters its contenders, so the POST fence and
    // the retry planner cannot disagree about who the rivals are.
    //
    // A body missing a field its connector requires was rejected before any HTTP call, so it
    // provably committed nothing. Without this, one malformed row makes a valid payment unsendable
    // for ever — and a malformed body of our own would be refused for want of evidence about a
    // call that was never made, which is the exemption `planManualRetry` already gives its target.
    .filter((row) => attemptCouldHaveReachedTheLedger(params.type, row.payload))
    // An attempt against a different document cannot have settled this one, and is not covered by
    // the probe below either — so judging this post against it would be comparing an attempt with
    // a ledger reading that says nothing about it.
    .filter((row) => attemptCouldBeTheSameDocument(params.type, row.payload, params.payload))

  const probe = await probeLedgerSettlement(params.connector, { type: params.type, payload: params.payload })

  /**
   * THE FIRST ROW IN A VIRGIN SCOPE — no longer a free pass (Codex round 4, finding 3).
   *
   * It used to return before the probe, on the reasoning that a row nothing has been sent from
   * cannot duplicate an attempt of OURS. That is true and it is not the hazard. The hazard is a
   * settlement A HUMAN made: an operator who records the payment in Xero by hand and then marks
   * the invoice paid in IMS queues a brand-new row against a document that is already settled,
   * and a first attempt is precisely the case that cannot know about it from its own history.
   * The probe CAN see it. Being told to ignore what the probe can see, on a money path, is not a
   * defensible saving — and the saving was one GET.
   *
   * Judged with this row's own MARKER as well as its numbers, because a marker match is possible
   * here even though this row has never posted: a revival that carried a pinned
   * `_idempotencyKey` over from a row retention has since deleted posts under the SAME mark, and
   * that vanished predecessor leaves no sibling to be found.
   *
   * THE DATE IS PINNED HERE, NOT WAIVED (Codex round 5, finding 1). Round 4 let an `unknown` of
   * cause `attempt-undescribable` proceed, on the reasoning that a row the processors will date
   * "today at post time" can never be described, so refusing would strand it for ever. The
   * reasoning was right that refusing for ever is wrong and wrong that proceeding is therefore
   * right: it let a virgin undated row walk straight past a settlement the probe could SEE.
   *
   * What makes it describable is that this row has not been sent yet. `params.postingDate` is
   * the very value the processor is about to put in the ledger — not a prediction of it. Round 6
   * predicted it by calling the processors' own date function a second time here, which is a
   * prediction whenever that function reads a clock: astride a UTC midnight the two calls answer
   * different days, and the probe then hunts a settlement the post will never create (round 7,
   * Codex HIGH #1). The caller resolves it once and hands it over, so the attempt is compared on
   * what it WILL create by construction. (Sound only because this branch is unreachable for a row
   * that has posted: a row that failed to claim the stamp is a contender unless
   * `attemptCouldHaveReachedTheLedger` rejects its body, and that rejection is itself proof no
   * call was ever made.)
   *
   * That leaves one genuinely undescribable shape — a payload with no readable AMOUNT, which
   * both connectors reject before any HTTP call anyway. It may still not walk past a settlement
   * the probe can see: an undescribable attempt proceeds only when the ledger positively holds
   * NOTHING, which is the one state in which there is nothing to duplicate. Both LEDGER unknowns
   * — the probe could not answer, or it returned a settlement it could not measure — refuse as
   * before.
   */
  if (contenders.length === 0) {
    const marker = settlementMarkerFor(effectiveTokenFor(params.connector, { id: params.entryId, payload: params.payload }))
    const attempt = describeAttempt(params.type, params.payload, marker, { postingOn: comparableAttemptDate(params.postingDate) })
    const verdict = classifyLedgerSettlement(attempt, probe)
    if (verdict.outcome === 'present') {
      return {
        proceed: false,
        error: `Not sent: the accounting connector already holds a settlement of ${verdict.detail} against `
          + 'this document, and IMS has never sent one for it — so it was recorded outside IMS. '
          + 'Sending this would pay it twice. Check the ledger and resolve this entry by hand.',
      }
    }
    if (verdict.outcome === 'unknown') {
      if (verdict.cause !== 'attempt-undescribable') {
        return {
          proceed: false,
          error: `Not sent: IMS could not establish what the accounting connector already holds against `
            + `this document (${verdict.reason}). Posting on a reading that failed could pay it twice.`,
        }
      }
      // Undescribable AND the ledger is not empty: this row cannot say what it would create, so it
      // cannot rule itself out against what is already there. Refuse on what is visible.
      //
      // o3d-obyd r31 — AND THIS IS THE ONE PLACE OUTSIDE `classifyLedgerSettlement` THAT READS A
      // CONCLUSION STRAIGHT OUT OF A RECORD LIST. It reads the strongest one: an empty list is taken
      // as "there is nothing here that could be confused with this attempt", and the row PROCEEDS TO
      // POST. That inference has exactly the premise Codex's HIGH 1 is about — it is sound only if
      // the empty list is the whole collection.
      //
      // IT IS SOUND HERE, AND NOT BY ACCIDENT OF THIS LINE. `settlementAnswer` refuses a response
      // that states no settled figure AND carries no record, so an UNPROVED probe always has at
      // least one record and `records.length > 0` already catches every one of them. Adding
      // `|| !probe.provedComplete` here would be a guard that cannot fire — no input reaches it, so
      // nothing could ever show it working, and a check nobody can break reads as protection while
      // being decoration. r31 wrote it, could not kill it with a mutant, and removed it again.
      //
      // o3d-zo4j — AND THE FUTURE ARM ARRIVED, SO THE GUARD IS BACK AND IT HAS INPUTS.
      //
      // r31's premise was that `settlementAnswer` refuses the ONLY unproved shape there was — no
      // settled figure AND no record — so `ok && !provedComplete` implied `records.length > 0`. This
      // round adds a SECOND way to be unproved: a collection that EXCEEDS the figure certifying it.
      // That one is reached with the figure stated, so nothing refuses it, and it can carry an EMPTY
      // record list — a credit note whose allocations all belong to OTHER invoices contradicts its own
      // `RemainingCredit` while this bill's filtered list has nothing in it. The length test would then
      // read that empty list as "nothing here could be confused with this attempt" and POST, on a
      // collection the probe has just said is not to be trusted as whole.
      //
      // So it is its own arm rather than a widened condition: the sentence below counts settlements,
      // and this shape has none to count. It is falsifiable — delete it and the credit-note excess
      // authorises the post.
      if (probe.ok && !probe.provedComplete && probe.records.length === 0) {
        return {
          proceed: false,
          error: 'Not sent: this entry does not record the amount its attempt would send, and the '
            + 'accounting connector contradicted its own account of what has settled this document, '
            + 'so what it returned is not proof of what it holds. An empty list from a reading like '
            + 'that is not evidence there is nothing here, and sending could pay it twice. Resolve '
            + 'this entry by hand.',
        }
      }
      if (!probe.ok || probe.records.length > 0) {
        return {
          proceed: false,
          error: 'Not sent: this entry does not record the amount its attempt would send, and the '
            + `accounting connector already holds ${probe.ok ? probe.records.length : 'a'} settlement`
            + `${probe.ok && probe.records.length === 1 ? '' : 's'} against this document. IMS cannot `
            + 'tell them apart, so sending could pay it twice. Resolve this entry by hand.',
        }
      }
    }
    return { proceed: true }
  }

  for (const contender of contenders) {
    const marker = settlementMarkerFor(effectiveTokenFor(params.connector, contender))
    // o3d-r948 r6 — THIS LOOP NEVER NEEDED THE EXCLUSION, AND NOW NOBODY HAS IT.
    //
    // r3 recorded here why omitting `settlementsOfOtherAttempts` cost this site nothing, and the
    // argument survives the option's removal intact — it is worth keeping, because it is the one
    // place in the codebase where the exclusion would provably have changed no verdict:
    //
    //   Every attempt that could have recorded an id on this document is IN `contenders` — that is
    //   what the sibling query selects — so a record the exclusion would skip is one this very loop
    //   judges on its own turn. That turn cannot answer `clear` for it either: the record is
    //   unmeasurable (the only case the exclusion ever changed), so its owner's turn returns
    //   `record-unmeasurable`. The verdict is the same refusal either way; only the sentence differs.
    //
    //   The contenders this loop drops are dropped for reasons that also disqualify their recorded
    //   ids: `attemptCouldHaveReachedTheLedger` false PROVES no call was made, so the row owns no
    //   settlement, and `attemptCouldBeTheSameDocument` false means whatever it owns settles another
    //   document.
    //
    // What changed in r6 is only that there is no option to omit. See `classifyLedgerSettlement`.
    const verdict = classifyLedgerSettlement(describeAttempt(params.type, contender.payload, marker), probe)
    if (verdict.outcome === 'clear') continue
    if (verdict.outcome === 'present') {
      return {
        proceed: false,
        error: `Not sent: the accounting connector already holds a settlement of ${verdict.detail} against `
          + `this document, matching ${contender.own ? 'an earlier attempt from this entry' : `another entry for it (${contender.id})`}. `
          + 'Sending it again would pay it twice. Check the ledger and resolve this entry by hand.',
      }
    }
    return {
      proceed: false,
      error: `Not sent: ${contender.own ? 'this entry has been attempted before' : `another entry for this document has been attempted (${contender.id})`} `
        + `and IMS could not establish whether that attempt reached the ledger (${verdict.reason}). `
        + 'Re-posting could pay the document twice.',
    }
  }
  return { proceed: true }
}

/** What a money branch returns to its processor. Structurally the two connectors' `EntryResult`. */
export type MoneyPostOutcome = { success: boolean; externalId?: string; error?: string }

/**
 * A money POST made while its exclusion was gone. Every field needed to find the document — this
 * is the record that turns "we may have paid twice" from something discovered at reconciliation
 * into something searchable from the minute it happened.
 *
 * DURABLE, NOT LOG-ONLY (round 6, Codex HIGH #4). Round 5 wrote this to stderr and called it
 * "announced". Stderr is a stream: whoever is watching at that second sees it and nobody else
 * ever does, so an operator looking at the accounting sync history — or any alerting that reads
 * IMS's own records rather than a container's log driver — finds a payment that simply succeeded,
 * with nothing anywhere saying it went out unprotected. On a double-payment path that is the
 * difference between a searchable incident and a rumour.
 *
 * So it is also written to the ACTIVITY LOG, at ERROR, against the sync row. Not to the sync row
 * itself: a successful post is immediately followed by `status: SYNCED, errorMessage: null` in
 * both processors, so anything this wrote there would be erased by the write that reports the
 * success.
 *
 * AND THE WRITE IS CHECKED (round 7, Codex MEDIUM #3). It used to call `logActivity`, which never
 * throws AND swallows its own failures — so the `catch` around it could not fire, and a write that
 * failed was indistinguishable here from one that succeeded. The durable record could therefore
 * vanish silently at exactly the moment it mattered, leaving the code believing it had made the
 * incident findable. `logActivityPersisted` is the same call that REPORTS, and its answer is used:
 *
 *  1. one retry, because the common failure is a transient blip on a connection pool that has just
 *     been hammered by an HTTP round trip, and a second attempt costs nothing on the happy path
 *     (it is not reached at all unless the first fails);
 *  2. failing that, a distinct stderr line that says the durable record was NOT written and
 *     carries the whole incident as JSON, so it is reconstructable from the log stream rather than
 *     merely alluded to;
 *  3. the outcome is RETURNED, so the caller can put the incident somewhere that does survive when
 *     it has such a place — a failed post's `errorMessage` is written to the sync row and not
 *     overwritten, so that branch says so in the operator-facing text.
 *
 * It still never throws. The incident must not turn a committed payment into an exception, which
 * is the one thing worse than an unrecorded incident.
 *
 * Deliberately NOT a re-probe. Reading the ledger again here could not be conclusive: a rival
 * post inside the same window may not be readable yet, and one that lands a second later would be
 * missed anyway. An inconclusive check that reads like a verdict is worse than a plain alarm.
 */
async function reportLostMoneyPostExclusion(
  params: { connector: string; entryId: string; type: string; referenceType: string; referenceId: string; payload?: unknown },
  outcome: 'committed' | 'failed' | 'threw',
  externalId?: string,
): Promise<{ persisted: boolean }> {
  const description = `Money post made without its exclusion: the advisory lock's connection died `
    + `while the ${params.type} call to ${params.connector} was in flight, so another entry may have `
    + `posted to this document at the same time (outcome=${outcome}). Check the accounting connector `
    + `for a duplicate settlement.`
  const metadata = {
    connector: params.connector,
    type: params.type,
    referenceType: params.referenceType,
    referenceId: params.referenceId,
    documentKey: settlementDocumentKey(params.type, params.payload),
    entryId: params.entryId,
    outcome,
    externalId: externalId ?? null,
  }
  console.error(
    `[money-post] EXCLUSION LOST during the post — the advisory lock's connection died while the call `
    + `was in flight, so another entry may have posted to this document at the same time. `
    + `connector=${params.connector} type=${params.type} scope=${params.referenceType}:${params.referenceId} `
    + `entry=${params.entryId} outcome=${outcome}. Check the accounting connector for a duplicate settlement.`,
  )
  let persisted = false
  try {
    const { logActivityPersisted } = await import('@/lib/activity-log')
    const entry = {
      entityType: 'SYNC' as const,
      entityId: params.entryId,
      action: 'money_post_exclusion_lost',
      tag: 'accounting',
      level: 'ERROR' as const,
      description,
      // No session to resolve on a connector worker, and resolving one would be the only part of
      // this call that can be slow on a path that has just moved money.
      resolveUser: false,
      metadata,
    }
    persisted = await logActivityPersisted(entry)
    if (!persisted) persisted = await logActivityPersisted(entry)
  } catch (error) {
    // `logActivityPersisted` does not throw, so this is the module failing to import at all. The
    // console line above is still out; an activity-log failure must not be the thing that turns a
    // committed payment into an exception.
    console.error('[money-post] could not record the lost-exclusion incident:', error)
  }
  if (!persisted) {
    // NOT the same line as the one above, and not a duplicate of it: that one says a payment went
    // out unprotected, this one says the only durable record of it does not exist. An operator
    // reading IMS's own history will find nothing about this payment, so the log stream is now the
    // sole copy and it has to carry the whole incident rather than a pointer to it.
    console.error(
      '[money-post] INCIDENT NOT PERSISTED — the lost-exclusion record could not be written to the '
      + 'activity log, so IMS holds no durable trace of this unprotected money post. Incident: '
      + JSON.stringify(metadata),
    )
  }
  return { persisted }
}

/**
 * o3d-0m56 round 4, Codex CRITICAL #2 — THE ONLY WAY A MONEY POST SHOULD BE SPELT.
 *
 * `authoriseMoneyPost` answers "is this document already settled?" and the caller then posts. On
 * its own that is a decision and a write with a network round trip between them, and nothing
 * serialized them against a competing row for the same document: two rows could each probe, each
 * see nothing, and each post. The read was in the right place and still left the window it was
 * invented to close.
 *
 * This wrapper puts the stamp, the sibling read, the probe AND the post inside one per-document
 * lock, so the whole sequence is indivisible to any other worker. The post is a callback rather
 * than something the caller runs afterwards precisely so that it CANNOT be left outside: there is
 * no shape of this API in which a caller acquires protection and then posts without it.
 *
 * A caller that cannot take the lock does not wait — see money-post-lock.ts. It returns a normal
 * retryable failure, which is the same shape as a remote rejection, so the row is re-attempted
 * later and re-probes then, by which time the holder's payment is readable.
 *
 * `lock` is injectable so the fence is testable without PostgreSQL; nothing in production passes
 * it.
 */
export async function postMoneyUnderLedgerFence(
  params: MoneyPostFenceParams & { lock?: MoneyPostLock },
  post: () => Promise<MoneyPostOutcome>,
): Promise<MoneyPostOutcome> {
  const { isMoneyMovingSyncType } = await import('@/lib/domain/accounting/followup-retry-guard')
  // Non-money types take neither the lock nor the fence, exactly as before: the ordinary queue
  // traffic must not queue behind a payment.
  if (!isMoneyMovingSyncType(params.type)) return post()

  const lock = params.lock
    ?? (await import('@/lib/domain/accounting/money-post-lock')).withMoneyPostLock
  // THE DOCUMENT, not the scope (round 6, Codex CRITICAL #2). `referenceType`/`referenceId` are
  // carried for the incident report, but the key the exclusion is taken on is the external
  // document this post will settle — see money-post-document.ts.
  const outcome = await lock({
    connector: params.connector,
    type: params.type,
    referenceType: params.referenceType,
    referenceId: params.referenceId,
    documentKey: settlementDocumentKey(params.type, params.payload),
  }, async (held): Promise<MoneyPostOutcome> => {
    const authorised = await authoriseMoneyPost(params)
    if (!authorised.proceed) return { success: false, error: authorised.error }
    // THE LAST THING CHECKED BEFORE THE CALL. PostgreSQL frees a session advisory lock the instant
    // its connection dies, so a pinned connection that failed during the ledger read means the
    // exclusion this verdict was taken under is already gone and another worker may be posting to
    // this document now. Throwing here is correct — the reading is void, not merely stale.
    held.assertHeld('posting money to the accounting connector')
    let outcome: MoneyPostOutcome
    try {
      outcome = await post()
    } catch (error) {
      if (!held.lost) throw error
      const incident = await reportLostMoneyPostExclusion(params, 'threw')
      // THE THROWN PATH HAS THE SAME DURABLE FALLBACK AS THE FAILED ONE (round 8, Codex MEDIUM #2).
      // A throw here is a post of UNKNOWN outcome made without its exclusion, and both processors
      // record `String(e)` as the row's `errorMessage` — so the thrown text is written to the sync
      // row exactly as a failed post's error text is, and is the same last-resort place to put the
      // incident when the activity log could not take it. Round 7 added that fallback to the failed
      // branch and left this one rethrowing the bare error, which discards it: the activity write
      // had already failed, the stderr line is a stream, and the row then said only "socket hang
      // up" about a call that may have moved money unprotected.
      //
      // The connector's own words come FIRST and unaltered, and the original is kept as `cause`:
      // the retry classification both processors run (`isRateLimitError`) reads this text, and it
      // must still recognise a 429 that happened to lose the lock.
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} — Not sent safely: the money-post `
        + 'lock for this document was lost while IMS was posting to the accounting connector, so '
        + 'another entry may have posted at the same time and this call\'s outcome is unknown. Check '
        + 'the ledger for a duplicate before retrying.'
        + (incident.persisted
          ? ''
          : ' IMS could also not record this incident in the activity log, so this message is the '
            + 'only durable record of it.'),
        { cause: error },
      )
    }
    if (!held.lost) return outcome
    // THE ASSERTION ABOVE CANNOT COVER THE CALL ITSELF (Codex round 5, finding 2). The connection
    // can die after it and while the HTTP request is in flight, and no amount of re-checking makes
    // a check-then-act atomic against a remote system. So the residual is not argued away, it is
    // made DETECTABLE — asked once the call has returned, when the answer is finally knowable —
    // and RECOVERABLE, which it already is by construction:
    //
    //   - the payment carries IMS's mark (Xero `Reference`, QuickBooks `PrivateNote`), so a later
    //     probe finds it whoever posted it and whatever has since been done to its amount or date;
    //   - `remoteAttemptedAt` was stamped before the call, so no later row treats this scope as
    //     virgin, and every subsequent post re-probes under a FRESH lock — there is no path from
    //     here to a second post on this reading;
    //   - a successful outcome keeps its `externalId`, because that is the handle a reversal needs.
    //     Discarding it to report a failure would hide a real payment and buy nothing.
    //
    // What is irreducible: if another worker took the freed lock and posted in the same window,
    // the document really is paid twice. That is now announced at the moment it becomes possible,
    // by the process that did it, naming the document — not discovered at reconciliation.
    const incident = await reportLostMoneyPostExclusion(params, outcome.success ? 'committed' : 'failed', outcome.externalId)
    if (outcome.success) return outcome
    return {
      success: false,
      error: 'Not sent safely: the money-post lock for this document was lost while IMS was posting to '
        + 'the accounting connector, so another entry may have posted at the same time. '
        + `The connector reported: ${outcome.error ?? 'no error'}. Check the ledger for a duplicate `
        + 'before retrying.'
        // The DURABLE fallback for this branch (round 7, Codex MEDIUM #3). A failed post's error
        // message IS written to the sync row and survives, so when the activity-log record could
        // not be written the incident still reaches an operator through the row itself — which is
        // the only place left once the activity log is unavailable.
        + (incident.persisted
          ? ''
          : ' IMS could also not record this incident in the activity log, so this message is the '
            + 'only durable record of it.'),
    }
  })
  if (!outcome.locked) {
    return {
      success: false,
      error: 'Not sent: another entry for this document is posting to the accounting connector right '
        + 'now. This entry will retry once that attempt is readable in the ledger.',
    }
  }
  return outcome.result
}
