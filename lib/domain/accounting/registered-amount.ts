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
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  if (typeof p.currency !== 'string' || p.currency !== currency) return null
  return payloadExactAmount(payload)
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
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const exact = p[REGISTERED_AMOUNT_DECIMAL_FIELD]
  // PRESENT DECIDES, readable or not — see `exactPayloadDecimal`.
  if (exact !== undefined) return typeof exact === 'string' ? exactPayloadDecimal(exact) : null
  if (typeof p.amount !== 'number' || !Number.isFinite(p.amount)) return null
  // The double's own exact decimal reading, which is what the caller's summation made of it before
  // this field existed. Unchanged for every historical row.
  return toDecimal(p.amount)
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
