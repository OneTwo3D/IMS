import { Prisma } from '@/app/generated/prisma/client'

/**
 * The booked rate of a DOCUMENT (sales order, purchase order, bill), for the refund and credit-note paths that must
 * convert at the rate the document was booked at.
 *
 * These paths never look up a fresh rate from `fx_rates` (o3d-q0x56.8): a credit note reverses what was booked, so
 * the stored rate is the only right one. What they used to do when it was missing was substitute 1, which silently
 * turned a foreign amount into a base amount one-for-one. They now refuse:
 *
 *   - a usable stored rate (finite, greater than zero) is the answer: it is what the document was booked at;
 *   - otherwise a document in the BASE currency is 1, derived from `currency === baseCurrency` and not from the
 *     value being absent;
 *   - otherwise (a FOREIGN document with null, undefined, zero, negative, NaN or an unparseable rate) it throws
 *     `MissingStoredFxRateError`, which names the document and says what to do.
 *
 * An empty or unknown document currency is not the base currency, so it also needs a stored rate.
 */
export class MissingStoredFxRateError extends Error {
  constructor(
    message: string,
    readonly currency: string,
    readonly baseCurrency: string,
    readonly document: string,
  ) {
    super(message)
    this.name = 'MissingStoredFxRateError'
  }
}

export function isMissingStoredFxRateError(error: unknown): error is MissingStoredFxRateError {
  return error instanceof MissingStoredFxRateError
}

function normaliseCode(code: unknown): string {
  return typeof code === 'string' ? code.trim().toUpperCase() : ''
}

/** The stored rate when it is a finite number greater than zero, else null. */
export function usableStoredFxRate(storedRate: Prisma.Decimal | number | string | null | undefined): Prisma.Decimal | null {
  try {
    if (storedRate === null || storedRate === undefined || typeof storedRate === 'boolean') return null
    const parsed = new Prisma.Decimal(storedRate as ConstructorParameters<typeof Prisma.Decimal>[0])
    return parsed.isFinite() && parsed.gt(0) ? parsed : null
  } catch {
    return null
  }
}

export function requireStoredFxRateToBase(params: {
  /** The document's own currency. */
  currency: string | null | undefined
  baseCurrency: string
  /** `fxRateToBase` as stored on the document: 1 base = `rate` foreign. */
  storedRate: Prisma.Decimal | number | string | null | undefined
  /** What to call it in the message, e.g. `order SO-1042`. */
  document: string
}): Prisma.Decimal {
  const stored = usableStoredFxRate(params.storedRate)
  if (stored) return stored
  const currency = normaliseCode(params.currency)
  const base = normaliseCode(params.baseCurrency)
  if (currency !== '' && currency === base) return new Prisma.Decimal(1)
  throw new MissingStoredFxRateError(
    `${params.document} is in ${currency || '(no currency)'} but has no usable stored FX rate to ${base} `
    + `(found ${params.storedRate === null || params.storedRate === undefined ? 'none' : String(params.storedRate)}). `
    + 'IMS will not substitute a rate of 1 or look up another one: correct the document\'s exchange rate, then retry.',
    currency,
    base,
    params.document,
  )
}

/**
 * `requireStoredFxRateToBase` with the base currency read LAZILY: a document with a usable stored rate (the normal
 * case) costs no base-currency read at all; only a missing rate needs to know whether the document is in the base
 * currency (1) or foreign (refuse).
 */
export async function resolveStoredFxRateToBase(params: {
  currency: string | null | undefined
  baseCurrency: () => Promise<string>
  storedRate: Prisma.Decimal | number | string | null | undefined
  document: string
}): Promise<Prisma.Decimal> {
  const stored = usableStoredFxRate(params.storedRate)
  if (stored) return stored
  return requireStoredFxRateToBase({ ...params, baseCurrency: await params.baseCurrency() })
}
