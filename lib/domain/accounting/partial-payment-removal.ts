import {
  addMoney,
  compareDecimal,
  ledgerAmountEpsilon,
  roundMoney,
  subtractMoney,
  toDecimal,
  type Decimal,
  type DecimalInput,
} from '@/lib/domain/math/decimal'

// ---------------------------------------------------------------------------
// A PART OF THE PAYMENT IS GONE FROM THE LEDGER (o3d-cdhl)
// ---------------------------------------------------------------------------
//
// The payment poller already separates a FULL removal (the ledger states a zero, and IMS holds no payment
// of its own that the read cannot speak for) from everything else, and acts on the full one: it clears
// paidAt and raises the chargeback credit note. What it did with a PART removal was warn on every poll and
// reconcile nothing: the ledger holds 60 of a 100 invoice, IMS holds the order as paid in full, and the
// two stay apart for ever.
//
// This module is the MEASUREMENT: how much of what IMS recorded as paid the ledger no longer holds. It is
// pure, takes every fact as an argument, and says "unproven" rather than guess, because the figure it
// yields becomes a number on an order and an alert an operator acts on.
//
// WHAT IT WILL NOT DO is decide what the shortfall means for the books. Unwinding recognised or deferred
// revenue for a removed payment (a credit note, or a bad debt write-off) is an accounting policy that the
// order owner decides; nothing here or in its caller posts anything to the ledger.

/** The verdicts on IMS's own payment registrations under which a ledger shortfall is a REMOVAL, not IMS's silence. */
const MEASURABLE_VERDICTS = new Set(['STILL_HELD', 'NOTHING_REGISTERED', 'LEDGER_DID_NOT_LIST_PAYMENTS'])

export type PartialRemovalUnprovenReason =
  | 'currency-differs'
  | 'ledger-amount-not-stated'
  | 'ledger-holds-credit'
  | 'order-has-refunds'
  | 'not-ledger-evidence'
  | 'total-not-readable'

export type PartialRemovalMeasurement =
  /** The ledger holds less than IMS recorded as paid by `removed` (> 0), all in the order currency. */
  | { kind: 'REMOVED'; removed: Decimal; recordedPaid: Decimal; ledgerPaid: Decimal; documentTotal: Decimal; currency: string }
  /** The ledger holds more than the amount IMS last recorded as paid: part of an earlier shortfall is back. */
  | { kind: 'RESTORED'; restored: Decimal; recordedPaid: Decimal; ledgerPaid: Decimal; documentTotal: Decimal; currency: string }
  /** IMS and the ledger agree on what is paid. Nothing to record, nothing to warn about when a shortfall is already recorded. */
  | { kind: 'AGREES'; recordedPaid: Decimal; ledgerPaid: Decimal }
  /** The facts do not prove a measurable removal. The caller keeps whatever it did before (withhold and report). */
  | { kind: 'UNPROVEN'; reason: PartialRemovalUnprovenReason }

export type PartialRemovalFacts = {
  /** The order's own currency; the ledger's amounts are only comparable when the invoice states the same one. */
  orderCurrency: string
  /** The currency the ledger states for the invoice, or null when it does not. */
  ledgerCurrency: string | null
  /** The order total in the order currency: what a fully paid order has paid. */
  orderTotal: DecimalInput
  /** What the ledger states as paid against the invoice (payments only), parsed by `parseLedgerAmount`; null = not stated. */
  ledgerPaid: number | null
  /** What the ledger states as allocated credit against the invoice; undefined when the payload did not carry the field. */
  ledgerCredited: number | string | null | undefined
  /** Part of the paid amount already recorded as missing on the order (order currency), null/0 for none. */
  alreadyRemoved: DecimalInput
  /** The order carries a credit note or refund: the paid total is then not simply the order total. */
  orderHasRefunds: boolean
  /** The paid flag came from the ledger itself (`unregisteredPaidAt` null). A channel or operator flag is IMS's silence. */
  paidFlagIsLedgerSourced: boolean
  /** The registered-payment verdict (`RegisteredPaymentVerdict['verdict']`). */
  registrationVerdict: string
}

/**
 * Measure what part of the recorded payment the ledger no longer holds.
 *
 * recordedPaid = orderTotal - alreadyRemoved. The order is held as paid IN FULL (that is what `paidAt` says),
 * less whatever shortfall was already recorded against it, so a repeat read of the same ledger figure
 * measures zero and a recheck cannot reconcile the same removal twice.
 */
export function measurePartialPaymentRemoval(facts: PartialRemovalFacts): PartialRemovalMeasurement {
  const currency = facts.orderCurrency
  if (facts.ledgerCurrency === null || facts.ledgerCurrency.toUpperCase() !== currency.toUpperCase()) {
    return { kind: 'UNPROVEN', reason: 'currency-differs' }
  }
  if (facts.ledgerPaid === null || !Number.isFinite(facts.ledgerPaid) || facts.ledgerPaid < 0) {
    // A negative paid amount is not a quantity to subtract from; it is unproven.
    return { kind: 'UNPROVEN', reason: 'ledger-amount-not-stated' }
  }
  if (!MEASURABLE_VERDICTS.has(facts.registrationVerdict) || !facts.paidFlagIsLedgerSourced) {
    return { kind: 'UNPROVEN', reason: 'not-ledger-evidence' }
  }
  if (facts.orderHasRefunds) return { kind: 'UNPROVEN', reason: 'order-has-refunds' }

  let total: Decimal
  let already: Decimal
  let credited: Decimal
  try {
    total = toDecimal(facts.orderTotal)
    already = facts.alreadyRemoved == null ? toDecimal(0) : toDecimal(facts.alreadyRemoved)
    credited = facts.ledgerCredited == null ? toDecimal(0) : toDecimal(facts.ledgerCredited)
  } catch {
    return { kind: 'UNPROVEN', reason: 'total-not-readable' }
  }
  const epsilon = ledgerAmountEpsilon(currency)
  // An allocated credit note is not a payment, and a shortfall next to one cannot be attributed to the payment.
  if (compareDecimal(credited.abs(), epsilon) > 0) return { kind: 'UNPROVEN', reason: 'ledger-holds-credit' }
  if (compareDecimal(total, 0) <= 0) return { kind: 'UNPROVEN', reason: 'total-not-readable' }

  const ledgerPaid = roundMoney(toDecimal(facts.ledgerPaid), currency)
  const recordedPaid = roundMoney(subtractMoney(total, already), currency)
  const difference = subtractMoney(recordedPaid, ledgerPaid)

  if (compareDecimal(difference, epsilon) > 0) {
    return { kind: 'REMOVED', removed: roundMoney(difference, currency), recordedPaid, ledgerPaid, documentTotal: total, currency }
  }
  if (compareDecimal(difference.negated(), epsilon) > 0 && compareDecimal(already, 0) > 0) {
    // More is held than IMS last recorded, and a shortfall is on record, so part of it came back. Bounded by the shortfall:
    // a ledger that holds more than the order total is not a payment IMS recorded.
    const restored = difference.negated()
    const bounded = compareDecimal(restored, already) > 0 ? already : restored
    return { kind: 'RESTORED', restored: roundMoney(bounded, currency), recordedPaid, ledgerPaid, documentTotal: total, currency }
  }
  return { kind: 'AGREES', recordedPaid, ledgerPaid }
}

/** The shortfall that stands after one measured change (never negative). */
export function shortfallAfter(alreadyRemoved: DecimalInput, change: { kind: 'REMOVED'; removed: Decimal } | { kind: 'RESTORED'; restored: Decimal }): Decimal {
  const before = alreadyRemoved == null ? toDecimal(0) : toDecimal(alreadyRemoved)
  const after = change.kind === 'REMOVED' ? addMoney(before, change.removed) : subtractMoney(before, change.restored)
  return compareDecimal(after, 0) < 0 ? toDecimal(0) : after
}

/** A registration IMS raised for the order, reduced to what naming the removed payment needs. */
export type RegisteredReceipt = {
  /** The id the ledger issued when the payment posted. */
  ledgerPaymentId: string
  /** Its recorded amount in the order currency, or null when the payload would not state one. */
  amount: Decimal | null
}

/**
 * Name the IMS-registered payments the ledger no longer lists, when they account for the removal.
 *
 * Only the payments registered against THIS invoice and absent from the ledger's own list are considered, and the
 * answer is a name only when their recorded amounts add up to the measured removal. Anything less certain returns
 * an empty list: a payment named wrongly sends an operator to remove the wrong one, and the figure stands without it.
 */
export function matchRemovedRegisteredPayments(
  removed: Decimal,
  currency: string,
  registered: readonly RegisteredReceipt[],
  listedLedgerPaymentIds: ReadonlySet<string> | null,
): string[] {
  if (listedLedgerPaymentIds === null) return []
  const absent = registered.filter((r) => !listedLedgerPaymentIds.has(r.ledgerPaymentId.trim().toLowerCase()))
  if (absent.length === 0 || absent.some((r) => r.amount === null)) return []
  const total = absent.reduce<Decimal>((sum, r) => addMoney(sum, r.amount as Decimal), toDecimal(0))
  const epsilon = ledgerAmountEpsilon(currency)
  if (compareDecimal(subtractMoney(total, removed).abs(), epsilon) > 0) return []
  return absent.map((r) => r.ledgerPaymentId)
}
