import { db } from '@/lib/db'
import { getAccountingSettings, queueAccountingSync } from '@/lib/accounting'
import {
  buildRealisedFxJournal,
  computeRealisedFx,
  reverseJournalLines,
  getUnrealisedFxAccounts,
  resolveSettlementFxRateToBase,
  roundMoney,
  type FxSettlementSide,
} from '@/lib/accounting-fx'
import { getBaseCurrencyCode } from '@/lib/base-currency'

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

async function getPriorRevaluations(valuationDate: string): Promise<PriorRevaluation[]> {
  const logs = await db.accountingSyncLog.findMany({
    where: {
      type: 'UNREALISED_FX_JOURNAL',
      status: { in: [...ACTIVE_SYNC_STATUSES] },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, payload: true },
  })

  const reversalSources = new Set<string>()
  const prior: PriorRevaluation[] = []
  let hasSameDateRevaluation = false

  for (const log of logs) {
    const payload = log.payload
    if (!isActivePayload(payload)) continue
    if (payload.kind === 'reversal' && typeof payload.sourceEntryId === 'string') {
      reversalSources.add(payload.sourceEntryId)
      continue
    }
    if (payload.kind !== 'revaluation') continue
    if (payload.valuationDate === valuationDate) {
      hasSameDateRevaluation = true
      continue
    }
    if (typeof payload.valuationDate !== 'string' || payload.valuationDate >= valuationDate) continue
    if (payload.side !== 'receivable' && payload.side !== 'payable') continue
    prior.push({
      id: log.id,
      valuationDate: payload.valuationDate,
      side: payload.side,
      lines: parseJournalLines(payload.lines),
    })
  }

  if (hasSameDateRevaluation) return []
  return prior.filter((entry) => !reversalSources.has(entry.id) && entry.lines.length > 0)
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
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
      totalForeign: { gt: 0 },
    },
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      invoiceNumber: true,
      currency: true,
      totalForeign: true,
      fxRateToBase: true,
      payments: {
        where: { refundId: null },
        select: { amount: true, currency: true },
      },
    },
  })

  return orders.flatMap((order) => {
    const paid = order.payments.reduce((sum, payment) => (
      payment.currency === order.currency ? sum + Number(payment.amount) : sum
    ), 0)
    const outstandingForeign = roundMoney(Number(order.totalForeign) - paid)
    if (outstandingForeign < 0.01) return []
    return [{
      id: order.id,
      reference: order.invoiceNumber ?? order.externalOrderNumber ?? order.orderNumber ?? order.id,
      side: 'receivable' as const,
      currency: order.currency,
      outstandingForeign,
      bookedRateToBase: Number(order.fxRateToBase),
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
      fxRateToBase: true,
      po: { select: { reference: true, currency: true } },
    },
  })

  return invoices.map((invoice) => ({
    id: invoice.id,
    reference: invoice.invoiceNumber ?? invoice.po.reference,
    side: 'payable' as const,
    currency: invoice.po.currency,
    outstandingForeign: Number(invoice.totalForeign),
    bookedRateToBase: Number(invoice.fxRateToBase),
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
    }))
    const revaluation = computeRealisedFx({
      side: params.side,
      amountForeign: balance.outstandingForeign,
      bookedRateToBase: balance.bookedRateToBase,
      settlementRateToBase,
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

  if (await hasRevaluationForDate(valuationDate)) {
    return { success: true, skipped: true, reason: 'Revaluation already queued for this date', valuationDate, reversed: 0, revalued: 0, documents: 0 }
  }

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

  const [receivables, payables] = await Promise.all([
    getOpenReceivables(baseCurrency),
    getOpenPayables(baseCurrency),
  ])

  let revalued = 0
  let documents = 0
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

  return { success: true, valuationDate, reversed, revalued, documents }
}
