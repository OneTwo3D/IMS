'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requirePermission } from '@/lib/auth/server'
import {
  WC_SYNC_ADVISORY_LOCK_KEY,
  WC_SETTINGS_VERSION_KEY,
} from '@/lib/connectors/woocommerce/sync-lock'

// All mutating exports in this file require the `sync` permission.
async function requireAdmin() {
  return requirePermission('sync')
}

// ---------------------------------------------------------------------------
// Sync settings
// ---------------------------------------------------------------------------

export type WcSyncSettings = {
  wc_sync_enabled: string
  wc_sync_order_statuses: string
  wc_sync_interval_minutes: string
  wc_sync_product_enabled: string
  wc_sync_product_direction: string
  wc_stock_sync_enabled: string
  wc_cogs_sync_enabled: string
  wc_webhook_secret: string
  wc_webhook_last_received_at: string
  last_wc_order_sync_at: string
  last_wc_product_sync_at: string
  last_wc_stock_sync_at: string
  wc_initial_import_completed: string
}

const SYNC_SETTING_KEYS = [
  'wc_sync_enabled', 'wc_sync_order_statuses', 'wc_sync_interval_minutes',
  'wc_sync_product_enabled', 'wc_sync_product_direction', 'wc_stock_sync_enabled', 'wc_cogs_sync_enabled',
  'wc_webhook_secret', 'wc_webhook_last_received_at', 'last_wc_order_sync_at', 'last_wc_product_sync_at', 'last_wc_stock_sync_at',
  'wc_initial_import_completed',
]

const SYNC_DEFAULTS: WcSyncSettings = {
  wc_sync_enabled: 'false',
  wc_sync_order_statuses: '["processing"]',
  wc_sync_interval_minutes: '5',
  wc_sync_product_enabled: 'false',
  wc_sync_product_direction: 'from_wc',
  wc_stock_sync_enabled: 'false',
  wc_cogs_sync_enabled: 'false',
  wc_webhook_secret: '',
  wc_webhook_last_received_at: '',
  last_wc_order_sync_at: '',
  last_wc_product_sync_at: '',
  last_wc_stock_sync_at: '',
  wc_initial_import_completed: '',
}

export async function getWcSyncSettings(): Promise<WcSyncSettings> {
  await requireAdmin()
  const rows = await db.setting.findMany({ where: { key: { in: SYNC_SETTING_KEYS } } })
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const result = { ...SYNC_DEFAULTS }
  for (const k of Object.keys(result) as (keyof WcSyncSettings)[]) {
    const v = map.get(k)
    if (v) result[k] = v
  }
  return result
}

export async function saveWcSyncSettings(data: Partial<WcSyncSettings>): Promise<{ success: boolean }> {
  await requireAdmin()
  const ops = Object.entries(data)
    .filter(([k]) => SYNC_SETTING_KEYS.includes(k))
    .map(([k, v]) =>
      db.setting.upsert({ where: { key: k }, create: { key: k, value: v }, update: { value: v } }),
    )
  await db.$transaction(ops)
  await logActivity({ entityType: 'SETTING', tag: 'settings', action: 'updated', description: 'Updated WooCommerce sync settings' })
  revalidatePath('/sync')
  return { success: true }
}

// ---------------------------------------------------------------------------
// WC connection credentials
// ---------------------------------------------------------------------------

/**
 * Save WooCommerce credentials.
 *
 * Cache-integrity contract: `Product.wcProductId` is an id against one
 * specific WooCommerce installation. Changing the store URL or the
 * consumer key means cached mappings may now point at unrelated
 * products on a different catalog. Rather than trying to detect
 * store identity from inside the sync path (which historically
 * collapsed into false "same store" decisions or flushed on routine
 * catalog edits), invalidation is enforced HERE, atomically with the
 * credentials write: if the effective url/key/secret changes, we
 * null every `wcProductId` in the same transaction that writes the
 * new values. The next sync re-resolves via SKU lookup against the
 * new store.
 *
 * Concurrency contract with in-flight stock syncs: a rebind must not
 * race a concurrently running `pushStockToWc`. The whole write
 * (credentials + cache wipe + version bump) runs inside a transaction
 * that first takes `pg_advisory_xact_lock(WC_SYNC_ADVISORY_LOCK_KEY)`.
 * `pushStockToWc` takes the same advisory lock when it snapshots its
 * credentials at start-of-run and again for every wcProductId write.
 * Whichever side commits first wins cleanly: a persist that races us
 * and loses the lock will, on the far side, observe the new
 * `wc_settings_version` and abort its write before any old-store id
 * can land on top of the wiped cache.
 *
 * Manual DB edits to these settings outside this action are explicitly
 * out of scope — operators that rewrite the settings table directly
 * must also call `resetWcProductIdCache()` (or click the "Reset cached
 * product IDs" button) to flush the cache.
 */
export async function saveWcCredentials(url: string, key: string, secret: string): Promise<{ success: boolean; wipedMappings: number }> {
  await requireAdmin()

  const incomingSecretIsMasked = !!secret && secret.includes('*')

  const saveOutcome = await db.$transaction(async (tx) => {
    // Serialize against in-flight stock syncs. See the concurrency
    // contract in this function's doc comment.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_SYNC_ADVISORY_LOCK_KEY})`

    // Read the current values UNDER the advisory lock so the rebind
    // decision and the write are based on the same serialized view.
    const existing = await tx.setting.findMany({
      where: { key: { in: ['wc_url', 'wc_consumer_key', 'wc_consumer_secret'] } },
    })
    const existingMap = new Map(existing.map((s) => [s.key, s.value]))
    const prevUrl = existingMap.get('wc_url') ?? ''
    const prevKey = existingMap.get('wc_consumer_key') ?? ''
    const prevSecret = existingMap.get('wc_consumer_secret') ?? ''
    const effectiveSecret = incomingSecretIsMasked ? prevSecret : secret

    // "Rebind" = any of the three effective values actually differs from
    // what's already stored. A no-op save (operator opened the form and
    // clicked Save without touching fields) leaves everything equal and
    // does NOT wipe the cache. The masked-secret passthrough is handled
    // above so a re-save with the masked placeholder is NOT seen as a
    // secret change.
    const isRebind =
      url !== prevUrl || key !== prevKey || effectiveSecret !== prevSecret

    await tx.setting.upsert({
      where: { key: 'wc_url' },
      create: { key: 'wc_url', value: url },
      update: { value: url },
    })
    await tx.setting.upsert({
      where: { key: 'wc_consumer_key' },
      create: { key: 'wc_consumer_key', value: key },
      update: { value: key },
    })
    if (secret && !incomingSecretIsMasked) {
      await tx.setting.upsert({
        where: { key: 'wc_consumer_secret' },
        create: { key: 'wc_consumer_secret', value: secret },
        update: { value: secret },
      })
    }

    if (!isRebind) {
      return { isRebind, wipedMappings: 0 }
    }

    // Bump the settings version. Any stock sync that snapshotted the
    // old value will observe this bump on its next persist attempt
    // (also advisory-lock-guarded) and abort instead of writing.
    const currentVersion = await tx.setting.findUnique({
      where: { key: WC_SETTINGS_VERSION_KEY },
    })
    const nextVersion = String(
      (Number.parseInt(currentVersion?.value ?? '0', 10) || 0) + 1,
    )
    await tx.setting.upsert({
      where: { key: WC_SETTINGS_VERSION_KEY },
      create: { key: WC_SETTINGS_VERSION_KEY, value: nextVersion },
      update: { value: nextVersion },
    })

    // Wipe the cache in the same transaction. A crash between the
    // credentials write and the wipe would otherwise leave the cache
    // pointing at an ambiguous store.
    const wiped = await tx.product.updateMany({
      where: { wcProductId: { not: null } },
      data: { wcProductId: null },
    })
    return { isRebind, wipedMappings: wiped.count }
  })

  await logActivity({
    entityType: 'SETTING',
    tag: 'settings',
    action: 'updated',
    description: saveOutcome.isRebind
      ? `Updated WooCommerce connection credentials — cleared ${saveOutcome.wipedMappings} cached wcProductId mapping(s)`
      : 'Updated WooCommerce connection credentials (no change detected, cache preserved)',
    metadata: { isRebind: saveOutcome.isRebind, wipedMappings: saveOutcome.wipedMappings },
  })
  revalidatePath('/sync')
  return { success: true, wipedMappings: saveOutcome.wipedMappings }
}

/**
 * Operator-invoked nuclear reset of the `wcProductId` cache.
 *
 * Intended for recovery after out-of-band settings edits (manual DB
 * writes, fixture loads, backup restores) that `saveWcCredentials`
 * never saw and therefore could not auto-wipe. Also serves as a
 * panic button if an operator suspects the cache is corrupted for
 * any other reason.
 *
 * Nullifies every non-null `Product.wcProductId` in one update,
 * writes an activity log entry, and revalidates `/sync` so the UI
 * reflects the reset.
 */
export async function resetWcProductIdCache(): Promise<{ success: boolean; wipedMappings: number }> {
  await requireAdmin()
  // Serialize with in-flight stock syncs and bump the version so any
  // snapshotted run aborts on its next persist attempt — same contract
  // as `saveWcCredentials`, minus the credentials writes themselves.
  const wipedCount = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_SYNC_ADVISORY_LOCK_KEY})`
    const currentVersion = await tx.setting.findUnique({
      where: { key: WC_SETTINGS_VERSION_KEY },
    })
    const nextVersion = String(
      (Number.parseInt(currentVersion?.value ?? '0', 10) || 0) + 1,
    )
    await tx.setting.upsert({
      where: { key: WC_SETTINGS_VERSION_KEY },
      create: { key: WC_SETTINGS_VERSION_KEY, value: nextVersion },
      update: { value: nextVersion },
    })
    const cleared = await tx.product.updateMany({
      where: { wcProductId: { not: null } },
      data: { wcProductId: null },
    })
    return cleared.count
  })
  await logActivity({
    entityType: 'SETTING',
    tag: 'settings',
    action: 'updated',
    description: `Operator reset — cleared ${wipedCount} cached wcProductId mapping(s)`,
    metadata: { wipedMappings: wipedCount },
  })
  revalidatePath('/sync')
  return { success: true, wipedMappings: wipedCount }
}

export async function getWcCredentials(): Promise<{ url: string; key: string; secret: string; secretMasked: boolean }> {
  await requireAdmin()
  const rows = await db.setting.findMany({ where: { key: { in: ['wc_url', 'wc_consumer_key', 'wc_consumer_secret'] } } })
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const secret = map.get('wc_consumer_secret') ?? ''
  return {
    url: map.get('wc_url') ?? '',
    key: map.get('wc_consumer_key') ?? '',
    // Never send full secret to client — mask it
    secret: secret ? `${secret.slice(0, 7)}${'*'.repeat(Math.max(0, secret.length - 7))}` : '',
    secretMasked: !!secret,
  }
}

// ---------------------------------------------------------------------------
// Tax rate mappings (WC rate id → IMS tax rate)
// ---------------------------------------------------------------------------

export type TaxRateMappingRow = {
  id: string
  wcTaxRateId: number
  wcName: string
  wcCountry: string | null
  wcRatePct: number
  wcClass: string | null
  taxRateId: string
  taxRateName: string
}

export async function getWcTaxRateMappings(): Promise<TaxRateMappingRow[]> {
  await requireAdmin()
  const rows = await db.wcTaxRateMapping.findMany({
    include: { taxRate: { select: { name: true } } },
    orderBy: [{ wcCountry: 'asc' }, { wcName: 'asc' }],
  })
  return rows.map((r) => ({
    id: r.id,
    wcTaxRateId: r.wcTaxRateId,
    wcName: r.wcName,
    wcCountry: r.wcCountry,
    wcRatePct: Number(r.wcRatePct),
    wcClass: r.wcClass,
    taxRateId: r.taxRateId,
    taxRateName: r.taxRate.name,
  }))
}

export async function updateWcTaxRateMapping(
  wcTaxRateId: number,
  taxRateId: string,
): Promise<{ success: boolean }> {
  await requireAdmin()
  await db.wcTaxRateMapping.update({
    where: { wcTaxRateId },
    data: { taxRateId },
  })
  revalidatePath('/sync')
  return { success: true }
}

export async function deleteWcTaxRateMapping(id: string): Promise<{ success: boolean }> {
  await requireAdmin()
  await db.wcTaxRateMapping.delete({ where: { id } })
  revalidatePath('/sync')
  return { success: true }
}

export async function importWcTaxRatesFromApi(): Promise<{
  success: boolean
  importedRates?: number
  reusedRates?: number
  mappedRates?: number
  errors?: string[]
  error?: string
}> {
  try {
    await requireAdmin()
    const { importWcTaxRates } = await import('@/lib/connectors/woocommerce/sync/taxes')
    const result = await importWcTaxRates()

    await logActivity({
      entityType: 'SETTING',
      tag: 'sync',
      action: 'wc_tax_rates_imported',
      description: `Imported ${result.importedRates} new VAT rate(s), reused ${result.reusedRates} existing, mapped ${result.mappedRates} WC tax rate(s) from WooCommerce`,
      metadata: result as unknown as Record<string, unknown>,
    })

    revalidatePath('/sync')
    revalidatePath('/settings/accounting')
    return {
      success: true,
      importedRates: result.importedRates,
      reusedRates: result.reusedRates,
      mappedRates: result.mappedRates,
      errors: result.errors,
    }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Status mappings
// ---------------------------------------------------------------------------

export type StatusMappingRow = {
  id: string
  wcStatus: string
  imsStatus: string
}

export async function getWcStatusMappings(): Promise<StatusMappingRow[]> {
  await requireAdmin()
  const rows = await db.wcStatusMapping.findMany({ orderBy: { wcStatus: 'asc' } })
  return rows.map((r) => ({ id: r.id, wcStatus: r.wcStatus, imsStatus: r.imsStatus }))
}

export async function upsertWcStatusMapping(wcStatus: string, imsStatus: string): Promise<{ success: boolean }> {
  await requireAdmin()
  await db.wcStatusMapping.upsert({
    where: { wcStatus },
    create: { wcStatus, imsStatus: imsStatus as never },
    update: { imsStatus: imsStatus as never },
  })
  revalidatePath('/sync')
  return { success: true }
}

// ---------------------------------------------------------------------------
// Sync logs
// ---------------------------------------------------------------------------

export type SyncLogRow = {
  id: string
  direction: string
  status: string
  entityType: string
  entityId: string | null
  wcId: number | null
  errorMessage: string | null
  syncedAt: string | null
  createdAt: string
}

export async function getWcSyncLogs(limit = 50): Promise<SyncLogRow[]> {
  await requireAdmin()
  const rows = await db.wcSyncLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  return rows.map((r) => ({
    id: r.id,
    direction: r.direction,
    status: r.status,
    entityType: r.entityType,
    entityId: r.entityId,
    wcId: r.wcId,
    errorMessage: r.errorMessage,
    syncedAt: r.syncedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }))
}

// ---------------------------------------------------------------------------
// Auto-create WooCommerce webhooks
// ---------------------------------------------------------------------------

const WC_WEBHOOK_DEFS = [
  { name: 'OTI – Order created',   topic: 'order.created',   path: '/api/webhooks/woocommerce/orders' },
  { name: 'OTI – Order updated',   topic: 'order.updated',   path: '/api/webhooks/woocommerce/orders' },
  { name: 'OTI – Product updated', topic: 'product.updated', path: '/api/webhooks/woocommerce/products' },
] as const

export async function createWcWebhooks(): Promise<{
  success: boolean
  created: number
  existing: number
  errors: string[]
}> {
  await requireAdmin()

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) return { success: false, created: 0, existing: 0, errors: ['NEXT_PUBLIC_APP_URL is not set'] }

  // Read webhook secret from DB — must exist
  const secretRow = await db.setting.findUnique({ where: { key: 'wc_webhook_secret' } })
  if (!secretRow?.value) {
    return { success: false, created: 0, existing: 0, errors: ['Webhook secret not configured — generate one first'] }
  }
  const secret = secretRow.value

  const { wcFetch, wcPost } = await import('@/lib/connectors/woocommerce/api')

  // List existing webhooks to avoid duplicates
  const { data: existing, error: listError } = await wcFetch('/webhooks', { per_page: '100' })
  if (listError) return { success: false, created: 0, existing: 0, errors: [listError] }

  const existingWebhooks = Array.isArray(existing) ? existing as Array<{ topic?: string; delivery_url?: string }> : []

  let created = 0
  let alreadyExist = 0
  const errors: string[] = []

  for (const def of WC_WEBHOOK_DEFS) {
    const deliveryUrl = `${appUrl}${def.path}`

    const isDuplicate = existingWebhooks.some(
      (wh) => wh.topic === def.topic && wh.delivery_url === deliveryUrl,
    )
    if (isDuplicate) {
      alreadyExist++
      continue
    }

    const { error } = await wcPost('/webhooks', {
      name: def.name,
      topic: def.topic,
      delivery_url: deliveryUrl,
      secret,
      status: 'active',
    })
    if (error) {
      errors.push(`${def.topic}: ${error}`)
    } else {
      created++
    }
  }

  if (created > 0) {
    await logActivity({
      entityType: 'SETTING',
      tag: 'sync',
      action: 'wc_webhooks_created',
      description: `Created ${created} WooCommerce webhook(s)${alreadyExist > 0 ? `, ${alreadyExist} already existed` : ''}`,
    })
  }

  return { success: errors.length === 0, created, existing: alreadyExist, errors }
}

// ---------------------------------------------------------------------------
// Manual sync triggers
// ---------------------------------------------------------------------------

/**
 * Fetch active (enabled) WooCommerce payment gateways. Used to populate the
 * payment method dropdown in the accounting integration's payment account
 * mapping. Returns an empty list if WC is not connected or the call fails —
 * the UI will simply fall back to free-text entry or historical combos.
 */
export async function getWcActivePaymentGateways(): Promise<Array<{ id: string; title: string }>> {
  await requireAdmin()
  try {
    const { wcFetch } = await import('@/lib/connectors/woocommerce/api')
    const { data, error } = await wcFetch('/payment_gateways')
    if (error || !Array.isArray(data)) return []
    return (data as Array<{ id?: string; title?: string; method_title?: string; enabled?: boolean }>)
      .filter((g) => g.enabled && typeof g.id === 'string')
      .map((g) => ({ id: g.id as string, title: g.title || g.method_title || (g.id as string) }))
  } catch {
    return []
  }
}

export async function triggerManualSync(type: 'orders' | 'products' | 'stock'): Promise<{ success: boolean; result?: unknown; error?: string }> {
  await requireAdmin()
  try {
    if (type === 'orders') {
      const { syncNewWcOrders } = await import('@/lib/connectors/woocommerce/sync/order-import')
      const result = await syncNewWcOrders()
      return { success: true, result }
    }
    if (type === 'products') {
      const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
      const result = await syncAllWcProducts()
      return { success: true, result }
    }
    if (type === 'stock') {
      const { pushStockToWc } = await import('@/lib/connectors/woocommerce/sync/stock-sync')
      const result = await pushStockToWc()
      return { success: true, result }
    }
    return { success: false, error: 'Unknown sync type' }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}
