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

export function compareDecimal(a: DecimalInput, b: DecimalInput): -1 | 0 | 1 {
  const comparison = toDecimal(a).cmp(toDecimal(b))
  if (comparison < 0) return -1
  if (comparison > 0) return 1
  return 0
}

export function isZero(value: DecimalInput): boolean {
  return toDecimal(value).isZero()
}
