'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
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
    const products = await db.product.findMany({ select: { id: true, sku: true } })
    const skuToId = new Map(products.map((p) => [p.sku.toUpperCase(), p.id]))

    const existingImports = await db.stockMovement.findMany({
      where: { note: { startsWith: 'Historical WC import' } },
      select: { referenceId: true },
    })
    const alreadyImported = new Set(existingImports.map((m) => m.referenceId))

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
        if (alreadyImported.has(wcOrderRef)) { result.skipped++; continue }

        const orderDate = new Date(order.date_created)

        for (const item of order.line_items) {
          if (!item.sku || item.quantity <= 0) continue
          const productId = skuToId.get(item.sku.toUpperCase())
          if (!productId) { result.skipped++; continue }

          await db.stockMovement.create({
            data: {
              type: 'SALE_DISPATCH',
              productId,
              qty: item.quantity,
              note: `Historical WC import — Order #${order.number}`,
              referenceType: 'WcHistorical',
              referenceId: wcOrderRef,
              createdAt: orderDate,
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
    logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', description: `Imported ${result.ordersProcessed} historical WC orders` })
    return result
  } catch (e) {
    result.status = 'error'
    result.message = String(e)
    result.errors.push(String(e))
    logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', level: 'ERROR', description: `Failed to import historical WC orders: ${String(e)}` })
    return result
  }
}
