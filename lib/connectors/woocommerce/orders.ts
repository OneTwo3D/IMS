import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { notify } from '@/lib/notifications'
import { wcFetch } from './api'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WcOrder = {
  id: number
  number: string
  status: string
  date_created: string
  currency: string
  total: string
  line_items: {
    id: number
    sku: string
    name: string
    quantity: number
    total: string
  }[]
}

export type HistoricalImportProgress = {
  status: 'idle' | 'running' | 'done' | 'error'
  message: string
  ordersProcessed: number
  movementsCreated: number
  ordersSkipped: number   // already-imported orders
  itemsSkipped: number    // line items with no matching SKU
  totalOrders: number
  totalPages: number
  currentPage: number
  errors: string[]
}

const JOB_KEY = 'historical_import_job'

const INITIAL_PROGRESS: HistoricalImportProgress = {
  status: 'idle',
  message: '',
  ordersProcessed: 0,
  movementsCreated: 0,
  ordersSkipped: 0,
  itemsSkipped: 0,
  totalOrders: 0,
  totalPages: 0,
  currentPage: 0,
  errors: [],
}

// ---------------------------------------------------------------------------
// Progress persistence — stored in the settings table
// ---------------------------------------------------------------------------

async function saveProgress(progress: HistoricalImportProgress) {
  await db.setting.upsert({
    where: { key: JOB_KEY },
    create: { key: JOB_KEY, value: JSON.stringify(progress) },
    update: { value: JSON.stringify(progress) },
  })
}

export async function getImportProgress(): Promise<HistoricalImportProgress> {
  const row = await db.setting.findUnique({ where: { key: JOB_KEY } })
  if (!row?.value) return INITIAL_PROGRESS
  try { return JSON.parse(row.value) } catch { return INITIAL_PROGRESS }
}

// ---------------------------------------------------------------------------
// Start the import as a background job.
// Returns immediately — the import runs in the background.
// ---------------------------------------------------------------------------

export async function startHistoricalImport(dateFrom: string, dateTo: string): Promise<void> {
  // Check if already running
  const current = await getImportProgress()
  if (current.status === 'running') return

  const progress: HistoricalImportProgress = {
    ...INITIAL_PROGRESS,
    status: 'running',
    message: 'Preparing import…',
  }
  await saveProgress(progress)

  // Fire and forget — do NOT await
  runImport(dateFrom, dateTo, progress).catch(async (e) => {
    progress.status = 'error'
    progress.message = String(e)
    progress.errors.push(String(e))
    await saveProgress(progress)
  })
}

// ---------------------------------------------------------------------------
// The actual import logic — runs in background, persists progress to DB
// ---------------------------------------------------------------------------

async function runImport(dateFrom: string, dateTo: string, progress: HistoricalImportProgress) {
  try {
    const products = await db.product.findMany({ select: { id: true, sku: true } })
    const skuToId = new Map(products.map((p) => [p.sku.toUpperCase(), p.id]))

    const existingImports = await db.stockMovement.findMany({
      where: { note: { startsWith: 'Historical WC import' } },
      select: { referenceId: true },
    })
    const alreadyImported = new Set(existingImports.map((m) => m.referenceId))

    let page = 1
    let totalPages = 1
    const perPage = 100

    while (page <= totalPages) {
      const processed = progress.ordersProcessed + progress.ordersSkipped
      progress.currentPage = page
      progress.message = progress.totalOrders > 0
        ? `Importing orders… ${processed} / ${Math.max(processed, progress.totalOrders)}`
        : 'Fetching orders…'
      await saveProgress(progress)

      // Retry up to 3 times per page to handle transient timeouts
      let result: Awaited<ReturnType<typeof wcFetch>> | null = null
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          result = await wcFetch('/orders', {
            after: new Date(dateFrom).toISOString(),
            before: new Date(dateTo + 'T23:59:59').toISOString(),
            status: 'completed,delivered',
            per_page: String(perPage),
            page: String(page),
            orderby: 'date',
            order: 'asc',
          })
          if (!result.error) break
        } catch (fetchErr) {
          result = { data: null, totalPages: 0, totalItems: 0, error: String(fetchErr) }
        }
        // Wait before retry (2s, 4s)
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
      const orders = result.data as WcOrder[]

      // Batch all movements for this page
      const batch: {
        type: 'SALE_DISPATCH'
        productId: string
        qty: number
        note: string
        referenceType: string
        referenceId: string
        createdAt: Date
      }[] = []

      for (const order of orders) {
        const wcOrderRef = `wc-${order.id}`
        if (alreadyImported.has(wcOrderRef)) { progress.ordersSkipped++; continue }

        const orderDate = new Date(order.date_created)

        for (const item of order.line_items) {
          if (!item.sku || item.quantity <= 0) continue
          const productId = skuToId.get(item.sku.toUpperCase())
          if (!productId) { progress.itemsSkipped++; continue }

          batch.push({
            type: 'SALE_DISPATCH',
            productId,
            qty: item.quantity,
            note: `Historical WC import — Order #${order.number}`,
            referenceType: 'WcHistorical',
            referenceId: wcOrderRef,
            createdAt: orderDate,
          })
        }
        progress.ordersProcessed++
        // Mark as imported so re-runs within same job don't duplicate
        alreadyImported.add(wcOrderRef)
      }

      if (batch.length > 0) {
        const created = await db.stockMovement.createMany({ data: batch })
        progress.movementsCreated += created.count
      }

      page++
    }

    progress.status = 'done'
    const parts: string[] = []
    if (progress.ordersProcessed > 0) parts.push(`Imported ${progress.ordersProcessed} orders, created ${progress.movementsCreated} demand records.`)
    if (progress.ordersSkipped > 0) parts.push(`${progress.ordersSkipped} orders already imported.`)
    if (progress.itemsSkipped > 0) parts.push(`${progress.itemsSkipped} line items skipped (no matching SKU).`)
    if (progress.errors.length > 0) parts.push(`${progress.errors.length} page errors.`)
    if (parts.length === 0) parts.push('No new orders found.')
    progress.message = parts.join(' ')
    await saveProgress(progress)

    await logActivity({
      entityType: 'IMPORT', tag: 'import', action: 'imported',
      description: `Imported ${progress.ordersProcessed} historical WC orders, ${progress.movementsCreated} demand records`,
      resolveUser: false,
    })

    notify({
      type: 'success',
      title: 'Historical Import Complete',
      message: `Imported ${progress.ordersProcessed} orders, created ${progress.movementsCreated} demand records.`,
      actionUrl: '/analytics/forecast',
    })
  } catch (e) {
    progress.status = 'error'
    progress.message = String(e)
    progress.errors.push(String(e))
    await saveProgress(progress)

    await logActivity({
      entityType: 'IMPORT', tag: 'import', action: 'imported', level: 'ERROR',
      description: `Failed to import historical WC orders: ${String(e)}`,
      resolveUser: false,
    })

    notify({
      type: 'error',
      title: 'Historical Import Failed',
      message: String(e),
      actionUrl: '/analytics/forecast',
    })
  }
}
