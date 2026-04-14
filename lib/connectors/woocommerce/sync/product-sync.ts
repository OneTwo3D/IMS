/**
 * Bidirectional product sync between WooCommerce and IMS.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { wcFetch, wcPut } from '../api'
import {
  deriveLegacyActiveFromLifecycleStatus,
  deriveLifecycleStatusFromWooStatus,
  deriveWooStatusFromLifecycleStatus,
} from '@/lib/products/lifecycle'
import type { WcFullProduct, WcVariation, SyncResult } from './types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip HTML tags and decode common entities. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** Parse a WC numeric string, returning null if empty/NaN. */
function parseNum(val: string | undefined | null): number | null {
  if (!val) return null
  const n = parseFloat(val)
  return Number.isNaN(n) ? null : n
}

/** Search WC product attributes array by name (case-insensitive, ignores underscores/spaces), return first option value. */
function getWcAttribute(
  attrs: WcFullProduct['attributes'] | undefined,
  ...names: string[]
): string | null {
  if (!attrs) return null
  const normalise = (s: string) => s.toLowerCase().replace(/[_\s]+/g, '')
  const targets = names.map(normalise)
  const attr = attrs.find((a) => targets.includes(normalise(a.name)))
  return attr?.options?.[0] ?? null
}

// ---------------------------------------------------------------------------
// WC → IMS product sync
// ---------------------------------------------------------------------------

export async function syncWcProductToIms(wcProduct: WcFullProduct): Promise<{ success: boolean; error?: string }> {
  try {
    if (!wcProduct.sku) return { success: true } // skip products without SKU

    const existing = await db.product.findFirst({ where: { sku: wcProduct.sku } })

    // --- Shared field extraction ---
    const description = stripHtml(wcProduct.short_description || wcProduct.description || '')
    const salesPriceGbp = parseNum(wcProduct.regular_price)
    const salePriceGbp = parseNum(wcProduct.sale_price)
    const weight = parseNum(wcProduct.weight)
    const depthCm = parseNum(wcProduct.dimensions?.length)   // WC "length" = depth
    const widthCm = parseNum(wcProduct.dimensions?.width)
    const heightCm = parseNum(wcProduct.dimensions?.height)
    const imageUrl = wcProduct.images?.[0]?.src ?? null
    const gtin = wcProduct.global_unique_id?.trim() || null

    // Customs fields from WC attributes
    const hsCodeAttr = getWcAttribute(wcProduct.attributes, 'hs_code', 'hs code', 'hscode')
    const originAttr = getWcAttribute(wcProduct.attributes, 'country_of_origin', 'Country of Origin', 'coo')

    // Product type mapping
    const productType = wcProduct.type === 'variable' ? 'VARIABLE' : 'SIMPLE'
    const existingLifecycleStatus = existing?.lifecycleStatus ?? null
    const lifecycleStatus = deriveLifecycleStatusFromWooStatus(wcProduct.status, existingLifecycleStatus)
    const active = deriveLegacyActiveFromLifecycleStatus(lifecycleStatus)

    if (existing) {
      // Build update data — always sync these fields
      const updateData: Record<string, unknown> = {
        name: wcProduct.name,
        description: description || existing.description,
        imageUrl: imageUrl ?? existing.imageUrl,
        weight: weight ?? existing.weight,
        depthCm: depthCm ?? existing.depthCm,
        widthCm: widthCm ?? existing.widthCm,
        heightCm: heightCm ?? existing.heightCm,
        active,
        lifecycleStatus,
        type: productType,
      }

      // Prices — only set on non-VARIABLE products (VARIABLE shows min-max from variants)
      if (productType !== 'VARIABLE') {
        if (salesPriceGbp !== null) updateData.salesPriceGbp = salesPriceGbp
        if (salePriceGbp !== null) updateData.salePriceGbp = salePriceGbp
      } else {
        updateData.salesPriceGbp = null
        updateData.salePriceGbp = null
      }

      // GTIN — only set if IMS field is currently null/empty
      if (gtin && !existing.barcode) updateData.barcode = gtin

      // Customs — only set if IMS field is currently null/empty
      if (hsCodeAttr && !existing.hsCode) updateData.hsCode = hsCodeAttr
      if (originAttr && !existing.countryOfOrigin) updateData.countryOfOrigin = originAttr

      await db.product.update({ where: { id: existing.id }, data: updateData })
    } else {
      // Create new product
      await db.product.create({
        data: {
          sku: wcProduct.sku,
          name: wcProduct.name,
          description: description || null,
          imageUrl,
          barcode: gtin,
          weight,
          depthCm,
          widthCm,
          heightCm,
          salesPriceGbp: productType === 'VARIABLE' ? null : salesPriceGbp,
          salePriceGbp: productType === 'VARIABLE' ? null : salePriceGbp,
          active,
          lifecycleStatus,
          type: productType,
          hsCode: hsCodeAttr,
          countryOfOrigin: originAttr,
        },
      })
    }

    // --- Variations (VARIABLE products) ---
    if (wcProduct.type === 'variable' && wcProduct.variations?.length > 0) {
      const parent = await db.product.findFirst({ where: { sku: wcProduct.sku } })
      if (parent) {
        await syncVariations(wcProduct.id, parent.id, wcProduct.name)
      }
    }

    // --- Product options (variation attributes) ---
    if (wcProduct.attributes?.length) {
      const parent = existing ?? await db.product.findFirst({ where: { sku: wcProduct.sku } })
      if (parent) {
        const variationAttrs = wcProduct.attributes.filter((a) => a.variation)
        for (const attr of variationAttrs) {
          await db.productOption.upsert({
            where: {
              productId_name: { productId: parent.id, name: attr.name },
            },
            create: {
              productId: parent.id,
              name: attr.name,
              values: attr.options.join(','),
              sortOrder: attr.position,
            },
            update: {
              values: attr.options.join(','),
              sortOrder: attr.position,
            },
          })
        }
      }
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
// Variation sync helper
// ---------------------------------------------------------------------------

async function syncVariations(
  wcParentId: number,
  imsParentId: string,
  parentName: string,
) {
  let page = 1
  let totalPages = 1

  while (page <= totalPages) {
    const { data, totalPages: tp, error } = await wcFetch(
      `/products/${wcParentId}/variations`,
      { per_page: '100', page: String(page) },
    )
    if (error) break

    totalPages = tp
    const variations = data as WcVariation[]

    for (const v of variations) {
      if (!v.sku) continue // skip variations without SKU

      // Build variant name: parent name + attribute values
      const attrSuffix = v.attributes?.map((a) => a.option).filter(Boolean).join(' / ')
      const variantName = attrSuffix ? `${parentName} — ${attrSuffix}` : parentName

      const description = stripHtml(v.description || '')
      const salesPriceGbp = parseNum(v.regular_price)
      const salePriceGbp = parseNum(v.sale_price)
      const weight = parseNum(v.weight)
      const depthCm = parseNum(v.dimensions?.length)
      const widthCm = parseNum(v.dimensions?.width)
      const heightCm = parseNum(v.dimensions?.height)
      const imageUrl = v.images?.[0]?.src ?? null
      const gtin = v.global_unique_id?.trim() || null

      const existing = await db.product.findFirst({ where: { sku: v.sku } })

      if (existing) {
        const updateData: Record<string, unknown> = {
          name: variantName,
          description: description || existing.description,
          imageUrl: imageUrl ?? existing.imageUrl,
          weight: weight ?? existing.weight,
          depthCm: depthCm ?? existing.depthCm,
          widthCm: widthCm ?? existing.widthCm,
          heightCm: heightCm ?? existing.heightCm,
          active: deriveLegacyActiveFromLifecycleStatus(
            deriveLifecycleStatusFromWooStatus(v.status, existing.lifecycleStatus),
          ),
          lifecycleStatus: deriveLifecycleStatusFromWooStatus(v.status, existing.lifecycleStatus),
          type: 'VARIANT',
          parentId: imsParentId,
        }
        if (salesPriceGbp !== null) updateData.salesPriceGbp = salesPriceGbp
        if (salePriceGbp !== null) updateData.salePriceGbp = salePriceGbp
        if (gtin && !existing.barcode) updateData.barcode = gtin

        await db.product.update({ where: { id: existing.id }, data: updateData })
      } else {
        await db.product.create({
          data: {
            sku: v.sku,
            name: variantName,
            description: description || null,
            imageUrl,
            barcode: gtin,
            weight,
            depthCm,
            widthCm,
            heightCm,
            salesPriceGbp,
            salePriceGbp,
            active: deriveLegacyActiveFromLifecycleStatus(deriveLifecycleStatusFromWooStatus(v.status)),
            lifecycleStatus: deriveLifecycleStatusFromWooStatus(v.status),
            type: 'VARIANT',
            parentId: imsParentId,
          },
        })
      }
    }

    page++
  }
}

// ---------------------------------------------------------------------------
// IMS → WC product push
// ---------------------------------------------------------------------------

export async function pushImsProductToWc(productId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const product = await db.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        sku: true,
        name: true,
        description: true,
        salesPriceGbp: true,
        salePriceGbp: true,
        barcode: true,
        type: true,
        wcProductId: true,
        lifecycleStatus: true,
        parent: { select: { sku: true, wcProductId: true } },
      },
    })
    if (!product?.sku) return { success: false, error: 'Product has no SKU' }

    // Push updates
    const updateData: Record<string, unknown> = { name: product.name }
    updateData.status = deriveWooStatusFromLifecycleStatus(product.lifecycleStatus)
    if (product.description) updateData.description = product.description
    if (product.salesPriceGbp) updateData.regular_price = String(Number(product.salesPriceGbp))
    if (product.salePriceGbp) updateData.sale_price = String(Number(product.salePriceGbp))

    // Only send global_unique_id if barcode is purely numeric (WC only accepts numbers)
    if (product.barcode && /^\d+$/.test(product.barcode)) {
      updateData.global_unique_id = product.barcode
    }

    let wcProductId: number
    let putPath: string

    if (product.type === 'VARIANT') {
      const parentWcId = product.parent?.wcProductId != null ? Number(product.parent.wcProductId) : null
      if (!parentWcId || !product.parent?.sku) {
        return { success: false, error: `Variant ${product.sku} is missing a WooCommerce parent mapping` }
      }

      let variationId = product.wcProductId != null ? Number(product.wcProductId) : null
      if (!variationId) {
        const { data, error } = await wcFetch(`/products/${parentWcId}/variations`, { sku: product.sku, per_page: '100' })
        if (error) return { success: false, error }
        const variations = data as WcVariation[]
        const matches = variations.filter((variation) => variation.sku === product.sku)
        if (matches.length !== 1) {
          return { success: false, error: `Expected exactly one WooCommerce variation for SKU ${product.sku} under ${product.parent.sku}` }
        }
        variationId = matches[0].id
        await db.product.update({
          where: { id: product.id },
          data: { wcProductId: BigInt(variationId) },
        })
      }

      wcProductId = variationId
      putPath = `/products/${parentWcId}/variations/${variationId}`
    } else {
      const { data, error } = await wcFetch('/products', { sku: product.sku, per_page: '1' })
      if (error) return { success: false, error }

      const wcProducts = data as WcFullProduct[]
      if (!wcProducts.length) return { success: false, error: `No WC product found for SKU ${product.sku}` }

      wcProductId = wcProducts[0].id
      putPath = `/products/${wcProductId}`
    }

    const { error: putError } = await wcPut(putPath, updateData)
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

  // Only fetch products modified since last sync (incremental)
  const lastSyncSetting = await db.setting.findUnique({ where: { key: 'last_wc_product_sync_at' } })
  const modifiedAfter = lastSyncSetting?.value ?? null

  let page = 1
  let totalPages = 1

  while (page <= totalPages) {
    const params: Record<string, string> = {
      per_page: '100',
      page: String(page),
      status: 'any',
    }
    if (modifiedAfter) params.modified_after = modifiedAfter

    const { data, totalPages: tp, error } = await wcFetch('/products', params)
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
