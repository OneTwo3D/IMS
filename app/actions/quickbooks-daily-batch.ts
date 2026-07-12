'use server'

import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth/server'
import { computeDailyBatchA1A2Preview } from '@/lib/domain/accounting/daily-batch-preview'
import type { AccountingBatchPreview } from '@/app/actions/accounting-batch'
import type {
  DailyBatchHistoryDay,
  DailyBatchHistoryEntry,
} from '@/app/actions/xero-daily-batch'

/**
 * Preview & history for the QuickBooks daily batch sub-ledger.
 *
 * Mirrors the Xero read surface (app/actions/xero-daily-batch.ts) for the
 * QuickBooks connector so the /sync daily-batch UI shows real data when
 * QuickBooks is active instead of an empty placeholder.
 *
 * Scope (onetwo3d-ims-2t0q): groups A1 (revenue deferral) and A2 (inventory
 * reclassification) are computed from local state via the shared
 * connector-agnostic helper, and history reads the connector:'quickbooks'
 * DAILY_BATCH_* sync logs. Group B (shipment revenue + COGS) preview is
 * deferred — it requires mirroring the QuickBooks per-run batch semantics and
 * reversal-aware true-up, tracked as a separate follow-up — so it is flagged
 * `groupBPreviewed: false` (the batch poster still posts B at run time).
 */

const PREVIEW_TTL_MS = 60_000

type CachedPreview = { builtAt: number; value: AccountingBatchPreview }
let previewCache: CachedPreview | null = null

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

async function computePreview(): Promise<AccountingBatchPreview> {
  const { groupA1, groupA2 } = await computeDailyBatchA1A2Preview()
  return {
    generatedAt: new Date().toISOString(),
    cachedFor: 0,
    groupA1,
    groupA2,
    // Group B preview deferred for QuickBooks (2t0q follow-up) — the daily
    // batch still posts shipment revenue/COGS at run time, so flag it as
    // not-previewed (rather than "nothing pending") for the UI.
    groupB: { shipmentCount: 0, totalRevenue: 0, totalCogs: 0, shipments: [] },
    groupBPreviewed: false,
  }
}

export async function getQuickBooksDailyBatchPreview(
  opts?: { force?: boolean },
): Promise<AccountingBatchPreview> {
  await requirePermission('sync')

  const now = Date.now()
  if (!opts?.force && previewCache && now - previewCache.builtAt < PREVIEW_TTL_MS) {
    return {
      ...previewCache.value,
      cachedFor: Math.max(
        0,
        Math.round((PREVIEW_TTL_MS - (now - previewCache.builtAt)) / 1000),
      ),
    }
  }

  const value = await computePreview()
  previewCache = { builtAt: Date.now(), value }
  return { ...value, cachedFor: Math.round(PREVIEW_TTL_MS / 1000) }
}

export async function refreshQuickBooksDailyBatchPreview(): Promise<AccountingBatchPreview> {
  previewCache = null
  return getQuickBooksDailyBatchPreview({ force: true })
}

export async function getQuickBooksDailyBatchHistory(
  days = 30,
): Promise<DailyBatchHistoryDay[]> {
  await requirePermission('sync')

  const since = new Date()
  since.setDate(since.getDate() - days)

  const rows = await db.accountingSyncLog.findMany({
    where: {
      connector: 'quickbooks',
      type: {
        in: [
          'DAILY_BATCH_REVENUE_DEFERRAL',
          'DAILY_BATCH_INVENTORY_ALLOC',
          'DAILY_BATCH_GROUP_B',
        ],
      },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
  })

  const byDate = new Map<string, DailyBatchHistoryDay>()

  for (const row of rows) {
    const payload = (row.payload ?? {}) as {
      date?: string
      narration?: string
      lines?: Array<{
        accountCode?: string
        description?: string
        debit?: number
        credit?: number
      }>
    }
    const date = typeof payload.date === 'string' && payload.date
      ? payload.date.slice(0, 10)
      : row.createdAt.toISOString().slice(0, 10)
    let day = byDate.get(date)
    if (!day) {
      day = { date, a1: null, a2: null, b: null }
      byDate.set(date, day)
    }

    const lines = Array.isArray(payload.lines)
      ? payload.lines.map((l) => ({
          accountCode: l.accountCode ?? '',
          description: l.description ?? '',
          debit: Number(l.debit ?? 0),
          credit: Number(l.credit ?? 0),
        }))
      : []
    const totalDebit = round2(lines.reduce((s, l) => s + l.debit, 0))

    const entry: DailyBatchHistoryEntry = {
      id: row.id,
      status: row.status,
      narration: payload.narration ?? '',
      lineCount: lines.length,
      totalDebit,
      createdAt: row.createdAt.toISOString(),
      syncedAt: row.syncedAt?.toISOString() ?? null,
      externalTransactionId: row.externalTransactionId,
      errorMessage: row.errorMessage,
      retryCount: row.retryCount,
      lines,
    }

    if (row.type === 'DAILY_BATCH_REVENUE_DEFERRAL') day.a1 = entry
    else if (row.type === 'DAILY_BATCH_INVENTORY_ALLOC') day.a2 = entry
    else if (row.type === 'DAILY_BATCH_GROUP_B') day.b = entry
  }

  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date))
}
