import type { AccountingSettings } from '@/lib/accounting'
import type { Prisma } from '@/app/generated/prisma/client'
import { endOfBusinessDateUtc, getFxRateToBase, type MissingFxRateError } from '@/lib/currencies/fx-lookup'
import { roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

export type FxSettlementSide = 'receivable' | 'payable'

export type RealisedFxInput = {
  side: FxSettlementSide
  amountForeign: number
  bookedRateToBase: number
  settlementRateToBase: number
  /**
   * The base-currency value at which `amountForeign` was actually booked to the
   * AR/AP control account (e.g. the stored document totalBase, prorated to the
   * outstanding portion). When provided this is used as the booked leg instead of
   * recomputing amountForeign/bookedRate — so the revaluation measures against the
   * real carrying value and ties back to the control account, rather than a
   * freshly re-rounded figure that disagrees with the posted base (cogs-audit
   * scjz.55). Falls back to amountForeign/bookedRate when omitted.
   */
  bookedBase?: number
}

export type RealisedFxResult = {
  bookedBase: number
  settlementBase: number
  gainLossBase: number
  outcome: 'gain' | 'loss' | 'none'
}

export type FxJournalLine = {
  accountCode: string
  description: string
  debit?: number
  credit?: number
  taxType?: string
}

export function roundAccountingMoney(value: DecimalInput): number {
  return roundQuantity(value, 2).toNumber()
}

export function computeRealisedFx(input: RealisedFxInput): RealisedFxResult {
  const amountForeign = Number(input.amountForeign)
  const bookedRate = Number(input.bookedRateToBase)
  const settlementRate = Number(input.settlementRateToBase)
  if (
    !Number.isFinite(amountForeign) || amountForeign <= 0 ||
    !Number.isFinite(bookedRate) || bookedRate <= 0 ||
    !Number.isFinite(settlementRate) || settlementRate <= 0
  ) {
    return { bookedBase: 0, settlementBase: 0, gainLossBase: 0, outcome: 'none' }
  }

  // Convert each leg in full Decimal precision; round only for the displayed
  // booked/settlement amounts. The gain/loss is computed from the UNROUNDED
  // legs and rounded once, so rounding each leg before differencing can no
  // longer manufacture or drop a penny near the 0.01 emit threshold
  // (cogs-audit scjz.54 float contamination + scjz.56 double-rounding).
  const bookedBaseDec = input.bookedBase != null && Number.isFinite(input.bookedBase)
    ? toDecimal(input.bookedBase)
    : toDecimal(amountForeign).div(bookedRate)
  const settlementBaseDec = toDecimal(amountForeign).div(settlementRate)
  const bookedBase = roundAccountingMoney(bookedBaseDec)
  const settlementBase = roundAccountingMoney(settlementBaseDec)
  const rawGainLoss = input.side === 'receivable'
    ? settlementBaseDec.sub(bookedBaseDec)
    : bookedBaseDec.sub(settlementBaseDec)
  const gainLossBase = roundAccountingMoney(rawGainLoss)
  const outcome = Math.abs(gainLossBase) < 0.01
    ? 'none'
    : gainLossBase > 0
    ? 'gain'
    : 'loss'

  return { bookedBase, settlementBase, gainLossBase, outcome }
}

export function buildRealisedFxJournal(params: {
  side: FxSettlementSide
  gainLossBase: number
  controlAccount: string
  fxGainLossAccount: string
  description: string
}) {
  const amount = roundAccountingMoney(Math.abs(params.gainLossBase))
  if (amount < 0.01) return []
  const controlLine = {
    accountCode: params.controlAccount,
    description: params.description,
    debit: params.gainLossBase > 0 ? amount : 0,
    credit: params.gainLossBase > 0 ? 0 : amount,
  }
  const fxLine = {
    accountCode: params.fxGainLossAccount,
    description: params.description,
    debit: params.gainLossBase > 0 ? 0 : amount,
    credit: params.gainLossBase > 0 ? amount : 0,
  }
  return [controlLine, fxLine]
}

export function reverseJournalLines(lines: FxJournalLine[], descriptionSuffix: string): FxJournalLine[] {
  return lines.map((line) => ({
    accountCode: line.accountCode,
    description: `${line.description} ${descriptionSuffix}`.trim(),
    debit: roundAccountingMoney(Number(line.credit ?? 0)),
    credit: roundAccountingMoney(Number(line.debit ?? 0)),
    taxType: line.taxType,
  }))
}

export function getRealisedFxAccounts(settings: AccountingSettings, side: FxSettlementSide): {
  controlAccount: string
  fxGainLossAccount: string
} | null {
  const controlAccount = side === 'receivable'
    ? settings.accountsReceivableAccount
    : settings.accountsPayableAccount
  if (!controlAccount || !settings.realisedFxGainLossAccount) return null
  return {
    controlAccount,
    fxGainLossAccount: settings.realisedFxGainLossAccount,
  }
}

export function getUnrealisedFxAccounts(settings: AccountingSettings, side: FxSettlementSide): {
  controlAccount: string
  fxGainLossAccount: string
} | null {
  const controlAccount = side === 'receivable'
    ? settings.accountsReceivableAccount
    : settings.accountsPayableAccount
  if (!controlAccount || !settings.unrealisedFxGainLossAccount) return null
  return {
    controlAccount,
    fxGainLossAccount: settings.unrealisedFxGainLossAccount,
  }
}

/**
 * The rate a settlement or revaluation is measured at: the central `fx_rates` lookup, and nothing else.
 *
 * A MISSING rate REFUSES (owner ruling 2026-10-24): there is no default of 1, no fallback to the document's
 * booked rate and no vendor rate. Every `MissingFxRateError` reason (`no_rate`, `invalid_currency`,
 * `non_positive_rate`, `ambiguous_rate`, ...) propagates; callers decide what "refused" means for their own
 * writes (see `describeFxRefusal` for the operator text).
 *
 * Only a base-currency document answers 1, and it does so because `currency === baseCurrency`, never because a
 * value was missing. An EMPTY currency is not the base currency: it reaches the lookup and refuses.
 *
 * `asOf` must already be an instant. A date-only input (`YYYY-MM-DD`) is converted by the caller with
 * `endOfBusinessDateUtc` (or `settlementAsOfFromInput`) so a rate fetched at 09:00 on that day is visible.
 */
export async function resolveSettlementFxRateToBase(
  tx: Prisma.TransactionClient,
  params: {
    currency: string
    baseCurrency: string
    asOf: Date
  },
): Promise<number> {
  const currency = params.currency.trim().toUpperCase()
  const baseCurrency = params.baseCurrency.trim().toUpperCase()
  if (currency && currency === baseCurrency) return 1
  const rate = await getFxRateToBase(tx, { currency, asOf: params.asOf, baseCurrency })
  return rate.rate.toNumber()
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * The `asOf` for an FX lookup from a user-supplied payment/valuation input.
 *
 * A date-only string (`YYYY-MM-DD`, what a date picker sends) names a BUSINESS DAY, so it maps to the end of that
 * UTC day (`endOfBusinessDateUtc`); `new Date('2026-06-10')` is midnight and would hide every rate fetched that day.
 * Anything else is a real instant and is used as it is (`fallback` when the input is absent: "now").
 */
export function settlementAsOfFromInput(input: string | Date | null | undefined, fallback: Date): Date {
  if (typeof input === 'string' && DATE_ONLY.test(input)) return endOfBusinessDateUtc(input)
  if (input instanceof Date) return input
  if (typeof input === 'string' && input) return new Date(input)
  return fallback
}

/**
 * What to persist beside `paidAt` so a report can tell an explicit instant from a date-only input: the stored instant itself when the input was an explicit instant (anything but a `YYYY-MM-DD`
 * string), null when it was date-only. A stored `paidAt` of exactly midnight UTC is ambiguous on its own (a date-only input is stored as that midnight, an explicit 00:00:00Z instant is the same value).
 */
export function explicitSettlementInstant(input: string | Date | null | undefined, stored: Date): Date | null {
  if (typeof input === 'string' && DATE_ONLY.test(input)) return null
  return stored
}

/**
 * The `asOf` a report must use to re-derive a payment's settlement rate from its stored `paidAt`.
 *
 * A stored `paidAt` that is EXACTLY midnight UTC is, absent other evidence, a date-only input that was stored as `new Date('YYYY-MM-DD')` (the payment form and the bill-payment form do this), and
 * reads as that business day. The evidence is `explicitInstant` (`paidAtExplicitInstant`, see explicitSettlementInstant): when it equals `paidAt` the input WAS an explicit instant, midnight included,
 * and it is used as the instant, as the payment's own journal did. A value that no longer equals `paidAt` (paidAt changed since) is no evidence. Any other stored value is a real instant.
 */
export function settlementAsOfFromStored(paidAt: Date, explicitInstant?: Date | null): Date {
  if (explicitInstant && explicitInstant.getTime() === paidAt.getTime()) return paidAt
  if (
    paidAt.getUTCHours() === 0 && paidAt.getUTCMinutes() === 0 && paidAt.getUTCSeconds() === 0 && paidAt.getUTCMilliseconds() === 0
  ) return endOfBusinessDateUtc(paidAt)
  return paidAt
}

/** The operator-facing sentence for a refused rate. Always says what to do: add the rate, or correct the document. */
export function describeFxRefusal(error: MissingFxRateError): string {
  const remedy = 'Add the rate in Settings -> Currencies (or correct the document), then retry.'
  switch (error.reason) {
    case 'no_rate':
      return `${error.message}. ${remedy}`
    case 'ambiguous_rate':
      return `${error.message}: two different rates are stored for the same instant. Remove the wrong one in Settings -> Currencies, then retry.`
    case 'non_positive_rate':
    case 'non_finite_rate':
      return `${error.message}: the stored rate is not a positive number. Correct it in Settings -> Currencies, then retry.`
    case 'invalid_currency':
    case 'invalid_base_currency':
      return `${error.message}. Correct the document's currency, then retry.`
    default:
      return `${error.message}. ${remedy}`
  }
}
