'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'

// ---------------------------------------------------------------------------
// WooCommerce API helper
// ---------------------------------------------------------------------------

async function wcFetch(path: string, params: Record<string, string> = {}): Promise<{ data: unknown; totalPages: number; error?: string }> {
  const urlSetting = await db.setting.findUnique({ where: { key: 'wc_url' } })
  const keySetting = await db.setting.findUnique({ where: { key: 'wc_consumer_key' } })
  const secretSetting = await db.setting.findUnique({ where: { key: 'wc_consumer_secret' } })

  if (!urlSetting?.value || !keySetting?.value || !secretSetting?.value) {
    return { data: null, totalPages: 0, error: 'WooCommerce not configured. Set wc_url, wc_consumer_key, wc_consumer_secret in Settings.' }
  }

  const url = new URL(`${urlSetting.value.replace(/\/$/, '')}/wp-json/wc/v3${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const auth = Buffer.from(`${keySetting.value}:${secretSetting.value}`).toString('base64')
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(30000),
  })

  if (!res.ok) {
    return { data: null, totalPages: 0, error: `WC API error: ${res.status} ${res.statusText}` }
  }

  const totalPages = parseInt(res.headers.get('x-wp-totalpages') ?? '1')
  const data = await res.json()
  return { data, totalPages }
}

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
  skipped: number
  errors: string[]
}

// ---------------------------------------------------------------------------
// Import historical WC orders as stock movements for forecasting
// ---------------------------------------------------------------------------

export async function importHistoricalWcOrders(
  dateFrom: string,
  dateTo: string,
): Promise<HistoricalImportProgress> {
  const result: HistoricalImportProgress = {
    status: 'running',
    message: 'Starting import...',
    ordersProcessed: 0,
    movementsCreated: 0,
    skipped: 0,
    errors: [],
  }

  try {
    // Build SKU → productId lookup
    const products = await db.product.findMany({ select: { id: true, sku: true } })
    const skuToId = new Map(products.map((p) => [p.sku.toUpperCase(), p.id]))

    // Check for existing historical imports to avoid duplicates
    const existingImports = await db.stockMovement.findMany({
      where: { note: { startsWith: 'Historical WC import' } },
      select: { referenceId: true },
    })
    const alreadyImported = new Set(existingImports.map((m) => m.referenceId))

    // Fetch orders page by page
    let page = 1
    let totalPages = 1

    while (page <= totalPages) {
      const { data, totalPages: tp, error } = await wcFetch('/orders', {
        after: new Date(dateFrom).toISOString(),
        before: new Date(dateTo + 'T23:59:59').toISOString(),
        status: 'completed',
        per_page: '100',
        page: String(page),
        orderby: 'date',
        order: 'asc',
      })

      if (error) {
        result.status = 'error'
        result.message = error
        result.errors.push(error)
        return result
      }

      totalPages = tp
      const orders = data as WcOrder[]

      for (const order of orders) {
        const wcOrderRef = `wc-${order.id}`

        // Skip if already imported
        if (alreadyImported.has(wcOrderRef)) {
          result.skipped++
          continue
        }

        const orderDate = new Date(order.date_created)

        for (const item of order.line_items) {
          if (!item.sku || item.quantity <= 0) continue

          const productId = skuToId.get(item.sku.toUpperCase())
          if (!productId) {
            // Product doesn't exist in IMS — skip silently (common for discontinued products)
            result.skipped++
            continue
          }

          // Create a historical SALE_DISPATCH movement
          // Note: this does NOT affect current stock levels — it's for forecasting only
          await db.stockMovement.create({
            data: {
              type: 'SALE_DISPATCH',
              productId,
              qty: item.quantity,
              note: `Historical WC import — Order #${order.number}`,
              referenceType: 'WcHistorical',
              referenceId: wcOrderRef,
              createdAt: orderDate, // use the original order date
            },
          })
          result.movementsCreated++
        }

        result.ordersProcessed++
      }

      page++
    }

    result.status = 'done'
    result.message = `Imported ${result.ordersProcessed} orders, created ${result.movementsCreated} demand records. Skipped ${result.skipped}.`

    revalidatePath('/analytics')
    return result
  } catch (e) {
    result.status = 'error'
    result.message = String(e)
    result.errors.push(String(e))
    return result
  }
}

// ---------------------------------------------------------------------------
// CSV-based historical import (alternative to WC API)
// ---------------------------------------------------------------------------

export async function importHistoricalSalesCsv(
  formData: FormData,
): Promise<HistoricalImportProgress> {
  const result: HistoricalImportProgress = {
    status: 'running', message: '', ordersProcessed: 0, movementsCreated: 0, skipped: 0, errors: [],
  }

  try {
    const file = formData.get('file') as File | null
    if (!file) { result.status = 'error'; result.message = 'No file'; return result }

    const { parseCsv } = await import('@/lib/csv')
    const rows = parseCsv(await file.text())

    const products = await db.product.findMany({ select: { id: true, sku: true } })
    const skuToId = new Map(products.map((p) => [p.sku.toUpperCase(), p.id]))

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const sku = (row['sku'] ?? row['SKU'] ?? '').trim()
      const qty = Number(row['qty'] ?? row['quantity'] ?? row['Qty'] ?? 0)
      const dateStr = row['date'] ?? row['Date'] ?? row['order_date'] ?? ''

      if (!sku || qty <= 0) { result.skipped++; continue }

      const productId = skuToId.get(sku.toUpperCase())
      if (!productId) { result.skipped++; continue }

      const orderDate = dateStr ? new Date(dateStr) : new Date()
      if (isNaN(orderDate.getTime())) {
        result.errors.push(`Row ${i + 2}: invalid date "${dateStr}"`)
        result.skipped++
        continue
      }

      await db.stockMovement.create({
        data: {
          type: 'SALE_DISPATCH',
          productId,
          qty,
          note: `Historical CSV import`,
          referenceType: 'CsvHistorical',
          referenceId: `csv-${i}`,
          createdAt: orderDate,
        },
      })
      result.movementsCreated++
    }

    result.status = 'done'
    result.message = `Created ${result.movementsCreated} demand records from CSV. Skipped ${result.skipped}.`
    revalidatePath('/analytics')
    return result
  } catch (e) {
    result.status = 'error'
    result.message = String(e)
    return result
  }
}
