/**
 * Bidirectional product sync between WooCommerce and IMS.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { decryptSecret } from '@/lib/secrets'
import { getSettingValue } from '@/lib/settings-store'
import { wcFetch, wcPut } from '../api'
import { WC_SETTINGS_VERSION_KEY, WC_SYNC_ADVISORY_LOCK_KEY } from '../sync-lock'
import type { ConnectorCredentials } from '../../types'
import {
  deriveLegacyActiveFromLifecycleStatus,
  deriveLifecycleStatusFromWooStatus,
  deriveWooStatusFromLifecycleStatus,
} from '@/lib/products/lifecycle'
import type { Prisma } from '@/app/generated/prisma/client'
import type { WcFullProduct, WcVariation, SyncResult } from './types'

const WEBHOOK_PRIMARY_FRESH_MS = 24 * 60 * 60 * 1000

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

async function snapshotProductSyncContext(): Promise<{
  creds: ConnectorCredentials | null
  syncVersion: string
}> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_SYNC_ADVISORY_LOCK_KEY})`
    const rows = await tx.setting.findMany({
      where: {
        key: { in: ['wc_url', 'wc_consumer_key', 'wc_consumer_secret', WC_SETTINGS_VERSION_KEY] },
      },
    })
    const map = new Map(rows.map((row) => [row.key, row.value]))
    const url = map.get('wc_url')
    const key = map.get('wc_consumer_key')
    const secret = map.get('wc_consumer_secret')
    const syncVersion = map.get(WC_SETTINGS_VERSION_KEY) ?? '0'
    const creds: ConnectorCredentials | null = url && key && secret
      ? { url: url.replace(/\/$/, ''), key, secret: decryptSecret(secret) }
      : null
    return { creds, syncVersion }
  })
}

async function ensureWcSettingsVersionMatches(expectedVersion: string): Promise<{
  ok: true
} | {
  ok: false
  currentVersion: string
}> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_SYNC_ADVISORY_LOCK_KEY})`
    const row = await tx.setting.findUnique({ where: { key: WC_SETTINGS_VERSION_KEY } })
    const currentVersion = row?.value ?? '0'
    if (currentVersion !== expectedVersion) {
      return { ok: false as const, currentVersion }
    }
    return { ok: true as const }
  })
}

async function persistMappingIfVersionMatches(
  productId: string,
  externalId: number,
  expectedVersion: string,
): Promise<
  | { ok: true }
  | { ok: false; reason: 'version_changed' }
  | { ok: false; reason: 'error'; error: string }
> {
  try {
    return await db.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_SYNC_ADVISORY_LOCK_KEY})`
      const row = await tx.setting.findUnique({ where: { key: WC_SETTINGS_VERSION_KEY } })
      const currentVersion = row?.value ?? '0'
      if (currentVersion !== expectedVersion) {
        return { ok: false as const, reason: 'version_changed' as const }
      }
      await tx.product.update({
        where: { id: productId },
        data: { externalProductId: BigInt(externalId) },
      })
      return { ok: true as const }
    })
  } catch (error) {
    return { ok: false as const, reason: 'error' as const, error: String(error) }
  }
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

    await db.shoppingSyncLog.create({
      data: {
        direction: 'FROM_CONNECTOR',
        status: 'SYNCED',
        entityType: 'Product',
        entityId: existing?.id,
        externalId: wcProduct.id,
        syncedAt: new Date(),
      },
    })

    return { success: true }
  } catch (e) {
    await db.shoppingSyncLog.create({
      data: {
        direction: 'FROM_CONNECTOR',
        status: 'FAILED',
        entityType: 'Product',
        externalId: wcProduct.id,
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
    const { creds, syncVersion } = await snapshotProductSyncContext()
    if (!creds) {
      return { success: false, error: 'WooCommerce not configured. Set wc_url, wc_consumer_key, wc_consumer_secret in Settings.' }
    }
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
        externalProductId: true,
        lifecycleStatus: true,
        parent: { select: { sku: true, externalProductId: true } },
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

    let externalProductId: number
    let putPath: string

    if (product.type === 'VARIANT') {
      const parentWcId = product.parent?.externalProductId != null ? Number(product.parent.externalProductId) : null
      if (!parentWcId || !product.parent?.sku) {
        return { success: false, error: `Variant ${product.sku} is missing a WooCommerce parent mapping` }
      }

      let variationId = product.externalProductId != null ? Number(product.externalProductId) : null
      if (!variationId) {
        const { data, error } = await wcFetch(
          `/products/${parentWcId}/variations`,
          { sku: product.sku, per_page: '100' },
          creds,
        )
        if (error) return { success: false, error }
        const variations = data as WcVariation[]
        const matches = variations.filter((variation) => variation.sku === product.sku)
        if (matches.length !== 1) {
          return { success: false, error: `Expected exactly one WooCommerce variation for SKU ${product.sku} under ${product.parent.sku}` }
        }
        variationId = matches[0].id
        const persisted = await persistMappingIfVersionMatches(product.id, variationId, syncVersion)
        if (!persisted.ok) {
          return {
            success: false,
            error: persisted.reason === 'version_changed'
              ? `WooCommerce settings changed while resolving ${product.sku}`
              : persisted.error,
          }
        }
      } else {
        const { data, error } = await wcFetch(`/products/${parentWcId}/variations/${variationId}`, {}, creds)
        if (error) return { success: false, error }
        const variation = data as WcVariation
        if (variation.sku !== product.sku) {
          return { success: false, error: `Cached WooCommerce variation ${variationId} no longer matches SKU ${product.sku}` }
        }
      }

      externalProductId = variationId
      putPath = `/products/${parentWcId}/variations/${variationId}`
    } else {
      let resolvedId = product.externalProductId != null ? Number(product.externalProductId) : null
      if (resolvedId != null) {
        const { data, error } = await wcFetch(`/products/${resolvedId}`, {}, creds)
        if (error) return { success: false, error }
        const wcProduct = data as WcFullProduct
        if (wcProduct.sku !== product.sku) {
          return { success: false, error: `Cached WooCommerce product ${resolvedId} no longer matches SKU ${product.sku}` }
        }
      } else {
        const { data, error } = await wcFetch('/products', { sku: product.sku, per_page: '2' }, creds)
        if (error) return { success: false, error }

        const wcProducts = (data as WcFullProduct[]).filter((wcProduct) => wcProduct.sku === product.sku)
        if (wcProducts.length !== 1) {
          return {
            success: false,
            error: wcProducts.length === 0
              ? `No WC product found for SKU ${product.sku}`
              : `Ambiguous WC products found for SKU ${product.sku}`,
          }
        }
        resolvedId = wcProducts[0].id
        const persisted = await persistMappingIfVersionMatches(product.id, resolvedId, syncVersion)
        if (!persisted.ok) {
          return {
            success: false,
            error: persisted.reason === 'version_changed'
              ? `WooCommerce settings changed while resolving ${product.sku}`
              : persisted.error,
          }
        }
      }

      externalProductId = resolvedId
      putPath = `/products/${externalProductId}`
    }

    const versionCheck = await ensureWcSettingsVersionMatches(syncVersion)
    if (!versionCheck.ok) {
      return {
        success: false,
        error: `WooCommerce settings changed while syncing ${product.sku}`,
      }
    }

    const { error: putError } = await wcPut(putPath, updateData, creds)
    if (putError) return { success: false, error: putError }

    await db.shoppingSyncLog.create({
      data: {
        direction: 'TO_CONNECTOR',
        status: 'SYNCED',
        entityType: 'Product',
        entityId: productId,
        externalId: externalProductId,
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

export async function syncAllWcProducts(
  opts: { mode?: 'poll' | 'reconcile' | 'manual_reconcile' } = {},
): Promise<SyncResult> {
  const result: SyncResult = { synced: 0, skipped: 0, errors: [] }
  const mode = opts.mode ?? 'poll'
  const cursorKey = mode === 'poll' ? 'last_wc_product_sync_at' : 'last_wc_product_reconcile_at'

  // Only fetch products modified since last sync (incremental)
  const lastSyncSetting = await db.setting.findUnique({ where: { key: cursorKey } })
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
    where: { key: cursorKey },
    create: { key: cursorKey, value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  })

  if (result.synced > 0) {
    await logActivity({
      entityType: 'SYNC', action: 'product_sync', tag: 'sync', level: 'INFO',
      description: `WC product ${mode === 'poll' ? 'poll' : 'reconciliation'}: ${result.synced} synced, ${result.skipped} skipped`,
      resolveUser: false,
    })
  }

  return result
}
export async function isWcProductWebhookPrimaryActive(): Promise<boolean> {
  const [secret, lastReceived] = await Promise.all([
    getSettingValue('wc_webhook_secret'),
    db.setting.findUnique({ where: { key: 'wc_product_webhook_last_received_at' } }),
  ])

  if (!secret || !lastReceived?.value) return false
  const ts = Date.parse(lastReceived.value)
  if (!Number.isFinite(ts)) return false
  return (Date.now() - ts) <= WEBHOOK_PRIMARY_FRESH_MS
}
