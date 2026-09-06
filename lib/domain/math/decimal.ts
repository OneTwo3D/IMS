import { Prisma } from '@/app/generated/prisma/client'

export type Decimal = Prisma.Decimal
export type DecimalInput = Prisma.Decimal | Prisma.DecimalJsLike | number | string | null | undefined

const ZERO_DECIMAL = new Prisma.Decimal(0)

// ISO 4217 minor units that differ from the 2-decimal default.
const CURRENCY_MINOR_UNITS: Record<string, number> = {
  BIF: 0,
  BHD: 3,
  CLF: 4,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  IQD: 3,
  ISK: 0,
  JOD: 3,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  PYG: 0,
  RWF: 0,
  TND: 3,
  UGX: 0,
  UYI: 0,
  UYW: 4,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
}

function assertFiniteNumber(value: number): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Invalid decimal number: ${value}`)
  }
}

function assertFiniteDecimal(value: Decimal, message: string): Decimal {
  if (!value.isFinite()) {
    throw new TypeError(message)
  }
  return value
}

function assertValidPrecision(precision: number): void {
  if (!Number.isInteger(precision) || precision < 0) {
    throw new TypeError(`Decimal precision must be a non-negative integer: ${precision}`)
  }
}

/**
 * ISO 4217 minor-unit digits for a currency code — 2 for most, 0 for JPY/KRW/ISK, 3 for the Gulf
 * dinars. Exported (o3d-5tf) so money tolerances can be expressed as a fraction of ONE MINOR UNIT
 * instead of hard-coding a penny: a 0.005 threshold is half a minor unit in GBP, five whole minor
 * units in KWD and a meaningless sliver in JPY.
 *
 * o3d-w00 leans on the same fact for a second reason: the minor unit is also how COARSELY a source
 * may have quantised a money figure before IMS stored it, which is what sizes the rounding tolerance
 * on any RATE derived from two such figures. Assuming the penny there gives a zero-decimal currency a
 * bound a hundred times too tight. That is the same number, so it stays ONE exported function rather
 * than a second name for it.
 */
export function currencyMinorUnits(currency: string): number {
  return currencyPrecision(currency)
}

/**
 * The finest minor-unit precision this repository supports — CLF and UYW at four decimals.
 *
 * IT IS THE STRICTEST SETTING AND THAT IS WHY IT IS THE ANSWER FOR AN UNSTATED CURRENCY. Every rule
 * derived from the minor unit gets HARSHER as the unit gets finer: the "holds nothing" epsilon
 * shrinks, and the magnitude above which a minor unit stops surviving JSON transport falls. So a
 * payload that does not say what currency it is in is read with this precision, and both rules then
 * fail in the direction that WITHHOLDS rather than the one that declares a payment gone.
 *
 * Exported from here, beside `currencyMinorUnits`, because two connectors need the same answer and
 * the alternative is the same number written down twice — which is the failure mode this branch has
 * closed repeatedly.
 */
export const FINEST_SUPPORTED_MINOR_UNITS = 4

/**
 * The minor-unit digits a LEDGER READ is sized against, for a currency that may not have been stated.
 *
 * o3d-psrx r16 — ONE PLACE, BECAUSE THREE RULES NOW ASK THE SAME QUESTION. The magnitude bound, the
 * scale refusal and the "holds nothing" epsilon are all derived from the document's minor unit, and
 * each of them had written out `currency == null ? FINEST_SUPPORTED_MINOR_UNITS : currencyMinorUnits(...)`
 * for itself. Three copies of a fail-safe direction is three chances for one of them to be edited
 * into the lenient reading, which is the direction that clears `paidAt` over money that is still
 * there. The direction is stated once, here, and every rule derives from it.
 */
export function ledgerMinorUnits(currency: string | null): number {
  return currency == null ? FINEST_SUPPORTED_MINOR_UNITS : currencyMinorUnits(currency)
}

/**
 * o3d-psrx r10 (Codex HIGH 3), moved here in r17 — HOW SMALL AN AMOUNT COUNTS AS NOTHING, IN THIS
 * DOCUMENT'S CURRENCY.
 *
 * r9 used Xero's `PAYMENT_PRESENT_EPSILON`, which was 0.005 and documented for Xero's two-decimal
 * amounts: half a penny, comfortably inside the gap between "nothing" and the smallest payment that
 * can exist. Both connectors' reversal readers also receive three- and four-decimal currencies
 * (`currencyMinorUnits` — BHD/IQD/JOD/KWD/LYD/OMR/TND at 3, CLF/UYW at 4). Against those, a fixed
 * 0.005 is FIVE whole minor units in a Gulf dinar and fifty in CLF: a document the ledger states
 * 0.004 is still settled on reads as holding NOTHING, the registration gate then admits, and
 * `paidAt` is cleared with a chargeback credit note raised over a document the ledger is still
 * accounting for. That is the o3d-psrx defect itself, reached through the tolerance.
 *
 * So the threshold is HALF ONE MINOR UNIT of the document's own currency — strictly below one minor
 * unit in every currency, which is what makes "the smallest amount that can exist is not zero" true
 * everywhere rather than only in GBP. In a two-decimal currency it is 0.005 exactly, so nothing about
 * the ordinary case moves.
 *
 * A NULL CURRENCY TAKES THE STRICTEST THRESHOLD, not the most convenient one. QuickBooks omits
 * `CurrencyRef` when multicurrency is off and Xero's fixtures predate `CurrencyCode`, and the
 * fail-safe direction is unambiguous: too LARGE a threshold discards a real minor unit as zero and
 * lets a reversal through, while too small a one can only move a document from "holds nothing" into
 * a verdict that WITHHOLDS. So an unstated currency is given the finest precision this repository
 * supports.
 *
 * o3d-psrx r17 (Codex HIGH) — AND IT LIVES HERE, BESIDE `ledgerMinorUnits`, BECAUSE IT IS THE ANSWER
 * BOTH CONNECTORS GIVE. It was written in `lib/connectors/quickbooks/payment-poller.ts`, which is
 * DOWNSTREAM of Xero's `invoice-delta.ts` in the import graph, so Xero's `partitionPaymentReversals`
 * could not reach it and kept a fixed 0.005 of its own. Two rules with different ideas of "how small
 * is nothing" is precisely what r16's scale rule made reachable: it admits `0.001` in KWD and
 * `0.0001` in CLF — one whole minor unit, a payment the ledger genuinely holds — and Xero then
 * measured that against a constant sized for pennies and called it zero. There is now ONE function,
 * in the module both connectors already import their minor units from, and no import direction that
 * can put it out of either one's reach again.
 */
export function ledgerAmountEpsilon(currency: string | null): Decimal {
  // r16: through the shared resolver, so this rule and the two magnitude rules cannot drift apart on
  // what an unstated currency means.
  const digits = ledgerMinorUnits(currency)
  // Half of 10^-digits, written exactly rather than computed in binary floating point.
  return toDecimal(`0.${'0'.repeat(digits)}5`)
}

function currencyPrecision(currency: string): number {
  const normalizedCurrency = currency.trim().toUpperCase()
  if (!normalizedCurrency) return 2
  return CURRENCY_MINOR_UNITS[normalizedCurrency] ?? 2
}

function isDecimalJsLike(value: unknown): value is Prisma.DecimalJsLike {
  return typeof value === 'object' &&
    value !== null &&
    'toFixed' in value &&
    typeof value.toFixed === 'function'
}

export function toDecimal(value: DecimalInput): Decimal {
  if (value == null) return ZERO_DECIMAL
  if (value instanceof Prisma.Decimal) {
    return assertFiniteDecimal(value, `Invalid decimal value: ${value.toString()}`)
  }

  if (typeof value === 'number') {
    assertFiniteNumber(value)
    return new Prisma.Decimal(value)
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return ZERO_DECIMAL
    return assertFiniteDecimal(new Prisma.Decimal(trimmed), `Invalid decimal string: ${value}`)
  }

  if (isDecimalJsLike(value)) {
    const fixed = value.toFixed()
    return assertFiniteDecimal(new Prisma.Decimal(fixed), `Invalid decimal value: ${fixed}`)
  }

  return assertFiniteDecimal(new Prisma.Decimal(value), `Invalid decimal value: ${String(value)}`)
}

export function addMoney(a: DecimalInput, b: DecimalInput): Decimal {
  return toDecimal(a).add(toDecimal(b))
}

export function subtractMoney(a: DecimalInput, b: DecimalInput): Decimal {
  return toDecimal(a).sub(toDecimal(b))
}

export function multiplyMoney(a: DecimalInput, b: DecimalInput): Decimal {
  return toDecimal(a).mul(toDecimal(b))
}

export function roundMoney(value: DecimalInput, currency: string): Decimal {
  return toDecimal(value).toDecimalPlaces(currencyPrecision(currency), Prisma.Decimal.ROUND_HALF_UP)
}

export function roundQuantity(value: DecimalInput, precision: number): Decimal {
  assertValidPrecision(precision)
  return toDecimal(value).toDecimalPlaces(precision, Prisma.Decimal.ROUND_HALF_UP)
}

/**
 * Floor a quantity to `precision` decimal places (ROUND_DOWN). Use when a value
 * must never exceed the input — e.g. capping a received quantity to a column's
 * precision so a sub-granularity request can't round UP and over-book.
 */
export function floorQuantity(value: DecimalInput, precision: number): Decimal {
  assertValidPrecision(precision)
  return toDecimal(value).toDecimalPlaces(precision, Prisma.Decimal.ROUND_DOWN)
}

export function compareDecimal(a: DecimalInput, b: DecimalInput): -1 | 0 | 1 {
  const comparison = toDecimal(a).cmp(toDecimal(b))
  if (comparison < 0) return -1
  if (comparison > 0) return 1
  return 0
}

export function isZero(value: DecimalInput): boolean {
  return toDecimal(value).isZero()
}
