import type { AccountingSettings } from '@/lib/accounting'
import type { Prisma } from '@/app/generated/prisma/client'
import { roundQuantity } from '@/lib/domain/math/decimal'

export type FxSettlementSide = 'receivable' | 'payable'

export type RealisedFxInput = {
  side: FxSettlementSide
  amountForeign: number
  bookedRateToBase: number
  settlementRateToBase: number
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

export function roundAccountingMoney(value: number): number {
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

  const bookedBase = roundAccountingMoney(amountForeign / bookedRate)
  const settlementBase = roundAccountingMoney(amountForeign / settlementRate)
  const rawGainLoss = input.side === 'receivable'
    ? settlementBase - bookedBase
    : bookedBase - settlementBase
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

export async function resolveSettlementFxRateToBase(
  tx: Prisma.TransactionClient,
  params: {
    currency: string
    baseCurrency: string
    asOf: Date
    fallbackRateToBase: number
    referenceType?: string
    referenceId?: string
  },
): Promise<number> {
  const currency = params.currency.trim().toUpperCase()
  const baseCurrency = params.baseCurrency.trim().toUpperCase()
  if (!currency || currency === baseCurrency) return 1
  const rate = await tx.fxRate.findFirst({
    where: {
      fromCurrency: baseCurrency,
      toCurrency: currency,
      fetchedAt: { lte: params.asOf },
    },
    orderBy: { fetchedAt: 'desc' },
    select: { rate: true },
  })
  const resolved = rate ? Number(rate.rate) : Number(params.fallbackRateToBase)
  if (!rate && Number.isFinite(resolved) && resolved > 0) {
    await tx.activityLog.create({
      data: {
        entityType: 'SYSTEM',
        entityId: params.referenceId ?? null,
        action: 'fx_rate_fallback_used',
        tag: 'accounting',
        level: 'WARNING',
        description: `Used fallback FX rate for ${currency} settlement on ${params.asOf.toISOString().slice(0, 10)}`,
        metadata: {
          currency,
          baseCurrency,
          settlementDate: params.asOf.toISOString().slice(0, 10),
          fallbackRateToBase: resolved,
          referenceType: params.referenceType ?? null,
          referenceId: params.referenceId ?? null,
        },
      },
    })
  }
  return Number.isFinite(resolved) && resolved > 0 ? resolved : 1
}
