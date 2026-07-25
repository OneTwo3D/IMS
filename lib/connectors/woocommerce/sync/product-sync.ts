/**
 * Bidirectional product sync between WooCommerce and IMS.
 */

import { after } from 'next/server'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { decryptSettingValue } from '@/lib/security/encrypted-settings'
import { getSettingValue } from '@/lib/settings-store'
import { wcFetch, wcPut } from '../api'
import { ensureWcCategoryTreeMirrored, resolveImsCategoryId } from './category-mirror'
import { isPermanentProductSyncConflict } from './product-sync-errors'
import {
  WC_PRODUCT_WRITE_LOCK_NAMESPACE,
  WC_SETTINGS_VERSION_KEY,
  WC_SYNC_ADVISORY_LOCK_KEY,
  resolveWcProductWriteLockIds,
  wcProductWriteLockKeys,
} from '../sync-lock'
import {
  assertWcRowNotClaimedByAnotherWcObject,
  WcSkuOwnershipConflictError,
} from './product-sync-errors'
import { validateWooCommerceBaseUrl } from '../url-safety'
import type { ConnectorCredentials } from '../../types'
import { toIsoCountryCode, DEFAULT_COUNTRY_OF_ORIGIN } from '@/lib/countries'
import { invalidateStaleHsProposal } from '@/lib/trade/hs-classification-trigger'
import { clampCustomsDescription } from '@/lib/trade/customs-description'
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

/**
 * Budget for the single product-write transaction (o3d-uh2). Every remote fetch
 * happens BEFORE the transaction opens, so this covers local writes only: one
 * parent row, N variant rows and the option/sync-log rows. Prisma's 5s default is
 * too tight for a product with several hundred variations, but the ceiling stays
 * low enough that a wedged transaction cannot hold its row locks indefinitely.
 */
const PRODUCT_WRITE_TX_TIMEOUT_MS = 60_000
const PRODUCT_WRITE_TX_MAX_WAIT_MS = 15_000

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

// Trade fields (HS code / country-of-origin / customs description) are owned upstream by
// hs-code-woo, which writes authoritative WC pa_* attributes. Policy: WC wins when present.
// When WC supplies a differing value we overwrite IMS (so re-classifications/corrections
// propagate); when WC omits the attribute we preserve the existing IMS value (never null it).
// Inputs are expected already-trimmed (see asTrimmedString / toIsoCountryCode at the call
// site); an empty string is treated as absent via truthiness.
export const WC_TRADE_FIELDS = ['hsCode', 'countryOfOrigin', 'customsDescription'] as const
export type WcTradeField = (typeof WC_TRADE_FIELDS)[number]
export type WcTradeSnapshot = Record<WcTradeField, string | null>
export type WcTradeFieldChange = { field: WcTradeField; from: string | null; to: string }

export function resolveWcTradeFieldUpdates(
  existing: WcTradeSnapshot,
  incoming: WcTradeSnapshot,
): WcTradeFieldChange[] {
  const changes: WcTradeFieldChange[] = []
  for (const field of WC_TRADE_FIELDS) {
    const next = incoming[field]
    // WC value absent/empty -> preserve IMS; present and different -> overwrite.
    if (next && next !== existing[field]) {
      changes.push({ field, from: existing[field], to: next })
    }
  }
  return changes
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

type MappingFailure =
  | { ok: false; reason: 'version_changed' }
  | { ok: false; reason: 'mapping_changed' }
  | { ok: false; reason: 'error'; error: string }

function describeMappingFailure(failure: MappingFailure, sku: string): string {
  switch (failure.reason) {
    case 'version_changed':
      return `WooCommerce settings changed while resolving ${sku}`
    case 'mapping_changed':
      // Another writer claimed this product while we were resolving it against WooCommerce. The
      // push is abandoned rather than overwriting them; the next run reads the winning mapping.
      return `WooCommerce mapping for ${sku} was claimed by another sync while resolving it`
    default:
      return failure.error
  }
}

/**
 * Claim `externalProductId` for a product that had none.
 *
 * Both callers reach here only inside `if (!resolvedId)` — i.e. having read a NULL mapping and
 * then gone to WooCommerce to resolve one. That premise is re-asserted in the write itself
 * (o3d-fsi): the update matches only while the mapping is still null.
 *
 * Without that predicate this is a one-sided race against the import path. If this resolver read
 * null, then blocked behind `updateProductGuardingOwnership`, Postgres would resume this UPDATE
 * after the importer committed and overwrite the id the importer just claimed — leaving a row
 * carrying one WooCommerce object's `parentId`/`type` and another's `externalProductId`. The
 * importer's guard cannot prevent that on its own; the other writer has to stop overwriting.
 */
async function persistMappingIfVersionMatches(
  productId: string,
  externalId: number,
  expectedVersion: string,
): Promise<
  | { ok: true }
  | { ok: false; reason: 'version_changed' }
  | { ok: false; reason: 'mapping_changed' }
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
      const { count } = await tx.product.updateMany({
        // Re-affirming the same id is a no-op we still want to succeed; anything else means
        // another writer claimed this product while we were resolving it.
        where: {
          id: productId,
          OR: [{ externalProductId: null }, { externalProductId: BigInt(externalId) }],
        },
        data: { externalProductId: BigInt(externalId) },
      })
      if (count === 0) return { ok: false as const, reason: 'mapping_changed' as const }
      return { ok: true as const }
    })
  } catch (error) {
    return { ok: false as const, reason: 'error' as const, error: String(error) }
  }
}

// ---------------------------------------------------------------------------
// WC → IMS product sync
// ---------------------------------------------------------------------------

/**
 * Import one WooCommerce product (and, for VARIABLE products, all of its
 * variations) into IMS.
 *
 * Ordering contract (o3d-uh2) — the whole point of this function's shape:
 *
 *   1. Everything remote happens FIRST: the category mirror and *every*
 *      variations page are fetched and validated before a single row is
 *      written. A page that fails throws here, while the database is still
 *      untouched.
 *   2. Everything local happens inside ONE transaction: parent, variants,
 *      product options and the SYNCED log commit together or not at all.
 *      Previously the parent was written first and each variations page as it
 *      arrived, so a mid-sync failure left a parent with no variants, or a
 *      parent with a mix of freshly-written and stale variants.
 *   3. That transaction opens with a per-SKU advisory lock, so two workers
 *      importing the same product serialize instead of both taking the create
 *      branch and one dying on a P2002 (see WC_PRODUCT_WRITE_LOCK_NAMESPACE).
 *   4. Only fire-and-forget/audit side effects run after the commit.
 *
 * No HTTP call may move inside the transaction: it holds row locks, and a slow
 * WooCommerce would hold them for the length of the request.
 *
 * `permanent: true` on a failure means re-running this identical payload re-hits the identical
 * conflict, so the caller should acknowledge and report it rather than retry (o3d-gtk; see
 * product-sync-errors.ts for why only barcode/externalProductId qualify).
 *
 * NOT COVERED (o3d-mlc7): this function does not participate in the credential-rebind fence
 * described in sync-lock.ts. It takes the per-SKU locks but never WC_SYNC_ADVISORY_LOCK_KEY
 * and never checks `wc_settings_version`, so an import carrying store-A data can resume after
 * a rebind/reset and repopulate store-A external ids against store-B credentials. The o3d-fsi
 * ownership guard does not help: it treats a wiped (null) mapping as adoptable, which is the
 * same outcome the previous unconditional update produced. Pre-existing, not introduced here.
 */
export async function syncWcProductToIms(
  wcProduct: WcFullProduct,
): Promise<{ success: boolean; error?: string; permanent?: boolean }> {
  try {
    const sku = asTrimmedString(wcProduct.sku)
    if (!sku) return { success: true } // skip products without SKU

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
    const customsDescriptionRaw = asTrimmedString(getWcAttribute(wcProduct.attributes, 'customs_description', 'customs description', 'customsdescription'))
    // Cap at the downstream WMS 50-char customs-description limit on the way in,
    // so the stored value matches what we can push downstream (and never blocks
    // a WMS product create). Preserve null/blank so "WC omitted it" semantics
    // are unchanged.
    const customsDescriptionAttr = customsDescriptionRaw ? clampCustomsDescription(customsDescriptionRaw) : customsDescriptionRaw

    // Product type mapping
    const productType = wcProduct.type === 'variable' ? 'VARIABLE' : 'SIMPLE'

    // Mirror WC's category tree once per sync run (cached) and resolve this product's
    // IMS ProductCategory id — preferring the WC primary category (Yoast / Rank Math)
    // and falling back to the deepest mapped category. Fails open: if the WC categories
    // endpoint is unreachable, leave categoryId untouched.
    const wcCategories = Array.isArray(wcProduct.categories) ? wcProduct.categories : []
    let imsCategoryId: string | null | undefined
    if (wcCategories.length > 0) {
      const mirror = await ensureWcCategoryTreeMirrored()
      if (mirror) imsCategoryId = resolveImsCategoryId(wcCategories, wcProduct.meta_data, mirror)
    }

    // --- Remote reads: ALL of them, before anything is written (o3d-uh2) ---
    // A variations page that fails throws from here, leaving the catalog untouched.
    const isVariable = wcProduct.type === 'variable' && wcProduct.variations?.length > 0
    const variations = isVariable ? await fetchAllWcVariations(wcProduct.id) : []

    const variationAttrs = Array.isArray(wcProduct.attributes)
      ? wcProduct.attributes.filter((a) => a.variation)
      : []

    // Every SKU this transaction will write (o3d-fsi). Computed out here because the
    // variations are already in hand — the lock set has to be complete BEFORE the first
    // lookup, not discovered as applyVariations walks. Resolved to sorted advisory-lock
    // ids outside the transaction: hashtext is pure, so this needs no snapshot, and the
    // ids (not the SKU strings) are what has to be acquired in a single global order.
    const lockIds = await resolveWcProductWriteLockIds(
      db,
      wcProductWriteLockKeys(
        sku,
        variations.map((v) => asTrimmedString(v.sku)).filter((s): s is string => Boolean(s)),
      ),
    )

    // --- Local writes: all of them, in ONE transaction ---
    const { syncedProductId, syncedSku, tradeChanges, wasUpdate } = await db.$transaction(
      async (tx: Prisma.TransactionClient) => {
        // Serialize concurrent syncs touching ANY of these SKUs so the find-then-create
        // below cannot race another WC sync into a P2002, and so two parents sharing a
        // variation SKU cannot both take the create branch (o3d-uh2, o3d-fsi).
        //
        // Acquired one statement at a time, ascending by lock id: that order is the
        // deadlock-freedom argument, and a single set-returning statement would leave the
        // acquisition sequence up to the planner. The extra round trips are proportionate
        // — applyVariations already makes one per variant.
        for (const lockId of lockIds) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_PRODUCT_WRITE_LOCK_NAMESPACE}::int4, ${lockId}::int4)`
        }

        const existing = await tx.product.findFirst({ where: { sku } })
        // Never reassign a row another WooCommerce object already maps (o3d-fsi): the
        // update branch below overwrites type/parentId/externalProductId. Checked here so a
        // conflict fails BEFORE any write, and re-checked atomically inside the update itself.
        const parentClaimants = new Set([BigInt(wcProduct.id)])
        if (existing) assertWcRowNotClaimedByAnotherWcObject(existing, parentClaimants)
        const lifecycleStatus = deriveLifecycleStatusFromWooStatus(
          wcProduct.status,
          existing?.lifecycleStatus ?? null,
        )
        const active = deriveLegacyActiveFromLifecycleStatus(lifecycleStatus)

        let productId: string
        let productSku: string
        let changes: WcTradeFieldChange[] = []

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

          // Trade fields — hs-code-woo (WC pa_*) is authoritative: overwrite IMS when WC supplies
          // a differing value so re-classifications propagate; preserve IMS when WC omits it.
          changes = resolveWcTradeFieldUpdates(
            {
              hsCode: existing.hsCode,
              countryOfOrigin: existing.countryOfOrigin,
              customsDescription: existing.customsDescription,
            },
            { hsCode: hsCodeAttr, countryOfOrigin: originIso, customsDescription: customsDescriptionAttr },
          )
          for (const change of changes) {
            updateData[change.field] = change.to
          }

          // Category — link to mirrored IMS category for the deepest WC category
          // referenced by this product. If WC dropped all categories, clear the link.
          if (imsCategoryId !== undefined) updateData.categoryId = imsCategoryId

          await updateProductGuardingOwnership(tx, existing, parentClaimants, updateData)
          // `sku` is never in updateData — the row is resolved BY sku — so the pre-update values
          // are still current, and re-reading only to learn what we already know costs a round trip.
          productId = existing.id
          productSku = existing.sku
        } else {
          const created = await tx.product.create({
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
              countryOfOrigin: originIso ?? DEFAULT_COUNTRY_OF_ORIGIN,
              customsDescription: customsDescriptionAttr,
              externalProductId: BigInt(wcProduct.id),
              categoryId: imsCategoryId ?? null,
            },
          })
          productId = created.id
          productSku = created.sku
        }

        // --- Variations (VARIABLE products) — already fetched, just applied here ---
        if (isVariable) {
          await applyVariations(tx, variations, productId, wcProduct.name, imsCategoryId)
        }

        // --- Product options (variation attributes) ---
        await applyProductOptions(tx, productId, variationAttrs)

        await tx.shoppingSyncLog.create({
          data: {
            direction: 'FROM_CONNECTOR',
            status: 'SYNCED',
            entityType: 'Product',
            entityId: productId,
            externalId: String(wcProduct.id),
            syncedAt: new Date(),
          },
        })

        return {
          syncedProductId: productId,
          syncedSku: productSku,
          tradeChanges: changes,
          wasUpdate: Boolean(existing),
        }
      },
      { timeout: PRODUCT_WRITE_TX_TIMEOUT_MS, maxWait: PRODUCT_WRITE_TX_MAX_WAIT_MS },
    )

    // --- Post-commit side effects (never roll back, never fail the import) ---

    // If WC changed the classification-relevant fields, drop the stale HS-code proposal so the
    // sweep re-classifies (6igm.5/.7). Fire-and-forget (not after() — this runs in non-request
    // sync/cron contexts too); never affects the import result.
    if (wasUpdate) {
      void invalidateStaleHsProposal(syncedProductId).catch((err) => console.error(err))
    }

    // Audit trail when hs-code-woo overwrote IMS trade fields (bhdm.2). logActivity
    // swallows its own errors, so running it after the commit cannot strand a
    // committed import behind a FAILED log.
    if (tradeChanges.length > 0) {
      await logActivity({
        entityType: 'PRODUCT',
        entityId: syncedProductId,
        action: 'wc_trade_fields_updated',
        tag: 'sync',
        description: `WC trade fields updated on ${syncedSku}: ${tradeChanges
          .map((c) => `${c.field} ${c.from ?? '∅'}→${c.to}`)
          .join(', ')}`,
      })
    }

    return { success: true }
  } catch (e) {
    const permanent = isPermanentProductSyncConflict(e)
    await db.shoppingSyncLog.create({
      data: {
        direction: 'FROM_CONNECTOR',
        status: 'FAILED',
        entityType: 'Product',
        externalId: String(wcProduct.id),
        // Prefix the permanent ones so the sync-log view distinguishes "will never succeed,
        // needs an operator" from "retrying" without re-parsing the Prisma error (o3d-gtk).
        errorMessage: permanent ? `PERMANENT_CONFLICT: ${String(e)}` : String(e),
        syncedAt: new Date(),
      },
    })
    return { success: false, error: String(e), permanent }
  }
}

// ---------------------------------------------------------------------------
// Variation sync helpers
//
// Deliberately split in two (o3d-uh2): fetchAllWcVariations does the remote work
// and must complete before the write transaction opens; applyVariations does the
// local work and must run inside it. Merging them again would either put HTTP
// inside a lock-holding transaction or reintroduce page-by-page partial writes.
// ---------------------------------------------------------------------------

/**
 * Fetch EVERY variations page for a WC parent, or throw.
 *
 * Nothing is written here, so a failure on any page (first or last) leaves the
 * catalog exactly as it was. Propagating instead of swallowing is o3d-q1w: the
 * parent sync then records FAILED, writes no SYNCED log, and neither the webhook
 * nor the bulk cursor advances, so the reconcile re-attempts.
 */
async function fetchAllWcVariations(wcParentId: number): Promise<WcVariation[]> {
  const all: WcVariation[] = []
  let page = 1
  let totalPages = 1

  while (page <= totalPages) {
    const { data, totalPages: tp, error } = await wcFetch(
      `/products/${wcParentId}/variations`,
      { per_page: '100', page: String(page) },
    )
    if (error) {
      throw new Error(
        `Failed to fetch variations for WC product ${wcParentId} (page ${page}/${totalPages}): ${error}`,
      )
    }

    totalPages = tp
    all.push(...(data as WcVariation[]))
    page++
  }

  return all
}

/**
 * Apply `data` to `row` ONLY while its WooCommerce mapping is still one this payload may write
 * (o3d-fsi). Zero rows updated means someone reassigned it in between: an ownership conflict.
 *
 * The plain read-then-check-then-update is a TOCTOU. `assertWcRowNotClaimedByAnotherWcObject`
 * decides on a snapshot, and the SKU advisory lock only excludes other WooCommerce IMPORTS —
 * `persistMappingIfVersionMatches` and the stock-sync mapping path write `externalProductId`
 * under a DIFFERENT lock. Either could reassign the row between the read and the write, after
 * which the stale check still passes and this transaction overwrites `parentId` and
 * `externalProductId` anyway. The exposure grows down the variation loop, because every prior
 * iteration awaits its own writes.
 *
 * Folding the predicate into the UPDATE closes that window without asking every other writer to
 * join the SKU-lock protocol: the row-level lock the update takes is what makes the check and
 * the write one step.
 */
async function updateProductGuardingOwnership(
  tx: Prisma.TransactionClient,
  row: { id: string; sku: string; externalProductId?: bigint | number | string | null },
  claimants: ReadonlySet<bigint>,
  data: Record<string, unknown>,
): Promise<void> {
  const { count } = await tx.product.updateMany({
    where: {
      id: row.id,
      OR: [{ externalProductId: null }, { externalProductId: { in: [...claimants] } }],
    },
    data,
  })
  if (count > 0) return

  // Re-read so the error names the claimant that actually won the race rather than the stale one.
  const current = await tx.product.findUnique({
    where: { id: row.id },
    select: { id: true, sku: true, externalProductId: true },
  })

  // The row is GONE — deleted concurrently, not claimed by anyone. Reporting that as an ownership
  // conflict would be doubly wrong: the message would tell an operator to resolve a duplicate SKU
  // that does not exist, and o3d-gtk classifies ownership conflicts as PERMANENT.
  //
  // Throwing a plain error instead puts this in the TRANSIENT bucket, which is where a deletion
  // race belongs. Be precise about what that buys today: the product webhook currently returns
  // HTTP 200 for transient failures too, so nothing retries yet either way — o3d-i0y (PR #551) is
  // what turns the transient branch into a retryable 5xx. This classification is what makes the
  // case retry once that lands, and stops it being permanently acked in the meantime.
  if (!current) {
    throw new Error(
      `IMS product ${row.id} (SKU "${row.sku}") disappeared while importing it; retrying`,
    )
  }

  assertWcRowNotClaimedByAnotherWcObject(current, claimants)

  // Re-read says the row is writable, yet the conditional update matched nothing — it was
  // reassigned and reassigned back, or another predicate moved. Refuse rather than retry in a
  // loop: the transaction rolls back and the delivery is retried from the top.
  throw new WcSkuOwnershipConflictError({
    sku: row.sku,
    claimedByWcId: String(current.externalProductId ?? 'none'),
    incomingWcId: [...claimants].map(String).join(', '),
    imsProductId: row.id,
  })
}

/** Write already-fetched variations inside the caller's transaction. */
async function applyVariations(
  tx: Prisma.TransactionClient,
  variations: WcVariation[],
  imsParentId: string,
  parentName: string,
  // Variants inherit the parent product's resolved category. Only a real (non-null)
  // category is applied — a variant's category is never cleared by inheritance, even
  // if the parent currently resolves to no category (matches the backfill's policy).
  parentCategoryId: string | null | undefined,
) {
  const entries = variations
    .map((v) => ({ v, sku: asTrimmedString(v.sku) }))
    .filter((entry): entry is { v: WcVariation; sku: string } => Boolean(entry.sku)) // skip variations without SKU
  if (entries.length === 0) return

  // One lookup for all variant SKUs rather than one per variant. This runs inside a
  // transaction holding row locks, so every saved round trip shortens the lock hold.
  const existingRows = await tx.product.findMany({
    where: { sku: { in: entries.map((entry) => entry.sku) } },
  })
  const existingBySku = new Map(existingRows.map((row) => [row.sku, row]))

  // Every WC variation id this payload maps to each SKU (o3d-fsi). WC permits one SKU on
  // several variations of a parent, and the sync has always resolved that last-one-wins —
  // so after an import the surviving row carries the LAST duplicate's id. Checking a row
  // against only the variation currently being applied would then reject it on the very
  // next re-sync: the first duplicate would find a row mapped to its sibling. Accepting
  // the whole group keeps the quirk tolerated across repeated syncs, while still refusing
  // any id that is not in this payload at all.
  const claimantsBySku = new Map<string, Set<bigint>>()
  for (const { v, sku } of entries) {
    const claimants = claimantsBySku.get(sku) ?? new Set<bigint>()
    claimants.add(BigInt(v.id))
    claimantsBySku.set(sku, claimants)
  }

  for (const { v, sku } of entries) {
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

    const existing = existingBySku.get(sku)

    if (existing) {
      // The update below rewrites type/parentId/externalProductId, so refuse a row a
      // different WC object already owns instead of reparenting it (o3d-fsi). Checked here so
      // the conflict is raised before any write, then re-checked atomically inside the update.
      const claimants = claimantsBySku.get(sku) ?? new Set([BigInt(v.id)])
      assertWcRowNotClaimedByAnotherWcObject(existing, claimants)

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
      if (parentCategoryId != null) updateData.categoryId = parentCategoryId
      if (salesPriceBase !== null) updateData.salesPriceBase = salesPriceBase
      if (salePriceBase !== null) updateData.salePriceBase = salePriceBase
      if (gtin && !existing.barcode) updateData.barcode = gtin

      await updateProductGuardingOwnership(tx, existing, claimants, updateData)
      // Reflect the FULL applied update, not just the new mapping. A later sibling sharing this
      // SKU builds its `?? existing.x` fallbacks from this row; caching the pre-update values
      // would write the first sibling's fresh description/image straight back out again.
      existingBySku.set(sku, { ...existing, ...updateData } as typeof existing)
    } else {
      const created = await tx.product.create({
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
          ...(parentCategoryId != null ? { categoryId: parentCategoryId } : {}),
          externalProductId: BigInt(v.id),
        },
      })
      // WC can repeat a SKU across variations of one parent; keep the map authoritative
      // so the duplicate updates the row we just created instead of colliding on it.
      existingBySku.set(sku, created)
    }
  }
}

/** Write the parent's variation attributes as ProductOptions, inside the caller's transaction. */
async function applyProductOptions(
  tx: Prisma.TransactionClient,
  productId: string,
  variationAttrs: NonNullable<WcFullProduct['attributes']>,
) {
  for (const attr of variationAttrs) {
    const attrName = asTrimmedString(attr.name)
    const optionValues = normalizeAttributeOptions(attr.options)
    if (!attrName || optionValues.length === 0) continue
    await tx.productOption.upsert({
      where: {
        productId_name: { productId, name: attrName },
      },
      create: {
        productId,
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
          return { success: false, error: describeMappingFailure(persisted, product.sku) }
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
          return { success: false, error: describeMappingFailure(persisted, product.sku) }
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
