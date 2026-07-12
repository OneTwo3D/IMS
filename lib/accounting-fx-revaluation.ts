import { db } from '@/lib/db'
import { getAccountingSettings, queueAccountingSync } from '@/lib/accounting'
import {
  buildRealisedFxJournal,
  computeRealisedFx,
  reverseJournalLines,
  getUnrealisedFxAccounts,
  resolveSettlementFxRateToBase,
  roundAccountingMoney,
  type FxSettlementSide,
} from '@/lib/accounting-fx'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { addMoney, multiplyMoney, subtractMoney, toDecimal } from '@/lib/domain/math/decimal'

const ACTIVE_SYNC_STATUSES = ['PENDING', 'PROCESSING', 'SYNCED'] as const

type JournalLine = {
  accountCode: string
  description: string
  debit?: number
  credit?: number
  taxType?: string
}

type OpenBalance = {
  id: string
  reference: string
  side: FxSettlementSide
  currency: string
  outstandingForeign: number
  bookedRateToBase: number
  // Stored base value of the outstanding portion (document totalBase prorated by
  // outstandingForeign/totalForeign) — the actual AR/AP carrying value to revalue
  // against, rather than recomputing outstandingForeign/rate (cogs-audit scjz.55).
  bookedBase: number
}

type PriorRevaluation = {
  id: string
  valuationDate: string
  side: FxSettlementSide
  lines: JournalLine[]
}

type RevaluationPayload = {
  kind?: string
  side?: string
  valuationDate?: string
  sourceEntryId?: string
  lines?: JournalLine[]
}

export type FxRevaluationResult = {
  success: boolean
  valuationDate: string
  skipped?: boolean
  reason?: string
  error?: string
  reversed: number
  revalued: number
  documents: number
}

function asDateOnly(input?: Date | string): string {
  const date = input ? new Date(input) : new Date()
  if (Number.isNaN(date.getTime())) throw new Error('Invalid valuation date')
  return date.toISOString().slice(0, 10)
}

function isActivePayload(value: unknown): value is RevaluationPayload {
  return value != null && typeof value === 'object'
}

function parseJournalLines(value: unknown): JournalLine[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((line) => {
    if (!line || typeof line !== 'object') return []
    const entry = line as Record<string, unknown>
    if (typeof entry.accountCode !== 'string' || typeof entry.description !== 'string') return []
    return [{
      accountCode: entry.accountCode,
      description: entry.description,
      debit: typeof entry.debit === 'number' ? entry.debit : Number(entry.debit ?? 0),
      credit: typeof entry.credit === 'number' ? entry.credit : Number(entry.credit ?? 0),
      taxType: typeof entry.taxType === 'string' ? entry.taxType : undefined,
    }]
  })
}

/**
 * Pure selection of strictly-earlier revaluations that still need reversing.
 *
 * `logs` must already be filtered to ACTIVE statuses (PENDING/PROCESSING/SYNCED),
 * so a prior whose reversal FAILED is absent from `reversalSources` and is
 * therefore returned for retry. We deliberately do NOT bail out when a same-date
 * revaluation already exists: that earlier blanket short-circuit stranded
 * failed/missing reversals permanently, compounding unrealised FX each period
 * (scjz.39). A prior with an active reversal is already covered and excluded; a
 * fresh PENDING reversal for a failed one is allowed because the idempotency
 * unique index is partial on active statuses.
 */
export function selectPriorRevaluationsToReverse(
  logs: Array<{ id: string; payload: unknown }>,
  valuationDate: string,
): PriorRevaluation[] {
  const reversalSources = new Set<string>()
  const prior: PriorRevaluation[] = []

  for (const log of logs) {
    const payload = log.payload
    if (!isActivePayload(payload)) continue
    if (payload.kind === 'reversal' && typeof payload.sourceEntryId === 'string') {
      reversalSources.add(payload.sourceEntryId)
      continue
    }
    if (payload.kind !== 'revaluation') continue
    // Only strictly-earlier revaluations need reversing; >= valuationDate (same
    // day or future) is excluded here.
    if (typeof payload.valuationDate !== 'string' || payload.valuationDate >= valuationDate) continue
    if (payload.side !== 'receivable' && payload.side !== 'payable') continue
    prior.push({
      id: log.id,
      valuationDate: payload.valuationDate,
      side: payload.side,
      lines: parseJournalLines(payload.lines),
    })
  }

  return prior.filter((entry) => !reversalSources.has(entry.id) && entry.lines.length > 0)
}

async function getPriorRevaluations(valuationDate: string): Promise<PriorRevaluation[]> {
  const logs = await db.accountingSyncLog.findMany({
    where: {
      type: 'UNREALISED_FX_JOURNAL',
      status: { in: [...ACTIVE_SYNC_STATUSES] },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, payload: true },
  })
  return selectPriorRevaluationsToReverse(logs, valuationDate)
}

async function hasRevaluationForDate(valuationDate: string): Promise<boolean> {
  const logs = await db.accountingSyncLog.findMany({
    where: {
      type: 'UNREALISED_FX_JOURNAL',
      status: { in: [...ACTIVE_SYNC_STATUSES] },
    },
    select: { payload: true },
  })
  return logs.some((log) => {
    const payload = log.payload
    return isActivePayload(payload) &&
      payload.kind === 'revaluation' &&
      payload.valuationDate === valuationDate
  })
}

async function getOpenReceivables(baseCurrency: string): Promise<OpenBalance[]> {
  const orders = await db.salesOrder.findMany({
    where: {
      currency: { not: baseCurrency },
      status: { not: 'CANCELLED' },
      refundStatus: { not: 'FULL' },
      totalForeign: { gt: 0 },
    },
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      invoiceNumber: true,
      currency: true,
      totalForeign: true,
      totalBase: true,
      fxRateToBase: true,
      payments: {
        where: { refundId: null },
        select: { amount: true, currency: true },
      },
    },
  })

  return orders.flatMap((order) => {
    const paid = order.payments.reduce((sum, payment) => (
      payment.currency === order.currency ? addMoney(sum, payment.amount) : sum
    ), toDecimal(0))
    const outstandingForeign = roundAccountingMoney(subtractMoney(order.totalForeign, paid))
    if (outstandingForeign < 0.01) return []
    // Prorate the stored base by the outstanding share (one fxRate per order).
    const totalForeign = toDecimal(order.totalForeign)
    const bookedBase = totalForeign.gt(0)
      ? multiplyMoney(order.totalBase, outstandingForeign).div(totalForeign).toNumber()
      : 0
    return [{
      id: order.id,
      reference: order.invoiceNumber ?? order.externalOrderNumber ?? order.orderNumber ?? order.id,
      side: 'receivable' as const,
      currency: order.currency,
      outstandingForeign,
      bookedRateToBase: Number(order.fxRateToBase),
      bookedBase,
    }]
  })
}

async function getOpenPayables(baseCurrency: string): Promise<OpenBalance[]> {
  const invoices = await db.purchaseInvoice.findMany({
    where: {
      paidAt: null,
      totalForeign: { gt: 0 },
      po: { currency: { not: baseCurrency } },
    },
    select: {
      id: true,
      invoiceNumber: true,
      totalForeign: true,
      totalBase: true,
      fxRateToBase: true,
      po: { select: { reference: true, currency: true } },
    },
  })

  return invoices.map((invoice) => ({
    id: invoice.id,
    reference: invoice.invoiceNumber ?? invoice.po.reference,
    side: 'payable' as const,
    currency: invoice.po.currency,
    // Preserve the stored bill precision (totalForeign is Decimal(18,4)); do NOT
    // 2dp-round here or 3-decimal currencies / 4dp bill totals would be revalued
    // against an amount that disagrees with the stored payable. computeRealisedFx
    // still rounds the resulting gain/loss to 2dp for the journal (cogs-audit scjz.57).
    outstandingForeign: toDecimal(invoice.totalForeign).toNumber(),
    bookedRateToBase: Number(invoice.fxRateToBase),
    // Open payables are fully unpaid here (paidAt: null), so the outstanding base is
    // the full stored totalBase — the real AP carrying value (cogs-audit scjz.55).
    bookedBase: toDecimal(invoice.totalBase).toNumber(),
  }))
}

async function buildRevaluationLines(params: {
  balances: OpenBalance[]
  side: FxSettlementSide
  valuationDate: string
  baseCurrency: string
  controlAccount: string
  fxGainLossAccount: string
}): Promise<{ lines: JournalLine[]; documents: number }> {
  const valuationDate = new Date(params.valuationDate)
  const lines: JournalLine[] = []
  let documents = 0

  for (const balance of params.balances) {
    const settlementRateToBase = await db.$transaction((tx) => resolveSettlementFxRateToBase(tx, {
      currency: balance.currency,
      baseCurrency: params.baseCurrency,
      asOf: valuationDate,
      fallbackRateToBase: balance.bookedRateToBase,
      referenceType: params.side === 'receivable' ? 'SalesOrder' : 'PurchaseInvoice',
      referenceId: balance.id,
    }))
    const revaluation = computeRealisedFx({
      side: params.side,
      amountForeign: balance.outstandingForeign,
      bookedRateToBase: balance.bookedRateToBase,
      settlementRateToBase,
      bookedBase: balance.bookedBase,
    })
    const journalLines = buildRealisedFxJournal({
      side: params.side,
      gainLossBase: revaluation.gainLossBase,
      controlAccount: params.controlAccount,
      fxGainLossAccount: params.fxGainLossAccount,
      description: `Unrealised FX ${revaluation.outcome} on ${balance.reference}`,
    })
    if (journalLines.length === 0) continue
    lines.push(...journalLines)
    documents += 1
  }

  return { lines, documents }
}

export async function runArApFxRevaluation(input?: {
  valuationDate?: Date | string
}): Promise<FxRevaluationResult> {
  const valuationDate = asDateOnly(input?.valuationDate)
  const [settings, baseCurrency] = await Promise.all([
    getAccountingSettings(),
    getBaseCurrencyCode(),
  ])

  if (!settings.syncEnabled) {
    return { success: true, skipped: true, reason: 'Accounting sync disabled', valuationDate, reversed: 0, revalued: 0, documents: 0 }
  }
  if (!settings.unrealisedFxGainLossAccount) {
    return { success: false, error: 'Configure an unrealised FX gain/loss account before running revaluation.', valuationDate, reversed: 0, revalued: 0, documents: 0 }
  }
  const receivableAccounts = getUnrealisedFxAccounts(settings, 'receivable')
  const payableAccounts = getUnrealisedFxAccounts(settings, 'payable')
  if (!receivableAccounts || !payableAccounts) {
    return { success: false, error: 'Configure AR, AP, and unrealised FX accounts before running revaluation.', valuationDate, reversed: 0, revalued: 0, documents: 0 }
  }

  // Don't bail the whole run when today's revaluation already exists: the
  // reversal-retry loop below must still run so a prior reversal that failed (or
  // never queued) gets retried instead of being stranded (scjz.39). Only the
  // fresh revaluation step is skipped when it has already been queued today.
  const alreadyRevaluedForDate = await hasRevaluationForDate(valuationDate)

  let reversed = 0
  const priorRevaluations = await getPriorRevaluations(valuationDate)
  for (const prior of priorRevaluations) {
    const lines = reverseJournalLines(prior.lines, `(reversal for ${prior.valuationDate})`)
    if (lines.length === 0) continue
    await queueAccountingSync({
      type: 'UNREALISED_FX_JOURNAL',
      referenceType: 'FxRevaluation',
      referenceId: valuationDate,
      payload: {
        kind: 'reversal',
        valuationDate,
        sourceEntryId: prior.id,
        sourceValuationDate: prior.valuationDate,
        side: prior.side,
        date: valuationDate,
        reference: `FXREV-${valuationDate}`,
        narration: `Reverse unrealised FX revaluation from ${prior.valuationDate}`,
        lines,
      },
      idempotencyKey: `unrealised-fx:reversal:${valuationDate}:${prior.id}`,
    })
    reversed += 1
  }

  let revalued = 0
  let documents = 0
  // Skip only the fresh revaluation when one is already queued for today; the
  // reversal retries above always run regardless (scjz.39).
  if (!alreadyRevaluedForDate) {
    const [receivables, payables] = await Promise.all([
      getOpenReceivables(baseCurrency),
      getOpenPayables(baseCurrency),
    ])

    for (const [side, balances, accounts] of [
      ['receivable', receivables, receivableAccounts],
      ['payable', payables, payableAccounts],
    ] as const) {
      const built = await buildRevaluationLines({
        balances,
        side,
        valuationDate,
        baseCurrency,
        controlAccount: accounts.controlAccount,
        fxGainLossAccount: accounts.fxGainLossAccount,
      })
      documents += built.documents
      if (built.lines.length === 0) continue

      await queueAccountingSync({
        type: 'UNREALISED_FX_JOURNAL',
        referenceType: 'FxRevaluation',
        referenceId: valuationDate,
        payload: {
          kind: 'revaluation',
          valuationDate,
          side,
          date: valuationDate,
          reference: `FXREV-${valuationDate}`,
          narration: `Unrealised ${side === 'receivable' ? 'AR' : 'AP'} FX revaluation at ${valuationDate}`,
          lines: built.lines,
          documentCount: built.documents,
        },
        idempotencyKey: `unrealised-fx:revaluation:${valuationDate}:${side}`,
      })
      revalued += 1
    }
  }

  // Report skipped only when nothing happened this run (revaluation already
  // existed and no reversal needed retrying), preserving the prior signal.
  const noop = alreadyRevaluedForDate && reversed === 0 && revalued === 0
  return {
    success: true,
    valuationDate,
    reversed,
    revalued,
    documents,
    ...(noop ? { skipped: true, reason: 'Revaluation already queued for this date' } : {}),
  }
}
