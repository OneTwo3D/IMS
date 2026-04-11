'use server'

/**
 * Generic CSV-based historical sales import (not WC-specific).
 * WooCommerce-specific import logic lives in lib/connectors/woocommerce/orders.ts.
 */

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'

export type HistoricalImportProgress = {
  status: 'idle' | 'running' | 'done' | 'error'
  message: string
  ordersProcessed: number
  movementsCreated: number
  skipped: number
  errors: string[]
}

export async function importHistoricalSalesCsv(
  formData: FormData,
): Promise<HistoricalImportProgress> {
  await requirePermission('sync')
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
    logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', description: `Imported ${result.movementsCreated} historical sales from CSV` })
    return result
  } catch (e) {
    result.status = 'error'
    result.message = String(e)
    logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', level: 'ERROR', description: `Failed to import historical sales from CSV: ${String(e)}` })
    return result
  }
}
