/**
 * IMS → WooCommerce stock level sync.
 * Pushes available stock from warehouses with syncToWoocommerce=true.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { wcFetch, wcPost } from '../api'
import type { WcFullProduct, SyncResult } from './types'

export async function pushStockToWc(): Promise<SyncResult> {
  const result: SyncResult = { synced: 0, skipped: 0, errors: [] }

  // Check if stock sync is enabled
  const enabled = await db.setting.findUnique({ where: { key: 'wc_stock_sync_enabled' } })
  if (enabled?.value !== 'true') return result

  // Get warehouses that sync to WC
  const warehouses = await db.warehouse.findMany({
    where: { syncToWoocommerce: true, active: true },
    select: { id: true },
  })
  if (!warehouses.length) return result

  const whIds = warehouses.map((w) => w.id)

  // Aggregate available stock per product across synced warehouses
  const stockLevels = await db.stockLevel.findMany({
    where: { warehouseId: { in: whIds } },
    select: { productId: true, quantity: true, reservedQty: true },
  })

  const stockByProduct = new Map<string, number>()
  for (const sl of stockLevels) {
    const available = Math.max(0, Number(sl.quantity) - Number(sl.reservedQty))
    stockByProduct.set(sl.productId, (stockByProduct.get(sl.productId) ?? 0) + available)
  }

  // Check if COGS sync is enabled
  const cogsSetting = await db.setting.findUnique({ where: { key: 'wc_cogs_sync_enabled' } })
  const cogsSyncEnabled = cogsSetting?.value === 'true'

  // Get products with SKUs
  const productIds = [...stockByProduct.keys()]
  const products = await db.product.findMany({
    where: { id: { in: productIds }, sku: { not: '' } },
    select: { id: true, sku: true },
  })

  // Get next FIFO cost per product (oldest layer with remaining stock)
  const cogsByProduct = new Map<string, number>()
  if (cogsSyncEnabled) {
    for (const product of products) {
      const oldestLayer = await db.costLayer.findFirst({
        where: { productId: product.id, remainingQty: { gt: 0 } },
        orderBy: { receivedAt: 'asc' },
        select: { unitCostGbp: true },
      })
      if (oldestLayer) {
        cogsByProduct.set(product.id, Number(oldestLayer.unitCostGbp))
      }
    }
  }

  // Build SKU → WC product ID map (batch lookup)
  const skuToWcId = new Map<string, number>()
  const skuList = products.map((p) => p.sku)

  // Fetch WC products in pages to build map
  for (let i = 0; i < skuList.length; i += 20) {
    const batch = skuList.slice(i, i + 20)
    for (const sku of batch) {
      const { data } = await wcFetch('/products', { sku, per_page: '1' })
      const wcProducts = data as WcFullProduct[]
      if (wcProducts?.[0]) {
        skuToWcId.set(sku, wcProducts[0].id)
      }
    }
  }

  // Batch update via WC REST API
  const updates: { id: number; stock_quantity: number; manage_stock: boolean; cost_of_goods_sold?: { values: { defined_value: string }[] } }[] = []

  for (const product of products) {
    const wcId = skuToWcId.get(product.sku)
    if (!wcId) { result.skipped++; continue }

    const available = stockByProduct.get(product.id) ?? 0
    const entry: typeof updates[number] = { id: wcId, stock_quantity: Math.floor(available), manage_stock: true }

    const cogs = cogsByProduct.get(product.id)
    if (cogs !== undefined) {
      entry.cost_of_goods_sold = { values: [{ defined_value: cogs.toFixed(2) }] }
    }

    updates.push(entry)
  }

  // Send in batches of 100 (WC API limit)
  for (let i = 0; i < updates.length; i += 100) {
    const batch = updates.slice(i, i + 100)
    const { error } = await wcPost('/products/batch', { update: batch })
    if (error) {
      result.errors.push(error)
    } else {
      result.synced += batch.length

      // Log each update
      for (const u of batch) {
        await db.wcSyncLog.create({
          data: {
            direction: 'TO_WC',
            status: 'SYNCED',
            entityType: 'StockLevel',
            wcId: u.id,
            payload: JSON.parse(JSON.stringify({ stock_quantity: u.stock_quantity })),
            syncedAt: new Date(),
          },
        })
      }
    }
  }

  // Update last sync timestamp
  await db.setting.upsert({
    where: { key: 'last_wc_stock_sync_at' },
    create: { key: 'last_wc_stock_sync_at', value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  })

  if (result.synced > 0) {
    logActivity({
      entityType: 'SYNC', action: 'stock_sync', tag: 'sync', level: 'INFO',
      description: `Pushed stock levels to WC: ${result.synced} products updated`,
    })
  }

  return result
}
