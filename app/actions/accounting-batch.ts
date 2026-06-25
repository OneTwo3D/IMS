'use server'

import { getActiveAccountingConnectorInfo } from '@/lib/accounting'
import type {
  DailyBatchHistoryDay,
  DailyBatchPreview,
} from '@/app/actions/xero-daily-batch'

export type AccountingBatchPreview = DailyBatchPreview

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
// its own connector's DAILY_BATCH_* sync logs and settings. Only Xero provides
// one today, so non-Xero connectors get an honest empty surface rather than
// bleeding Xero's batch data into the UI. The daily-batch *poster* still runs
// per active connector via /api/cron/accounting-daily-batch.
// Follow-up: implement a QuickBooks daily-batch preview/history surface.
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
  if (connector?.id !== 'xero') return emptyAccountingBatchPreview()
  const { getXeroDailyBatchPreview } = await import('@/app/actions/xero-daily-batch')
  return getXeroDailyBatchPreview(opts)
}

export async function getAccountingBatchHistory(
  days = 30,
): Promise<AccountingBatchHistoryDay[]> {
  const connector = await getActiveAccountingConnectorInfo()
  if (connector?.id !== 'xero') return []
  const { getXeroDailyBatchHistory } = await import('@/app/actions/xero-daily-batch')
  const rows = await getXeroDailyBatchHistory(days)
  return rows.map(mapHistoryDay)
}

export async function refreshAccountingBatchPreview(): Promise<AccountingBatchPreview> {
  const connector = await getActiveAccountingConnectorInfo()
  if (connector?.id !== 'xero') return emptyAccountingBatchPreview()
  const { refreshXeroDailyBatchPreview } = await import('@/app/actions/xero-daily-batch')
  return refreshXeroDailyBatchPreview()
}
