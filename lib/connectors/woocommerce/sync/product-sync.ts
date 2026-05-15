/**
 * Bidirectional product sync between WooCommerce and IMS.
 */

import { after } from 'next/server'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { decryptSettingValue } from '@/lib/security/encrypted-settings'
import { getSettingValue } from '@/lib/settings-store'
import { wcFetch, wcPut } from '../api'
import { WC_SETTINGS_VERSION_KEY, WC_SYNC_ADVISORY_LOCK_KEY } from '../sync-lock'
import { validateWooCommerceBaseUrl } from '../url-safety'
import type { ConnectorCredentials } from '../../types'
import { toIsoCountryCode } from '@/lib/countries'
import {
  deriveLegacyActiveFromLifecycleStatus,
  deriveLifecycleStatusFromWooStatus,
  deriveWooStatusFromLifecycleStatus,
} from '@/lib/products/lifecycle'
import type { Prisma } from '@/app/generated/prisma/client'
import type { WcFullProduct, WcVariation, SyncResult } from './types'

const WEBHOOK_PRIMARY_FRESH_MS = 24 * 60 * 60 * 1000
const MANUAL_PRODUCT_SYNC_JOB_KEY = 'manual_wc_product_sync_job'
const MANUAL_PRODUCT_SYNC_STALE_MS = 30 * 60 * 1000

export type ManualProductSyncProgress = {
  status: 'idle' | 'running' | 'done' | 'error'
  message: string
  productsProcessed: number
  productsImported: number
  productsSkipped: number
  totalProducts: number
  currentPage: number
  totalPages: number
  errors: string[]
  startedAt?: string
  updatedAt?: string
}

type ProductSyncProgressSnapshot = {
  message: string
  processed: number
  synced: number
  skipped: number
  totalProducts: number
  currentPage: number
  totalPages: number
  errors: string[]
}

const INITIAL_MANUAL_PRODUCT_SYNC_PROGRESS: ManualProductSyncProgress = {
  status: 'idle',
  message: '',
  productsProcessed: 0,
  productsImported: 0,
  productsSkipped: 0,
  totalProducts: 0,
  currentPage: 0,
  totalPages: 0,
  errors: [],
}

async function saveManualProductSyncProgress(progress: ManualProductSyncProgress) {
  await db.setting.upsert({
    where: { key: MANUAL_PRODUCT_SYNC_JOB_KEY },
    create: { key: MANUAL_PRODUCT_SYNC_JOB_KEY, value: JSON.stringify(progress) },
    update: { value: JSON.stringify(progress) },
  })
}

export async function getManualWcProductSyncProgress(): Promise<ManualProductSyncProgress> {
  const row = await db.setting.findUnique({ where: { key: MANUAL_PRODUCT_SYNC_JOB_KEY } })
  if (!row?.value) return INITIAL_MANUAL_PRODUCT_SYNC_PROGRESS
  try {
    return JSON.parse(row.value) as ManualProductSyncProgress
  } catch {
    return INITIAL_MANUAL_PRODUCT_SYNC_PROGRESS
  }
}

export async function startManualWcProductSync(): Promise<void> {
  const current = await getManualWcProductSyncProgress()
  if (current.status === 'running') {
    const updatedAt = current.updatedAt ? Date.parse(current.updatedAt) : NaN
    if (Number.isFinite(updatedAt) && Date.now() - updatedAt < MANUAL_PRODUCT_SYNC_STALE_MS) return
  }

  const progress: ManualProductSyncProgress = {
    ...INITIAL_MANUAL_PRODUCT_SYNC_PROGRESS,
    status: 'running',
    message: 'Preparing WooCommerce product import...',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await saveManualProductSyncProgress(progress)

  after(() => runManualWcProductSync(progress).catch(async (error) => {
    progress.status = 'error'
    progress.message = error instanceof Error ? error.message : String(error)
    progress.errors = [...progress.errors, progress.message]
    await saveManualProductSyncProgress(progress)
  }))
}

async function runManualWcProductSync(progress: ManualProductSyncProgress) {
  const result = await syncAllWcProducts({
    mode: 'manual_reconcile',
    onProgress: async (snapshot) => {
      progress.status = 'running'
      progress.message = snapshot.message
      progress.productsProcessed = snapshot.processed
      progress.productsImported = snapshot.synced
      progress.productsSkipped = snapshot.skipped
      progress.totalProducts = snapshot.totalProducts
      progress.currentPage = snapshot.currentPage
      progress.totalPages = snapshot.totalPages
      progress.errors = snapshot.errors
      progress.updatedAt = new Date().toISOString()
      await saveManualProductSyncProgress(progress)
    },
  })

  progress.status = 'done'
  progress.productsProcessed = Math.max(progress.productsProcessed, result.synced + result.skipped)
  progress.productsImported = result.synced
  progress.productsSkipped = result.skipped
  progress.errors = result.errors
  progress.updatedAt = new Date().toISOString()

  const totalProducts = progress.totalProducts || (result.synced + result.skipped)
  if (totalProducts > 0) {
    const parts = [`Imported ${result.synced} of ${totalProducts} product(s)`]
    if (result.skipped > 0) parts.push(`${result.skipped} skipped`)
    if (result.errors.length > 0) parts.push(`${result.errors.length} errors`)
    progress.message = parts.join(' · ')
  } else if (result.errors.length > 0) {
    progress.message = `WooCommerce product import failed: ${result.errors[0]}`
  } else {
    progress.message = 'No WooCommerce products found'
  }

  await saveManualProductSyncProgress(progress)
}

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

function asTrimmedString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return null
}

/** Parse a WC numeric-ish value, returning null if empty/NaN. */
function parseNum(val: unknown): number | null {
  const normalized = asTrimmedString(val)
  if (!normalized) return null
  const n = parseFloat(normalized)
  return Number.isNaN(n) ? null : n
}

function getFirstImageUrl(images: unknown): string | null {
  if (!Array.isArray(images)) return null
  for (const image of images) {
    if (image && typeof image === 'object' && 'src' in image) {
      const src = asTrimmedString((image as { src?: unknown }).src)
      if (src) return src
    }
  }
  return null
}

function normalizeAttributeOptions(options: unknown): string[] {
  if (!Array.isArray(options)) return []
  return options
    .map((option) => asTrimmedString(option))
    .filter((option): option is string => Boolean(option))
}

/** Search WC product attributes array by name (case-insensitive, ignores underscores/spaces), return first option value. */
function getWcAttribute(
  attrs: WcFullProduct['attributes'] | undefined,
  ...names: string[]
): string | null {
  if (!Array.isArray(attrs)) return null
  const normalise = (s: string) => s.toLowerCase().replace(/[_\s]+/g, '')
  const targets = names.map(normalise)
  const attr = attrs.find((a) => {
    const name = asTrimmedString(a?.name)
    return name ? targets.includes(normalise(name)) : false
  })
  return attr ? normalizeAttributeOptions(attr.options)[0] ?? null : null
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
    const validatedUrl = url ? validateWooCommerceBaseUrl(url) : null
    const creds: ConnectorCredentials | null = validatedUrl?.ok && key && secret
      ? { url: validatedUrl.normalizedUrl, key, secret: decryptSettingValue('wc_consumer_secret', secret) }
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
    const sku = asTrimmedString(wcProduct.sku)
    if (!sku) return { success: true } // skip products without SKU

    const existing = await db.product.findFirst({ where: { sku } })

    // --- Shared field extraction ---
    const description = stripHtml(wcProduct.short_description || wcProduct.description || '')
    const salesPriceBase = parseNum(wcProduct.regular_price)
    const salePriceBase = parseNum(wcProduct.sale_price)
    const weight = parseNum(wcProduct.weight)
    const depthCm = parseNum(wcProduct.dimensions?.length)   // WC "length" = depth
    const widthCm = parseNum(wcProduct.dimensions?.width)
    const heightCm = parseNum(wcProduct.dimensions?.height)
    const imageUrl = getFirstImageUrl(wcProduct.images)
    const gtin = asTrimmedString(wcProduct.global_unique_id)

    // Customs fields from WC attributes
    const hsCodeAttr = asTrimmedString(getWcAttribute(wcProduct.attributes, 'hs_code', 'hs code', 'hscode'))
    const originAttr = getWcAttribute(wcProduct.attributes, 'country_of_origin', 'Country of Origin', 'coo')
    const originIso = toIsoCountryCode(originAttr)

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
        externalProductId: BigInt(wcProduct.id),
      }

      // Prices — only set on non-VARIABLE products (VARIABLE shows min-max from variants)
      if (productType !== 'VARIABLE') {
        if (salesPriceBase !== null) updateData.salesPriceBase = salesPriceBase
        if (salePriceBase !== null) updateData.salePriceBase = salePriceBase
      } else {
        updateData.salesPriceBase = null
        updateData.salePriceBase = null
      }

      // GTIN — only set if IMS field is currently null/empty
      if (gtin && !existing.barcode) updateData.barcode = gtin

      // Customs — only set if IMS field is currently null/empty
      if (hsCodeAttr && !existing.hsCode) updateData.hsCode = hsCodeAttr
      if (originIso && !existing.countryOfOrigin) updateData.countryOfOrigin = originIso

      const saved = await db.product.update({ where: { id: existing.id }, data: updateData })
      const syncedProductId = saved.id

      // --- Variations (VARIABLE products) ---
      if (wcProduct.type === 'variable' && wcProduct.variations?.length > 0) {
        await syncVariations(wcProduct.id, syncedProductId, wcProduct.name)
      }

      // --- Product options (variation attributes) ---
      if (Array.isArray(wcProduct.attributes) && wcProduct.attributes.length) {
        const variationAttrs = wcProduct.attributes.filter((a) => a.variation)
        for (const attr of variationAttrs) {
          const attrName = asTrimmedString(attr.name)
          const optionValues = normalizeAttributeOptions(attr.options)
          if (!attrName || optionValues.length === 0) continue
          await db.productOption.upsert({
            where: {
              productId_name: { productId: syncedProductId, name: attrName },
            },
            create: {
              productId: syncedProductId,
              name: attrName,
              values: optionValues.join(','),
              sortOrder: attr.position,
            },
            update: {
              values: optionValues.join(','),
              sortOrder: attr.position,
            },
          })
        }
      }

      await db.shoppingSyncLog.create({
        data: {
          direction: 'FROM_CONNECTOR',
          status: 'SYNCED',
          entityType: 'Product',
          entityId: syncedProductId,
          externalId: String(wcProduct.id),
          syncedAt: new Date(),
        },
      })

      return { success: true }
    } else {
      // Create new product
      const created = await db.product.create({
        data: {
          sku,
          name: wcProduct.name,
          description: description || null,
          imageUrl,
          barcode: gtin,
          weight,
          depthCm,
          widthCm,
          heightCm,
          salesPriceBase: productType === 'VARIABLE' ? null : salesPriceBase,
          salePriceBase: productType === 'VARIABLE' ? null : salePriceBase,
          active,
          lifecycleStatus,
          type: productType,
          hsCode: hsCodeAttr,
          countryOfOrigin: originIso,
          externalProductId: BigInt(wcProduct.id),
        },
      })

      // --- Variations (VARIABLE products) ---
      if (wcProduct.type === 'variable' && wcProduct.variations?.length > 0) {
        await syncVariations(wcProduct.id, created.id, wcProduct.name)
      }

      // --- Product options (variation attributes) ---
      if (Array.isArray(wcProduct.attributes) && wcProduct.attributes.length) {
        const variationAttrs = wcProduct.attributes.filter((a) => a.variation)
        for (const attr of variationAttrs) {
          const attrName = asTrimmedString(attr.name)
          const optionValues = normalizeAttributeOptions(attr.options)
          if (!attrName || optionValues.length === 0) continue
          await db.productOption.upsert({
            where: {
              productId_name: { productId: created.id, name: attrName },
            },
            create: {
              productId: created.id,
              name: attrName,
              values: optionValues.join(','),
              sortOrder: attr.position,
            },
            update: {
              values: optionValues.join(','),
              sortOrder: attr.position,
            },
          })
        }
      }

      await db.shoppingSyncLog.create({
        data: {
          direction: 'FROM_CONNECTOR',
          status: 'SYNCED',
          entityType: 'Product',
          entityId: created.id,
          externalId: String(wcProduct.id),
          syncedAt: new Date(),
        },
      })

      return { success: true }
    }
  } catch (e) {
    await db.shoppingSyncLog.create({
      data: {
        direction: 'FROM_CONNECTOR',
        status: 'FAILED',
        entityType: 'Product',
        externalId: String(wcProduct.id),
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
      const sku = asTrimmedString(v.sku)
      if (!sku) continue // skip variations without SKU

      // Build variant name: parent name + attribute values
      const attrSuffix = Array.isArray(v.attributes)
        ? v.attributes
          .map((a) => asTrimmedString(a.option))
          .filter((option): option is string => Boolean(option))
          .join(' / ')
        : ''
      const variantName = attrSuffix ? `${parentName} — ${attrSuffix}` : parentName

      const description = stripHtml(v.description || '')
      const salesPriceBase = parseNum(v.regular_price)
      const salePriceBase = parseNum(v.sale_price)
      const weight = parseNum(v.weight)
      const depthCm = parseNum(v.dimensions?.length)
      const widthCm = parseNum(v.dimensions?.width)
      const heightCm = parseNum(v.dimensions?.height)
      const imageUrl = getFirstImageUrl(v.images)
      const gtin = asTrimmedString(v.global_unique_id)

      const existing = await db.product.findFirst({ where: { sku } })

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
          externalProductId: BigInt(v.id),
        }
        if (salesPriceBase !== null) updateData.salesPriceBase = salesPriceBase
        if (salePriceBase !== null) updateData.salePriceBase = salePriceBase
        if (gtin && !existing.barcode) updateData.barcode = gtin

        await db.product.update({ where: { id: existing.id }, data: updateData })
      } else {
        await db.product.create({
          data: {
            sku,
            name: variantName,
            description: description || null,
            imageUrl,
            barcode: gtin,
            weight,
            depthCm,
            widthCm,
            heightCm,
            salesPriceBase,
            salePriceBase,
            active: deriveLegacyActiveFromLifecycleStatus(deriveLifecycleStatusFromWooStatus(v.status)),
            lifecycleStatus: deriveLifecycleStatusFromWooStatus(v.status),
            type: 'VARIANT',
            parentId: imsParentId,
            externalProductId: BigInt(v.id),
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
        salesPriceBase: true,
        salePriceBase: true,
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
    if (product.salesPriceBase) updateData.regular_price = String(Number(product.salesPriceBase))
    updateData.sale_price = product.salePriceBase ? String(Number(product.salePriceBase)) : ''

    // Only send global_unique_id if barcode is purely numeric (WC only accepts numbers)
    if (product.barcode && /^\d+$/.test(product.barcode)) {
      updateData.global_unique_id = product.barcode
    }

    let externalProductId: number
    let putPath: string

    if (product.parent?.sku) {
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
        externalId: String(externalProductId),
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
  opts: {
    mode?: 'poll' | 'reconcile' | 'manual_reconcile'
    onProgress?: (progress: ProductSyncProgressSnapshot) => Promise<void> | void
  } = {},
): Promise<SyncResult> {
  const result: SyncResult = { synced: 0, skipped: 0, errors: [] }
  const mode = opts.mode ?? 'poll'
  const onProgress = opts.onProgress
  const cursorKey = mode === 'poll' ? 'last_wc_product_sync_at' : 'last_wc_product_reconcile_at'
  let totalProducts = 0
  let processedProducts = 0

  const [lastSyncSetting, existingProduct] = await Promise.all([
    db.setting.findUnique({ where: { key: cursorKey } }),
    db.product.findFirst({ select: { id: true } }),
  ])

  // After a product reset or on a fresh install, there is nothing local to
  // reconcile against. Ignore any stale cursor and force a full import.
  const modifiedAfter = existingProduct ? (lastSyncSetting?.value ?? null) : null

  let page = 1
  let totalPages = 1

  async function reportProgress(message: string, currentPage = page) {
    if (!onProgress) return
    await onProgress({
      message,
      processed: processedProducts,
      synced: result.synced,
      skipped: result.skipped,
      totalProducts,
      currentPage,
      totalPages,
      errors: [...result.errors],
    })
  }

  await reportProgress('Preparing WooCommerce product import...', 0)

  while (page <= totalPages) {
    await reportProgress(
      `Fetching WooCommerce products... page ${page}${totalPages > 1 ? ` / ${totalPages}` : ''}`,
    )

    const params: Record<string, string> = {
      per_page: '100',
      page: String(page),
      status: 'any',
    }
    if (modifiedAfter) params.modified_after = modifiedAfter

    const { data, totalPages: tp, totalItems, error } = await wcFetch('/products', params)
    if (error) {
      result.errors.push(error)
      await reportProgress(`Failed to fetch WooCommerce products: ${error}`)
      break
    }

    totalPages = tp
    if (totalItems > 0) totalProducts = totalItems
    const products = data as WcFullProduct[]
    if (totalProducts === 0) totalProducts = products.length

    await reportProgress('Importing WooCommerce products...')

    for (const product of products) {
      if (!product.sku) {
        processedProducts++
        result.skipped++
        await reportProgress(
          totalProducts > 0
            ? `Importing WooCommerce products... ${Math.min(totalProducts, processedProducts)} / ${totalProducts} processed`
            : 'Importing WooCommerce products...',
        )
        continue
      }
      const r = await syncWcProductToIms(product)
      processedProducts++
      if (r.success) result.synced++
      else result.errors.push(`SKU ${product.sku}: ${r.error}`)

      await reportProgress(
        totalProducts > 0
          ? `Importing WooCommerce products... ${Math.min(totalProducts, processedProducts)} / ${totalProducts} processed`
          : 'Importing WooCommerce products...',
      )
    }

    page++
  }

  // Only advance the cursor after a fully clean run. Advancing after a fetch
  // or import error can permanently skip remote changes older than now.
  if (result.errors.length === 0) {
    await db.setting.upsert({
      where: { key: cursorKey },
      create: { key: cursorKey, value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    })
  }

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
