'use server'

import { getActiveAccountingConnectorInfo } from '@/lib/accounting'
import type {
  DailyBatchHistoryDay,
  DailyBatchPreview,
} from '@/app/actions/xero-daily-batch'

/**
 * Generic daily-batch preview. `groupBPreviewed` is `false` when the active
 * connector does not yet compute a group-B (shipment revenue + COGS) preview
 * (e.g. QuickBooks — 2t0q deferred B): the UI must then NOT treat a zero
 * group B as "nothing pending", since the batch still posts B at run time.
 * Omitted/undefined means group B is previewed normally (Xero).
 */
export type AccountingBatchPreview = DailyBatchPreview & { groupBPreviewed?: boolean }

export type AccountingBatchHistoryEntry = {
  id: string
  status: string
  narration: string
  lineCount: number
  totalDebit: number
  createdAt: string
  syncedAt: string | null
  externalTransactionId: string | null
  errorMessage: string | null
  retryCount: number
  lines: Array<{ accountCode: string; description: string; debit: number; credit: number }>
}

export type AccountingBatchHistoryDay = {
  date: string
  a1: AccountingBatchHistoryEntry | null
  a2: AccountingBatchHistoryEntry | null
  b: AccountingBatchHistoryEntry | null
}

function mapHistoryEntry(
  entry: DailyBatchHistoryDay['a1'],
): AccountingBatchHistoryEntry | null {
  if (!entry) return null
  return {
    id: entry.id,
    status: entry.status,
    narration: entry.narration,
    lineCount: entry.lineCount,
    totalDebit: entry.totalDebit,
    createdAt: entry.createdAt,
    syncedAt: entry.syncedAt,
    externalTransactionId: entry.externalTransactionId,
    errorMessage: entry.errorMessage,
    retryCount: entry.retryCount,
    lines: entry.lines,
  }
}

function mapHistoryDay(day: DailyBatchHistoryDay): AccountingBatchHistoryDay {
  return {
    date: day.date,
    a1: mapHistoryEntry(day.a1),
    a2: mapHistoryEntry(day.a2),
    b: mapHistoryEntry(day.b),
  }
}

// Daily-batch preview/history are connector-owned read surfaces: each queries
// its own connector's DAILY_BATCH_* sync logs and settings. Xero and QuickBooks
// each provide one; connectors without a surface get an honest empty result
// rather than bleeding another connector's batch data into the UI. The
// daily-batch *poster* still runs per active connector via
// /api/cron/accounting-daily-batch.
function emptyAccountingBatchPreview(): AccountingBatchPreview {
  return {
    generatedAt: new Date().toISOString(),
    cachedFor: 0,
    groupA1: { orderCount: 0, totalRevenue: 0, orders: [] },
    groupA2: { orderCount: 0, totalCost: 0, orders: [] },
    groupB: { shipmentCount: 0, totalRevenue: 0, totalCogs: 0, shipments: [] },
  }
}

export async function getAccountingBatchPreview(
  opts?: { force?: boolean },
): Promise<AccountingBatchPreview> {
  const connector = await getActiveAccountingConnectorInfo()
  if (connector?.id === 'xero') {
    const { getXeroDailyBatchPreview } = await import('@/app/actions/xero-daily-batch')
    return getXeroDailyBatchPreview(opts)
  }
  if (connector?.id === 'quickbooks') {
    const { getQuickBooksDailyBatchPreview } = await import('@/app/actions/quickbooks-daily-batch')
    return getQuickBooksDailyBatchPreview(opts)
  }
  return emptyAccountingBatchPreview()
}

export async function getAccountingBatchHistory(
  days = 30,
): Promise<AccountingBatchHistoryDay[]> {
  const connector = await getActiveAccountingConnectorInfo()
  if (connector?.id === 'xero') {
    const { getXeroDailyBatchHistory } = await import('@/app/actions/xero-daily-batch')
    const rows = await getXeroDailyBatchHistory(days)
    return rows.map(mapHistoryDay)
  }
  if (connector?.id === 'quickbooks') {
    const { getQuickBooksDailyBatchHistory } = await import('@/app/actions/quickbooks-daily-batch')
    const rows = await getQuickBooksDailyBatchHistory(days)
    return rows.map(mapHistoryDay)
  }
  return []
}

export async function refreshAccountingBatchPreview(): Promise<AccountingBatchPreview> {
  const connector = await getActiveAccountingConnectorInfo()
  if (connector?.id === 'xero') {
    const { refreshXeroDailyBatchPreview } = await import('@/app/actions/xero-daily-batch')
    return refreshXeroDailyBatchPreview()
  }
  if (connector?.id === 'quickbooks') {
    const { refreshQuickBooksDailyBatchPreview } = await import('@/app/actions/quickbooks-daily-batch')
    return refreshQuickBooksDailyBatchPreview()
  }
  return emptyAccountingBatchPreview()
}
