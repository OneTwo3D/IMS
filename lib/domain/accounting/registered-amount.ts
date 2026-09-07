/**
 * WHAT AN INVOICE-PAYMENT REGISTRATION'S PAYLOAD SAYS IT SENT — THE ONE READING OF IT.
 *
 * o3d-6abj — AND IT LIVES HERE, NOT IN `invoice-payment-enqueue.ts`, FOR THE REASON o3d-psrx r17
 * MOVED `ledgerAmountEpsilon` INTO `lib/domain/math/decimal.ts`.
 *
 * The post-site capacity guard (`invoice-payment-capacity.ts`) has to ask this same question, and it
 * is imported by BOTH connectors' sync processors. The enqueue module pulls in `@/lib/db`, the
 * accounting registry and the settlement probe, so a `capacity -> enqueue` import closes a cycle
 * through the very processors that call the guard. A shared rule that one of its two readers cannot
 * import is a rule that gets copied — and a second copy of "how much did this row register" is
 * exactly how the enqueue and post guards come to disagree about whether an invoice has capacity.
 *
 * So the reader sits upstream of both, in a module with no dependency but the decimal helpers, and
 * `invoice-payment-enqueue.ts` re-exports it so no existing import path had to move.
 */

import { toDecimal, type Decimal } from '@/lib/domain/math/decimal'

/**
 * THE PAYLOAD FIELD THAT CARRIES A REGISTRATION'S AMOUNT AS AN EXACT DECIMAL (o3d-1xq8).
 *
 * Written BESIDE `amount`, never instead of it. Historical rows carry only the number and must keep
 * settling exactly as they do today; every row written from now on carries both, and they agree —
 * `registerInvoicePaymentWithLedger` refuses to enqueue an amount whose two forms would not.
 */
export const REGISTERED_AMOUNT_DECIMAL_FIELD = 'amountDecimal'

/**
 * A decimal NUMERAL, and nothing else. `new Prisma.Decimal(...)` accepts `'1e3'`, `'0x10'` and
 * `'Infinity'`; a money field that will be summed against a stored total must be plain digits with at
 * most one point, so the grammar is asserted BEFORE the value is constructed rather than inferred
 * from the construction succeeding.
 */
const EXACT_DECIMAL_NUMERAL = /^-?\d+(?:\.\d+)?$/

/**
 * The exact decimal a payload string names, or NULL because it does not name one.
 *
 * NULL AND NEVER A FALLBACK. A payload that carries this field is a payload written by a build that
 * promised it is exact; if the string is unreadable, that promise is broken and the honest answer is
 * "this payload will not say" — reverting to the double beside it would silently reinstate the very
 * hop this field exists to remove.
 */
function exactPayloadDecimal(value: string): Decimal | null {
  const trimmed = value.trim()
  if (!EXACT_DECIMAL_NUMERAL.test(trimmed)) return null
  try {
    const parsed = toDecimal(trimmed)
    // The round trip is the proof that the digits survived: `toDecimal` is exact for a numeral of this
    // grammar, so a disagreement here means the string was not the figure it appeared to be.
    return parsed.toFixed() === toDecimal(parsed.toFixed()).toFixed() ? parsed : null
  } catch {
    return null
  }
}

/**
 * HOW MUCH A REGISTRATION TOLD THE LEDGER ABOUT, IN A NAMED CURRENCY (o3d-psrx r7, Codex HIGH 1).
 *
 * The enqueue writes the amount and `currency` into the payload from the receipt it was raised for,
 * and this is the durable record of what was actually SENT. The local `Payment` row is not a
 * substitute: it can be deleted, and its amount can be corrected, while the money that reached the
 * ledger cannot.
 *
 * `currency` IS PART OF THE ANSWER, NOT A DETAIL. The coverage test this feeds compares against
 * `SalesOrder.totalForeign`, which is stated in the ORDER's currency; a registration raised in another
 * covers none of it, and adding the two numbers would be arithmetic across two units. A payload that
 * does not state its currency therefore answers NULL rather than "presumably the order's".
 *
 * NULL IS "THIS PAYLOAD WILL NOT SAY", and every caller must read it that way rather than as zero or
 * as full cover. A row from before these fields existed, and one retention-compacted to `{}`
 * (o3d-m5qk), both answer NULL.
 *
 * o3d-1xq8 — AND IT ANSWERS A `Decimal`, PREFERRING THE PAYLOAD'S EXACT DECIMAL STRING.
 *
 * THE DEFECT. `amount` is a JSON number, and until this issue the enqueue built it with
 * `Number(receipt.amount)` — the `Decimal(18, 4)` receipt converted to a double. At 2^39 the spacing
 * between neighbouring doubles is 0.000122, wider than a four-decimal minor unit, so THE CONVERSION
 * MOVES THE FIGURE IN EITHER DIRECTION. o3d-psrx r18 disclosed only the DOWNWARD case
 * (`549755813888.0003` reads as `...0002`, a registration that really settled the order reads as one
 * minor unit short, and the coverage guard WITHHOLDS — the safe direction) and stated the conclusion
 * generally. It is not general: `549755813888.0008` converts UP to `549755813888.000854492…`, which
 * clears `documentTotal - PAID_COVERAGE_EPSILON` for a total of `549755813888.0009`. That
 * MANUFACTURES coverage — the guard stands down, the classifier returns GONE, and `paidAt` is cleared
 * with a chargeback credit note raised on a document nobody fully paid.
 *
 * THE FIX IS ADDITIVE. `registerInvoicePaymentWithLedger` now persists the stored receipt amount's
 * exact decimal string in {@link REGISTERED_AMOUNT_DECIMAL_FIELD} beside the number, and this reader
 * PREFERS it. A historical row carries no string, falls through to the number, and is read exactly as
 * it is today — no row is rewritten and no row gets worse.
 */
export function payloadRegisteredAmount(payload: unknown, currency: string): Decimal | null {
  return statedAmountOnly(readPayloadRegisteredAmount(payload, currency))
}

/* ------------------------------------------------------------------------------------------- *
 * o3d-r948 r2 (Codex HIGH 2) — THE TRI-STATE, AS A TYPE THAT CANNOT LOSE IT AGAIN.
 * ------------------------------------------------------------------------------------------- */

/**
 * WHY A `Decimal | null` WAS NOT ENOUGH, STATED ONCE.
 *
 * The readers below answer three DIFFERENT facts and the old signature had two values for them:
 *
 *   STATED       the payload names a figure and this code will spend it.
 *   NOT-STATED   the payload names none. There is nothing to refuse: a legacy row that predates
 *                every exact field, or a body compacted to `{}`. A caller holding a lossy number
 *                beside it may read THAT, because doing so is exactly what this code did before the
 *                exact fields existed, and no such row is made worse.
 *   REFUSED      the payload DOES name one and this code will not read it — a present
 *                `amountDecimal` that is not a string or does not parse, or a figure stated in a
 *                currency that is not the one asked about. `exactPayloadDecimal` already says why
 *                that must never fall back: "a payload that carries this field is a payload written
 *                by a build that promised it is exact; if the string is unreadable, that promise is
 *                broken". A currency the caller did not ask for is the same claim about the UNIT —
 *                the number beside it is money in some other denomination, and spending it is
 *                arithmetic across two units wearing a plausible figure.
 *
 * Both fallback sites in this repository collapsed REFUSED into NOT-STATED and spent the lossy
 * number: `syncRowSettledAmount` and the unresolved-attempt description in
 * `invoice-payment-registration.ts`. Neither could have done otherwise — the value they were handed
 * did not carry the distinction. So the distinction is now IN THE TYPE, and the one rule that is
 * allowed to fall back is written once, in {@link exactAmountReadingOrLegacy}.
 */
export type ExactAmountRefusal =
  /** `amountDecimal` is present and is not a string at all. */
  | 'exact-decimal-not-a-string'
  /** `amountDecimal` is present, is a string, and is not a decimal numeral this code will read. */
  | 'exact-decimal-malformed'
  /** The payload names no currency, so nothing it states can be known to be in the caller's unit. */
  | 'currency-not-stated'
  /** It names one, and it is not the caller's. */
  | 'currency-mismatch'
  /** A SUM of readings, one of whose terms was itself refused or unreadable. */
  | 'sum-term-unreadable'

export type ExactAmountReading =
  | { kind: 'stated'; amount: Decimal }
  | { kind: 'not-stated' }
  | { kind: 'refused'; reason: ExactAmountRefusal }

/** The one NOT-STATED value, so the absence of a reading and a stated absence are the same object. */
export const EXACT_AMOUNT_NOT_STATED: ExactAmountReading = { kind: 'not-stated' }

/**
 * THE COLLAPSE, NAMED — for the callers where `null` ALREADY withholds.
 *
 * `invoice-payment-capacity.ts`, `invoice-payment-registration.ts`'s live-registration sum,
 * `payment-reversal.ts` and `xero/invoice-delta.ts`'s `sumRegisteredAmounts` all refuse outright on a
 * null: NOT-STATED and REFUSED both mean "this sum cannot be taken", and neither reaches a fallback.
 * For those the two facts are genuinely interchangeable, and collapsing them is correct rather than
 * merely convenient. It is a named function so the collapse is greppable, and so that the next caller
 * that wants a fallback has to reach for the reading instead.
 */
export function statedAmountOnly(reading: ExactAmountReading): Decimal | null {
  return reading.kind === 'stated' ? reading.amount : null
}

/**
 * THE ONLY PLACE A LEGACY NUMBER MAY STAND IN FOR AN EXACT ONE.
 *
 * A caller that holds both an exact reading and the lossy wire number beside it asks this, and it
 * answers a reading rather than a figure so that the caller can still tell a refusal from a silence.
 * The rule, whole:
 *
 *   STATED      the exact figure, as read.
 *   REFUSED     STAYS REFUSED. The number beside it is the very figure the refusal is about.
 *   NOT-STATED  the number's OWN exact decimal reading — which is precisely what every reader made
 *               of such a row before the exact fields existed — or NOT-STATED again when there is no
 *               finite number either.
 */
export function exactAmountReadingOrLegacy(
  reading: ExactAmountReading | undefined,
  legacy: number | null | undefined,
): ExactAmountReading {
  const stated = reading ?? EXACT_AMOUNT_NOT_STATED
  if (stated.kind !== 'not-stated') return stated
  if (typeof legacy !== 'number' || !Number.isFinite(legacy)) return EXACT_AMOUNT_NOT_STATED
  return { kind: 'stated', amount: toDecimal(legacy) }
}

/**
 * {@link payloadRegisteredAmount}, answering WHICH of the three facts it found.
 *
 * The currency gate is asked FIRST and on its own terms: a payload stating another currency has an
 * amount, and the fact worth carrying is that it is not this document's — not that no figure exists.
 */
export function readPayloadRegisteredAmount(payload: unknown, currency: string): ExactAmountReading {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  if (typeof p.currency !== 'string') {
    // A payload with NOTHING in it names no amount either, and calling that a refusal would turn
    // every retention-compacted row into a stated-but-unreadable figure. So the empty body keeps its
    // old meaning — there is nothing here — and only a body that carries a figure can refuse.
    return p[REGISTERED_AMOUNT_DECIMAL_FIELD] === undefined && typeof p.amount !== 'number'
      ? EXACT_AMOUNT_NOT_STATED
      : { kind: 'refused', reason: 'currency-not-stated' }
  }
  if (p.currency !== currency) return { kind: 'refused', reason: 'currency-mismatch' }
  return readPayloadExactAmount(payload)
}

/**
 * o3d-78rq — THE SAME READING, WITHOUT THE CURRENCY GATE, FOR THE ONE CALLER THAT MUST NOT HAVE ONE.
 *
 * `payloadRegisteredAmount` above answers "how much of THIS order's currency did this row register?",
 * and refusing a payload stated in another currency is the whole point of it: adding the two figures
 * would be arithmetic across two units.
 *
 * `describeAttempt` asks a different question — "what figure did this attempt SEND?" — and the answer
 * to that does not depend on any other document's currency. It carries the payload's currency
 * separately (it is what sizes the match band), so a gate here would only be able to refuse a payload
 * that states no currency at all, and refusing THAT would describe an attempt as undescribable purely
 * for wanting one. So the amount rule is stated ONCE, here, and the currency gate belongs to the
 * coverage reader that needs it rather than to the reading of the figure.
 *
 * The preference is unchanged and is the whole of o3d-1xq8: the payload's exact decimal string where
 * it has one, and otherwise the JSON number's OWN exact decimal reading — which is what every reader
 * made of a historical row before that field existed, so no row is rewritten and no row gets worse.
 */
export function payloadExactAmount(payload: unknown): Decimal | null {
  return statedAmountOnly(readPayloadExactAmount(payload))
}

/**
 * {@link payloadExactAmount}, answering WHICH of the three facts it found — see
 * {@link ExactAmountReading}.
 */
export function readPayloadExactAmount(payload: unknown): ExactAmountReading {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const exact = p[REGISTERED_AMOUNT_DECIMAL_FIELD]
  // PRESENT DECIDES, readable or not — see `exactPayloadDecimal`. And now it decides in words: the
  // field being there is what makes an unreadable value a REFUSAL rather than a silence.
  if (exact !== undefined) {
    if (typeof exact !== 'string') return { kind: 'refused', reason: 'exact-decimal-not-a-string' }
    const parsed = exactPayloadDecimal(exact)
    return parsed === null
      ? { kind: 'refused', reason: 'exact-decimal-malformed' }
      : { kind: 'stated', amount: parsed }
  }
  if (typeof p.amount !== 'number' || !Number.isFinite(p.amount)) return EXACT_AMOUNT_NOT_STATED
  // The double's own exact decimal reading, which is what the caller's summation made of it before
  // this field existed. Unchanged for every historical row.
  return { kind: 'stated', amount: toDecimal(p.amount) }
}

/**
 * MAY THIS AMOUNT BE ENQUEUED AT ALL? (o3d-1xq8, Codex HIGH — the writer's backstop.)
 *
 * The payload's `amount` is a JSON number because the connectors need one: a Xero or QuickBooks
 * payment body states its amount as a JSON number, and every consumer of this payload that is not the
 * coverage reader — the capacity arithmetic, the retry guard's body test, the operator screens —
 * reads that number. The decimal string added above makes the COVERAGE route exact; it does nothing
 * for the figure that is actually SENT.
 *
 * So the writer refuses what it cannot state in both forms. A stored receipt whose `Decimal` does not
 * survive `Number(...)` and back has no honest number to send, and money IMS cannot state exactly
 * must not leave it. This is Codex's second option, kept as the backstop for the first rather than
 * instead of it — the writer holds the `Decimal`, so it is the one place that can tell.
 *
 * TRUE FOR EVERY AMOUNT ANY REAL ORDER CARRIES. A `Decimal(18, 4)` round-trips through a double up to
 * 2^53 / 10^4 ≈ 900,000,000,000 in the order's own currency; below that the check never fires.
 */
export function invoicePaymentAmountRoundTrips(amount: Decimal): boolean {
  const asNumber = amount.toNumber()
  if (!Number.isFinite(asNumber)) return false
  return toDecimal(asNumber).eq(amount)
}
