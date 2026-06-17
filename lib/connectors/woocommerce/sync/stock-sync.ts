/**
 * IMS → WooCommerce stock level sync.
 * Pushes available stock from warehouses with syncToStore=true.
 *
 * SKU resolution is cached on Product.externalProductId. First run resolves
 * unknown SKUs in bounded-parallel batches and persists the mapping;
 * subsequent runs are O(1) lookups by stored id.
 *
 * Drift handling (two lines of defence):
 *   1. Preflight — before any POST, cached externalProductIds are validated in
 *      bulk against the live WooCommerce catalog. Any id whose WC product
 *      no longer carries the expected SKU (deletion/recreation, id reuse,
 *      admin edit) is cleared and excluded from this run. Nothing is ever
 *      written to the wrong product.
 *   2. Post-response reconcile — the batch POST response is still checked
 *      per item as belt-and-braces for a race between preflight and push.
 *
 * Collision handling: if two IMS products resolve to the same WC id, or
 * persistence of a freshly resolved id fails (unique constraint), the
 * conflicting products are skipped entirely for this run and logged as
 * hard errors requiring manual reconciliation.
 *
 * Lookup error propagation: `wcFetch` errors during SKU resolution are
 * NOT treated as "SKU not in catalog". They're captured and surfaced in
 * `result.errors` so a WC outage produces actionable telemetry instead
 * of looking like a catalog mismatch.
 *
 * Concurrency-safety with credential rebinds: every WC API call in this
 * module uses a credentials snapshot taken at the start of the run, and
 * every externalProductId write is persisted inside a transaction that holds
 * a shared advisory lock and re-checks `wc_settings_version`. If an
 * operator rebinds credentials or resets the cache mid-run, the version
 * check fires and the sync aborts cleanly instead of writing old-store
 * ids into the freshly wiped cache. See `../sync-lock.ts`.
 */

import { after } from 'next/server'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { decryptSettingValue } from '@/lib/security/encrypted-settings'
import type { Prisma } from '@/app/generated/prisma/client'
import { wcFetch, wcPost } from '../api'
import {
  WC_SYNC_ADVISORY_LOCK_KEY,
  WC_SETTINGS_VERSION_KEY,
} from '../sync-lock'
import { validateWooCommerceBaseUrl } from '../url-safety'
import type { ConnectorCredentials } from '../../types'
import {
  shouldForceWooZeroStock,
  WOO_STOCK_SYNC_PRODUCT_STATUSES,
} from '@/lib/products/lifecycle'
import type { WcFullProduct, StockSyncResult, WcVariation } from './types'

const SKU_LOOKUP_CONCURRENCY = 8
const WC_BATCH_SIZE = 100
const PREFLIGHT_PAGE_SIZE = 100
const WC_PUSH_BATCH_TX_TIMEOUT_MS = 15000
const WC_VARIATION_BATCH_SIZE = 100
const WC_STOCK_SYNC_CONNECTOR = 'woocommerce'

/**
 * `wcFetch` uses the connector HTTP client for DNS-safe outbound requests, but
 * transport failures still escape as thrown exceptions instead of populating the
 * `{ error }` field the partial-failure logic in this module relies on. Wrap
 * every call the sync path makes so a thrown transport error is normalized into
 * the same `{ data: null, error }` shape. Without this shim, a single network
 * blip would bypass preflight/lookup error collection and abort the entire sync
 * with no `recordAttempt()` or activity log, contradicting the module's
 * partial-failure contract.
 *
 * The `creds` argument is the sync-run credentials snapshot. Passing
 * it explicitly (instead of letting `wcFetch` re-read credentials from
 * the DB on every call) is what guarantees a single sync never hits a
 * mix of old-store and new-store endpoints when an operator rebinds
 * mid-run: every request in a run targets the store whose credentials
 * existed when the run started.
 */
async function safeWcFetch(
  path: string,
  params: Record<string, string>,
  creds: ConnectorCredentials,
): Promise<{ data: unknown; error?: string }> {
  try {
    const { data, error } = await wcFetch(path, params, creds)
    return { data, error }
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    return { data: null, error: `WC fetch threw: ${msg}` }
  }
}

async function safeWcPost(
  path: string,
  body: unknown,
  creds: ConnectorCredentials,
): Promise<{ data: unknown; error?: string }> {
  try {
    const { data, error } = await wcPost(path, body, creds)
    return { data, error }
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    return { data: null, error: `WC post threw: ${msg}` }
  }
}

/**
 * Transactional, advisory-lock-guarded snapshot of the credentials and
 * the current `wc_settings_version`. Taking the snapshot inside the
 * advisory-lock-held transaction guarantees that `saveWcCredentials` /
 * `resetWcProductIdCache` cannot interleave with the read: if they
 * commit before us, we see the already-bumped version and the new
 * credentials; if they commit after us, every subsequent
 * `persistMappingIfVersionMatches` observes the mismatch and aborts
 * the write. Reading the two settings in separate calls outside the
 * lock would create a window where we could capture old credentials
 * and the new version (or vice versa) — precisely the race Codex
 * flagged.
 */
async function snapshotSyncContext(): Promise<{
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
    const map = new Map(rows.map((r) => [r.key, r.value]))
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

/**
 * Persist a resolved externalProductId, but only if the global settings
 * version still matches the value captured at sync start. Run inside
 * a transaction that holds the advisory lock so it is serialized
 * against any concurrent `saveWcCredentials` or `resetWcProductIdCache`.
 *
 *   - ok:true                 — wrote the mapping
 *   - reason:'version_changed' — credentials were rebound or cache was
 *                                reset mid-run; caller must abort the
 *                                whole sync to avoid further stale
 *                                writes
 *   - reason:'error'           — db.update failed (most commonly a
 *                                unique-constraint collision on
 *                                externalProductId — two IMS products
 *                                resolving to the same WC id)
 */
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
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_SYNC_ADVISORY_LOCK_KEY})`
      const row = await tx.setting.findUnique({ where: { key: WC_SETTINGS_VERSION_KEY } })
      const current = row?.value ?? '0'
      if (current !== expectedVersion) {
        return { ok: false as const, reason: 'version_changed' as const }
      }
      await tx.product.update({
        where: { id: productId },
        data: { externalProductId: BigInt(externalId) },
      })
      return { ok: true as const }
    })
  } catch (e) {
    return { ok: false as const, reason: 'error' as const, error: String(e) }
  }
}

type MappingInvalidationLog = {
  productId: string
  sku: string
  externalId: number
  reason: string
}

type MappingInvalidationOutcome =
  | { status: 'cleared'; log: MappingInvalidationLog }
  | { status: 'version_changed'; currentVersion: string }
  | { status: 'mapping_changed'; currentWcId: bigint | null }
  | { status: 'error'; error: string }

async function invalidateMappingIfVersionMatches(
  entry: { productId: string; sku: string; externalId: number },
  expectedVersion: string,
  reason: string,
): Promise<MappingInvalidationOutcome> {
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_SYNC_ADVISORY_LOCK_KEY})`
      const row = await tx.setting.findUnique({ where: { key: WC_SETTINGS_VERSION_KEY } })
      const currentVersion = row?.value ?? '0'
      if (currentVersion !== expectedVersion) {
        return { status: 'version_changed' as const, currentVersion }
      }

      const product = await tx.product.findUnique({
        where: { id: entry.productId },
        select: { externalProductId: true },
      })
      if (product?.externalProductId !== BigInt(entry.externalId)) {
        return {
          status: 'mapping_changed' as const,
          currentWcId: product?.externalProductId ?? null,
        }
      }

      await tx.product.update({
        where: { id: entry.productId },
        data: { externalProductId: null },
      })
      return {
        status: 'cleared' as const,
        log: {
          productId: entry.productId,
          sku: entry.sku,
          externalId: entry.externalId,
          reason,
        },
      }
    })
  } catch (e) {
    return { status: 'error', error: String(e) }
  }
}

type PushEntry = {
  productId: string
  sku: string
  externalId: number
  payload: {
    id: number
    stock_quantity: number
    manage_stock: boolean
    cost_of_goods_sold?: { values: { defined_value: string }[] }
  }
}

type VariantPushEntry = PushEntry & {
  parentWcId: number
}

type EffectiveTarget = {
  externalId: number
  parentWcId?: number
}

type CandidateProduct = {
  id: string
  sku: string
  type: 'SIMPLE' | 'VARIANT' | 'KIT' | 'BOM'
  lifecycleStatus: 'DRAFT' | 'ACTIVE' | 'EOL' | 'ARCHIVED'
  externalProductId: bigint | null
  parent: { sku: string } | null
  productComponents: {
    componentId: string
    qty: Prisma.Decimal
    component: {
      type: 'SIMPLE' | 'VARIABLE' | 'VARIANT' | 'KIT' | 'BOM' | 'NON_INVENTORY'
      lifecycleStatus: 'DRAFT' | 'ACTIVE' | 'EOL' | 'ARCHIVED'
    }
  }[]
}

function isVariationCandidate(product: Pick<CandidateProduct, 'parent'>): boolean {
  return product.parent != null
}

export type StockPushProgressSnapshot = { processed: number; synced: number; total: number }

type PushStockOptions = {
  productIds?: string[]
  forceProductIds?: string[]
  forceAll?: boolean
  source?: string
  /** Called before the first batch (with the total) and after every batch. */
  onProgress?: (snapshot: StockPushProgressSnapshot) => void | Promise<void>
}

async function persistSuccessfulPushState(
  tx: Prisma.TransactionClient,
  entries: Array<PushEntry | VariantPushEntry>,
): Promise<void> {
  const pushedAt = new Date()
  for (const entry of entries) {
    await tx.stockSyncState.upsert({
      where: {
        connector_productId: {
          connector: WC_STOCK_SYNC_CONNECTOR,
          productId: entry.productId,
        },
      },
      create: {
        connector: WC_STOCK_SYNC_CONNECTOR,
        productId: entry.productId,
        lastPushedQty: entry.payload.stock_quantity,
        lastPushedAt: pushedAt,
        lastPushedRemoteId: String(entry.externalId),
      },
      update: {
        lastPushedQty: entry.payload.stock_quantity,
        lastPushedAt: pushedAt,
        lastPushedRemoteId: String(entry.externalId),
      },
    })
  }
}

type WcBatchUpdateItem = {
  id: number
  sku?: string
  error?: { code?: string; message?: string }
}

type BatchReconcileOutcome = {
  successEntries: PushEntry[]
  skipped: number
  errors: string[]
  invalidations: MappingInvalidationLog[]
}

async function invalidateMappingInLockedTx(
  tx: Prisma.TransactionClient,
  entry: { productId: string; sku: string; externalId: number },
  reason: string,
): Promise<
  | { status: 'cleared'; log: MappingInvalidationLog }
  | { status: 'mapping_changed'; currentWcId: bigint | null }
> {
  const product = await tx.product.findUnique({
    where: { id: entry.productId },
    select: { externalProductId: true },
  })
  if (product?.externalProductId !== BigInt(entry.externalId)) {
    return {
      status: 'mapping_changed',
      currentWcId: product?.externalProductId ?? null,
    }
  }

  await tx.product.update({
    where: { id: entry.productId },
    data: { externalProductId: null },
  })
  return {
    status: 'cleared',
    log: {
      productId: entry.productId,
      sku: entry.sku,
      externalId: entry.externalId,
      reason,
    },
  }
}

async function pushBatchWithFence(
  batch: PushEntry[],
  creds: ConnectorCredentials,
  expectedVersion: string,
): Promise<
  | { status: 'version_changed'; currentVersion: string }
  | { status: 'batch_error'; error: string }
  | { status: 'ok'; outcome: BatchReconcileOutcome }
> {
  const precheck = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_SYNC_ADVISORY_LOCK_KEY})`
    const versionRow = await tx.setting.findUnique({
      where: { key: WC_SETTINGS_VERSION_KEY },
    })
    const currentVersion = versionRow?.value ?? '0'
    if (currentVersion !== expectedVersion) {
      return { status: 'version_changed' as const, currentVersion }
    }
    return { status: 'ok' as const }
  }, {
    timeout: WC_PUSH_BATCH_TX_TIMEOUT_MS,
  })
  if (precheck.status === 'version_changed') {
    return precheck
  }

  const { data, error } = await safeWcPost('/products/batch', {
    update: batch.map((e) => e.payload),
  }, creds)

  if (error) {
    return { status: 'batch_error' as const, error }
  }

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_SYNC_ADVISORY_LOCK_KEY})`
    const versionRow = await tx.setting.findUnique({
      where: { key: WC_SETTINGS_VERSION_KEY },
    })
    const currentVersion = versionRow?.value ?? '0'
    if (currentVersion !== expectedVersion) {
      return { status: 'version_changed' as const, currentVersion }
    }
    const outcome = await reconcileBatchResponse(tx, batch, data)

    for (const entry of outcome.successEntries) {
      await tx.shoppingSyncLog.create({
        data: {
          direction: 'TO_CONNECTOR',
          status: 'SYNCED',
          entityType: 'StockLevel',
          externalId: String(entry.externalId),
          payload: JSON.parse(JSON.stringify({ stock_quantity: entry.payload.stock_quantity })),
          syncedAt: new Date(),
        },
      })
    }

    await persistSuccessfulPushState(tx, outcome.successEntries)

    return { status: 'ok' as const, outcome }
  }, {
    timeout: WC_PUSH_BATCH_TX_TIMEOUT_MS,
  })
}

function emptyResult(message: string): StockSyncResult {
  return {
    synced: 0, skipped: 0, errors: [],
    candidates: 0, matched: 0, unmatched: 0,
    pushed: false, message, unmatchedSkuSample: [],
  }
}

export async function pushStockToWc(options?: PushStockOptions): Promise<StockSyncResult> {
  const enabled = await db.setting.findUnique({ where: { key: 'wc_stock_sync_enabled' } })
  if (enabled?.value !== 'true') {
    return emptyResult('Stock sync is disabled in settings')
  }
  const scopedProductIds = options?.productIds ? [...new Set(options.productIds)] : null
  const forceProductIds = new Set(options?.forceProductIds ?? [])
  const forceAll = options?.forceAll === true

  // Cross-store safety note:
  //
  // `Product.externalProductId` is a per-product id that is only meaningful
  // against the WooCommerce installation it was resolved from. We do
  // NOT attempt to auto-detect "the store moved" from inside the sync
  // path. Instead, cache invalidation is enforced at the credentials
  // save boundary in `saveWcCredentials` (app/actions/wc-sync.ts) and
  // via the operator-invoked `resetWcProductIdCache` action. Attempts
  // to derive a store identity from mutable catalog data turned out
  // to be both too permissive (normal catalog edits invalidate the
  // whole cache) and too strict (empty or slow endpoints fail-close
  // every run). Explicit rebind is simpler and predictable.
  //
  // The safety net WITHIN this path is still SKU-level preflight
  // validation against live WC products (below), which refuses to
  // persist local success/log state when a cached id now carries a
  // different SKU. Because the outbound WC POST now happens outside
  // the advisory-lock transaction, a credentials rebind can still
  // race between the precheck and the remote write; that trade-off is
  // intentional so slow Woo responses do not pin a DB transaction.

  // Pin this run to a single credentials + settings-version snapshot.
  // Every WC API call below uses `creds`; every externalProductId write is
  // gated on `syncVersion`. A concurrent rebind/reset bumps the
  // version inside the same advisory-locked transaction that wipes
  // the cache, so either (a) we see the new version here and never
  // start, or (b) we start with the old snapshot and the first
  // persist that races the rebind observes the bump and aborts the
  // run — see the concurrency-safety note at the top of this file.
  const { creds, syncVersion } = await snapshotSyncContext()
  if (!creds) {
    return emptyResult('WooCommerce credentials are not configured')
  }

  const warehouses = await db.warehouse.findMany({
    where: { syncToStore: true, active: true },
    select: { id: true },
  })
  if (!warehouses.length) {
    return emptyResult('No warehouses flagged syncToStore')
  }

  const whIds = warehouses.map((w) => w.id)
  const scopedComponentIds = scopedProductIds
    ? [
        ...new Set(
          (
            await db.productComponent.findMany({
              where: { productId: { in: scopedProductIds } },
              select: { componentId: true },
            })
          ).map((row) => row.componentId),
        ),
      ]
    : []
  const scopedStockProductIds = scopedProductIds
    ? [...new Set([...scopedProductIds, ...scopedComponentIds])]
    : null

  const stockLevels = await db.stockLevel.findMany({
    where: {
      warehouseId: { in: whIds },
      ...(scopedStockProductIds ? { productId: { in: scopedStockProductIds } } : {}),
    },
    select: { productId: true, warehouseId: true, quantity: true, reservedQty: true },
  })

  const stockByProduct = new Map<string, number>()
  const stockByProductWarehouse = new Map<string, Map<string, number>>()
  for (const sl of stockLevels) {
    const available = Math.max(0, Number(sl.quantity) - Number(sl.reservedQty))
    stockByProduct.set(sl.productId, (stockByProduct.get(sl.productId) ?? 0) + available)
    const byWarehouse = stockByProductWarehouse.get(sl.productId) ?? new Map<string, number>()
    byWarehouse.set(sl.warehouseId, available)
    stockByProductWarehouse.set(sl.productId, byWarehouse)
  }

  const cogsSetting = await db.setting.findUnique({ where: { key: 'wc_cogs_sync_enabled' } })
  const cogsSyncEnabled = cogsSetting?.value === 'true'

  const physicalProductIds = [...new Set(stockLevels.map((sl) => sl.productId))]
  const rawProducts = await db.product.findMany({
    where: {
      lifecycleStatus: { in: WOO_STOCK_SYNC_PRODUCT_STATUSES },
      sku: { not: '' },
      ...(scopedProductIds
        ? {
            OR: [
              { id: { in: scopedProductIds } },
              {
                type: 'KIT',
                productComponents: { some: { componentId: { in: scopedProductIds } } },
              },
            ],
          }
        : {
            OR: [
              { id: { in: physicalProductIds } },
              { type: 'KIT', productComponents: { some: {} } },
            ],
          }),
    },
    select: {
      id: true,
      sku: true,
      type: true,
      lifecycleStatus: true,
      externalProductId: true,
      parent: { select: { sku: true } },
      productComponents: {
        select: {
          componentId: true,
          qty: true,
          component: { select: { type: true, lifecycleStatus: true } },
        },
      },
    },
  })
  const products = rawProducts.filter(
    (p): p is CandidateProduct => p.type !== 'VARIABLE' && p.type !== 'NON_INVENTORY',
  )
  const result: StockSyncResult = {
    synced: 0, skipped: 0, errors: [],
    candidates: products.length, matched: 0, unmatched: 0,
    pushed: false, message: '', unmatchedSkuSample: [],
  }
  const productById = new Map(products.map((product) => [product.id, product]))
  const availableByProduct = new Map<string, number>()
  const kitAvailabilityMemo = new Map<string, number>()
  const kitAvailabilityErrors = new Set<string>()
  for (const product of products) {
    const available = product.type === 'KIT'
      ? computeKitAvailability(
          product,
          whIds,
          stockByProductWarehouse,
          productById,
          kitAvailabilityMemo,
          new Set<string>(),
          result.errors,
          kitAvailabilityErrors,
        )
      : (stockByProduct.get(product.id) ?? 0)
    availableByProduct.set(product.id, available)
  }

  const previousStates = await db.stockSyncState.findMany({
    where: {
      connector: WC_STOCK_SYNC_CONNECTOR,
      productId: { in: products.map((product) => product.id) },
    },
    select: { productId: true, lastPushedQty: true, lastPushedRemoteId: true },
  })
  const previousStateByProductId = new Map(
    previousStates.map((state) => [state.productId, state]),
  )

  if (products.length === 0) {
    result.message = 'No stocked products with SKUs to sync'
    await recordAttempt()
    return result
  }

  // Local mutable view — tracks which products have a usable externalProductId
  // for this run. Only populated after successful persistence or pre-existing
  // DB value; further pruned by preflight validation.
  //
  // externalProductId is stored as BIGINT (Prisma BigInt) to cover WC/WordPress
  // post ids beyond the signed-32-bit range. WC REST responses return the
  // id as a JS `number`, and Number.MAX_SAFE_INTEGER (2^53-1) is well above
  // any realistic WC post id, so we downcast to `number` at the Prisma read
  // boundary and keep the rest of the sync pipeline in `number` for easy
  // JSON serialization, Map keying, and comparison with the WC response.
  const effectiveTargets = new Map<string, EffectiveTarget>()
  for (const p of products) {
    if (p.externalProductId != null && !isVariationCandidate(p)) {
      effectiveTargets.set(p.id, { externalId: Number(p.externalProductId) })
    }
  }

  // -------- SKU resolution for uncached products --------
  const needsResolution = products.filter((p) => p.externalProductId == null || isVariationCandidate(p))
  const unmatchedSkus: string[] = []

  // Set to `true` by any caller that observes a version bump and wants
  // the remaining sync phases to bail out without touching the DB or
  // WooCommerce again. A local flag (rather than throwing) keeps the
  // existing partial-result/error plumbing — recordAttempt, activity
  // log, unmatched counts — all intact for the operator-facing report.
  let versionBumpedMidRun = false

  if (needsResolution.length > 0) {
    const { resolved, errors: lookupErrors, totalAttempts, failedAttempts } =
      await resolveSkusInParallel(needsResolution, creds)

    // If every single lookup call failed, treat as a WC outage — bail hard.
    if (totalAttempts > 0 && failedAttempts === totalAttempts) {
      result.errors.push(
        ...lookupErrors.map((e) => `lookup failure for SKU ${e.sku}: ${e.error}`),
      )
      result.message = `WooCommerce API unreachable — all ${totalAttempts} SKU lookups failed`
      await recordAttempt()
      await logActivity({
        entityType: 'SYNC', action: 'stock_sync', tag: 'sync', level: 'ERROR',
        description: `Stock sync aborted: all ${totalAttempts} WC SKU lookups failed (likely outage or auth failure)`,
        metadata: {
          totalAttempts,
          failedAttempts,
          sampleErrors: lookupErrors.slice(0, 5),
        },
      })
      return result
    }

    // Partial failures: record as errors, leave those SKUs out of matched/unmatched counting.
    const failedLookupSkus = new Set(lookupErrors.map((e) => e.sku))
    for (const err of lookupErrors) {
      result.errors.push(`lookup failure for SKU ${err.sku}: ${err.error}`)
    }

    for (const p of needsResolution) {
      if (failedLookupSkus.has(p.sku)) continue
      const target = resolved.get(p.sku)
      if (target == null) {
        unmatchedSkus.push(p.sku)
        continue
      }
      // Persist first. Only enable the mapping for this run if the write
      // succeeded — otherwise a unique-constraint collision would let two
      // IMS products push to the same WC product.
      //
      // The persist is guarded by `persistMappingIfVersionMatches`:
      // the externalProductId write lives in a transaction that takes the
      // shared advisory lock and re-checks `wc_settings_version`. If
      // an operator has rebound credentials or reset the cache since
      // this sync started, the write refuses and we stop resolving
      // further products — anything we'd write would target a store
      // we're no longer connected to.
      const outcome = await persistMappingIfVersionMatches(p.id, target.externalId, syncVersion)
      if (outcome.ok) {
        effectiveTargets.set(p.id, target)
      } else if (outcome.reason === 'version_changed') {
        versionBumpedMidRun = true
        result.errors.push(
          `WooCommerce credentials were rebound while resolving SKUs — aborted before persisting ${p.sku} (IMS ${p.id}) to avoid writing an old-store id`,
        )
        break
      } else {
        result.errors.push(
          `externalProductId collision: could not persist ${target.externalId} for IMS product ${p.id} (SKU ${p.sku}): ${outcome.error}`,
        )
      }
    }
    result.unmatchedSkuSample = unmatchedSkus.slice(0, 10)
  }

  if (versionBumpedMidRun) {
    result.message =
      'Stock sync aborted: WooCommerce credentials changed mid-run (cache was reset)'
    await recordAttempt()
    await logActivity({
      entityType: 'SYNC', action: 'stock_sync', tag: 'sync', level: 'WARNING',
      description:
        'Stock sync aborted: WooCommerce credentials rebound or cache reset mid-run',
      metadata: { expectedVersion: syncVersion, errors: result.errors.slice(0, 5) },
    })
    return result
  }

  // -------- In-memory collision dedupe --------
  const externalIdUsers = new Map<number, string[]>()
  for (const [pid, target] of effectiveTargets) {
    const list = externalIdUsers.get(target.externalId) ?? []
    list.push(pid)
    externalIdUsers.set(target.externalId, list)
  }
  for (const [externalId, pids] of externalIdUsers) {
    if (pids.length > 1) {
      result.errors.push(
        `externalProductId ${externalId} is mapped to ${pids.length} IMS products (${pids.join(', ')}); skipping all to avoid overwrite`,
      )
      for (const pid of pids) effectiveTargets.delete(pid)
    }
  }

  // -------- Preflight: validate cached ids against live WC catalog --------
  const skuByProduct = new Map(products.map((p) => [p.id, p.sku]))
  if (effectiveTargets.size > 0) {
    const { verifiedByProductId, checkedProductIds, outageDetected, preflightErrors } =
      await preflightEffectiveTargets(products, effectiveTargets, creds)

    if (outageDetected) {
      result.errors.push(...preflightErrors.map((e) => `preflight failure: ${e}`))
      result.message = 'WooCommerce API unreachable during preflight — aborted before push'
      await recordAttempt()
      await logActivity({
        entityType: 'SYNC', action: 'stock_sync', tag: 'sync', level: 'ERROR',
        description: 'Stock sync aborted: WooCommerce preflight API call failed',
        metadata: { preflightErrors: preflightErrors.slice(0, 5) },
      })
      return result
    }

    // Record non-fatal preflight errors so operators can see them.
    for (const msg of preflightErrors) {
      result.errors.push(`preflight warning: ${msg}`)
    }

    // Drop any product whose cached id is either absent from the preflight
    // response (deleted in WC) or returns a different SKU (id reuse / drift).
    //
    // CRITICAL: only invalidate when the id was actually checked (i.e. its
    // preflight page returned successfully). An id missing from `verified`
    // because its page errored out is *unknown*, not *deleted*, and must
    // NOT be cleared — otherwise a single transient transport failure can
    // wipe every externalProductId on that page.
    for (const [pid, target] of [...effectiveTargets.entries()]) {
      const expectedSku = skuByProduct.get(pid)
      const externalId = target.externalId
      const actualSku = verifiedByProductId.get(pid)

      if (actualSku === undefined) {
        if (checkedProductIds.has(pid)) {
          const invalidation = await invalidateMappingIfVersionMatches(
            { productId: pid, sku: expectedSku ?? '', externalId },
            syncVersion,
            `WC product ${externalId} not found in preflight response (likely deleted)`,
          )
          if (invalidation.status === 'cleared') {
            result.skipped++
            result.errors.push(
              `Stale WC mapping for SKU ${expectedSku ?? ''} (IMS ${pid}, WC ${externalId}): ${invalidation.log.reason} — cleared for re-resolution`,
            )
            await logActivity({
              entityType: 'SYNC', action: 'stock_sync', tag: 'sync', level: 'WARNING',
              description: `Cleared stale WooCommerce mapping for SKU ${invalidation.log.sku}`,
              metadata: {
                productId: invalidation.log.productId,
                externalId: invalidation.log.externalId,
                reason: invalidation.log.reason,
              },
            })
          } else if (invalidation.status === 'version_changed') {
            versionBumpedMidRun = true
            result.errors.push(
              `WooCommerce credentials were rebound while invalidating stale mapping for SKU ${expectedSku ?? ''} (IMS ${pid}, WC ${externalId}); preserved current mapping`,
            )
          } else if (invalidation.status === 'mapping_changed') {
            result.skipped++
            result.errors.push(
              `Stale WC mapping for SKU ${expectedSku ?? ''} (IMS ${pid}, WC ${externalId}) was not cleared because the product now points at WC ${invalidation.currentWcId == null ? 'null' : String(invalidation.currentWcId)} in the database`,
            )
          } else {
            result.errors.push(`Failed to clear stale externalProductId for ${pid}: ${invalidation.error}`)
          }
        } else {
          // Page containing this id failed preflight — we don't know the
          // current state. Skip for this run but keep the cached mapping
          // so the next run can re-verify without permanent data loss.
          result.errors.push(
            `preflight incomplete for IMS ${pid} (SKU ${expectedSku ?? '?'}, WC ${externalId}): page fetch failed, mapping preserved for next run`,
          )
        }
        effectiveTargets.delete(pid)
        if (versionBumpedMidRun) break
        continue
      }
      if (expectedSku && actualSku !== expectedSku) {
        const invalidation = await invalidateMappingIfVersionMatches(
          { productId: pid, sku: expectedSku, externalId },
          syncVersion,
          `preflight: WC id ${externalId} now has SKU "${actualSku}" (expected "${expectedSku}")`,
        )
        if (invalidation.status === 'cleared') {
          result.skipped++
          result.errors.push(
            `Stale WC mapping for SKU ${expectedSku} (IMS ${pid}, WC ${externalId}): ${invalidation.log.reason} — cleared for re-resolution`,
          )
          await logActivity({
            entityType: 'SYNC', action: 'stock_sync', tag: 'sync', level: 'WARNING',
            description: `Cleared stale WooCommerce mapping for SKU ${invalidation.log.sku}`,
            metadata: {
              productId: invalidation.log.productId,
              externalId: invalidation.log.externalId,
              reason: invalidation.log.reason,
            },
          })
        } else if (invalidation.status === 'version_changed') {
          versionBumpedMidRun = true
          result.errors.push(
            `WooCommerce credentials were rebound while invalidating stale mapping for SKU ${expectedSku} (IMS ${pid}, WC ${externalId}); preserved current mapping`,
          )
        } else if (invalidation.status === 'mapping_changed') {
          result.skipped++
          result.errors.push(
            `Stale WC mapping for SKU ${expectedSku} (IMS ${pid}, WC ${externalId}) was not cleared because the product now points at WC ${invalidation.currentWcId == null ? 'null' : String(invalidation.currentWcId)} in the database`,
          )
        } else {
          result.errors.push(`Failed to clear stale externalProductId for ${pid}: ${invalidation.error}`)
        }
        effectiveTargets.delete(pid)
        if (versionBumpedMidRun) break
      }
    }
  }

  // -------- Count matched/unmatched from final effective state --------
  for (const p of products) {
    if (effectiveTargets.has(p.id)) result.matched++
    else if (!result.errors.some((msg) => msg.includes(`SKU ${p.sku}`))) {
      // Only count as "unmatched" if there wasn't a lookup/drift error for this SKU.
      // Those are counted as errors, not catalog mismatches.
      result.unmatched++
    }
  }

  // -------- COGS gathering --------
  const cogsByProduct = new Map<string, number>()
  if (cogsSyncEnabled) {
    for (const product of products) {
      if (!effectiveTargets.has(product.id)) continue
      const oldestLayer = await db.costLayer.findFirst({
        where: { productId: product.id, remainingQty: { gt: 0 } },
        orderBy: { receivedAt: 'asc' },
        select: { unitCostBase: true },
      })
      if (oldestLayer) {
        cogsByProduct.set(product.id, Number(oldestLayer.unitCostBase))
      }
    }
  }

  // -------- Build push entries --------
  const pushEntries: PushEntry[] = []
  const variantPushEntries: VariantPushEntry[] = []
  for (const product of products) {
    const target = effectiveTargets.get(product.id)
    if (target == null) {
      if (!result.errors.some((m) => m.includes(product.id))) result.skipped++
      continue
    }
    const available = shouldForceWooZeroStock(product.lifecycleStatus)
      ? 0
      : (availableByProduct.get(product.id) ?? 0)
    const payload: PushEntry['payload'] = {
      id: target.externalId,
      stock_quantity: Math.floor(available),
      manage_stock: true,
    }
    const cogs = cogsByProduct.get(product.id)
    if (cogs !== undefined) {
      payload.cost_of_goods_sold = { values: [{ defined_value: cogs.toFixed(2) }] }
    }
    if (isVariationCandidate(product) && target.parentWcId != null) {
      const entry: VariantPushEntry = {
        productId: product.id,
        sku: product.sku,
        externalId: target.externalId,
        parentWcId: target.parentWcId,
        payload,
      }
      const prev = previousStateByProductId.get(product.id)
      if (
        !forceAll
        && !forceProductIds.has(product.id)
        && prev?.lastPushedQty === entry.payload.stock_quantity
        && prev.lastPushedRemoteId != null
        && prev.lastPushedRemoteId === String(entry.externalId)
      ) {
        continue
      }
      variantPushEntries.push(entry)
    } else {
      const entry: PushEntry = { productId: product.id, sku: product.sku, externalId: target.externalId, payload }
      const prev = previousStateByProductId.get(product.id)
      if (
        !forceAll
        && !forceProductIds.has(product.id)
        && prev?.lastPushedQty === entry.payload.stock_quantity
        && prev.lastPushedRemoteId != null
        && prev.lastPushedRemoteId === String(entry.externalId)
      ) {
        continue
      }
      pushEntries.push(entry)
    }
  }

  if (pushEntries.length === 0 && variantPushEntries.length === 0) {
    const reason = result.errors.length > 0
      ? 'errors during preflight/resolution'
      : 'no changed WooCommerce-matched products'
    result.message = `0 synced — ${reason}`
    await recordAttempt()
    await logActivity({
      entityType: 'SYNC', action: 'stock_sync', tag: 'sync', level: 'WARNING',
      description: `Stock sync pushed nothing (candidates=${result.candidates}, matched=${result.matched}, unmatched=${result.unmatched}, errors=${result.errors.length})`,
      metadata: {
        candidates: result.candidates,
        matched: result.matched,
        unmatched: result.unmatched,
        unmatchedSkuSample: result.unmatchedSkuSample,
        errors: result.errors.slice(0, 10),
      },
    })
    return result
  }

  // -------- Push in batches of 100 --------
  // One batch failing (transport / 5xx / throw) must not abort the whole
  // run: report the error, skip the batch, move on.
  //
  // Between batches we re-check `wc_settings_version` against our
  // run snapshot. If an operator has rebound credentials or reset the
  // cache since the snapshot, every already-submitted POST in this
  // run was sent to the *old* store using the old credentials (which
  // is harmless — it updates stock on the store those ids actually
  // belong to), but continuing would keep pushing to the old store
  // after the operator explicitly disconnected it. Break out and
  // surface the abort instead.
  await options?.onProgress?.({ processed: 0, synced: 0, total: pushEntries.length })
  for (let i = 0; i < pushEntries.length; i += WC_BATCH_SIZE) {
    const batch = pushEntries.slice(i, i + WC_BATCH_SIZE)
    const batchOutcome = await pushBatchWithFence(batch, creds, syncVersion)
    if (batchOutcome.status === 'version_changed') {
      const remaining = pushEntries.length - i
      result.errors.push(
        `WooCommerce credentials were rebound mid-run — aborted ${remaining} remaining push(es) to avoid pushing to a disconnected store`,
      )
      await logActivity({
        entityType: 'SYNC', action: 'stock_sync', tag: 'sync', level: 'WARNING',
        description: `Stock sync aborted mid-push: WC settings version changed (${syncVersion} → ${batchOutcome.currentVersion})`,
        metadata: { remaining, pushedBeforeAbort: result.synced },
      })
      versionBumpedMidRun = true
      break
    }

    if (batchOutcome.status === 'batch_error') {
      result.errors.push(`batch push ${i / WC_BATCH_SIZE + 1}: ${batchOutcome.error}`)
      continue
    }

    if (batchOutcome.outcome.successEntries.length > 0) result.pushed = true
    result.synced += batchOutcome.outcome.successEntries.length
    result.skipped += batchOutcome.outcome.skipped
    result.errors.push(...batchOutcome.outcome.errors)
    await options?.onProgress?.({
      processed: Math.min(i + WC_BATCH_SIZE, pushEntries.length),
      synced: result.synced,
      total: pushEntries.length,
    })

    for (const invalidation of batchOutcome.outcome.invalidations) {
      await logActivity({
        entityType: 'SYNC', action: 'stock_sync', tag: 'sync', level: 'WARNING',
        description: `Cleared stale WooCommerce mapping for SKU ${invalidation.sku}`,
        metadata: {
          productId: invalidation.productId,
          externalId: invalidation.externalId,
          reason: invalidation.reason,
        },
      })
    }
  }

  if (!versionBumpedMidRun) {
    const byParent = new Map<number, VariantPushEntry[]>()
    for (const entry of variantPushEntries) {
      const list = byParent.get(entry.parentWcId) ?? []
      list.push(entry)
      byParent.set(entry.parentWcId, list)
    }

    let processedVariantEntries = 0
    for (const group of byParent.values()) {
      for (let i = 0; i < group.length; i += WC_VARIATION_BATCH_SIZE) {
        const batch = group.slice(i, i + WC_VARIATION_BATCH_SIZE)
        const outcome = await pushVariantBatchWithFence(batch, creds, syncVersion)
        if (outcome.status === 'version_changed') {
          const remaining = variantPushEntries.length - processedVariantEntries
          result.errors.push(
            `WooCommerce credentials were rebound mid-run — aborted ${remaining} remaining variation push(es) to avoid pushing to a disconnected store`,
          )
          await logActivity({
            entityType: 'SYNC', action: 'stock_sync', tag: 'sync', level: 'WARNING',
            description: `Stock sync aborted mid-variation-push: WC settings version changed (${syncVersion} → ${outcome.currentVersion})`,
            metadata: { remaining, pushedBeforeAbort: result.synced },
          })
          versionBumpedMidRun = true
          break
        }
        if (outcome.status === 'push_error') {
          result.errors.push(`variation batch push ${batch[0]?.parentWcId ?? 'unknown'}: ${outcome.error}`)
          processedVariantEntries += batch.length
          continue
        }

        if (outcome.outcome.successEntries.length > 0) result.pushed = true
        result.synced += outcome.outcome.successEntries.length
        result.skipped += outcome.outcome.skipped
        result.errors.push(...outcome.outcome.errors)

        for (const invalidation of outcome.outcome.invalidations) {
          await logActivity({
            entityType: 'SYNC', action: 'stock_sync', tag: 'sync', level: 'WARNING',
            description: `Cleared stale WooCommerce mapping for SKU ${invalidation.sku}`,
            metadata: {
              productId: invalidation.productId,
              externalId: invalidation.externalId,
              reason: invalidation.reason,
            },
          })
        }
        processedVariantEntries += batch.length
      }
      if (versionBumpedMidRun) break
    }
  }

  await recordAttempt()

  if (result.pushed) {
    const now = new Date().toISOString()
    await db.setting.upsert({
      where: { key: 'last_wc_stock_sync_at' },
      create: { key: 'last_wc_stock_sync_at', value: now },
      update: { value: now },
    })
    await logActivity({
      entityType: 'SYNC', action: 'stock_sync', tag: 'sync', level: 'INFO',
      description: `Pushed stock levels to WC: ${result.synced} products updated`,
      metadata: {
        matched: result.matched,
        unmatched: result.unmatched,
        errors: result.errors.length,
      },
    })
  }

  result.message = result.unmatched > 0
    ? `${result.synced} synced, ${result.unmatched} unmatched in WooCommerce`
    : `${result.synced} synced`

  return result
}

/**
 * Fetch live WC products for a set of cached ids and build a verified
 * id→SKU map. Uses `include=<csv>&per_page=100` which is exactly one
 * request per 100 ids — vastly cheaper than per-SKU lookups.
 *
 * Returns:
 *   - verified: Map<externalId, currentSku> for every id WC returned in a
 *     successfully-fetched page
 *   - checkedIds: set of ids whose page actually completed successfully.
 *     The caller MUST use this to distinguish "id missing because WC
 *     deleted it" (in `checkedIds` but not in `verified`) from "id
 *     unverified because the page fetch failed" (not in `checkedIds`).
 *     Without this, a single transient transport error would invalidate
 *     every cached mapping on the failing page.
 *   - outageDetected: true if every page call failed (bail out)
 *   - preflightErrors: transport/auth errors, one per failing page
 */
async function preflightCachedIds(
  ids: number[],
  creds: ConnectorCredentials,
): Promise<{
  verified: Map<number, string>
  checkedIds: Set<number>
  outageDetected: boolean
  preflightErrors: string[]
  attempts: number
  failedAttempts: number
}> {
  const verified = new Map<number, string>()
  const checkedIds = new Set<number>()
  const preflightErrors: string[] = []
  let pages = 0
  let failedPages = 0

  for (let i = 0; i < ids.length; i += PREFLIGHT_PAGE_SIZE) {
    pages++
    const page = ids.slice(i, i + PREFLIGHT_PAGE_SIZE)
    const { data, error } = await safeWcFetch('/products', {
      include: page.join(','),
      per_page: String(PREFLIGHT_PAGE_SIZE),
    }, creds)
    if (error) {
      failedPages++
      preflightErrors.push(`${error} (${page.length} ids in page)`)
      continue
    }
    // Page completed — these ids are authoritatively verifiable.
    for (const id of page) checkedIds.add(id)
    const list = Array.isArray(data) ? (data as WcFullProduct[]) : []
    for (const wcProduct of list) {
      if (wcProduct && typeof wcProduct.id === 'number' && typeof wcProduct.sku === 'string') {
        verified.set(wcProduct.id, wcProduct.sku)
      }
    }
  }

  return {
    verified,
    checkedIds,
    outageDetected: pages > 0 && failedPages === pages,
    preflightErrors,
    attempts: pages,
    failedAttempts: failedPages,
  }
}

// WooCommerce REST error codes that positively prove the id no longer
// points to a real product. Anything outside this set (validation errors,
// plugin rejections, permission errors, etc.) is a sync failure, NOT drift —
// clearing `externalProductId` in those cases would destroy valid local state for
// an unrelated transient problem.
//
// `woocommerce_rest_cannot_view` is deliberately NOT in this list: it is
// returned for permission/visibility problems (auth regression, temporary
// capability change, admin unpublishing) as well as missing resources, so
// treating it as drift would null out valid mappings under an auth outage.
const WC_NOT_FOUND_ERROR_CODES = new Set([
  'woocommerce_rest_product_invalid_id',
  'woocommerce_rest_invalid_id',
  'woocommerce_rest_shop_order_invalid_id',
  'rest_post_invalid_id',
])

/**
 * Inspect the WC batch update response and reconcile drift. This runs
 * AFTER preflight, so it's a secondary safety net for the (very small)
 * window where a product could be mutated between preflight and push.
 *
 * Invalidation is gated on *positive* proof of drift:
 *   1. The returned SKU differs from the one we pushed for this id, or
 *   2. WC returned an explicit "not found / invalid id" error code.
 *
 * Anything else — missing items, generic errors, validation failures,
 * plugin-level rejections — is reported as a push failure but leaves the
 * cached mapping intact so the next run can retry against the same id.
 */
async function reconcileBatchResponse(
  tx: Prisma.TransactionClient,
  batch: PushEntry[],
  data: unknown,
): Promise<BatchReconcileOutcome> {
  const byId = new Map<number, WcBatchUpdateItem>()
  if (data && typeof data === 'object' && 'update' in data) {
    const items = (data as { update?: unknown }).update
    if (Array.isArray(items)) {
      for (const raw of items as WcBatchUpdateItem[]) {
        if (raw && typeof raw === 'object' && typeof raw.id === 'number') {
          byId.set(raw.id, raw)
        }
      }
    }
  }

  const successful: PushEntry[] = []
  const errors: string[] = []
  const invalidations: MappingInvalidationLog[] = []
  let skipped = 0

  for (const entry of batch) {
    const item = byId.get(entry.externalId)

    // Missing from response: batch APIs very occasionally drop items on
    // partial failures / plugin interference. Report as a push failure but
    // keep the cached mapping — we don't know it's stale.
    if (!item) {
      errors.push(
        `Push failed for SKU ${entry.sku} (IMS ${entry.productId}, WC ${entry.externalId}): item missing from batch response (mapping preserved)`,
      )
      skipped++
      continue
    }

    // Per-item error. Only treat "invalid id / not found" as drift; every
    // other error is a push failure (validation, auth, plugin rejection, …)
    // and must NOT clear the cached mapping.
    if (item.error) {
      const code = item.error.code ?? ''
      if (WC_NOT_FOUND_ERROR_CODES.has(code)) {
        const invalidation = await invalidateMappingInLockedTx(
          tx,
          entry,
          `WC returned "${code}" for id ${entry.externalId} — product no longer exists`,
        )
        if (invalidation.status === 'cleared') {
          invalidations.push(invalidation.log)
          errors.push(
            `Stale WC mapping for SKU ${entry.sku} (IMS ${entry.productId}, WC ${entry.externalId}): ${invalidation.log.reason} — cleared for re-resolution`,
          )
        } else {
          errors.push(
            `Stale WC mapping for SKU ${entry.sku} (IMS ${entry.productId}, WC ${entry.externalId}) was not cleared because the product now points at WC ${invalidation.currentWcId == null ? 'null' : String(invalidation.currentWcId)} in the database`,
          )
        }
        skipped++
      } else {
        errors.push(
          `Push failed for SKU ${entry.sku} (IMS ${entry.productId}, WC ${entry.externalId}): ${item.error.message ?? code ?? 'unknown error'} (mapping preserved)`,
        )
        skipped++
      }
      continue
    }

    // Positive proof of drift: the response came back clean but the SKU on
    // that id is now different from what we pushed.
    if (typeof item.sku === 'string' && item.sku !== '' && item.sku !== entry.sku) {
      const invalidation = await invalidateMappingInLockedTx(
        tx,
        entry,
        `post-push drift: WC id ${entry.externalId} now maps to SKU "${item.sku}" (expected "${entry.sku}")`,
      )
      if (invalidation.status === 'cleared') {
        invalidations.push(invalidation.log)
        errors.push(
          `Stale WC mapping for SKU ${entry.sku} (IMS ${entry.productId}, WC ${entry.externalId}): ${invalidation.log.reason} — cleared for re-resolution`,
        )
      } else {
        errors.push(
          `Stale WC mapping for SKU ${entry.sku} (IMS ${entry.productId}, WC ${entry.externalId}) was not cleared because the product now points at WC ${invalidation.currentWcId == null ? 'null' : String(invalidation.currentWcId)} in the database`,
        )
      }
      skipped++
      continue
    }

    successful.push(entry)
  }

  return { successEntries: successful, skipped, errors, invalidations }
}

async function recordAttempt() {
  const now = new Date().toISOString()
  await db.setting.upsert({
    where: { key: 'last_wc_stock_sync_attempt_at' },
    create: { key: 'last_wc_stock_sync_attempt_at', value: now },
    update: { value: now },
  })
}

function computeKitAvailability(
  product: CandidateProduct,
  warehouseIds: string[],
  stockByProductWarehouse: Map<string, Map<string, number>>,
  productById: Map<string, CandidateProduct>,
  memo: Map<string, number>,
  stack: Set<string>,
  errors: string[],
  seenCycleErrors: Set<string>,
): number {
  if (memo.has(product.id)) return memo.get(product.id) ?? 0
  if (product.productComponents.length === 0) {
    memo.set(product.id, 0)
    return 0
  }
  if (stack.has(product.id)) {
    const cycleKey = [...stack, product.id].join(' -> ')
    if (!seenCycleErrors.has(cycleKey)) {
      errors.push(`KIT cycle detected: ${cycleKey}`)
      seenCycleErrors.add(cycleKey)
    }
    memo.set(product.id, 0)
    return 0
  }

  stack.add(product.id)

  let total = 0
  for (const warehouseId of warehouseIds) {
    let kitsInWarehouse = Infinity
    for (const component of product.productComponents) {
      const required = Number(component.qty)
      if (required <= 0) {
        kitsInWarehouse = 0
        break
      }
      if (component.component.lifecycleStatus === 'ARCHIVED') {
        kitsInWarehouse = 0
        break
      }
      let available = Math.max(0, stockByProductWarehouse.get(component.componentId)?.get(warehouseId) ?? 0)
      if (component.component.type === 'KIT') {
        const nested = productById.get(component.componentId)
        available = nested
          ? computeKitAvailability(nested, [warehouseId], stockByProductWarehouse, productById, memo, stack, errors, seenCycleErrors)
          : 0
      }
      kitsInWarehouse = Math.min(kitsInWarehouse, Math.floor(available / required))
    }
    total += kitsInWarehouse === Infinity ? 0 : kitsInWarehouse
  }

  stack.delete(product.id)
  memo.set(product.id, total)
  return total
}

async function preflightEffectiveTargets(
  products: CandidateProduct[],
  effectiveTargets: Map<string, EffectiveTarget>,
  creds: ConnectorCredentials,
): Promise<{
  verifiedByProductId: Map<string, string>
  checkedProductIds: Set<string>
  outageDetected: boolean
  preflightErrors: string[]
}> {
  const productById = new Map(products.map((product) => [product.id, product]))
  const verifiedByProductId = new Map<string, string>()
  const checkedProductIds = new Set<string>()
  const preflightErrors: string[] = []

  let totalAttempts = 0
  let failedAttempts = 0

  const standardEntries: { productId: string; externalId: number }[] = []
  const variantEntries: { productId: string; externalId: number; parentWcId: number }[] = []
  for (const [productId, target] of effectiveTargets) {
    const product = productById.get(productId)
    if (!product) continue
    if (isVariationCandidate(product) && target.parentWcId != null) {
      variantEntries.push({ productId, externalId: target.externalId, parentWcId: target.parentWcId })
    } else {
      standardEntries.push({ productId, externalId: target.externalId })
    }
  }

  if (standardEntries.length > 0) {
    const standard = await preflightCachedIds(
      [...new Set(standardEntries.map((entry) => entry.externalId))],
      creds,
    )
    totalAttempts += standard.attempts
    failedAttempts += standard.failedAttempts
    preflightErrors.push(...standard.preflightErrors)

    const productIdsByWcId = new Map<number, string[]>()
    for (const entry of standardEntries) {
      const list = productIdsByWcId.get(entry.externalId) ?? []
      list.push(entry.productId)
      productIdsByWcId.set(entry.externalId, list)
    }

    for (const [externalId, productIds] of productIdsByWcId) {
      if (standard.checkedIds.has(externalId)) {
        for (const productId of productIds) checkedProductIds.add(productId)
      }
      const sku = standard.verified.get(externalId)
      if (sku !== undefined) {
        for (const productId of productIds) verifiedByProductId.set(productId, sku)
      }
    }
  }

  const variantEntriesByParent = new Map<number, typeof variantEntries>()
  for (const entry of variantEntries) {
    const list = variantEntriesByParent.get(entry.parentWcId) ?? []
    list.push(entry)
    variantEntriesByParent.set(entry.parentWcId, list)
  }

  for (const [parentWcId, entries] of variantEntriesByParent) {
    for (let i = 0; i < entries.length; i += PREFLIGHT_PAGE_SIZE) {
      totalAttempts++
      const batch = entries.slice(i, i + PREFLIGHT_PAGE_SIZE)
      const ids = batch.map((entry) => entry.externalId)
      const { data, error } = await safeWcFetch(
        `/products/${parentWcId}/variations`,
        { include: ids.join(','), per_page: String(PREFLIGHT_PAGE_SIZE) },
        creds,
      )
      if (error) {
        failedAttempts++
        const sampleSku = productById.get(batch[0]?.productId ?? '')?.sku ?? String(parentWcId)
        preflightErrors.push(`variant group ${sampleSku}: ${error}`)
        continue
      }

      const variations = Array.isArray(data) ? (data as WcVariation[]) : []
      const verifiedByWcId = new Map<number, string>()
      for (const variation of variations) {
        if (typeof variation.id === 'number' && typeof variation.sku === 'string') {
          verifiedByWcId.set(variation.id, variation.sku)
        }
      }

      for (const entry of batch) {
        checkedProductIds.add(entry.productId)
        const sku = verifiedByWcId.get(entry.externalId)
        if (sku !== undefined) {
          verifiedByProductId.set(entry.productId, sku)
        }
      }
    }
  }

  return {
    verifiedByProductId,
    checkedProductIds,
    outageDetected: totalAttempts > 0 && failedAttempts === totalAttempts,
    preflightErrors,
  }
}

async function pushVariantBatchWithFence(
  entries: VariantPushEntry[],
  creds: ConnectorCredentials,
  expectedVersion: string,
): Promise<
  | { status: 'version_changed'; currentVersion: string }
  | { status: 'push_error'; error: string }
  | { status: 'ok'; outcome: BatchReconcileOutcome }
> {
  const parentWcId = entries[0]?.parentWcId
  if (parentWcId == null) {
    return { status: 'push_error', error: 'variant batch missing parent Woo id' }
  }

  const precheck = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_SYNC_ADVISORY_LOCK_KEY})`
    const versionRow = await tx.setting.findUnique({
      where: { key: WC_SETTINGS_VERSION_KEY },
    })
    const currentVersion = versionRow?.value ?? '0'
    if (currentVersion !== expectedVersion) {
      return { status: 'version_changed' as const, currentVersion }
    }
    return { status: 'ok' as const }
  }, {
    timeout: WC_PUSH_BATCH_TX_TIMEOUT_MS,
  })
  if (precheck.status === 'version_changed') {
    return precheck
  }

  const { data, error } = await safeWcPost(
    `/products/${parentWcId}/variations/batch`,
    { update: entries.map((entry) => entry.payload) },
    creds,
  )
  if (error) {
    return { status: 'push_error' as const, error }
  }

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_SYNC_ADVISORY_LOCK_KEY})`
    const versionRow = await tx.setting.findUnique({
      where: { key: WC_SETTINGS_VERSION_KEY },
    })
    const currentVersion = versionRow?.value ?? '0'
    if (currentVersion !== expectedVersion) {
      return { status: 'version_changed' as const, currentVersion }
    }
    const outcome = await reconcileBatchResponse(tx, entries, data)

    for (const entry of outcome.successEntries) {
      await tx.shoppingSyncLog.create({
        data: {
          direction: 'TO_CONNECTOR',
          status: 'SYNCED',
          entityType: 'StockLevel',
          externalId: String(entry.externalId),
          payload: JSON.parse(JSON.stringify({ stock_quantity: entry.payload.stock_quantity })),
          syncedAt: new Date(),
        },
      })
    }

    await persistSuccessfulPushState(tx, outcome.successEntries)

    return {
      status: 'ok' as const,
      outcome,
    }
  }, {
    timeout: WC_PUSH_BATCH_TX_TIMEOUT_MS,
  })
}

/**
 * Resolve SKUs → WC product ids with bounded parallelism.
 * Returns both resolved ids and any transport errors so the caller can
 * distinguish a WC outage from a true catalog mismatch.
 *
 * Fails closed on SKU ambiguity: if WooCommerce returns more than one
 * product for the same SKU, we refuse to cache or push anything for it.
 * `per_page=2` is deliberately the smallest page size that lets us
 * detect duplicates. Without this check, preflight cannot save us: the
 * cached id still carries the right SKU, so drift detection would never
 * fire, and stock updates would silently target the wrong product.
 *
 * Ambiguity is reported via `errors` (so the caller skips it exactly
 * like a transport failure) but is NOT counted toward `failedAttempts`,
 * so a catalog full of duplicate SKUs doesn't trigger false "WC outage"
 * bail-out.
 */
async function resolveSkusInParallel(
  products: CandidateProduct[],
  creds: ConnectorCredentials,
): Promise<{
  resolved: Map<string, EffectiveTarget>
  errors: { sku: string; error: string }[]
  totalAttempts: number
  failedAttempts: number
}> {
  const resolved = new Map<string, EffectiveTarget>()
  const errors: { sku: string; error: string }[] = []
  let totalAttempts = 0
  let failedAttempts = 0

  const variants = products.filter((product) => isVariationCandidate(product))
  const standardProducts = products.filter((product) => !isVariationCandidate(product))

  const variantGroups = new Map<string, CandidateProduct[]>()
  for (const product of variants) {
    const parentSku = product.parent?.sku
    if (!parentSku) {
      errors.push({ sku: product.sku, error: 'variant has no parent SKU in IMS; cannot resolve Woo variation id' })
      continue
    }
    const list = variantGroups.get(parentSku) ?? []
    list.push(product)
    variantGroups.set(parentSku, list)
  }

  for (const [parentSku, group] of variantGroups) {
    totalAttempts++
    const parentLookup = await safeWcFetch('/products', { sku: parentSku, per_page: '2' }, creds)
    if (parentLookup.error) {
      failedAttempts++
      for (const product of group) {
        errors.push({ sku: product.sku, error: `parent SKU ${parentSku}: ${parentLookup.error}` })
      }
      continue
    }
    const parents = (parentLookup.data as WcFullProduct[] | null) ?? []
    if (parents.length === 0) continue
    if (parents.length > 1) {
      for (const product of group) {
        errors.push({
          sku: product.sku,
          error: `ambiguous parent SKU ${parentSku} — WooCommerce returned ${parents.length}+ products`,
        })
      }
      continue
    }

    const parentWcId = parents[0]?.id
    if (typeof parentWcId !== 'number') continue

    for (let i = 0; i < group.length; i += WC_VARIATION_BATCH_SIZE) {
      const batch = group.slice(i, i + WC_VARIATION_BATCH_SIZE)
      totalAttempts++
      const lookup = await safeWcFetch(
        `/products/${parentWcId}/variations`,
        { per_page: String(WC_VARIATION_BATCH_SIZE), include: batch.map((product) => product.externalProductId != null ? Number(product.externalProductId) : 0).filter((id) => id > 0).join(',') },
        creds,
      )

      if (!lookup.error && Array.isArray(lookup.data) && batch.every((product) => product.externalProductId != null)) {
        const bySku = new Map<string, WcVariation[]>()
        for (const variation of lookup.data as WcVariation[]) {
          const list = bySku.get(variation.sku) ?? []
          list.push(variation)
          bySku.set(variation.sku, list)
        }
        for (const product of batch) {
          const matches = bySku.get(product.sku) ?? []
          if (matches.length === 1 && typeof matches[0]?.id === 'number') {
            resolved.set(product.sku, { externalId: matches[0].id, parentWcId })
            continue
          }
          if (matches.length > 1) {
            errors.push({
              sku: product.sku,
              error: `ambiguous — WooCommerce returned ${matches.length}+ variations sharing this SKU under parent ${parentSku}`,
            })
          }
        }
        continue
      }

      const variationLookup = await safeWcFetch(
        `/products/${parentWcId}/variations`,
        { per_page: '100' },
        creds,
      )
      if (variationLookup.error) {
        failedAttempts++
        for (const product of batch) {
          errors.push({ sku: product.sku, error: variationLookup.error })
        }
        continue
      }
      const variations = (variationLookup.data as WcVariation[] | null) ?? []
      const bySku = new Map<string, WcVariation[]>()
      for (const variation of variations) {
        const list = bySku.get(variation.sku) ?? []
        list.push(variation)
        bySku.set(variation.sku, list)
      }
      for (const product of batch) {
        const matches = bySku.get(product.sku) ?? []
        if (matches.length === 0) continue
        if (matches.length > 1) {
          errors.push({
            sku: product.sku,
            error: `ambiguous — WooCommerce returned ${matches.length}+ variations sharing this SKU under parent ${parentSku}`,
          })
          continue
        }
        const variationId = matches[0]?.id
        if (typeof variationId === 'number') {
          resolved.set(product.sku, { externalId: variationId, parentWcId })
        }
      }
    }
  }

  let cursor = 0
  async function worker() {
    while (cursor < standardProducts.length) {
      const idx = cursor++
      const product = standardProducts[idx]
      const sku = product.sku
      totalAttempts++
      const { data, error } = await safeWcFetch('/products', { sku, per_page: '2' }, creds)
      if (error) {
        failedAttempts++
        errors.push({ sku, error })
        continue
      }
      const wcProducts = (data as WcFullProduct[] | null) ?? []
      if (wcProducts.length === 0) continue
      if (wcProducts.length > 1) {
        errors.push({
          sku,
          error: `ambiguous — WooCommerce returned ${wcProducts.length}+ products sharing this SKU; refusing to bind mapping until catalog is deduplicated`,
        })
        continue
      }
      const externalId = wcProducts[0]?.id
      if (typeof externalId === 'number') {
        resolved.set(sku, { externalId })
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(SKU_LOOKUP_CONCURRENCY, standardProducts.length) },
    () => worker(),
  )
  await Promise.all(workers)
  return { resolved, errors, totalAttempts, failedAttempts }
}

// ---------------------------------------------------------------------------
// Manual stock-push progress (mirrors the manual product-sync progress so the
// UI can show a live "X of Y synced" count while the background push runs).
// ---------------------------------------------------------------------------

const MANUAL_STOCK_SYNC_JOB_KEY = 'manual_wc_stock_sync_job'
const MANUAL_STOCK_SYNC_STALE_MS = 30 * 60 * 1000

export type ManualStockSyncProgress = {
  status: 'idle' | 'running' | 'done' | 'error'
  message: string
  processed: number
  synced: number
  total: number
  errors: string[]
  startedAt?: string
  updatedAt?: string
}

const INITIAL_MANUAL_STOCK_SYNC_PROGRESS: ManualStockSyncProgress = {
  status: 'idle', message: '', processed: 0, synced: 0, total: 0, errors: [],
}

async function saveManualStockSyncProgress(progress: ManualStockSyncProgress): Promise<void> {
  await db.setting.upsert({
    where: { key: MANUAL_STOCK_SYNC_JOB_KEY },
    create: { key: MANUAL_STOCK_SYNC_JOB_KEY, value: JSON.stringify(progress) },
    update: { value: JSON.stringify(progress) },
  })
}

export async function getManualWcStockSyncProgress(): Promise<ManualStockSyncProgress> {
  const row = await db.setting.findUnique({ where: { key: MANUAL_STOCK_SYNC_JOB_KEY } })
  if (!row?.value) return INITIAL_MANUAL_STOCK_SYNC_PROGRESS
  try {
    return JSON.parse(row.value) as ManualStockSyncProgress
  } catch {
    return INITIAL_MANUAL_STOCK_SYNC_PROGRESS
  }
}

/**
 * Start the manual full stock push in the background and persist a progress
 * record the UI polls. Deduped: a second start while one is already running
 * (and fresh) is a no-op.
 */
export async function startManualWcStockSync(): Promise<void> {
  const current = await getManualWcStockSyncProgress()
  if (current.status === 'running') {
    const updatedAt = current.updatedAt ? Date.parse(current.updatedAt) : NaN
    if (Number.isFinite(updatedAt) && Date.now() - updatedAt < MANUAL_STOCK_SYNC_STALE_MS) return
  }

  const progress: ManualStockSyncProgress = {
    ...INITIAL_MANUAL_STOCK_SYNC_PROGRESS,
    status: 'running',
    message: 'Preparing WooCommerce stock push…',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await saveManualStockSyncProgress(progress)

  after(() =>
    runManualWcStockPush(progress).catch(async (error) => {
      progress.status = 'error'
      progress.message = error instanceof Error ? error.message : String(error)
      progress.errors = [...progress.errors, progress.message]
      progress.updatedAt = new Date().toISOString()
      await saveManualStockSyncProgress(progress)
    }),
  )
}

async function runManualWcStockPush(progress: ManualStockSyncProgress): Promise<void> {
  const result = await pushStockToWc({
    forceAll: true,
    source: 'MANUAL',
    onProgress: async (snap) => {
      progress.status = 'running'
      progress.processed = snap.processed
      progress.synced = snap.synced
      progress.total = snap.total
      progress.message = snap.total > 0
        ? `Pushing stock to WooCommerce — ${snap.synced} of ${snap.total} synced`
        : 'No changed products to push'
      progress.updatedAt = new Date().toISOString()
      await saveManualStockSyncProgress(progress)
    },
  })

  progress.status = result.errors.length > 0 ? 'error' : 'done'
  progress.synced = result.synced
  progress.total = Math.max(progress.total, result.synced)
  progress.errors = result.errors.slice(0, 20)
  progress.message = result.message?.trim()
    ? result.message.trim()
    : result.errors.length > 0
      ? `Stock push finished with ${result.errors.length} error(s) — ${result.synced} synced`
      : result.synced > 0
        ? `Stock push complete — ${result.synced} product(s) synced to WooCommerce`
        : 'Stock push complete — all products already in sync'
  progress.updatedAt = new Date().toISOString()
  await saveManualStockSyncProgress(progress)
}
