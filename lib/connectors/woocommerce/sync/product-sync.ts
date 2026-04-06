/**
 * Bidirectional product sync between WooCommerce and IMS.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { wcFetch, wcPut } from '../api'
import type { WcFullProduct, SyncResult } from './types'

// ---------------------------------------------------------------------------
// WC → IMS product sync
// ---------------------------------------------------------------------------

export async function syncWcProductToIms(wcProduct: WcFullProduct): Promise<{ success: boolean; error?: string }> {
  try {
    if (!wcProduct.sku) return { success: true } // skip products without SKU

    const existing = await db.product.findFirst({ where: { sku: wcProduct.sku } })

    if (existing) {
      // Update existing product
      await db.product.update({
        where: { id: existing.id },
        data: {
          name: wcProduct.name,
          description: wcProduct.short_description || wcProduct.description || undefined,
          imageUrl: wcProduct.images?.[0]?.src ?? existing.imageUrl,
        },
      })
    } else {
      // Create new product
      await db.product.create({
        data: {
          sku: wcProduct.sku,
          name: wcProduct.name,
          description: wcProduct.short_description || wcProduct.description || null,
          imageUrl: wcProduct.images?.[0]?.src ?? null,
          barcode: wcProduct.barcode ?? null,
          weight: wcProduct.weight ? parseFloat(wcProduct.weight) : null,
          active: wcProduct.status === 'publish',
        },
      })
    }

    await db.wcSyncLog.create({
      data: {
        direction: 'FROM_WC',
        status: 'SYNCED',
        entityType: 'Product',
        entityId: existing?.id,
        wcId: wcProduct.id,
        syncedAt: new Date(),
      },
    })

    return { success: true }
  } catch (e) {
    await db.wcSyncLog.create({
      data: {
        direction: 'FROM_WC',
        status: 'FAILED',
        entityType: 'Product',
        wcId: wcProduct.id,
        errorMessage: String(e),
        syncedAt: new Date(),
      },
    })
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// IMS → WC product push
// ---------------------------------------------------------------------------

export async function pushImsProductToWc(productId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const product = await db.product.findUnique({
      where: { id: productId },
      select: { sku: true, name: true, description: true, salesPriceGbp: true, salePriceGbp: true },
    })
    if (!product?.sku) return { success: false, error: 'Product has no SKU' }

    // Find WC product by SKU
    const { data, error } = await wcFetch('/products', { sku: product.sku, per_page: '1' })
    if (error) return { success: false, error }

    const wcProducts = data as WcFullProduct[]
    if (!wcProducts.length) return { success: false, error: `No WC product found for SKU ${product.sku}` }

    const wcProductId = wcProducts[0].id

    // Push updates
    const updateData: Record<string, unknown> = { name: product.name }
    if (product.description) updateData.description = product.description
    if (product.salesPriceGbp) updateData.regular_price = String(Number(product.salesPriceGbp))
    if (product.salePriceGbp) updateData.sale_price = String(Number(product.salePriceGbp))

    const { error: putError } = await wcPut(`/products/${wcProductId}`, updateData)
    if (putError) return { success: false, error: putError }

    await db.wcSyncLog.create({
      data: {
        direction: 'TO_WC',
        status: 'SYNCED',
        entityType: 'Product',
        entityId: productId,
        wcId: wcProductId,
        payload: JSON.parse(JSON.stringify(updateData)),
        syncedAt: new Date(),
      },
    })

    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Bulk product sync (WC → IMS)
// ---------------------------------------------------------------------------

export async function syncAllWcProducts(): Promise<SyncResult> {
  const result: SyncResult = { synced: 0, skipped: 0, errors: [] }

  let page = 1
  let totalPages = 1

  while (page <= totalPages) {
    const { data, totalPages: tp, error } = await wcFetch('/products', {
      per_page: '100',
      page: String(page),
      status: 'publish',
    })
    if (error) { result.errors.push(error); break }

    totalPages = tp
    const products = data as WcFullProduct[]

    for (const product of products) {
      if (!product.sku) { result.skipped++; continue }
      const r = await syncWcProductToIms(product)
      if (r.success) result.synced++
      else result.errors.push(`SKU ${product.sku}: ${r.error}`)
    }

    page++
  }

  // Update last sync timestamp
  await db.setting.upsert({
    where: { key: 'last_wc_product_sync_at' },
    create: { key: 'last_wc_product_sync_at', value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  })

  if (result.synced > 0) {
    logActivity({
      entityType: 'SYNC', action: 'product_sync', tag: 'sync', level: 'INFO',
      description: `WC product sync: ${result.synced} synced, ${result.skipped} skipped`,
    })
  }

  return result
}
