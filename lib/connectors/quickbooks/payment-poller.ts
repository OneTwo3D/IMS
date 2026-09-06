/**
 * QuickBooks Online payment detection polling.
 * Polls QBO for recently paid invoices and bills, updating IMS records.
 * Mirrors lib/connectors/xero/payment-poller.ts.
 */

import { db } from '@/lib/db'
import { logActivity, logActivityPersisted } from '@/lib/activity-log'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import {
  detectPaymentReversals,
  readDatabaseLedgerFence,
  readPaidProvenanceVerdicts,
} from '@/lib/domain/accounting/payment-reversal'
import {
  ledgerCurrencyCode,
  parseLedgerAmount,
  readLedgerDifferenceAsNumber,
  zeroPaidIsProvenReversal,
  type LedgerReadFence,
  type RegisteredPaymentVerdict,
} from '@/lib/connectors/xero/invoice-delta'
import {
  compareDecimal,
  currencyMinorUnits,
  FINEST_SUPPORTED_MINOR_UNITS,
  ledgerMinorUnits,
  toDecimal,
  type Decimal,
} from '@/lib/domain/math/decimal'
import {
  closeWithheldMarker,
  deferWithheldMarker,
  dueWithheldMarkers,
  openWithheldDocuments,
  withheldEntityKey,
  WITHHELD_RECHECK_BATCH,
} from '@/lib/domain/accounting/withheld-reversal-markers'
import { qboQuery } from './api'
import { getSettingValue } from '@/lib/settings-store'

const LAST_POLL_KEY = 'quickbooks_last_payment_poll'

/** A QuickBooks reversal can only ever speak about rows QuickBooks itself issued. */
const QUICKBOOKS_CONNECTOR = 'quickbooks'

/**
 * Whose withheld-reversal markers this poller owns.
 *
 * `legacyOwner: false` — markers written before the connector key existed belong to XERO, which is the
 * only poller that had a recheck at all until o3d-psrx r4. Claiming them here would send QuickBooks
 * asking about Xero invoice ids for ever.
 */
const QBO_MARKER_SCOPE = { connector: QUICKBOOKS_CONNECTOR, legacyOwner: false } as const

type QboInvoice = {
  Id: string
  Balance: number
  /** o3d-psrx r4: a VOIDED document is zeroed rather than deleted, which is how the by-id read sees it. */
  TotalAmt?: number
  MetaData?: { LastUpdatedTime?: string }
}

type QboBill = {
  Id: string
  Balance: number
  TotalAmt?: number
  MetaData?: { LastUpdatedTime?: string }
}

type QboQueryResponse<T> = {
  QueryResponse: Record<string, T[] | undefined>
}

type QboEntityId = { Id: string }

/**
 * o3d-psrx r8 (Codex HIGH 2) — WHAT THE LEDGER SAYS IT STILL HOLDS ON A DOCUMENT, AND WHETHER IT SAID.
 *
 * `paid` is `TotalAmt - Balance`, in the document's own currency; NULL when either figure could not be
 * read. NULL IS NOT ZERO — see the verdict this feeds.
 *
 * NO NEW QUICKBOOKS CALL EXISTS TO MAKE THIS. `qboQuery` issues `SELECT * FROM <entity> WHERE ...`, so
 * `Balance` and `TotalAmt` are already in the very responses the reversal reads take; the only thing
 * that was missing was reading them. That matters beyond tidiness: an evidence gate that needed an
 * extra round trip per document would be one the poller could skip under rate limiting, and a gate
 * that can be skipped is not a gate.
 */
export type QboLedgerAmount = {
  /** `TotalAmt - Balance`: what QuickBooks states is SETTLED on the document. NULL if either is unreadable. */
  paid: number | null
  /** `TotalAmt` as stated. */
  total: number | null
  /**
   * `Balance` as stated — what is still OUTSTANDING on the document, QuickBooks' own figure rather
   * than a subtraction of ours. It is not a loss: see `LEDGER_PARTIALLY_PAID`.
   */
  outstanding: number | null
  /** `CurrencyRef.value`, or NULL when the payload did not state one (o3d-psrx r10, Codex HIGH 3). */
  currency: string | null
  /**
   * o3d-psrx r15 (Codex MEDIUM 2) — WHERE THE MINOR UNIT THE AMOUNTS WERE READ AGAINST CAME FROM.
   *
   * `currency` above is what QUICKBOOKS STATED and nothing else, because it is what the operator
   * warnings and the withheld marker report as the ledger's own figure. This says which currency
   * `parseLedgerAmount` was actually given, which is a different question the moment QuickBooks
   * states none: see `resolveLedgerRowCurrency`.
   */
  currencySource: LedgerCurrencySource
}

/**
 * o3d-psrx r15 (Codex MEDIUM 2), CORRECTED IN r16 (Codex HIGH 2) — WHERE THE MINOR UNIT COMES FROM
 * WHEN QUICKBOOKS DOES NOT SAY, AND WHY AN IMS GUESS MAY ONLY TIGHTEN IT.
 *
 * QuickBooks omits `CurrencyRef` whenever multicurrency is disabled, which is the ORDINARY shape of an
 * ordinary company's documents rather than an anomaly. r15 read that as a reason to fall back to the
 * currency of the IMS document the row is linked to, and to size the MAGNITUDE BOUND from it.
 *
 * THAT WAS WRONG, AND THE ARGUMENT FOR IT WAS WRONG IN A SPECIFIC WAY WORTH KEEPING WRITTEN DOWN. It
 * reasoned that a coarser bound only READS more documents while a coarser epsilon DISCARDS more, so
 * provenance could be spent on the bound and withheld from the epsilon. But reading a document that
 * should have been refused IS the false-reversal path: the bound exists because a decode can collapse
 * a minor unit, and admitting a figure whose real currency is finer than the guessed one admits
 * exactly that collapse. Codex's case: `600000000000.0003` and `600000000000.0002` are one CLF minor
 * unit apart and decode to the same double; an unverified IMS `GBP` admits both under the two-decimal
 * bound, the difference is zero, and the ledger reads as holding nothing. THE BOUND IS A SAFETY
 * MECHANISM, NOT A CONVENIENCE, and an unverified currency must never widen one.
 *
 * SO THE RULE IS STRICTEST-WHEN-UNSTATED, AND AN IMS CURRENCY MAY ONLY NARROW:
 *
 *   LEDGER        QuickBooks stated `CurrencyRef`. Authoritative, and it always wins.
 *   IMS_DOCUMENT  the currency of the IMS order or purchase order this row is linked to by
 *                 `accountingInvoiceId` — used ONLY when its minor unit is at least as fine as the
 *                 unstated fallback, i.e. only where believing it can make no rule looser. Since no
 *                 supported currency is finer than the fallback, this NEVER widens the bound today and
 *                 in practice changes nothing; it is written as the RULE rather than as the present
 *                 coincidence so that adding a five-decimal currency cannot silently turn an IMS guess
 *                 back into a widening.
 *   NONE          nothing usable. The strictest bound applies, AND the refusal it produces says that
 *                 this is why — see `currencyUnbound`.
 *
 * AND THE REGRESSION THAT MOTIVATED r15 WAS NOT ONE. Codex's reproduction needed `600000000000` — six
 * hundred billion — to reach the strictest bound. The largest absolute value in ANY numeric column of
 * any IMS database is 11,660, and the largest MONEY figure is 1,100: the case is eight orders of
 * magnitude above anything real. Refusing an absurd amount whose currency genuinely cannot be
 * established is correct behaviour, not a regression, and the marker and operator sentence r15 added
 * are the part of it worth keeping — they name the binding defect instead of silently guessing past it.
 *
 * A DURABLY VERIFIED QUICKBOOKS HOME CURRENCY IS NOT AVAILABLE TO BE A THIRD SOURCE, and that is a
 * fact this repository has already established rather than a choice made here: `connectQuickBooks`
 * compares `fetchCompanyInfo`'s `HomeCurrency` against the IMS base currency ONLY when it could read
 * it, stores the binding either way, and persists neither the value nor the fact that it compared.
 * `getBaseCurrencyCode()` is therefore not a stand-in for what the ledger denominates in — the same
 * conclusion `payloadPaymentCurrency` reached in o3d-batch-ret r12, and o3d-emus is the issue that
 * would make such a source exist. Until it does, an unstated currency is read at the finest precision
 * this repository supports, in EVERY rule sized by the minor unit rather than in some of them.
 */
export type LedgerCurrencySource = 'LEDGER' | 'IMS_DOCUMENT' | 'NONE'

export type ResolvedLedgerCurrency = {
  /** As QuickBooks stated it, or NULL. Never inferred. */
  stated: string | null
  /** The code the amounts are READ against — stated, else an IMS code that can only tighten, else NULL. */
  read: string | null
  source: LedgerCurrencySource
}

export function resolveLedgerRowCurrency(
  statedCurrencyRef: unknown,
  imsDocumentCurrency: string | null | undefined,
): ResolvedLedgerCurrency {
  const stated = parseQboCurrency(statedCurrencyRef)
  if (stated != null) return { stated, read: stated, source: 'LEDGER' }
  // Validated through the SAME `ledgerCurrencyCode` the payload goes through: an IMS column holding
  // something that is not an ISO-4217 code is not provenance, it is another unstated currency.
  const ims = ledgerCurrencyCode(imsDocumentCurrency ?? null)
  // NARROW ONLY. `>=` is the whole rule: a finer minor unit means a smaller magnitude bound and a
  // smaller epsilon, so believing an unverified code can only make this read STRICTER than the
  // unstated fallback. A coarser one would loosen a safety mechanism on an unverified guess, which is
  // the r16 finding.
  if (ims != null && currencyMinorUnits(ims) >= FINEST_SUPPORTED_MINOR_UNITS) {
    return { stated: null, read: ims, source: 'IMS_DOCUMENT' }
  }
  return { stated: null, read: null, source: 'NONE' }
}

/** The IMS currency for each QuickBooks document id a read is about, keyed by `accountingInvoiceId`. */
export type LedgerDocumentCurrencies = ReadonlyMap<string, string | null>

/**
 * The IMS-side currency provenance for a set of candidate documents, keyed the way the ledger read is.
 *
 * AMBIGUITY COLLAPSES TO NULL RATHER THAN TO A WINNER. `accountingInvoiceId` is globally unique on
 * PurchaseInvoice, but nothing forbids a SalesOrder and a PurchaseInvoice from carrying the same
 * QuickBooks id, and each entity's read is built from its own candidates — so this is defensive rather
 * than reachable today. If it ever became reachable, two documents disagreeing about the currency is
 * exactly the state in which neither is provenance, and the strictest bound is the right answer.
 */
export function ledgerDocumentCurrencies(
  documents: ReadonlyArray<{ accountingInvoiceId: string | null; currency?: string | null }>,
): LedgerDocumentCurrencies {
  const index = new Map<string, string | null>()
  for (const document of documents) {
    const id = document.accountingInvoiceId
    if (id == null) continue
    const code = ledgerCurrencyCode(document.currency ?? null)
    if (index.has(id) && index.get(id) !== code) index.set(id, null)
    else index.set(id, code)
  }
  return index
}

type QboAmountRow = { Id: string; Balance?: unknown; TotalAmt?: unknown; CurrencyRef?: unknown }

/**
 * o3d-psrx r10 (Codex HIGH 2) — ONE PARSE OF THE ROW, AND EVERY LATER READING USES ITS RESULT.
 *
 * r9 had two readers of the same two fields that disagreed about their type: the by-id recheck asked
 * `typeof row.Balance === 'number'` to decide void/balance-due, while `qboLedgerAmount` deliberately
 * accepted a numeric STRING. On a payload that serialised `Balance` as `"50.00"` the strict reader
 * saw no balance due, so the document was recorded as returned and never entered `balanceDue` — and
 * the recheck then CLOSED its withheld marker as settled while the disagreement stood. The stricter
 * of two disagreeing readers must not be the one that decides whether a marker survives.
 *
 * So the row is read ONCE, here, through `parseLedgerAmount` — the same reader Xero's amount
 * partition uses — and both classifications are derived from that result. One parse, one truth.
 */
type QboParsedLedgerRow = {
  total: number | null
  balance: number | null
  currency: string | null
  /**
   * The code the two amounts were READ against, carried because the SUBTRACTION between them is sized
   * by the minor unit too and must not re-resolve it from `currency` — which is the STATED code and is
   * null exactly where the resolved one matters. See `readLedgerDifferenceAsNumber`.
   */
  readCurrency: string | null
  currencySource: LedgerCurrencySource
}

function parseQboLedgerRow(row: QboAmountRow, imsDocumentCurrency: string | null | undefined): QboParsedLedgerRow {
  // o3d-psrx r14: the currency is read FIRST because the amount reader needs it — the magnitude above
  // which a figure's own minor unit cannot survive `Response.json()` is a property of that minor unit,
  // and it is the bound `parseLedgerAmount` refuses on. r15: and it is RESOLVED rather than merely
  // read, because a missing `CurrencyRef` is the ordinary single-currency shape and not an unknown.
  const currency = resolveLedgerRowCurrency(row.CurrencyRef, imsDocumentCurrency)
  return {
    total: parseLedgerAmount(row.TotalAmt, currency.read),
    balance: parseLedgerAmount(row.Balance, currency.read),
    // STATED, never resolved: this is the figure the operator warnings and the withheld marker report
    // as the ledger's own, so it must not become an inference. `currencySource` carries the rest.
    currency: currency.stated,
    readCurrency: currency.read,
    currencySource: currency.source,
  }
}

/**
 * The document's currency, out of the same row the amounts come from.
 *
 * QuickBooks states it as `CurrencyRef: { value: 'GBP' }`, and some responses use a plain string
 * instead (the reading `fetchCompanyInfo` already makes of `HomeCurrency`). Anything that is not an
 * ISO-4217-shaped code is NULL rather than a guess — see `ledgerAmountEpsilon`, which is written
 * about exactly that null.
 */
function parseQboCurrency(value: unknown): string | null {
  const raw = typeof value === 'string'
    ? value
    : typeof (value as { value?: unknown } | null)?.value === 'string'
      ? (value as { value: string }).value
      : null
  // The UNWRAPPING is QuickBooks-shaped; the VALIDATION is not, and is shared with Xero's reading of
  // `CurrencyCode` so that "is this an ISO-4217 code" has one answer across both connectors.
  return ledgerCurrencyCode(raw)
}

/**
 * o3d-psrx r13 (Codex HIGH 2) — THE SUBTRACTION IS A CONVERSION TOO, AND IT GETS THE SAME GUARD.
 *
 * r12 guarded the two figures COMING IN and nothing about the arithmetic BETWEEN them. `TotalAmt`
 * and `Balance` each survived the losslessness round trip and their exact Decimal difference was
 * then handed to a bare `.toNumber()` — so the derived figure, the only one any verdict is taken on,
 * was the single unguarded conversion in the chain.
 *
 * It is reachable with figures the round trip admits. Total `0.005055810576648219` less balance
 * `0.00005581057664821855` is exactly `0.00500000000000000045` — STRICTLY ABOVE the GBP epsilon of
 * `0.005`, so the ledger holds a payment — and `.toNumber()` returns exactly `0.005`, which the
 * epsilon comparison reads as `<= 0`. A positive payment becomes `HOLDS_NOTHING`, which is the
 * verdict `zeroPaidIsProvenReversal` is written about: the provenance gate then admits a reversal
 * that clears `paidAt`, re-arms Mark Paid over a supplier payment that was genuinely made, or raises
 * a sales chargeback against a document the ledger is still accounting for.
 *
 * So the derived amount is converted through `readDecimalAsNumber`, the same reader the inputs go
 * through, and a conversion that cannot be spent in place of the Decimal yields NULL. NULL IS NOT
 * ZERO here either: `classifyQboLedgerEvidence` reads a null `paid` as `UNPROVEN`, which WITHHOLDS.
 * A figure this code cannot represent is not permission to declare the payment gone.
 *
 * o3d-psrx r15 (Codex MEDIUM 1) — AND IT TOOK NO CURRENCY, because the magnitude bound belonged to
 * the arms that decode a token and not to this conversion: the difference is a Decimal this code
 * computed EXACTLY from two figures already admitted by their own arm, so its own evidence is intact
 * and the round trip can decide it directly.
 *
 * o3d-psrx r16 (Codex HIGH 1) — AND IT TAKES ONE AGAIN, FOR A DIFFERENT REASON. The round trip decides
 * whether the SUBTRACTION was represented; it says nothing about whether the two operands still stand
 * far enough apart for their difference to mean anything. Two tokens finer than their minor unit can
 * decode to ONE double and their exact difference is then zero, which is the false reversal itself. So
 * the operands are checked against the magnitude at which their decode spacing exceeds the threshold
 * the difference is about to be compared against — `readLedgerDifferenceAsNumber`, which is where both
 * halves now live together.
 */
function qboLedgerAmountFrom(parsed: QboParsedLedgerRow): QboLedgerAmount {
  const { total, balance, currency, readCurrency, currencySource } = parsed
  return {
    total,
    outstanding: balance,
    // o3d-psrx r16 (Codex HIGH 1): the DIFFERENCE is read by the rule written for a difference, not by
    // the one written for a single value. Decimal rather than float — `100.1 - 0.1` is
    // 100.00000000000001 in IEEE-754 and this figure is compared against a threshold small enough for
    // a four-decimal currency to see that — and refused outright where the two operands' decode
    // spacing is wider than the threshold their difference is about to be compared against.
    paid: total === null || balance === null
      ? null
      : readLedgerDifferenceAsNumber(total, balance, readCurrency),
    currency,
    currencySource,
  }
}

/**
 * The document's current settled and outstanding amounts as QuickBooks states them, from one row of
 * a reversal read.
 *
 * `Balance` and `TotalAmt` are read through `parseLedgerAmount` — the SAME reader Xero's amount
 * partition uses — so a string figure, a missing one and an unparseable one all get the answer the
 * other connector already gives them, rather than a second dialect of "is this a number".
 */
export function qboLedgerAmount(row: QboAmountRow, imsDocumentCurrency?: string | null): QboLedgerAmount {
  return qboLedgerAmountFrom(parseQboLedgerRow(row, imsDocumentCurrency))
}

/**
 * A VOIDED document holds nothing, and that is a fact about the document rather than a subtraction.
 *
 * QuickBooks voids by ZEROING (`TotalAmt = 0`), which is how both reversal reads recognise it, so
 * there is no value left on the document for a payment to be applied to. Stated as its own rule and
 * not left to `TotalAmt - Balance` because the arithmetic depends on QuickBooks serialising both
 * fields on a zeroed document — and a payload that omits one would make an unreadable amount out of
 * the one case that needs no reading, withholding every voided reversal. The IMS treatment of a
 * voided document (clear `paidAt`, raise NO chargeback — QBO has already reversed the AR) is
 * unchanged by this round.
 */
function qboVoidedAmount(currency: string | null, currencySource: LedgerCurrencySource): QboLedgerAmount {
  return { paid: 0, total: 0, outstanding: 0, currency, currencySource }
}

/**
 * o3d-psrx r10 (Codex HIGH 3) — HOW SMALL AN AMOUNT COUNTS AS NOTHING, IN THIS DOCUMENT'S CURRENCY.
 *
 * r9 used `PAYMENT_PRESENT_EPSILON`, which is 0.005 and is documented for Xero's two-decimal
 * amounts: half a penny, comfortably inside the gap between "nothing" and the smallest payment that
 * can exist. This classifier receives QuickBooks documents, and the repository supports three- and
 * four-decimal currencies (`currencyMinorUnits` — BHD/JOD/KWD at 3, CLF/UYW at 4). Against those, a
 * fixed 0.005 is FIVE whole minor units in a Gulf dinar and fifty in CLF: a document QuickBooks
 * states 0.004 is still settled on reads as holding NOTHING, the registration gate then admits, and
 * `paidAt` is cleared with a chargeback credit note raised over a document the ledger is still
 * accounting for. That is the o3d-psrx defect itself, reached through the tolerance.
 *
 * So the threshold is HALF ONE MINOR UNIT of the document's own currency — strictly below one minor
 * unit in every currency, which is what makes "the smallest amount that can exist is not zero" true
 * everywhere rather than only in GBP. In a two-decimal currency it is 0.005 exactly, so nothing about
 * the ordinary case moves.
 *
 * A NULL CURRENCY TAKES THE STRICTEST THRESHOLD, not the most convenient one. QuickBooks omits
 * `CurrencyRef` when multicurrency is off, and the fail-safe direction is unambiguous: too LARGE a
 * threshold discards a real minor unit as zero and lets a reversal through, while too small a one
 * can only move a document from `HOLDS_NOTHING` into a verdict that WITHHOLDS. So an unstated
 * currency is given the finest precision this repository supports.
 */
export function ledgerAmountEpsilon(currency: string | null): Decimal {
  // r16: through the shared resolver, so this rule and the two magnitude rules cannot drift apart on
  // what an unstated currency means.
  const digits = ledgerMinorUnits(currency)
  // Half of 10^-digits, written exactly rather than computed in binary floating point.
  return toDecimal(`0.${'0'.repeat(digits)}5`)
}

/**
 * o3d-psrx r9 (Codex HIGH), reworded in r10 — THE THREE ANSWERS QUICKBOOKS' OWN FIGURES CAN GIVE.
 *
 * r8 asked one question of these figures — "has the ledger been shown to hold NOTHING?" — and put
 * every other answer in one bucket. r9's finding was that the bucket held two very different things:
 *
 *   HOLDS_NOTHING   `paid` is zero within the currency's epsilon. This is the state every admitting
 *                   arm of `zeroPaidIsProvenReversal` is written about, so the registration evidence
 *                   decides.
 *   PARTIALLY_PAID  `paid` is POSITIVE and short of a stated `total`, with the difference — the
 *                   ledger's own `Balance` — still outstanding. Nothing here is undecided:
 *                   QuickBooks stated both figures and IMS read both. It is stable, so the same
 *                   reading comes back on every future poll.
 *   UNPROVEN        everything else, and every member of it is an ABSENCE rather than a reading: no
 *                   row for the document at all, a figure `parseLedgerAmount` would not read, a total
 *                   that was not stated, or a `paid` that is not a quantity this code can explain
 *                   (negative — an over-credited document). `paid` equal to the total is here too,
 *                   deliberately: the ledger and IMS AGREE about it, so there is nothing to report.
 *
 * THE LAST SENTENCE IS THE ONE THAT STOPS THIS CRYING WOLF. A rule that treated every `paid < total`
 * as something to warn about would fire on a document the ledger has fully settled the moment one
 * ever reached this gate, and an operator shown a warning about a settled document learns to ignore
 * the ones that are real.
 *
 * o3d-psrx r10 (Codex HIGH 1) — AND WHAT `PARTIALLY_PAID` IS ALLOWED TO SAY. r9 named this
 * `PART_REMOVED` and its third figure `removedAmount`, which asserts a PRIOR state these figures do
 * not contain: `TotalAmt` and `Balance` describe the document now, and a document that was only ever
 * part paid states exactly what one that lost a payment states. So the outcome carries the ledger's
 * current position — settled, total, outstanding — and makes no claim about how it got there.
 *
 * `PARTIALLY_PAID` carries numbers, never nulls, and that is what its consumers are allowed to rely
 * on: a verdict quantifying anything out of a figure nobody could read would be worse than the
 * silence it replaced.
 */
export type QboLedgerEvidence =
  | { kind: 'HOLDS_NOTHING' }
  | {
      kind: 'PARTIALLY_PAID'
      paidAmount: number
      documentTotal: number
      outstandingAmount: number
      currency: string | null
    }
  | {
      kind: 'UNPROVEN'
      paidAmount: number | null
      documentTotal: number | null
      /**
       * o3d-psrx r15 (Codex MEDIUM 2) — TRUE when QUICKBOOKS did not say what currency this document's
       * figures are in, so they were read against the strictest minor unit this repository supports.
       *
       * r16: an IMS currency may only NARROW the bound, never widen it, so it does not clear this —
       * the amounts were still sized by the fallback rather than by the ledger's own statement.
       *
       * It is a property of the BINDING and not of the ledger's answer, and it is carried separately
       * for that reason: an UNPROVEN reached this way is not QuickBooks declining to state an amount,
       * it is IMS unable to size one. A document MISSING from the read has no binding to report on,
       * so it is FALSE there — see the first return below.
       */
      currencyUnbound: boolean
    }

export function classifyQboLedgerEvidence(amount: QboLedgerAmount | undefined): QboLedgerEvidence {
  // A document MISSING from the read is not a document with nothing on it: it is one this read said
  // nothing about, and "we did not hear" is never spent as an answer here or anywhere else in the
  // lifecycle.
  if (amount == null || amount.paid == null) {
    return {
      kind: 'UNPROVEN',
      paidAmount: null,
      documentTotal: amount?.total ?? null,
      // An absent row said nothing about a currency either, so there is no binding defect to report;
      // only a row that WAS read and could not be sized carries one.
      //
      // r16: NOT-`LEDGER` rather than `NONE`. Since an IMS currency may only NARROW the bound, every
      // source but the ledger's own read these amounts against the strictest minor unit — which is
      // exactly what this marker is documented to mean, and the operator sentence it selects is the
      // one that sends them to fix the binding.
      currencyUnbound: amount != null && amount.currencySource !== 'LEDGER',
    }
  }
  const { paid, total, outstanding, currency } = amount
  // o3d-psrx r10 (Codex HIGH 3): the threshold is a property of the DOCUMENT'S CURRENCY, not of
  // Xero's two decimal places, and every comparison below is decimal rather than binary float. See
  // `ledgerAmountEpsilon` for why an unstated currency takes the strictest one.
  const epsilon = ledgerAmountEpsilon(currency)
  const paidDecimal = toDecimal(paid)
  // Absolute value, not `> 0`: a paid amount this code cannot explain is not permission to declare the
  // payment gone. Exactly the reading `partitionPaymentReversals` gives a negative `AmountPaid`, so
  // "the ledger holds nothing" means one thing across both connectors.
  if (compareDecimal(paidDecimal.abs(), epsilon) <= 0) return { kind: 'HOLDS_NOTHING' }
  // STRICTLY POSITIVE, and short of a total the ledger actually stated. A negative `paid` fails the
  // first clause rather than being folded into the second, because the outstanding figure would then
  // exceed the document — a state this code has no honest reading of.
  //
  // The amount still outstanding is QuickBooks' OWN `Balance`, carried through from the row, not
  // `total - paid` recomputed here. Same number by construction, but one of them is a figure the
  // ledger stated and the other is an inference, and this verdict reports only what was stated.
  if (
    compareDecimal(paidDecimal, epsilon) > 0
    && total != null && outstanding != null
    && compareDecimal(toDecimal(outstanding), epsilon) > 0
  ) {
    return { kind: 'PARTIALLY_PAID', paidAmount: paid, documentTotal: total, outstandingAmount: outstanding, currency }
  }
  return {
    kind: 'UNPROVEN',
    paidAmount: paid,
    documentTotal: total,
    currencyUnbound: amount.currencySource !== 'LEDGER',
  }
}

/**
 * Split the QBO transactions that regressed out of the fully-paid state into the
 * full reversed set and the subset that was VOIDED. Mirrors the Xero poller's
 * {all, voided} contract (audit-M-acct #3 / scjz.71):
 *  - balanceDueEntities: invoices/bills whose Balance returned to > 0 (the payment
 *    was deleted/un-applied but the document is still live) — eligible for a
 *    revenue chargeback on the sales side.
 *  - voidedEntities: invoices/bills QBO zeroed out (TotalAmt = 0). QBO has already
 *    reversed their AR/revenue, so paidAt is cleared but NO chargeback is raised
 *    (a separate credit note would double-reverse).
 * Pure set union so it can be unit-tested without the QBO API.
 */
export function classifyQboReversals(
  balanceDueEntities: QboEntityId[],
  voidedEntities: QboEntityId[],
): { all: Set<string>; voided: Set<string> } {
  const all = new Set<string>()
  const voided = new Set<string>()
  for (const e of balanceDueEntities) all.add(e.Id)
  for (const e of voidedEntities) {
    all.add(e.Id)
    voided.add(e.Id)
  }
  return { all, voided }
}

// QBO equivalent of Xero's fetchReversedInvoiceIds. An IMS-paid document (Balance
// was 0) is "reversed" if, modified since the last poll, its QBO transaction now
// has Balance > 0 (payment removed) or TotalAmt = 0 (voided/zeroed). Returns null
// if either query failed so the caller can hold the poll watermark and retry.
async function fetchReversedEntityIds(
  entity: 'Invoice' | 'Bill',
  since: string,
  // o3d-psrx r15 (Codex MEDIUM 2): the currency of each IMS document this read might be about, from
  // the candidate rows the caller has ALREADY loaded. Passed in rather than fetched: the poller reads
  // its candidates before it asks QuickBooks anything, so the provenance is in hand, and a resolver
  // that went back to the database here would be a second read of rows the caller is holding.
  documentCurrencies: LedgerDocumentCurrencies,
): Promise<{ all: Set<string>; voided: Set<string>; amounts: Map<string, QboLedgerAmount>; ledgerObservedBefore: LedgerReadFence | null } | null> {
  // o3d-psrx r3 — THE FENCE IS MINTED HERE, AND HERE IS BEFORE THE LEDGER IS ASKED.
  //
  // It is read inside this function rather than by the caller for one reason: the ordering that makes
  // the fence sound is PROGRAM ORDER — this statement running before `qboQuery` — and a fence passed
  // in from elsewhere is a fence whose ordering nobody in this file can see. Null is a legitimate
  // answer (the database clock could not be read) and it decides NOTHING, which withholds every
  // reversal that has a registration to weigh.
  const ledgerObservedBefore = await readDatabaseLedgerFence()
  const [balanceRes, voidedRes] = await Promise.all([
    qboQuery<QboQueryResponse<QboAmountRow>>(entity, `Balance > '0' AND MetaData.LastUpdatedTime > '${since}'`),
    qboQuery<QboQueryResponse<QboAmountRow>>(entity, `TotalAmt = '0' AND MetaData.LastUpdatedTime > '${since}'`),
  ])
  if (!balanceRes.ok || !voidedRes.ok) return null
  const balanceDue = balanceRes.data?.QueryResponse?.[entity] ?? []
  const voided = voidedRes.data?.QueryResponse?.[entity] ?? []
  // o3d-psrx r8 (Codex HIGH 2) — the amounts these same rows already carry, kept instead of thrown
  // away. VOIDED is applied SECOND so a document in both sets is settled by the stronger rule.
  const amounts = new Map<string, QboLedgerAmount>()
  for (const row of balanceDue) amounts.set(row.Id, qboLedgerAmount(row, documentCurrencies.get(row.Id)))
  for (const row of voided) {
    const currency = resolveLedgerRowCurrency(row.CurrencyRef, documentCurrencies.get(row.Id))
    amounts.set(row.Id, qboVoidedAmount(currency.stated, currency.source))
  }
  return { ...classifyQboReversals(balanceDue, voided), amounts, ledgerObservedBefore }
}

/**
 * THE SAME QUESTION, ASKED ABOUT NAMED DOCUMENTS INSTEAD OF A TIME WINDOW (o3d-psrx r4 / o3d-a6i2).
 *
 * `fetchReversedEntityIds` above is the DELTA read: it asks which documents regressed since the
 * watermark, and it is what the watermark is for. This one asks about a LIST OF IDS and is deliberately
 * independent of the cursor — because the documents it is for are the ones the cursor has already moved
 * past, and the thing that will settle them is usually not a QuickBooks change at all (a PENDING
 * registration finishing, a FAILED one being cancelled, a database fence that failed once).
 *
 * ONE CLASSIFICATION, NOT A SECOND ONE WORDED LIKE IT: the two populations are split by
 * `classifyQboReversals`, exactly as the delta read splits them. What differs is only which documents
 * were asked about, which is the whole point.
 *
 * `returned` is the third answer this read gives and the delta read cannot: WHICH of the ids QuickBooks
 * actually answered about. A document that did not come back has not been reconsidered, and "we did not
 * hear" must never be spent as "there is nothing left to decide".
 *
 * Null on any failed query, so the caller closes nothing and every marker stays due.
 */
async function fetchReversedEntityIdsByIds(
  entity: 'Invoice' | 'Bill',
  ids: readonly string[],
  /** o3d-psrx r15: see `fetchReversedEntityIds` — the recheck loads its documents first too. */
  documentCurrencies: LedgerDocumentCurrencies,
): Promise<{ all: Set<string>; voided: Set<string>; returned: Set<string>; unreadable: Set<string>; amounts: Map<string, QboLedgerAmount>; ledgerObservedBefore: LedgerReadFence | null } | null> {
  // Minted BEFORE the ledger is asked, for the reason `fetchReversedEntityIds` gives: the ordering is
  // PROGRAM ORDER, and one fence covering several batches only ever decides FEWER registrations.
  const ledgerObservedBefore = await readDatabaseLedgerFence()
  const balanceDue: QboEntityId[] = []
  const voided: QboEntityId[] = []
  const returned = new Set<string>()
  const unreadable = new Set<string>()
  const amounts = new Map<string, QboLedgerAmount>()
  for (let i = 0; i < ids.length; i += WITHHELD_RECHECK_BATCH) {
    const batch = ids.slice(i, i + WITHHELD_RECHECK_BATCH)
    // Single-quoted ids, and ids that could break out of the quoting are refused rather than escaped:
    // an `accountingInvoiceId` is a QuickBooks-issued numeric id, and anything else in that column is
    // not a document this read can ask about.
    const safe = batch.filter((id) => /^[A-Za-z0-9_-]+$/.test(id))
    if (safe.length === 0) continue
    const res = await qboQuery<QboQueryResponse<QboAmountRow>>(
      entity, `Id IN (${safe.map((id) => `'${id}'`).join(', ')})`,
    )
    if (!res.ok) return null
    for (const row of res.data?.QueryResponse?.[entity] ?? []) {
      returned.add(row.Id)
      // o3d-psrx r10 (Codex HIGH 2) — ONE PARSE, AND EVERY CLASSIFICATION BELOW READS ITS RESULT.
      //
      // These three lines used to ask `typeof row.Balance === 'number'` while the amount map beside
      // them accepted a numeric string. A `Balance` of `"50.00"` therefore failed the balance-due
      // test, the document went into `returned` with no disagreement recorded against it, and the
      // recheck CLOSED its withheld marker as settled while the ledger still disagreed with IMS. Two
      // readers of one field, the stricter deciding whether the marker survives.
      const parsed = parseQboLedgerRow(row, documentCurrencies.get(row.Id))
      // The same two predicates the delta read expresses as `Balance > '0'` and `TotalAmt = '0'`,
      // now over the parsed values rather than over the raw ones.
      const isVoided = parsed.total !== null && parsed.total === 0
      if (parsed.balance !== null && parsed.balance > 0) balanceDue.push({ Id: row.Id })
      // o3d-psrx r11 (Codex HIGH) — AND A FIGURE THE GRAMMAR REFUSED IS NOT A STATEMENT THAT NOTHING
      // IS OUTSTANDING.
      //
      // Every OTHER outcome of this loop is a reading: a balance due, a void, or a stated zero. An
      // unreadable amount is none of them, and the closing loop below reads "returned, nothing
      // still withheld, no error" as SETTLED — so without this the marker on a document whose
      // amount arrived as `"0x64"` (or as anything else `parseLedgerAmount` now refuses) would be
      // CLOSED, which is the r10 defect reached through the parser instead of through a `typeof`.
      // A void is exempt because it IS a reading: the document holds nothing by its own rule.
      //
      // o3d-psrx r12 (Codex HIGH 2) — EITHER FIGURE, NOT JUST `Balance`.
      //
      // r11 watched one field of the two this loop reads, and the escape was the other one:
      // `Balance: "0.00", TotalAmt: "0x0"` gives a readable zero balance (so nothing is due and the
      // document never becomes a candidate) and an unreadable total (so `isVoided` is false and the
      // r11 test never fired) — returned, not withheld, not unreadable, CLOSED as settled, with
      // QuickBooks' own statement of what the document is worth never read at all.
      //
      // WHAT THE CLOSING DECISION READS, ENUMERATED, rather than the field that was named. The rows
      // this read returns carry exactly four fields (`QboAmountRow`), and the marker below closes on:
      //   Id         — the join to the marker. A missing or unmatched one leaves the document out of
      //                `returned`, and the loop DEFERS on that. Fail-safe already.
      //   Balance    — decides `balanceDue`, and so whether the document is a candidate at all.
      //   TotalAmt   — decides `isVoided`, the other way in, and is half of the `paid` figure the
      //                provenance gate weighs.
      //   CurrencyRef— sizes the gate's epsilon (`ledgerAmountEpsilon`) and, since r14, the magnitude
      //                bound the two figures above are read against. r15 made the SECOND of those
      //                resolvable from the IMS document, so this field can now decide whether
      //                `Balance` and `TotalAmt` are readable at all — which is a route to `unreadable`
      //                and therefore to a DEFER. Still fail-safe in both directions: a currency
      //                nothing can supply takes the FINEST minor unit, which gives the STRICTEST
      //                bound (more refusals, so more defers) and the SMALLEST epsilon (which can only
      //                move a document out of HOLDS_NOTHING into a verdict that withholds).
      // So `Balance` and `TotalAmt` are the two whose refusal could be spent as a settlement, and
      // BOTH are watched here. `parsed.currency` deliberately is not: it has no way to close.
      if (!isVoided && (parsed.balance === null || parsed.total === null)) unreadable.add(row.Id)
      if (isVoided) voided.push({ Id: row.Id })
      // o3d-psrx r8: and the amounts, from the row this loop is already holding. Voided by its own
      // rule for the reason `qboVoidedAmount` gives.
      amounts.set(row.Id, isVoided ? qboVoidedAmount(parsed.currency, parsed.currencySource) : qboLedgerAmountFrom(parsed))
    }
  }
  return { ...classifyQboReversals(balanceDue, voided), returned, unreadable, amounts, ledgerObservedBefore }
}

/**
 * o3d-psrx r3 (Codex HIGH) — THE PROVENANCE GATE, APPLIED TO WHATEVER QUICKBOOKS SAYS REGRESSED.
 *
 * THE DEFECT. r2 established that a paid sale IMS never told the ledger about must not be reversed,
 * and wired it into the Xero poller. This poller's reversal candidate query selected neither
 * `unregisteredPaidAt` nor any receipt/registration evidence, so every recently modified balance-due
 * invoice walked straight into reversal handling. A native order marked paid through
 * `markSalesOrderPaid` has no shopping link, sets the marker, and by design creates no ledger
 * payment — it satisfied that query exactly, and IMS's deliberate non-registration read as a removed
 * payment: chargeback credit note raised, `paidAt` cleared, against a customer who paid.
 *
 * ONE DECISION, NOT A SECOND ONE WORDED LIKE IT. `readPaidProvenanceVerdicts` and
 * `zeroPaidIsProvenReversal` are the SAME functions the Xero poller reaches its verdict with. The
 * only connector-shaped argument is `ledgerListedPaymentIds`, and QuickBooks' answer to that is
 * always NULL: the reversal read asks which invoice ids regressed and nothing else, so this poller
 * cannot enumerate the payments a document carries. Null means "absence cannot be established from
 * this payload", NOT "no payments" — so GONE and STILL_HELD are unreachable here and a document with
 * a posted registration lands on LEDGER_DID_NOT_LIST_PAYMENTS.
 *
 * WHICH DIRECTION THIS MOVES. Every verdict `zeroPaidIsProvenReversal` admits was already reversed
 * before this gate existed, so no reversal this poller used to make is lost. What it adds is
 * withholding for the three states that used to reverse wrongly: the paid flag with no ledger
 * receipt behind it (PAID_WITHOUT_LEDGER_RECEIPT), a local receipt not yet registered
 * (RECEIPT_NOT_REGISTERED), and a registration this read cannot speak for (REGISTRATION_UNDECIDED).
 *
 * AND THE RESIDUAL r3 FILED SEPARATELY WAS NOT SEPARATE — IT WAS THE THING THAT MADE THE GATE ADMIT
 * (r8, Codex HIGH 2).
 *
 * r3 wrote here: "`Balance > 0` covers a PART payment as well as a removed one, and this poller does
 * not read the amounts to tell them apart. Xero's poller does (`partitionPaymentReversals`). That is
 * a different defect from the one Codex found and it is filed separately; nothing here makes it
 * worse." Every clause of that is true and the conclusion was wrong, because of what the paragraph
 * above it says: this poller enumerates nothing, so a document with a posted registration lands on
 * `LEDGER_DID_NOT_LIST_PAYMENTS` — an ADMITTED verdict. Put the two together and a bill or invoice
 * with two registrations covering its total, ONE of whose payments was removed, shows a balance due,
 * reaches the gate, is admitted, and has `paidAt` cleared and a chargeback credit note raised over
 * it — while QuickBooks is still holding the other payment. The amount reading was not a nicety this
 * connector lacked; it was the PRECONDITION `zeroPaidIsProvenReversal` is written about, and the
 * whole reason `LEDGER_DID_NOT_LIST_PAYMENTS` may admit at all is that Xero establishes it upstream
 * ("the payload withheld `Payments[]`, but it STATED a zero total").
 *
 * SO THIS GATE ESTABLISHES IT TOO, FROM EVIDENCE IT ALREADY HAD. `qboQuery` issues `SELECT *`, so
 * `TotalAmt` and `Balance` are in the very responses the reversal reads already take — no QuickBooks
 * call is added, and none can be skipped under rate limiting to get around this. A document is asked
 * the registration question ONLY once QuickBooks has stated that it holds nothing on it; anything
 * else — a positive paid amount, or an amount the payload would not state — is
 * `LEDGER_NOT_PROVEN_ZERO_PAID` and withholds.
 *
 * WHAT THIS STILL CANNOT DO, said plainly so nobody reads it as more: it establishes that the ledger
 * holds NOTHING, not WHOSE payment is gone. `GONE` and `STILL_HELD` remain unreachable here, because
 * the reversal read enumerates no payment ids and this round adds no call to fetch them. A zero-paid
 * QuickBooks document carrying a bound registration is therefore still `LEDGER_DID_NOT_LIST_PAYMENTS`
 * and still reverses — which is right, and is the same reading Xero gives a payload with no list and
 * a stated zero.
 *
 * WHAT IT COSTS. A genuine QuickBooks chargeback that removes only PART of the payments on a document
 * no longer clears `paidAt` by itself. It is not lost: the withheld marker written below brings the
 * document back on the recheck timer regardless of the delta cursor, so when the rest of the payment
 * goes the paid amount reaches zero and the next pass reverses it; and until then an operator has a
 * WARNING naming both figures. Set against the alternative, which is clearing `paidAt` and raising a
 * FULL chargeback credit note against a document the ledger is still holding money on, this is the
 * cheaper failure by a wide margin — and it is the reading the Xero poller has always given a
 * part-paid document ("Not a reversal, and the IMS document must stay paid: clearing it re-arms the
 * UI over money that has already moved").
 *
 * AND THE PARAGRAPH ABOVE UNDERSTATED IT, WHICH IS r9's FINDING (Codex HIGH). "When the rest of the
 * payment goes" is a case, not the case. A document that STAYS part paid — half settled, half
 * outstanding, for ever — never reaches a zero paid amount, so nothing above it ever resolves, and r8
 * put it in the same verdict as a payload IMS could not parse. A verdict meaning "IMS could not
 * establish anything" is the wrong name for a document whose figures IMS read perfectly: it made a
 * stated position indistinguishable from an unreadable one and, because the document keeps its
 * `paidAt`, the practical effect was that the disagreement was absorbed as "still paid" and nobody
 * could find it again.
 *
 * SO IT GETS ITS OWN VERDICT, AND NOTHING ELSE CHANGES. `LEDGER_PARTIALLY_PAID` withholds
 * exactly as `LEDGER_NOT_PROVEN_ZERO_PAID` withholds — no reversal decision moves in either direction
 * — but it carries the three figures, the marker carries them as queryable fields, the poll summary
 * counts these documents apart from the rest, and the warning tells the operator plainly that IMS will
 * not reconcile this one. RECONCILING IT — turning the outstanding amount into a partial credit note
 * and unwinding that much of the recognised revenue — is NOT built here and is filed as o3d-cdhl.
 * Recording a disagreement and reconciling it are different pieces of work, and a round that silently
 * did the second because it was doing the first would be putting new money-moving accounting behind a
 * bug fix.
 *
 * AND r10 (Codex HIGH 1) TOOK THE STORY BACK OUT OF IT. r9 called the verdict
 * `LEDGER_PART_PAYMENT_REMOVED` and its third figure `removedAmount`, on the strength of
 * `TotalAmt - Balance`. That arithmetic measures the document as it stands NOW and contains no prior
 * amount and no payment history, so a document that was only ever part paid produces figures
 * identical to one that lost a payment. The quantity was real, the removal was a story told about it,
 * and it is the story an operator acts on. The verdict now reports the ledger's stated position —
 * settled, total, outstanding, and the currency they are in — and says in as many words that this
 * does not establish a removal. Nothing about the reversal decision moved.
 *
 * ONE CORNER OF IT IS NOW CLOSED, and only that corner (r7, Codex HIGH 1). Where the order still
 * carries its off-ledger provenance marker, the SHARED classifier compares what the bound
 * registrations told the ledger against the order's total and withholds when they do not cover it —
 * so a GBP 1 registration going missing can no longer reverse a GBP 100 hand-marked order through
 * this connector either. That mattered here specifically: this poller's `ledgerListedPaymentIds` is
 * always null, so a document with a posted registration lands on LEDGER_DID_NOT_LIST_PAYMENTS, which
 * `zeroPaidIsProvenReversal` ADMITS. The residual above is untouched for every order WITHOUT a
 * marker, which is the population it was written about.
 */
export type QboReversalGate<T> = {
  /** Reversal may proceed: the evidence proves the payment is gone, or there was never one of ours. */
  admitted: T[]
  /** Reversal WITHHELD — `paidAt` is left set and reported, never cleared on unproven evidence. */
  withheld: Array<{ doc: T; verdict: RegisteredPaymentVerdict }>
}

export async function gateQboReversalsOnProvenance<T extends { id: string; accountingInvoiceId: string | null; unregisteredPaidAt?: Date | null }>(
  candidates: T[],
  params: {
    registrationType: 'BILL_PAYMENT' | 'INVOICE_PAYMENT'
    referenceType: 'PurchaseInvoice' | 'SalesOrder'
    ledgerObservedBefore: LedgerReadFence | null
    /**
     * o3d-psrx r8 (Codex HIGH 2) — WHAT QUICKBOOKS SAYS IT STILL HOLDS, KEYED BY `accountingInvoiceId`.
     *
     * Supplied by the reversal read that produced the candidates, from the same response. A document
     * MISSING from this map is not a document with nothing on it: it is one this read said nothing
     * about, and it withholds on the same fail-closed reading an absent verdict gets below.
     */
    ledgerAmounts: ReadonlyMap<string, QboLedgerAmount>
  },
): Promise<QboReversalGate<T>> {
  const gate: QboReversalGate<T> = { admitted: [], withheld: [] }
  if (candidates.length === 0) return gate
  const verdicts = await readPaidProvenanceVerdicts(candidates, {
    connector: QUICKBOOKS_CONNECTOR,
    registrationType: params.registrationType,
    referenceType: params.referenceType,
    ledgerObservedBefore: params.ledgerObservedBefore,
    // QuickBooks' reversal read enumerates no payments. See the header — null is not emptiness.
    ledgerListedPaymentIds: () => null,
  })
  for (const doc of candidates) {
    // o3d-psrx r8 (Codex HIGH 2) — THE PRECONDITION FIRST, AND IT DOMINATES EVERY REGISTRATION
    // VERDICT. `zeroPaidIsProvenReversal` decides whether a ZERO-PAID document may clear `paidAt`;
    // asking it about a document that merely shows a balance due is asking a question whose subject
    // has not been established. Ordered above the registration verdict because it is the cheaper
    // and the more useful of two withholdings: it names the money QuickBooks is still holding, which
    // is what an operator has to go and look at, and no registration evidence can make a document
    // the ledger is still paid on into a proven reversal.
    const amount = doc.accountingInvoiceId == null ? undefined : params.ledgerAmounts.get(doc.accountingInvoiceId)
    // o3d-psrx r9 (Codex HIGH): THREE answers, not two. `classifyQboLedgerEvidence` states them and
    // says why the third exists; what matters here is that a document the ledger STATED as part paid
    // and an evidence ABSENCE stop sharing a verdict, so the marker below can say which one this is.
    const evidence = classifyQboLedgerEvidence(amount)
    // ONE ADMIT/WITHHOLD DECISION, NOT A SECOND ONE WORDED LIKE IT: the precondition is expressed as
    // a VERDICT and put through the same `zeroPaidIsProvenReversal` every other answer goes through,
    // so a connector added next month cannot reach an admitted reversal past a rule stated here.
    const verdict = evidence.kind === 'HOLDS_NOTHING'
      ? verdicts.get(doc.id)
      : evidence.kind === 'PARTIALLY_PAID'
        ? {
            verdict: 'LEDGER_PARTIALLY_PAID' as const,
            paidAmount: evidence.paidAmount,
            documentTotal: evidence.documentTotal,
            outstandingAmount: evidence.outstandingAmount,
            currency: evidence.currency,
          }
        : {
            verdict: 'LEDGER_NOT_PROVEN_ZERO_PAID' as const,
            paidAmount: evidence.paidAmount,
            documentTotal: evidence.documentTotal,
            // o3d-psrx r15 (Codex MEDIUM 2): carried onto the verdict so the withheld sentence and the
            // durable marker can say WHY this document was unreadable, rather than reporting a
            // currency-binding defect as though QuickBooks had declined to state an amount.
            currencyUnbound: evidence.currencyUnbound,
          }
    // NO VERDICT IS NOT A PASS. An absence means nothing was decided about this document, and the
    // fail-closed reading of "nothing was decided" is the same one a null fence gets: withhold.
    if (verdict == null) {
      gate.withheld.push({ doc, verdict: { verdict: 'REGISTRATION_UNDECIDED', entryIds: [] } })
      continue
    }
    if (zeroPaidIsProvenReversal(verdict)) gate.admitted.push(doc)
    else gate.withheld.push({ doc, verdict })
  }
  return gate
}

/** Why a withheld reversal was withheld, in words an operator can act on. */
export function qboWithheldReversalReason(verdict: RegisteredPaymentVerdict): string {
  switch (verdict.verdict) {
    case 'PAID_WITHOUT_LEDGER_RECEIPT':
      return 'IMS holds this as paid from a channel or an operator, and no payment was ever registered '
        + 'with QuickBooks for it. QuickBooks showing a balance due is IMS\'s own silence, not a removed '
        + 'payment, so paidAt was LEFT SET and no chargeback credit note was raised. If the payment '
        + 'really was reversed, unwind it by hand.'
    case 'RECEIPT_NOT_REGISTERED':
      return `IMS has recorded a receipt (${verdict.paymentIds.join(', ')}) that has not been registered `
        + 'with QuickBooks yet, so the balance due is a payment of OURS that has not landed rather than '
        + 'one taken away. paidAt was LEFT SET; IMS will decide this itself once the registration posts.'
    case 'REGISTRATION_UNDECIDED':
      return `IMS holds a payment registration (${verdict.entryIds.join(', ') || 'clock unreadable'}) that `
        + 'this QuickBooks read cannot speak for, so the balance due may be a payment of ours still in '
        + 'flight. paidAt was LEFT SET rather than guessed.'
    case 'STILL_HELD':
      return `QuickBooks still lists the payment IMS registered (${verdict.paymentIds.join(', ')}) on a `
        + 'document it reports as unpaid. That contradiction is not proof of a reversal, so paidAt was '
        + 'LEFT SET. Reconcile the document in QuickBooks.'
    // o3d-psrx r7 (Codex HIGH 1). REACHABLE FROM THIS CONNECTOR, and by the route the header above
    // describes: QuickBooks enumerates no payments, so a document with a posted registration lands on
    // LEDGER_DID_NOT_LIST_PAYMENTS — which `zeroPaidIsProvenReversal` ADMITS. A £1 registration on a
    // £100 order marked paid off-ledger therefore reversed the whole £100 here exactly as it did on
    // the Xero side, and the guard that stops it lives in the shared classifier for that reason.
    case 'PART_COVERED_OFF_LEDGER':
      return `IMS holds this as paid on evidence QuickBooks was never given, and the payment `
        + `registration(s) it did raise `
        + `${verdict.registeredTotal == null
          ? 'do not record how much they sent'
          : `cover only ${verdict.registeredTotal} of the order's ${verdict.documentTotal} total`}. `
        + `A balance due is therefore an account of PART of this order; the rest of it was never in `
        + `QuickBooks to be removed. paidAt was LEFT SET and no chargeback credit note was raised. `
        + `Record the remaining receipt, or unwind the order by hand if the payment is genuinely gone.`
    // o3d-psrx r8 (Codex HIGH 2). The evidence QuickBooks CAN give about a reversal, and it is about
    // the document rather than about IMS's rows — so the operator's action is different from every
    // other arm here: go and look at what the ledger is still holding, not at a sync row.
    case 'LEDGER_NOT_PROVEN_ZERO_PAID':
      // o3d-psrx r15 (Codex MEDIUM 2), REWORDED IN r16 — THE BINDING DEFECT IS ITS OWN SENTENCE,
      // BECAUSE IT SENDS THE OPERATOR SOMEWHERE ELSE. Every other wording in this arm sends them to the
      // QuickBooks document to see what is applied to it; this one is about nothing being able to say
      // what currency the figures are in, and the document they would open looks perfectly ordinary.
      //
      // r16 NAMES ONE FIX AND NOT TWO. r15's wording offered "set the currency on the linked IMS
      // document" as an alternative, which was true only while an IMS currency could widen the bound.
      // It cannot — an unverified code may tighten a read and never loosen one — so that half of the
      // sentence would now send an operator to make a change that decides nothing. An instruction that
      // does not work is worse than no instruction.
      if (verdict.currencyUnbound) {
        return 'QuickBooks answered about this document without stating a CurrencyRef, so nothing the '
          + 'ledger said could size the minor unit its amounts are denominated in. The currency the '
          + 'linked IMS order or purchase order records is NOT used to size them: nothing has verified '
          + 'it against QuickBooks, and reading a document with a coarser minor unit than its real one '
          + 'is how a payment still on the ledger reads as nothing. So these amounts were read against '
          + 'the finest precision IMS supports, which refused them, and the ledger has NOT been shown '
          + 'to hold nothing on this document. paidAt was LEFT SET and no chargeback credit note was '
          + 'raised. Enable multicurrency in QuickBooks so it states a CurrencyRef on this document, '
          + 'and the next poll decides this by itself.'
      }
      return verdict.paidAmount == null
        ? 'QuickBooks reported a balance due on this document without stating an amount IMS could '
          + 'read, so it has not been shown to be holding NOTHING. A balance due on its own does not '
          + 'establish that the payments IMS registered were removed — a payment that is PART of the '
          + 'document produces the same balance. paidAt was LEFT SET and no chargeback credit note '
          + 'was raised. Open the document in QuickBooks to see what is still applied to it.'
        // o3d-psrx r9 (Codex HIGH): NO LONGER THE PART-PAYMENT SENTENCE. A document the ledger states
        // as part paid has its own verdict now, so what is left here is a figure that does not
        // describe one — a total QuickBooks would not state, an amount it reports as still fully
        // paid, or a quantity this code will not subtract. Saying "part of the money is missing"
        // about any of those would be an assertion about money nobody established, which is the fault
        // the split exists to end.
        : `QuickBooks answered about this document with figures IMS cannot read a removal out of: it `
          + `reports ${verdict.paidAmount} still paid `
          + `${verdict.documentTotal == null
            ? 'on a document whose total it did not state'
            : `against a total of ${verdict.documentTotal}`}, which does not show that anything was `
          + `taken away. paidAt was LEFT SET and no chargeback credit note was raised. Open the `
          + `document in QuickBooks to see what is applied to it. (A document QuickBooks states as `
          + `only PART PAID is reported separately and names the amount still outstanding.)`
    // o3d-psrx r9 (Codex HIGH), REWRITTEN IN r10 (Codex HIGH 1). THE ONE ARM THAT REPORTS A STANDING
    // DISAGREEMENT RATHER THAN AN UNCERTAINTY, and the only one that has to tell an operator IMS will
    // not put it right by itself. Every other withheld sentence above describes something IMS expects
    // to settle — a registration lands, a receipt is recorded, a figure becomes readable — and says
    // so. This one cannot: there is no partial-settlement accounting path (o3d-cdhl), and the
    // document will keep reading as fully paid until a person changes it.
    //
    // WHAT IT MUST NOT SAY. r9's wording was "has given back part of the payment … so N has been
    // removed", which asserts a HISTORY that `TotalAmt` and `Balance` do not contain: a document that
    // was only ever part paid states exactly the same two figures as one that lost a payment. So the
    // sentence states the ledger's position, states IMS's, and names the difference between them —
    // and leaves the operator to find out which it is, because that is the question IMS cannot answer
    // and the one they are being sent to the document to settle.
    case 'LEDGER_PARTIALLY_PAID':
      return `QuickBooks states this document is only PART PAID, while IMS holds it as fully paid: `
        + `QuickBooks reports ${verdict.paidAmount} settled of a ${verdict.documentTotal} total, `
        + `leaving ${verdict.outstandingAmount} outstanding`
        + `${verdict.currency == null ? '' : ` (${verdict.currency})`}. THAT IS ALL IMS KNOWS: these `
        + `figures describe the document as it stands now, and a document that was only ever part `
        + `paid looks identical to one a payment was taken back from — so this is NOT a report that a `
        + `payment was removed. IMS did not act on it either way: clearing paidAt and raising a full `
        + `credit note would reverse the ${verdict.paidAmount} QuickBooks still accounts for. paidAt `
        + `was LEFT SET, so IMS goes on showing this document as fully paid and WILL NOT correct that `
        + `by itself. Open it in QuickBooks and see what the ${verdict.outstandingAmount} is: if it is `
        + `still owed, settle it there and IMS closes this by itself on the next poll; if a payment `
        + `was taken back, raise the credit note for it by hand and correct the order. This warning is `
        + `rewritten on every recheck until the two agree, and if the remaining ${verdict.paidAmount} `
        + `goes too IMS will reverse the document in full by itself.`
    case 'GONE':
    case 'NOTHING_REGISTERED':
    case 'LEDGER_DID_NOT_LIST_PAYMENTS':
      // Not reachable — these are the admitted verdicts. Stated rather than defaulted so a new
      // verdict added to the union is a type error here instead of a silent generic sentence.
      return 'Reversal was admitted; no reason to report.'
  }
}

/**
 * THE SALES REVERSAL CANDIDATES, AS ONE CALLABLE STEP (o3d-psrx r3, Codex HIGH).
 *
 * Lifted out of `pollQuickBooksPayments` for the same reason `readSalesResidualVerdicts` was lifted
 * out of the Xero poller: the defect Codex found was a break in the wiring from the DATABASE ROW to
 * the VERDICT — the poller asked a question the row could answer and never selected the column that
 * answers it — and a test that rebuilt the query by hand would have sailed straight over it. This is
 * the poller's OWN query, and tests/concurrency/qbo-paid-provenance-reversal.concurrent.test.ts calls
 * THIS and feeds it to the SAME gate production feeds it to, against a real PostgreSQL and with no
 * QuickBooks call anywhere.
 */
export async function readQboSalesReversalCandidates() {
  return await db.salesOrder.findMany({
    where: {
      accountingInvoiceId: { not: null },
      paidAt: { not: null },
      shoppingLinks: { none: {} },
    },
    select: {
      id: true,
      accountingInvoiceId: true,
      orderNumber: true,
      externalOrderNumber: true,
      status: true,
      revenueDeferredDate: true,
      // o3d-psrx r15 (Codex MEDIUM 2): WHAT THIS ORDER IS DENOMINATED IN, selected with the candidates
      // for the same reason `unregisteredPaidAt` is — the reversal verdict turns on it. QuickBooks
      // omits `CurrencyRef` whenever multicurrency is off, and without this column the amounts on an
      // ordinary base-currency document are read against the finest minor unit and refused.
      currency: true,
      // o3d-psrx r3 (Codex HIGH): WHERE this order's paid flag came from. Selected with `paidAt`'s own
      // candidates because the reversal verdict turns on it — see gateQboReversalsOnProvenance.
      // Leaving it out is the defect itself: every verdict then reads as NOTHING_REGISTERED and a sale
      // an operator marked paid by hand is reversed with a chargeback credit note against it.
      unregisteredPaidAt: true,
    },
  })
}

/** The bill reversal candidates, same reasoning. A bill carries no provenance column (o3d-a3wx). */
export async function readQboBillReversalCandidates() {
  return await db.purchaseInvoice.findMany({
    where: { accountingInvoiceId: { not: null }, paidAt: { not: null } },
    // o3d-psrx r15: `po.currency` is the bill's denomination — a PurchaseInvoice carries no currency
    // column of its own, it holds foreign/base pairs against the PO's. See `resolveLedgerRowCurrency`.
    select: { id: true, accountingInvoiceId: true, poId: true, po: { select: { reference: true, status: true, currency: true } } },
  })
}

export type QboSalesReversalDoc = Awaited<ReturnType<typeof readQboSalesReversalCandidates>>[number]
export type QboBillReversalDoc = Awaited<ReturnType<typeof readQboBillReversalCandidates>>[number]

/**
 * THE DURABLE RECORD OF A WITHHELD REVERSAL, AND THE THING THAT BRINGS IT BACK (o3d-psrx r4).
 *
 * Before r4 this was `logActivity` — fire and forget — and the poll checkpointed regardless. That was
 * the whole of Codex's second finding: QuickBooks selects candidates only where `LastUpdatedTime`
 * exceeds the watermark, so a withheld document whose cause resolves LOCALLY (a PENDING registration
 * finishing, a FAILED one cancelled, a database fence that failed once) was never asked about again.
 *
 * Two things changed, and they are different things:
 *
 *   THE ROW IS THE WORK ITEM. It carries `connector` so `openWithheldDocuments` can claim it, and its
 *   `createdAt` is the recheck timer. Writing it again is what restarts that timer.
 *   A ROW THAT DID NOT LAND HOLDS THE WATERMARK. This is the one case where holding the cursor is
 *   right and not a freeze: with no marker there is nothing to bring the document back at all, so the
 *   delta window is the only remaining route to it. (A marker that DID land never holds the cursor —
 *   see the note at the withheld loop.)
 */
/**
 * o3d-psrx r9 (Codex HIGH) — THE LEDGER'S STATED FIGURES, ON THE MARKER, AS FIELDS RATHER THAN PROSE.
 *
 * A withheld marker is the durable record and the recheck work item both. For every other verdict
 * that is enough: the marker says "undecided", and what settles it is a later read. A document the
 * ledger states as PART PAID is different in kind — nothing about it is undecided and nothing IMS
 * does will settle it — so the marker has to carry the AMOUNTS, not just the classification, or the
 * only place they exist is inside an English sentence nobody can query.
 *
 * o3d-psrx r10 (Codex HIGH 1): `removedAmount` is now `outstandingAmount`, because that is what the
 * figure is — the ledger's own balance, what is still owed. The old name asserted that this much had
 * been paid and taken back, which `TotalAmt - Balance` cannot establish. `ledgerCurrency` is written
 * beside them: an amount stored as a bare number, to be listed later next to amounts from other
 * documents, is not a figure anybody can add up.
 *
 * Written only for the verdict that actually carries figures. Emitting nulls for every other verdict
 * would make `outstandingAmount IS NOT NULL` useless as the way to find these, which is the one thing
 * this is for.
 */
function withheldMarkerMoney(verdict: RegisteredPaymentVerdict): Record<string, number | boolean | string> {
  // o3d-psrx r15 (Codex MEDIUM 2): the binding defect is queryable too, and for the same reason the
  // part-paid figures are — the only other place it exists is inside an English sentence. Emitted
  // only when it is TRUE, so `currencyUnbound = true` remains the way to find these.
  if (verdict.verdict === 'LEDGER_NOT_PROVEN_ZERO_PAID') {
    return verdict.currencyUnbound ? { currencyUnbound: true } : {}
  }
  if (verdict.verdict !== 'LEDGER_PARTIALLY_PAID') return {}
  return {
    ledgerPartiallyPaid: true,
    ledgerPaidAmount: verdict.paidAmount,
    documentTotal: verdict.documentTotal,
    outstandingAmount: verdict.outstandingAmount,
    ...(verdict.currency == null ? {} : { ledgerCurrency: verdict.currency }),
  }
}

async function signalWithheldQboReversal(entry: {
  entityType: 'SALES_ORDER' | 'PURCHASE_ORDER'
  entityId: string
  action: 'payment_reversal_withheld' | 'bill_payment_reversal_withheld'
  description: string
  accountingInvoiceId: string | null
  verdict: RegisteredPaymentVerdict
}): Promise<boolean> {
  return await logActivityPersisted({
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    tag: 'sync',
    level: 'WARNING',
    description: entry.description,
    metadata: {
      // o3d-psrx r4: WHOSE marker this is. The Xero poller writes the same action names, and a recheck
      // that claimed the other connector's rows would ask the wrong ledger about the wrong ids.
      connector: QUICKBOOKS_CONNECTOR,
      registrationVerdict: entry.verdict.verdict,
      accountingInvoiceId: entry.accountingInvoiceId,
      // o3d-psrx r9: and the figures, when there ARE figures. See `withheldMarkerMoney`.
      ...withheldMarkerMoney(entry.verdict),
    },
    resolveUser: false,
  })
}

function qboSalesWithheldDescription(order: QboSalesReversalDoc, verdict: RegisteredPaymentVerdict): string {
  return `QuickBooks reports a balance due on order ${order.orderNumber ?? order.externalOrderNumber} `
    + `(status: ${order.status}), but the payment reversal was WITHHELD. ${qboWithheldReversalReason(verdict)}`
}

function qboBillWithheldDescription(bill: QboBillReversalDoc, verdict: RegisteredPaymentVerdict): string {
  return `QuickBooks reports a balance due on the bill for PO ${bill.po.reference} `
    + `(PO status: ${bill.po.status}), but the payment reversal was WITHHELD. ${qboWithheldReversalReason(verdict)}`
}

/**
 * The closing effects of an ADMITTED sales reversal, as one step both the delta pass and the recheck
 * run. Lifted out in r4 for the reason the candidate query was lifted out in r3: a recheck that
 * re-implemented "what happens when a reversal is admitted" would be a second answer to the question
 * that raises credit notes.
 *
 * `holdWatermark` is a FAILED chargeback: `paidAt` is left set so the reversal is retried, and the
 * cursor must not move past the invoice or the retry never happens.
 */
async function applyQboSalesReversal(
  order: QboSalesReversalDoc,
  opts: { invoiceVoided: boolean },
  errors: string[],
): Promise<{ reversed: boolean; holdWatermark: boolean }> {
  // scjz.71: a reversed payment on a revenue-POSTED order (revenue recognised +
  // invoiced) is a chargeback — raise a revenue-only credit note that reverses
  // recognised revenue against AR. Idempotent (one chargeback per order).
  // A VOIDED invoice has already had its AR/revenue reversed by QBO, so a
  // separate credit note would double-reverse — only auto-chargeback an
  // un-applied payment where the invoice is still live.
  // CRITICAL: clear paidAt ONLY after the chargeback is recorded — otherwise a
  // failed chargeback would drop the order out of the next poll's paidOrders
  // (paidAt: not null) and the recognised revenue would never be reversed.
  let chargebackFailed = false
  // o3d-w00 (Codex r8 #3): the refusal the posted-VAT fence raises stands until an admin changes
  // the tax configuration, so holding paidAt AND the poll watermark for it would freeze the whole
  // QuickBooks cursor indefinitely — every later payment and reversal behind it, not just this
  // order. Payment truth is reconciled and the order flagged instead.
  let chargebackManualReason: string | undefined
  if (order.revenueDeferredDate && !opts.invoiceVoided) {
    try {
      const { raiseChargebackForReversedOrder } = await import('@/app/actions/sales')
      const chargeback = await raiseChargebackForReversedOrder(order.id, { internalBypassToken: INTERNAL_ACTION_BYPASS })
      if (chargeback.error && chargeback.manualResolutionRequired) {
        chargebackManualReason = chargeback.error
        errors.push(`Chargeback for order ${order.orderNumber ?? order.id} needs manual handling: ${chargeback.error}`)
      } else if (chargeback.error) {
        chargebackFailed = true
        errors.push(`Chargeback for order ${order.orderNumber ?? order.id} failed: ${chargeback.error}`)
      }
    } catch (chargebackError) {
      chargebackFailed = true
      errors.push(`Chargeback for order ${order.orderNumber ?? order.id} failed: ${String(chargebackError)}`)
    }
  }
  // Leave paidAt set on a failed chargeback so the reversal is re-attempted and
  // the order is not silently shown unpaid-and-unreversed. Also hold the poll
  // watermark: unlike Xero (whose cursor gate is errors.length===0), the QBO
  // cursor advances on allQueriesSucceeded, so without this the window moves past
  // the reversed invoice and the LastUpdatedTime>since reversal query never
  // re-returns it — the chargeback would never actually retry.
  if (chargebackFailed) return { reversed: false, holdWatermark: true }
  // o3d-psrx r2: the provenance is cleared with the flag it describes.
  await db.salesOrder.update({
    where: { id: order.id },
    data: { paidAt: null, unregisteredPaidAt: null },
  })
  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: order.id,
    action: 'payment_reversal_detected',
    tag: 'sync',
    level: 'WARNING',
    description: chargebackManualReason
      ? `Payment no longer present in QuickBooks for order ${order.orderNumber ?? order.externalOrderNumber} (status: ${order.status}) — cleared paidAt, but the revenue unwind was REFUSED and no credit note has been raised: ${chargebackManualReason} Raise the credit note manually, or fix the tax mapping and re-run the poller.`
      : `Payment no longer present in QuickBooks for order ${order.orderNumber ?? order.externalOrderNumber} (status: ${order.status}) — cleared paidAt. Review whether the order status should revert.`,
    resolveUser: false,
  })
  return { reversed: true, holdWatermark: false }
}

/** The closing effects of an ADMITTED bill reversal. No chargeback equivalent on the purchase side. */
async function applyQboBillReversal(bill: QboBillReversalDoc): Promise<void> {
  await db.purchaseInvoice.update({ where: { id: bill.id }, data: { paidAt: null } })
  await logActivity({
    entityType: 'PURCHASE_ORDER',
    entityId: bill.poId,
    action: 'bill_payment_reversal_detected',
    tag: 'sync',
    level: 'WARNING',
    description: `Bill payment no longer present in QuickBooks for PO ${bill.po.reference} (PO status: ${bill.po.status}) — cleared paidAt.`,
    resolveUser: false,
  })
}

/**
 * GO BACK AND RE-ASK EVERY WITHHELD QUICKBOOKS REVERSAL THAT HAS RESTED LONG ENOUGH
 * (o3d-psrx r4, Codex HIGH; closes o3d-a6i2).
 *
 * THE DEFECT. `pollQuickBooksPayments` advances `LastUpdatedTime` after every successful query, and
 * candidates are selected only where `LastUpdatedTime` exceeds it. A withheld candidate was therefore
 * checkpointed past — and several of the causes that withhold it resolve with NO QuickBooks document
 * change: a PENDING or PROCESSING registration finishing or being CANCELLED, or a database fence that
 * failed once. A genuine chargeback or supplier-payment reversal could stay represented as paid
 * indefinitely, recoverable only by a human reading the warning.
 *
 * WHAT THIS IS NOT. It is not a cursor hold. Holding the cursor for a paid flag that by design is
 * never registered would freeze every later QuickBooks payment and reversal behind it — the trap
 * o3d-w00 records, and the reason r3 advanced the watermark deliberately. The cursor keeps moving AND
 * the withheld documents are revisited BY KEY.
 *
 * THE LIFECYCLE IS XERO'S, NOT A SECOND ONE WORDED LIKE IT. `openWithheldDocuments`,
 * `dueWithheldMarkers`, `closeWithheldMarker` and `deferWithheldMarker` are the same functions
 * o3d-clxw rounds 4–6 argued into shape, moved to lib/domain/accounting/withheld-reversal-markers.ts
 * because none of that reasoning was ever about Xero: the work item is an activity row, the timer is
 * its `createdAt`, the page is a round robin over documents rather than rows, and a settled document
 * cannot spend the scan. All this connector supplies is its own read-by-id and its own gate — which is
 * the SAME gate the delta pass uses, so a recheck cannot reach a verdict the delta would not have.
 *
 * FAILURE IS ALWAYS TOWARDS ASKING AGAIN. A QuickBooks read that fails closes nothing; a document
 * QuickBooks did not return is DEFERRED, not closed; and a pass that recorded any error while these
 * documents were being decided defers rather than closes, because "we could not decide" must never be
 * spent as "there is nothing left to decide" (o3d-clxw round 5, finding 2).
 */
export async function recheckWithheldQboReversals(
  errors: string[],
): Promise<{ rechecked: number; resolved: number; salesReversed: number; billsReversed: number; partiallyPaidDocuments: number }> {
  // o3d-psrx r9: `partiallyPaidDocuments` is counted separately from `rechecked` because it is the
  // one outcome of a recheck that is NOT progress — the document was reconsidered, the ledger stated
  // the same part-paid position, and nothing IMS does will change it. See the poll summary.
  const out = { rechecked: 0, resolved: 0, salesReversed: 0, billsReversed: 0, partiallyPaidDocuments: 0 }
  // NO AGE BOUND (o3d-psrx r5, Codex HIGH 2). Every still-open marker is scanned, however old: an
  // outage longer than any horizon is exactly when a withheld reversal must not be dropped, and the
  // page is bounded by DOCUMENTS rather than by time. See the module note in withheld-reversal-markers.
  const { open: openMarkers, closed: closureMarkers } = await openWithheldDocuments(QBO_MARKER_SCOPE)
  const due = dueWithheldMarkers(openMarkers, closureMarkers, Date.now())
  if (due.length === 0) return out
  out.rechecked = due.length

  const poIds = due.filter((m) => m.entityType === 'PURCHASE_ORDER').map((m) => m.entityId)
  const soIds = due.filter((m) => m.entityType === 'SALES_ORDER').map((m) => m.entityId)

  // Only documents IMS STILL holds as paid have a disagreement left to settle. One PO can carry more
  // than one bill, which is why the bill side is keyed by poId and may map to several documents.
  const bills = poIds.length === 0 ? [] : await db.purchaseInvoice.findMany({
    where: { poId: { in: poIds }, paidAt: { not: null }, accountingInvoiceId: { not: null } },
    select: { id: true, accountingInvoiceId: true, poId: true, po: { select: { reference: true, status: true, currency: true } } },
  })
  const orders = soIds.length === 0 ? [] : await db.salesOrder.findMany({
    where: { id: { in: soIds }, paidAt: { not: null }, accountingInvoiceId: { not: null } },
    select: {
      id: true,
      accountingInvoiceId: true,
      orderNumber: true,
      externalOrderNumber: true,
      status: true,
      revenueDeferredDate: true,
      // o3d-psrx r15: and the currency, for the reason the delta candidate query gives — this read
      // feeds the SAME amount reader, so a recheck must be able to size the figures the delta could.
      currency: true,
      // No exceptions to the provenance rule inside a file that decides reversals — this read feeds
      // the SAME gate the delta pass feeds, and the gate is what consumes it.
      unregisteredPaidAt: true,
    },
  })

  const documentIdsByEntity = new Map<string, string[]>()
  const add = (key: string, invoiceId: string | null): void => {
    if (!invoiceId) return
    documentIdsByEntity.set(key, [...(documentIdsByEntity.get(key) ?? []), invoiceId])
  }
  for (const bill of bills) add(withheldEntityKey('PURCHASE_ORDER', bill.poId), bill.accountingInvoiceId)
  for (const order of orders) add(withheldEntityKey('SALES_ORDER', order.id), order.accountingInvoiceId)

  const salesRead = orders.length === 0 ? null : await fetchReversedEntityIdsByIds(
    'Invoice', [...new Set(orders.map((o) => o.accountingInvoiceId).filter((id): id is string => id != null))],
    ledgerDocumentCurrencies(orders))
  const billsRead = bills.length === 0 ? null : await fetchReversedEntityIdsByIds(
    'Bill', [...new Set(bills.map((b) => b.accountingInvoiceId).filter((id): id is string => id != null))],
    ledgerDocumentCurrencies(bills.map((b) => ({ accountingInvoiceId: b.accountingInvoiceId, currency: b.po.currency }))))
  if ((orders.length > 0 && salesRead == null) || (bills.length > 0 && billsRead == null)) {
    // Nothing is closed and nothing is deferred: every due document keeps the marker it already has,
    // so the whole page is still due on the next poll.
    errors.push('Withheld-reversal recheck could not read QuickBooks; nothing was reconsidered.')
    return out
  }

  const returned = new Set<string>([...(salesRead?.returned ?? []), ...(billsRead?.returned ?? [])])
  // o3d-psrx r11: documents QuickBooks answered about in figures IMS could not read. See the defer below.
  const unreadable = new Set<string>([...(salesRead?.unreadable ?? []), ...(billsRead?.unreadable ?? [])])
  const stillWithheld = new Set<string>()
  // The recheck's equivalent of refusing to checkpoint is refusing to CLOSE, so it watches the same
  // signal the delta pass does: any error recorded while these documents were being decided means this
  // pass did not decide them all. Coarse in the safe direction only — an unrelated error defers
  // documents that were in fact settled, which costs one activity row and one more reconsideration.
  const errorsBeforeDecision = errors.length

  if (salesRead != null && orders.length > 0) {
    const gate = await gateQboReversalsOnProvenance(detectPaymentReversals(orders, salesRead.all), {
      registrationType: 'INVOICE_PAYMENT',
      referenceType: 'SalesOrder',
      ledgerObservedBefore: salesRead.ledgerObservedBefore,
      // o3d-psrx r8: the amounts from the SAME read that produced these candidates.
      ledgerAmounts: salesRead.amounts,
    })
    for (const { doc: order, verdict } of gate.withheld) {
      // Rewriting the marker is what RESTARTS the timer, which is what keeps the page a round robin
      // rather than a queue with a permanent head. `observe` before the write, not after: "we could
      // not write it down" must never be mistaken for "the disagreement is over".
      stillWithheld.add(withheldEntityKey('SALES_ORDER', order.id))
      if (verdict.verdict === 'LEDGER_PARTIALLY_PAID') out.partiallyPaidDocuments++
      await signalWithheldQboReversal({
        entityType: 'SALES_ORDER',
        entityId: order.id,
        action: 'payment_reversal_withheld',
        description: qboSalesWithheldDescription(order, verdict),
        accountingInvoiceId: order.accountingInvoiceId,
        verdict,
      })
    }
    for (const order of gate.admitted) {
      const invoiceVoided = order.accountingInvoiceId != null && salesRead.voided.has(order.accountingInvoiceId)
      const applied = await applyQboSalesReversal(order, { invoiceVoided }, errors)
      if (applied.reversed) out.salesReversed++
      // A failed chargeback leaves `paidAt` set and the disagreement open, so the marker stays.
      else stillWithheld.add(withheldEntityKey('SALES_ORDER', order.id))
    }
  }

  if (billsRead != null && bills.length > 0) {
    const gate = await gateQboReversalsOnProvenance(detectPaymentReversals(bills, billsRead.all), {
      registrationType: 'BILL_PAYMENT',
      referenceType: 'PurchaseInvoice',
      ledgerObservedBefore: billsRead.ledgerObservedBefore,
      ledgerAmounts: billsRead.amounts,
    })
    for (const { doc: bill, verdict } of gate.withheld) {
      stillWithheld.add(withheldEntityKey('PURCHASE_ORDER', bill.poId))
      if (verdict.verdict === 'LEDGER_PARTIALLY_PAID') out.partiallyPaidDocuments++
      await signalWithheldQboReversal({
        entityType: 'PURCHASE_ORDER',
        entityId: bill.poId,
        action: 'bill_payment_reversal_withheld',
        description: qboBillWithheldDescription(bill, verdict),
        accountingInvoiceId: bill.accountingInvoiceId,
        verdict,
      })
    }
    for (const bill of gate.admitted) {
      await applyQboBillReversal(bill)
      out.billsReversed++
    }
  }

  const decisionIncomplete = errors.length > errorsBeforeDecision

  for (const marker of due) {
    const key = withheldEntityKey(marker.entityType, marker.entityId)
    // Still withheld — the signal pass has already rewritten the marker, which restarts its timer. If
    // that write failed the OLD marker stands, and the document simply stays due.
    if (stillWithheld.has(key)) continue

    const documentIds = documentIdsByEntity.get(key)
    // Grounded in IMS's own state and in nothing QuickBooks said, so an error in the decision pass has
    // no bearing on it: there is no disagreement left to decide either way.
    if (!documentIds || documentIds.length === 0) {
      out.resolved++
      await closeWithheldMarker(marker, QBO_MARKER_SCOPE.connector, 'no-paid-document',
        'IMS no longer holds a paid, QuickBooks-linked document for this record, so the withheld '
        + 'payment reversal has nothing left to decide and is closed.')
      continue
    }
    // A read that did not come back cannot close anything. Deferring rewrites the marker so this
    // document goes to the BACK of the oldest-first page instead of holding its head for ever.
    if (!documentIds.every((id) => returned.has(id))) {
      await deferWithheldMarker(marker, QBO_MARKER_SCOPE.connector, 'QuickBooks did not return the document')
      continue
    }
    // o3d-psrx r11 (Codex HIGH) — A DOCUMENT THAT CAME BACK IN FIGURES IMS COULD NOT READ HAS NOT
    // BEEN RECONSIDERED EITHER. It contributed no balance due for the same reason it contributed no
    // amount: nobody read it. Closing here would spend "we could not read it" as "there is nothing
    // left to decide", which is the one thing this whole loop is written not to do.
    if (documentIds.some((id) => unreadable.has(id))) {
      await deferWithheldMarker(marker, QBO_MARKER_SCOPE.connector,
        'QuickBooks stated an amount on the document that is not decimal money, so IMS could not read it')
      continue
    }
    if (decisionIncomplete) {
      await deferWithheldMarker(marker, QBO_MARKER_SCOPE.connector, 'the reconsideration pass could not complete')
      continue
    }
    out.resolved++
    await closeWithheldMarker(marker, QBO_MARKER_SCOPE.connector, 'settled',
      'The withheld payment reversal for this document was reconsidered against a fresh QuickBooks '
      + 'read and is no longer withheld — it was either reversed, or the ledger and IMS now agree. Closed.')
  }

  return out
}

/**
 * Poll QuickBooks for paid invoices and bills.
 * Updates paidAt on matching IMS records and advances order status.
 */
export async function pollQuickBooksPayments(): Promise<{ salesPaid: number; billsPaid: number; salesReversed: number; billsReversed: number; salesReversalsWithheld: number; billsReversalsWithheld: number; partiallyPaidDocuments: number; withheldRechecked: number; withheldResolved: number; errors: string[] }> {
  const errors: string[] = []
  let salesPaid = 0
  let billsPaid = 0
  let salesReversed = 0
  let billsReversed = 0
  // o3d-psrx r3: reversals the provenance gate refused. Reported, never silently dropped.
  let salesReversalsWithheld = 0
  let billsReversalsWithheld = 0
  // o3d-psrx r9 (Codex HIGH): of those withheld reversals, the ones where QuickBooks STATED the
  // document as part paid — a settled amount, a total, and a balance still outstanding — against an
  // IMS document held as fully paid. Counted apart from the rest because it is the only withheld
  // outcome that will never resolve on its own: every other one is waiting for something (a
  // registration, a readable figure, a fresh read), and this one is waiting for a person. A summary
  // that reported it inside `salesReversalsWithheld` would say a poll is making progress when it is
  // repeating itself.
  let partiallyPaidDocuments = 0
  // o3d-psrx r4 / o3d-a6i2: withheld documents re-asked off the delta cursor, and the ones that settled.
  let withheldRechecked = 0
  let withheldResolved = 0
  let allQueriesSucceeded = true

  const lastPoll = await getSettingValue(LAST_POLL_KEY)
  const since = lastPoll || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const now = new Date().toISOString()

  // --- Sales invoices (customer payments) ---
  const unpaidOrders = await db.salesOrder.findMany({
    where: {
      accountingInvoiceId: { not: null },
      paidAt: null,
      refundStatus: { not: 'FULL' }, // a fully refunded order must not be revived as paid
      shoppingLinks: { none: {} }, // manual orders only; shopping orders get channel payment status
    },
    select: { id: true, accountingInvoiceId: true, status: true },
  })

  if (unpaidOrders.length > 0) {
    // Query QBO for invoices with zero balance (fully paid)
    const res = await qboQuery<QboQueryResponse<QboInvoice>>(
      'Invoice',
      `Balance = '0' AND MetaData.LastUpdatedTime > '${since}'`,
    )

    if (!res.ok) {
      allQueriesSucceeded = false
      errors.push(`Failed to query QuickBooks invoices: ${res.error ?? 'Unknown error'}`)
    } else {
      const paidInvoices = res.data?.QueryResponse?.Invoice ?? []
      const paidInvoiceIds = new Set(paidInvoices.map((i) => i.Id))

      for (const order of unpaidOrders) {
        if (!order.accountingInvoiceId || !paidInvoiceIds.has(order.accountingInvoiceId)) continue

        try {
          // o3d-psrx r2: `unregisteredPaidAt: null` — a LEDGER-sourced paid flag (QuickBooks reported
          // the invoice paid). See SalesOrder.unregisteredPaidAt. Written here rather than left off
          // the object so this writer cannot inherit a marker an earlier non-ledger write left behind,
          // and so the paid-provenance guard can see it: an untyped `Record<string, unknown>` is
          // exactly the shape in which a missing column is not a type error.
          const updateData: Record<string, unknown> = { paidAt: new Date(), unregisteredPaidAt: null }
          // Advance status from PENDING_PAYMENT to PROCESSING
          if (order.status === 'PENDING_PAYMENT') {
            updateData.status = 'PROCESSING'
          }
          await db.salesOrder.update({
            where: { id: order.id },
            data: updateData,
          })

          // Trigger auto-allocation if status advanced.
          // o3d-67y: this runs in the sessionless cron, so it MUST pass INTERNAL_ACTION_BYPASS (as the Xero
          // poller does) — otherwise requirePermission('sales.process') fails, autoAllocateOrder returns
          // success:false, and since the poller only re-selects paidAt:null orders the paid order is never
          // retried and silently stays unallocated.
          if (order.status === 'PENDING_PAYMENT') {
            try {
              const { autoAllocateOrder } = await import('@/app/actions/allocation')
              await autoAllocateOrder(order.id, { internalBypassToken: INTERNAL_ACTION_BYPASS })
            } catch {
              // Non-critical — allocation can be done manually
            }
          }

          salesPaid++
        } catch (e) {
          errors.push(`Sales order ${order.id}: ${String(e)}`)
        }
      }
    }
  }

  // --- Sales payment reversals (audit-M-acct #3 / scjz.70/.71) ---
  // Forward poll only marks unpaid→paid. If an invoice IMS thinks is paid no longer
  // has a zero balance in QBO — payment deleted/un-applied (Balance > 0) or the
  // invoice voided (TotalAmt = 0) — clear paidAt so IMS stops showing it paid.
  // Status is NOT auto-reverted (the order may already be picking/shipped); a
  // WARNING carrying the current status flags it. Must run AFTER the forward pass
  // so a pay-then-reverse within one window nets to the correct (unpaid) state.
  const paidOrders = await readQboSalesReversalCandidates()

  if (paidOrders.length > 0) {
    const reversedIds = await fetchReversedEntityIds('Invoice', since, ledgerDocumentCurrencies(paidOrders))
    if (!reversedIds) {
      allQueriesSucceeded = false
      errors.push('Failed to query QuickBooks invoices for payment reversals')
    } else {
      // o3d-psrx r4 (Codex HIGH) — A NULL FENCE IS AN INCOMPLETE POLL, NOT A CLEAN ONE.
      //
      // With no database clock nothing is decided: every document carrying a registration withholds,
      // because every registration might have landed after the snapshot. That is the correct verdict
      // and it is NOT a reason to checkpoint — the query succeeded, so `allQueriesSucceeded` would
      // otherwise move the watermark past a window in which IMS could decide nothing at all. The
      // marker recheck would eventually re-ask, but the delta window is cheaper and this poll plainly
      // did not finish its job.
      if (reversedIds.ledgerObservedBefore == null) {
        allQueriesSucceeded = false
        errors.push('The database clock could not be read, so no sales payment reversal in this window '
          + 'could be decided. Holding the poll watermark so the window is re-read.')
      }
      // o3d-psrx r3 (Codex HIGH) — THE SAME EVIDENCE XERO NOW REQUIRES, REQUIRED HERE.
      const gate = await gateQboReversalsOnProvenance(
        detectPaymentReversals(paidOrders, reversedIds.all),
        {
          registrationType: 'INVOICE_PAYMENT',
          referenceType: 'SalesOrder',
          ledgerObservedBefore: reversedIds.ledgerObservedBefore,
          ledgerAmounts: reversedIds.amounts,
        },
      )

      // WITHHELD IS REPORTED, NEVER SILENT — AND NOW IT COMES BACK (o3d-psrx r4 / o3d-a6i2).
      //
      // The watermark is still deliberately NOT held for a withheld verdict that was RECORDED: a paid
      // flag that was never going to be registered stays unregistered for ever, so holding the cursor
      // on it would freeze every later QuickBooks payment and reversal behind it — the same trap
      // o3d-w00 (Codex r8 #3) records a few lines below for a refused chargeback.
      //
      // What r3 got wrong was the other half. The cursor moving on is fine; the document never being
      // asked about again is not, and QuickBooks selects candidates only where `LastUpdatedTime`
      // exceeds the watermark. Several withholding causes resolve with NO QuickBooks change at all — a
      // PENDING or PROCESSING registration finishing or being CANCELLED, a database fence that failed
      // once — so a genuine chargeback could stay represented as paid for ever. The activity row is now
      // a MARKER that `recheckWithheldQboReversals` re-reads by id on a timer, off the cursor entirely.
      //
      // A marker that did NOT land is the one case that holds the watermark, because then the delta
      // window is the only remaining route back to the document.
      for (const { doc: order, verdict } of gate.withheld) {
        salesReversalsWithheld++
        if (verdict.verdict === 'LEDGER_PARTIALLY_PAID') partiallyPaidDocuments++
        const landed = await signalWithheldQboReversal({
          entityType: 'SALES_ORDER',
          entityId: order.id,
          action: 'payment_reversal_withheld',
          description: qboSalesWithheldDescription(order, verdict),
          accountingInvoiceId: order.accountingInvoiceId,
          verdict,
        })
        if (!landed) {
          allQueriesSucceeded = false
          errors.push(`Withheld payment reversal for order ${order.orderNumber ?? order.id} left no durable `
            + `marker, so nothing would bring it back. Holding the poll watermark instead.`)
        }
      }

      for (const order of gate.admitted) {
        const invoiceVoided = order.accountingInvoiceId != null && reversedIds.voided.has(order.accountingInvoiceId)
        const applied = await applyQboSalesReversal(order, { invoiceVoided }, errors)
        if (applied.holdWatermark) allQueriesSucceeded = false
        if (applied.reversed) salesReversed++
      }
    }
  }

  // --- Purchase bills (vendor payments) ---
  const unpaidBills = await db.purchaseInvoice.findMany({
    where: {
      accountingInvoiceId: { not: null },
      paidAt: null,
    },
    select: { id: true, accountingInvoiceId: true },
  })

  if (unpaidBills.length > 0) {
    const res = await qboQuery<QboQueryResponse<QboBill>>(
      'Bill',
      `Balance = '0' AND MetaData.LastUpdatedTime > '${since}'`,
    )

    if (!res.ok) {
      allQueriesSucceeded = false
      errors.push(`Failed to query QuickBooks bills: ${res.error ?? 'Unknown error'}`)
    } else {
      const paidBills = res.data?.QueryResponse?.Bill ?? []
      const paidBillIds = new Set(paidBills.map((b) => b.Id))

      for (const bill of unpaidBills) {
        if (!bill.accountingInvoiceId || !paidBillIds.has(bill.accountingInvoiceId)) continue

        try {
          await db.purchaseInvoice.update({
            where: { id: bill.id },
            data: { paidAt: new Date() },
          })
          billsPaid++
        } catch (e) {
          errors.push(`Purchase invoice ${bill.id}: ${String(e)}`)
        }
      }
    }
  }

  // --- Purchase bill payment reversals (audit-M-acct #3) ---
  // A bill IMS thinks paid whose QBO transaction regressed (Balance > 0, payment
  // un-applied; or TotalAmt = 0, voided) gets paidAt cleared with a WARNING. No
  // chargeback equivalent on the purchase side.
  const paidBills = await readQboBillReversalCandidates()

  if (paidBills.length > 0) {
    const reversedIds = await fetchReversedEntityIds('Bill', since,
      ledgerDocumentCurrencies(paidBills.map((b) => ({ accountingInvoiceId: b.accountingInvoiceId, currency: b.po.currency }))))
    if (!reversedIds) {
      allQueriesSucceeded = false
      errors.push('Failed to query QuickBooks bills for payment reversals')
    } else {
      // o3d-psrx r4 (Codex HIGH): see the sales side — a fence that could not be read decides nothing,
      // and a window in which nothing could be decided must not be checkpointed past.
      if (reversedIds.ledgerObservedBefore == null) {
        allQueriesSucceeded = false
        errors.push('The database clock could not be read, so no bill payment reversal in this window '
          + 'could be decided. Holding the poll watermark so the window is re-read.')
      }
      // o3d-psrx r3: the SAME gate, at the sibling reader in this same file. A bill has no
      // `unregisteredPaidAt` column (markBillPaid queues its BILL_PAYMENT registration inside the paid
      // transaction — o3d-a3wx), so what this adds on the purchase side is the REGISTRATION fence: a
      // bill whose payment IMS has queued but not yet posted no longer has `paidAt` cleared on the
      // strength of a balance QuickBooks reports while that payment is still on its way. Clearing it
      // re-arms Mark Paid over money already leaving the bank, and pressing it pays the supplier twice.
      const gate = await gateQboReversalsOnProvenance(detectPaymentReversals(paidBills, reversedIds.all), {
        registrationType: 'BILL_PAYMENT',
        referenceType: 'PurchaseInvoice',
        ledgerObservedBefore: reversedIds.ledgerObservedBefore,
        ledgerAmounts: reversedIds.amounts,
      })

      for (const { doc: bill, verdict } of gate.withheld) {
        billsReversalsWithheld++
        if (verdict.verdict === 'LEDGER_PARTIALLY_PAID') partiallyPaidDocuments++
        const landed = await signalWithheldQboReversal({
          entityType: 'PURCHASE_ORDER',
          entityId: bill.poId,
          action: 'bill_payment_reversal_withheld',
          description: qboBillWithheldDescription(bill, verdict),
          accountingInvoiceId: bill.accountingInvoiceId,
          verdict,
        })
        if (!landed) {
          allQueriesSucceeded = false
          errors.push(`Withheld bill payment reversal for PO ${bill.po.reference} left no durable marker, `
            + `so nothing would bring it back. Holding the poll watermark instead.`)
        }
      }

      for (const bill of gate.admitted) {
        await applyQboBillReversal(bill)
        billsReversed++
      }
    }
  }

  // o3d-psrx r4 / o3d-a6i2 — AND GO BACK FOR EVERYTHING THIS POLL, OR AN EARLIER ONE, WITHHELD.
  //
  // Runs whatever the delta pass did, because the documents it is for are precisely the ones the delta
  // will never return again. Its own failures are recorded on `errors` and never checkpoint anything:
  // a marker is only ever CLOSED on an answer.
  const rechecked = await recheckWithheldQboReversals(errors)
  withheldRechecked += rechecked.rechecked
  withheldResolved += rechecked.resolved
  partiallyPaidDocuments += rechecked.partiallyPaidDocuments
  salesReversed += rechecked.salesReversed
  billsReversed += rechecked.billsReversed

  // Only advance the poll watermark if all QBO queries succeeded.
  // If a query failed, keep the previous checkpoint so the next run
  // replays the missed window instead of permanently skipping payments.
  if (allQueriesSucceeded) {
    await db.setting.upsert({
      where: { key: LAST_POLL_KEY },
      create: { key: LAST_POLL_KEY, value: now },
      update: { value: now },
    })
  }

  if (salesPaid > 0 || billsPaid > 0 || salesReversed > 0 || billsReversed > 0
    || salesReversalsWithheld > 0 || billsReversalsWithheld > 0 || withheldRechecked > 0
    || partiallyPaidDocuments > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_payment_poll',
      tag: 'sync',
      description: `QuickBooks payment poll: ${salesPaid} sales paid, ${billsPaid} bills paid, ${salesReversed} sales reversed, ${billsReversed} bills reversed`
        + `, ${salesReversalsWithheld} sales + ${billsReversalsWithheld} bill reversals withheld`
        + `, ${withheldRechecked} withheld reconsidered (${withheldResolved} settled)`
        + `, ${partiallyPaidDocuments} document(s) QuickBooks states as only PART PAID while IMS shows `
        + `them fully paid — these need a person`,
      metadata: { salesPaid, billsPaid, salesReversed, billsReversed, salesReversalsWithheld, billsReversalsWithheld, partiallyPaidDocuments, withheldRechecked, withheldResolved },
    })
  }

  return { salesPaid, billsPaid, salesReversed, billsReversed, salesReversalsWithheld, billsReversalsWithheld, partiallyPaidDocuments, withheldRechecked, withheldResolved, errors }
}
