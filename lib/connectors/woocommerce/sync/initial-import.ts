/**
 * WooCommerce active order import — background job.
 *
 * Imports active orders (processing/pending/on-hold) as SalesOrders via importWcOrder.
 * Historical demand data import is handled separately by the forecast module.
 *
 * Skips failed, cancelled, and refunded orders entirely.
 */

import { after } from 'next/server'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { notify } from '@/lib/notifications'
import { wcFetch } from '../api'
import { importWcOrder } from './order-import'
import type { WcFullOrder } from './types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InitialImportProgress = {
  status: 'idle' | 'running' | 'done' | 'error'
  message: string
  activeOrdersImported: number
  activeOrdersSkipped: number
  totalOrders: number
  currentPage: number
  totalPages: number
  errors: string[]
}

const JOB_KEY = 'initial_order_import_job'

const INITIAL_PROGRESS: InitialImportProgress = {
  status: 'idle',
  message: '',
  activeOrdersImported: 0,
  activeOrdersSkipped: 0,
  totalOrders: 0,
  currentPage: 0,
  totalPages: 0,
  errors: [],
}

// ---------------------------------------------------------------------------
// Progress persistence — stored in the settings table
// ---------------------------------------------------------------------------

async function saveProgress(progress: InitialImportProgress) {
  await db.setting.upsert({
    where: { key: JOB_KEY },
    create: { key: JOB_KEY, value: JSON.stringify(progress) },
    update: { value: JSON.stringify(progress) },
  })
}

export async function getInitialImportProgress(): Promise<InitialImportProgress> {
  const row = await db.setting.findUnique({ where: { key: JOB_KEY } })
  if (!row?.value) return INITIAL_PROGRESS
  try { return JSON.parse(row.value) } catch { return INITIAL_PROGRESS }
}

// ---------------------------------------------------------------------------
// Start the import as a background job
// ---------------------------------------------------------------------------

export async function startInitialImport(): Promise<void> {
  const current = await getInitialImportProgress()
  if (current.status === 'running') return

  // Check if already completed
  const completedSetting = await db.setting.findUnique({ where: { key: 'wc_initial_import_completed' } })
  if (completedSetting?.value === 'true') return

  const progress: InitialImportProgress = {
    ...INITIAL_PROGRESS,
    status: 'running',
    message: 'Preparing active order import\u2026',
  }
  await saveProgress(progress)

  after(() => runInitialImport(progress).catch(async (e) => {
    progress.status = 'error'
    progress.message = String(e)
    progress.errors.push(String(e))
    await saveProgress(progress)
  }))
}

// ---------------------------------------------------------------------------
// The actual import logic
// ---------------------------------------------------------------------------

async function runInitialImport(progress: InitialImportProgress) {
  try {
    progress.message = 'Importing active orders\u2026'
    await saveProgress(progress)

    // Deduplication: pre-load existing WooCommerce order links.
    const existingOrders = await db.shoppingOrderLink.findMany({
      where: { connector: 'woocommerce' },
      select: { externalOrderId: true },
    })
    const importedOrderIds = new Set(existingOrders.map((o) => Number(o.externalOrderId)))

    let page = 1
    let totalPages = 1

    while (page <= totalPages) {
      progress.currentPage = page
      progress.message = `Fetching active orders\u2026 page ${page}${totalPages > 1 ? ` / ${totalPages}` : ''}`
      await saveProgress(progress)

      let result: Awaited<ReturnType<typeof wcFetch>> | null = null
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          result = await wcFetch('/orders', {
            status: 'processing,pending,on-hold',
            per_page: '100',
            page: String(page),
            orderby: 'date',
            order: 'asc',
          })
          if (!result.error) break
        } catch (fetchErr) {
          result = { data: null, totalPages: 0, totalItems: 0, error: String(fetchErr) }
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000))
      }

      if (!result || result.error) {
        progress.errors.push(`Page ${page}: ${result?.error ?? 'unknown error'}`)
        page++
        continue
      }

      totalPages = result.totalPages
      progress.totalPages = totalPages
      if (result.totalItems > 0) progress.totalOrders = result.totalItems
      const orders = result.data as WcFullOrder[]

      for (const order of orders) {
        if (importedOrderIds.has(order.id)) {
          progress.activeOrdersSkipped++
          continue
        }

        const importResult = await importWcOrder(order, { useWcDateAsCreatedAt: true })
        if (importResult.success && importResult.orderId) {
          progress.activeOrdersImported++
        } else if (importResult.success) {
          progress.activeOrdersSkipped++
        } else {
          progress.errors.push(`Order #${order.number}: ${importResult.error}`)
        }

        importedOrderIds.add(order.id)
      }

      page++
    }

    // -----------------------------------------------------------------------
    // Completion
    // -----------------------------------------------------------------------
    await db.setting.upsert({
      where: { key: 'wc_initial_import_completed' },
      create: { key: 'wc_initial_import_completed', value: 'true' },
      update: { value: 'true' },
    })
    await db.setting.upsert({
      where: { key: 'last_wc_order_sync_at' },
      create: { key: 'last_wc_order_sync_at', value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    })

    progress.status = 'done'
    const parts: string[] = []
    if (progress.activeOrdersImported > 0) parts.push(`${progress.activeOrdersImported} active orders imported`)
    if (progress.activeOrdersSkipped > 0) parts.push(`${progress.activeOrdersSkipped} already imported`)
    if (progress.errors.length > 0) parts.push(`${progress.errors.length} errors`)
    if (parts.length === 0) parts.push('No active orders found')
    progress.message = parts.join(' \u00b7 ')
    await saveProgress(progress)

    await logActivity({
      entityType: 'IMPORT',
      tag: 'import',
      action: 'imported',
      description: `Active WC order import complete: ${progress.message}`,
      resolveUser: false,
    })

    notify({
      type: 'success',
      title: 'Active Order Import Complete',
      message: progress.message,
      actionUrl: '/sync',
    })
  } catch (e) {
    progress.status = 'error'
    progress.message = String(e)
    progress.errors.push(String(e))
    await saveProgress(progress)

    await logActivity({
      entityType: 'IMPORT',
      tag: 'import',
      action: 'imported',
      level: 'ERROR',
      description: `Active WC order import failed: ${String(e)}`,
      resolveUser: false,
    })

    notify({
      type: 'error',
      title: 'Active Order Import Failed',
      message: String(e),
      actionUrl: '/sync',
    })
  }
}

// ---------------------------------------------------------------------------
// Purge expired demand history (called from activity-cleanup cron)
// ---------------------------------------------------------------------------

export async function purgeExpiredDemandHistory(): Promise<number> {
  // Read retention from forecast settings, fall back to legacy key
  const forecastSetting = await db.setting.findUnique({ where: { key: 'forecast_retention_months' } })
  const legacySetting = !forecastSetting?.value
    ? await db.setting.findUnique({ where: { key: 'wc_initial_import_retention_months' } })
    : null
  const retentionMonths = Math.max(1, parseInt(forecastSetting?.value || legacySetting?.value || '24') || 24)
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - retentionMonths)

  const deleted = await db.stockMovement.deleteMany({
    where: {
      referenceType: { in: ['WcHistorical', 'WcInitialImport', 'CsvHistorical'] },
      createdAt: { lt: cutoff },
    },
  })

  if (deleted.count > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'cleanup',
      tag: 'system',
      description: `Purged ${deleted.count} expired demand history records (older than ${retentionMonths} months)`,
      metadata: { deletedCount: deleted.count },
      resolveUser: false,
    })
  }

  return deleted.count
}
