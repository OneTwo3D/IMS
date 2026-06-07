import type { Prisma } from '@/app/generated/prisma/client'

export const PURCHASE_ORDER_FX_OVERRIDE_WARNING_THRESHOLD = 0.01
export const PURCHASE_ORDER_FX_OVERRIDE_REJECT_THRESHOLD = 0.05

export type PurchaseOrderFxWarning = {
  code: 'purchase_order_fx_override_delta'
  baseCurrency: string
  currency: string
  expectedRateToBase: number
  manualRateToBase: number
  deltaPercent: number
  warningThresholdPercent: number
  rejectThresholdPercent: number
}

export type PurchaseOrderFxResolution = {
  fxRateToBase: number
  expectedRateToBase: number
  source: 'base-currency' | 'stored-rate' | 'manual-override'
  warning: PurchaseOrderFxWarning | null
}

export type PurchaseOrderFxEvaluation =
  | { ok: true; resolution: PurchaseOrderFxResolution }
  | { ok: false; error: string }

type FxRateClient = {
  fxRate: {
    findFirst(args: Prisma.FxRateFindFirstArgs): Promise<{ rate: unknown } | null>
  }
}

function normalizeCurrency(value: string): string {
  return value.trim().toUpperCase()
}

function positiveFiniteNumber(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function relativeDeltaPercent(actual: number, expected: number): number {
  return expected > 0 ? Math.abs(actual - expected) / expected : Number.POSITIVE_INFINITY
}

function formatRate(value: number): string {
  return value.toFixed(4)
}

function formatAsOfDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function rejectError(params: {
  manualRate: number
  expectedRate: number
  baseCurrency: string
  currency: string
  asOf: Date
  deltaPercent: number
  rejectThreshold: number
}): string {
  return `FX rate ${formatRate(params.manualRate)} differs from the stored ${params.baseCurrency}->${params.currency} rate ${formatRate(params.expectedRate)} (as of ${formatAsOfDate(params.asOf)}) by ${(params.deltaPercent * 100).toFixed(2)}%. Use a rate within ${(params.rejectThreshold * 100).toFixed(0)}% of that reference, or refresh the rate before saving.`
}

export function shouldResolvePurchaseOrderFxRate(params: {
  existingCurrency: string
  existingRateToBase: unknown
  inputCurrency?: string | null
  inputRateToBase?: unknown
}): boolean {
  const currencyChanged = params.inputCurrency != null
    && normalizeCurrency(params.inputCurrency) !== normalizeCurrency(params.existingCurrency)
  const manualRate = positiveFiniteNumber(params.inputRateToBase)
  const existingRate = positiveFiniteNumber(params.existingRateToBase)
  const fxRateChanged = manualRate != null
    && existingRate != null
    && Math.abs(manualRate - existingRate) > 0.000001
  return currencyChanged || fxRateChanged
}

export function evaluatePurchaseOrderFxRateOverride(params: {
  currency: string
  baseCurrency: string
  asOf: Date
  referenceRateToBase?: unknown
  manualRateToBase?: number | null
  warningThreshold?: number
  rejectThreshold?: number
}): PurchaseOrderFxEvaluation {
  const currency = normalizeCurrency(params.currency)
  const baseCurrency = normalizeCurrency(params.baseCurrency)
  const warningThreshold = params.warningThreshold ?? PURCHASE_ORDER_FX_OVERRIDE_WARNING_THRESHOLD
  const rejectThreshold = params.rejectThreshold ?? PURCHASE_ORDER_FX_OVERRIDE_REJECT_THRESHOLD
  const manualRate = positiveFiniteNumber(params.manualRateToBase)

  if (!currency || currency === baseCurrency) {
    return {
      ok: true,
      resolution: {
        fxRateToBase: 1,
        expectedRateToBase: 1,
        source: 'base-currency',
        warning: null,
      },
    }
  }

  const expectedRate = positiveFiniteNumber(params.referenceRateToBase)
  if (expectedRate == null) {
    return {
      ok: false,
      error: `Missing ${baseCurrency} FX rate for ${currency} on or before ${formatAsOfDate(params.asOf)}`,
    }
  }

  if (manualRate == null) {
    return {
      ok: true,
      resolution: {
        fxRateToBase: expectedRate,
        expectedRateToBase: expectedRate,
        source: 'stored-rate',
        warning: null,
      },
    }
  }

  const deltaPercent = relativeDeltaPercent(manualRate, expectedRate)
  if (deltaPercent > rejectThreshold) {
    return {
      ok: false,
      error: rejectError({
        manualRate,
        expectedRate,
        baseCurrency,
        currency,
        asOf: params.asOf,
        deltaPercent,
        rejectThreshold,
      }),
    }
  }

  const isStoredRateEquivalent = deltaPercent <= 0.000001
  const warning: PurchaseOrderFxWarning | null = deltaPercent > warningThreshold
    ? {
        code: 'purchase_order_fx_override_delta',
        baseCurrency,
        currency,
        expectedRateToBase: expectedRate,
        manualRateToBase: manualRate,
        deltaPercent,
        warningThresholdPercent: warningThreshold,
        rejectThresholdPercent: rejectThreshold,
      }
    : null

  return {
    ok: true,
    resolution: {
      fxRateToBase: manualRate,
      expectedRateToBase: expectedRate,
      source: isStoredRateEquivalent ? 'stored-rate' : 'manual-override',
      warning,
    },
  }
}

/**
 * Resolves the authoritative purchase-order FX rate. The stored FxRate table
 * remains the default source; a manual override is accepted only inside the
 * configured sanity band so a stale browser tab or decimal-place typo cannot
 * silently reprice future FIFO receipt cost layers.
 */
export async function resolvePurchaseOrderFxRateToBase(
  client: FxRateClient,
  params: {
    currency: string
    baseCurrency: string
    asOf: Date
    manualRateToBase?: number | null
    warningThreshold?: number
    rejectThreshold?: number
  },
): Promise<PurchaseOrderFxResolution> {
  const currency = normalizeCurrency(params.currency)
  const baseCurrency = normalizeCurrency(params.baseCurrency)
  const rate = currency && currency !== baseCurrency
    ? await client.fxRate.findFirst({
        where: {
          fromCurrency: baseCurrency,
          toCurrency: currency,
          fetchedAt: { lte: params.asOf },
        },
        orderBy: { fetchedAt: 'desc' },
        select: { rate: true },
      })
    : null

  const evaluation = evaluatePurchaseOrderFxRateOverride({
    currency,
    baseCurrency,
    asOf: params.asOf,
    referenceRateToBase: rate?.rate,
    manualRateToBase: params.manualRateToBase,
    warningThreshold: params.warningThreshold,
    rejectThreshold: params.rejectThreshold,
  })
  if (!evaluation.ok) {
    throw new Error(evaluation.error)
  }
  return evaluation.resolution
}
