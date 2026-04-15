'use server'

import {
  getXeroDailyBatchHistory,
  getXeroDailyBatchPreview,
  refreshXeroDailyBatchPreview,
  type DailyBatchHistoryDay,
  type DailyBatchPreview,
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

export async function getAccountingBatchPreview(
  opts?: { force?: boolean },
): Promise<AccountingBatchPreview> {
  return getXeroDailyBatchPreview(opts)
}

export async function getAccountingBatchHistory(
  days = 30,
): Promise<AccountingBatchHistoryDay[]> {
  const rows = await getXeroDailyBatchHistory(days)
  return rows.map(mapHistoryDay)
}

export async function refreshAccountingBatchPreview(): Promise<AccountingBatchPreview> {
  return refreshXeroDailyBatchPreview()
}
