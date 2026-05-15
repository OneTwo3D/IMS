'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requirePermission } from '@/lib/auth/server'
import { decryptSettingValue } from '@/lib/security/encrypted-settings'
import {
  getActiveSettingEnvOverrides,
  getSettingValue,
  getSettingValues,
  serializeSettingValue,
} from '@/lib/settings-store'
import { validateWooCommerceBaseUrl } from '@/lib/connectors/woocommerce/url-safety'
import { wcFetch } from '@/lib/connectors/woocommerce/api'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { getPublicAppUrl } from '@/lib/public-app-url'
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
  wc_order_webhook_last_received_at: string
  wc_product_webhook_last_received_at: string
  last_wc_order_sync_at: string
  last_wc_order_reconcile_at: string
  last_wc_product_sync_at: string
  last_wc_product_reconcile_at: string
  last_wc_stock_sync_at: string
  wc_initial_import_completed: string
  wc_fx_push_enabled: string
  last_wc_fx_push_at: string
  envOverrides: Record<string, string>
}

const SYNC_SETTING_KEYS = [
  'wc_sync_enabled', 'wc_sync_order_statuses', 'wc_sync_interval_minutes',
  'wc_sync_product_enabled', 'wc_sync_product_direction', 'wc_stock_sync_enabled', 'wc_cogs_sync_enabled',
  'wc_webhook_secret', 'wc_webhook_last_received_at', 'wc_order_webhook_last_received_at', 'wc_product_webhook_last_received_at',
  'last_wc_order_sync_at', 'last_wc_order_reconcile_at', 'last_wc_product_sync_at', 'last_wc_product_reconcile_at', 'last_wc_stock_sync_at',
  'wc_initial_import_completed',
  'wc_fx_push_enabled', 'last_wc_fx_push_at',
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
  wc_order_webhook_last_received_at: '',
  wc_product_webhook_last_received_at: '',
  last_wc_order_sync_at: '',
  last_wc_order_reconcile_at: '',
  last_wc_product_sync_at: '',
  last_wc_product_reconcile_at: '',
  last_wc_stock_sync_at: '',
  wc_initial_import_completed: '',
  wc_fx_push_enabled: 'false',
  last_wc_fx_push_at: '',
  envOverrides: {},
}

export async function getWcSyncSettings(): Promise<WcSyncSettings> {
  await requireAdmin()
  const map = await getSettingValues(SYNC_SETTING_KEYS)
  const result = { ...SYNC_DEFAULTS }
  for (const k of Object.keys(result) as (keyof WcSyncSettings)[]) {
    if (k === 'envOverrides') continue
    const v = map.get(k)
    if (v) result[k] = v
  }
  result.envOverrides = getActiveSettingEnvOverrides(SYNC_SETTING_KEYS)
  return result
}

function extractWooStoreCurrency(data: unknown): string | null {
  if (Array.isArray(data)) {
    for (const row of data) {
      if (!row || typeof row !== 'object') continue
      const id = typeof (row as { id?: unknown }).id === 'string' ? (row as { id: string }).id : null
      const value = typeof (row as { value?: unknown }).value === 'string' ? (row as { value: string }).value : null
      if (id && value && (id === 'woocommerce_currency' || id === 'currency')) return value.toUpperCase()
    }
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    const id = typeof obj.id === 'string' ? obj.id : null
    const value = typeof obj.value === 'string' ? obj.value : null
    if (id && value && (id === 'woocommerce_currency' || id === 'currency')) {
      return value.toUpperCase()
    }
    const direct = obj.currency
    if (typeof direct === 'string' && direct) return direct.toUpperCase()
    const settings = obj.settings
    if (settings && typeof settings === 'object') {
      const general = (settings as Record<string, unknown>).general
      if (general && typeof general === 'object') {
        const currency = (general as Record<string, unknown>).currency
        if (typeof currency === 'string' && currency) return currency.toUpperCase()
      }
    }
    const environment = obj.environment
    if (environment && typeof environment === 'object') {
      const currency = (environment as Record<string, unknown>).currency
      if (typeof currency === 'string' && currency) return currency.toUpperCase()
    }
  }
  return null
}

async function validateWooStoreBaseCurrency(credentials?: { url: string; key: string; secret: string } | null): Promise<{ ok: true; storeCurrency: string; baseCurrency: string } | { ok: false; error: string }> {
  const baseCurrency = await getBaseCurrencyCode()
  const probes = [
    { label: 'settings/general/woocommerce_currency', response: await wcFetch('/settings/general/woocommerce_currency', {}, credentials ?? undefined) },
    { label: 'settings/general', response: await wcFetch('/settings/general', {}, credentials ?? undefined) },
    { label: 'system_status', response: await wcFetch('/system_status', {}, credentials ?? undefined) },
  ]
  const storeCurrency = probes
    .map((probe) => (probe.response.error ? null : extractWooStoreCurrency(probe.response.data)))
    .find((currency): currency is string => !!currency)

  if (!storeCurrency) {
    const probeErrors = probes
      .filter((probe) => probe.response.error)
      .map((probe) => `${probe.label}: ${probe.response.error}`)
    if (probeErrors.length > 0) {
      return { ok: false, error: `Could not determine the WooCommerce store currency. ${probeErrors.join(' ')}` }
    }
    return { ok: false, error: 'Could not determine the WooCommerce store currency from the API.' }
  }
  if (storeCurrency !== baseCurrency) {
    return { ok: false, error: `WooCommerce store currency (${storeCurrency}) must match the IMS base currency (${baseCurrency}).` }
  }
  return { ok: true, storeCurrency, baseCurrency }
}

export async function saveWcSyncSettings(data: Partial<WcSyncSettings>): Promise<{ success: boolean; error?: string }> {
  await requireAdmin()
  if (data.wc_sync_enabled === 'true') {
    const validation = await validateWooStoreBaseCurrency()
    if (!validation.ok) return { success: false, error: validation.error }
  }
  const ops = Object.entries(data)
    .filter((entry): entry is [string, string] => SYNC_SETTING_KEYS.includes(entry[0]) && typeof entry[1] === 'string')
    .map(([k, v]) =>
      db.setting.upsert({
        where: { key: k },
        create: { key: k, value: serializeSettingValue(k, v ?? '') },
        update: { value: serializeSettingValue(k, v ?? '') },
      }),
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
 * Cache-integrity contract: `Product.externalProductId` is an id against one
 * specific WooCommerce installation. Changing the store URL or the
 * consumer key means cached mappings may now point at unrelated
 * products on a different catalog. Rather than trying to detect
 * store identity from inside the sync path (which historically
 * collapsed into false "same store" decisions or flushed on routine
 * catalog edits), invalidation is enforced HERE, atomically with the
 * credentials write: if the effective url/key/secret changes, we
 * null every `externalProductId` in the same transaction that writes the
 * new values. The next sync re-resolves via SKU lookup against the
 * new store.
 *
 * Concurrency contract with in-flight stock syncs: a rebind must not
 * race a concurrently running `pushStockToWc`. The whole write
 * (credentials + cache wipe + version bump) runs inside a transaction
 * that first takes `pg_advisory_xact_lock(WC_SYNC_ADVISORY_LOCK_KEY)`.
 * `pushStockToWc` takes the same advisory lock when it snapshots its
 * credentials at start-of-run and again for every externalProductId write.
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
export async function saveWcCredentials(url: string, key: string, secret: string): Promise<{ success: boolean; wipedMappings: number; error?: string; message?: string }> {
  await requireAdmin()

  const validatedUrl = validateWooCommerceBaseUrl(url)
  if (!validatedUrl.ok) {
    return { success: false, wipedMappings: 0, error: validatedUrl.error }
  }

  const nextKey = key.trim()
  const nextSecret = secret.trim()
  const incomingKeyIsMasked = !!nextKey && nextKey.includes('*')
  const currentKey = incomingKeyIsMasked
    ? await getSettingValue('wc_consumer_key')
    : nextKey
  const incomingSecretIsMasked = !!nextSecret && nextSecret.includes('*')
  const shouldReuseStoredSecret = incomingSecretIsMasked || !nextSecret
  const currentSecret = shouldReuseStoredSecret
    ? await getSettingValue('wc_consumer_secret')
    : nextSecret
  const currencyValidation = await validateWooStoreBaseCurrency({
    url: validatedUrl.normalizedUrl,
    key: currentKey ?? '',
    secret: currentSecret ?? '',
  })
  if (!currencyValidation.ok) {
    return { success: false, wipedMappings: 0, error: currencyValidation.error }
  }

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
    const prevSecret = existingMap.get('wc_consumer_secret')
      ? decryptSettingValue('wc_consumer_secret', existingMap.get('wc_consumer_secret')!)
      : ''
    const effectiveKey = incomingKeyIsMasked ? prevKey : nextKey
    const effectiveSecret = shouldReuseStoredSecret ? prevSecret : nextSecret

    // "Rebind" = any of the three effective values actually differs from
    // what's already stored. A no-op save (operator opened the form and
    // clicked Save without touching fields) leaves everything equal and
    // does NOT wipe the cache. The masked credential passthrough is handled
    // above so a re-save with masked placeholders is NOT seen as a change.
    const isRebind =
      validatedUrl.normalizedUrl !== prevUrl || effectiveKey !== prevKey || effectiveSecret !== prevSecret

    await tx.setting.upsert({
      where: { key: 'wc_url' },
      create: { key: 'wc_url', value: validatedUrl.normalizedUrl },
      update: { value: validatedUrl.normalizedUrl },
    })
    if (nextKey && !incomingKeyIsMasked) {
      await tx.setting.upsert({
        where: { key: 'wc_consumer_key' },
        create: { key: 'wc_consumer_key', value: nextKey },
        update: { value: nextKey },
      })
    }
    if (nextSecret && !incomingSecretIsMasked) {
      await tx.setting.upsert({
        where: { key: 'wc_consumer_secret' },
        create: { key: 'wc_consumer_secret', value: serializeSettingValue('wc_consumer_secret', nextSecret) },
        update: { value: serializeSettingValue('wc_consumer_secret', nextSecret) },
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
      where: { externalProductId: { not: null } },
      data: { externalProductId: null },
    })
    return { isRebind, wipedMappings: wiped.count }
  })

  await logActivity({
    entityType: 'SETTING',
    tag: 'settings',
    action: 'updated',
    description: saveOutcome.isRebind
      ? `Updated WooCommerce connection credentials — cleared ${saveOutcome.wipedMappings} cached externalProductId mapping(s)`
      : 'Updated WooCommerce connection credentials (no change detected, cache preserved)',
    metadata: { isRebind: saveOutcome.isRebind, wipedMappings: saveOutcome.wipedMappings },
  })
  revalidatePath('/sync')
  return {
    success: true,
    wipedMappings: saveOutcome.wipedMappings,
    message: `Connection verified against WooCommerce (${currencyValidation.storeCurrency}).`,
  }
}

/**
 * Operator-invoked nuclear reset of the `externalProductId` cache.
 *
 * Intended for recovery after out-of-band settings edits (manual DB
 * writes, fixture loads, backup restores) that `saveWcCredentials`
 * never saw and therefore could not auto-wipe. Also serves as a
 * panic button if an operator suspects the cache is corrupted for
 * any other reason.
 *
 * Nullifies every non-null `Product.externalProductId` in one update,
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
      where: { externalProductId: { not: null } },
      data: { externalProductId: null },
    })
    return cleared.count
  })
  await logActivity({
    entityType: 'SETTING',
    tag: 'settings',
    action: 'updated',
    description: `Operator reset — cleared ${wipedCount} cached externalProductId mapping(s)`,
    metadata: { wipedMappings: wipedCount },
  })
  revalidatePath('/sync')
  return { success: true, wipedMappings: wipedCount }
}

export async function getWcCredentials(): Promise<{ url: string; key: string; secret: string; secretMasked: boolean; envOverrides: Record<string, string> }> {
  await requireAdmin()
  const map = await getSettingValues(['wc_url', 'wc_consumer_key', 'wc_consumer_secret'])
  const key = map.get('wc_consumer_key') ?? ''
  const secret = map.get('wc_consumer_secret') ?? ''
  return {
    url: map.get('wc_url') ?? '',
    // Never send full credentials to client — mask them
    key: key ? `${key.slice(0, 7)}${'*'.repeat(Math.max(0, key.length - 7))}` : '',
    secret: secret ? `${secret.slice(0, 7)}${'*'.repeat(Math.max(0, secret.length - 7))}` : '',
    secretMasked: !!secret,
    envOverrides: getActiveSettingEnvOverrides(['wc_consumer_key', 'wc_consumer_secret']),
  }
}

// ---------------------------------------------------------------------------
// Tax rate mappings (WC rate id → IMS tax rate)
// ---------------------------------------------------------------------------

export type TaxRateMappingRow = {
  id: string
  externalTaxRateId: string
  externalName: string
  externalCountry: string | null
  externalRatePct: number
  externalClass: string | null
  taxRateId: string
  taxRateName: string
}

export async function getShoppingTaxRateMappings(): Promise<TaxRateMappingRow[]> {
  await requireAdmin()
  const rows = await db.shoppingTaxRateMapping.findMany({
    where: { connector: 'woocommerce' },
    include: { taxRate: { select: { name: true } } },
    orderBy: [{ externalCountry: 'asc' }, { externalName: 'asc' }],
  })
  return rows.map((r) => ({
    id: r.id,
    externalTaxRateId: r.externalTaxRateId,
    externalName: r.externalName,
    externalCountry: r.externalCountry,
    externalRatePct: Number(r.externalRatePct),
    externalClass: r.externalClass,
    taxRateId: r.taxRateId,
    taxRateName: r.taxRate.name,
  }))
}

export async function updateShoppingTaxRateMapping(
  externalTaxRateId: string,
  taxRateId: string,
): Promise<{ success: boolean }> {
  await requireAdmin()
  await db.shoppingTaxRateMapping.update({
    where: {
      connector_externalTaxRateId: {
        connector: 'woocommerce',
        externalTaxRateId,
      },
    },
    data: { taxRateId },
  })
  revalidatePath('/sync')
  return { success: true }
}

export async function deleteShoppingTaxRateMapping(id: string): Promise<{ success: boolean }> {
  await requireAdmin()
  await db.shoppingTaxRateMapping.delete({ where: { id } })
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
  externalStatus: string
  imsStatus: string
}

export async function getShoppingStatusMappings(): Promise<StatusMappingRow[]> {
  await requireAdmin()
  const rows = await db.shoppingStatusMapping.findMany({
    where: { connector: 'woocommerce' },
    orderBy: { externalStatus: 'asc' },
  })
  return rows.map((r) => ({ id: r.id, externalStatus: r.externalStatus, imsStatus: r.imsStatus }))
}

export async function upsertShoppingStatusMapping(externalStatus: string, imsStatus: string): Promise<{ success: boolean }> {
  await requireAdmin()
  await db.shoppingStatusMapping.upsert({
    where: {
      connector_externalStatus: {
        connector: 'woocommerce',
        externalStatus,
      },
    },
    create: { connector: 'woocommerce', externalStatus, imsStatus: imsStatus as never },
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
  externalId: string | null
  errorMessage: string | null
  syncedAt: string | null
  createdAt: string
}

export async function getShoppingSyncLogs(limit = 50): Promise<SyncLogRow[]> {
  await requireAdmin()
  const rows = await db.shoppingSyncLog.findMany({
    where: { connector: 'woocommerce' },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  return rows.map((r) => ({
    id: r.id,
    direction: r.direction,
    status: r.status,
    entityType: r.entityType,
    entityId: r.entityId,
    externalId: r.externalId,
    errorMessage: r.errorMessage,
    syncedAt: r.syncedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }))
}

// ---------------------------------------------------------------------------
// Auto-create WooCommerce webhooks
// ---------------------------------------------------------------------------

const WC_WEBHOOK_DEFS = [
  { name: 'OTI – Order created',   topic: 'order.created',   path: '/api/webhooks/shopping/woocommerce/orders' },
  { name: 'OTI – Order updated',   topic: 'order.updated',   path: '/api/webhooks/shopping/woocommerce/orders' },
  { name: 'OTI – Refund created',  topic: 'refund.created',  path: '/api/webhooks/shopping/woocommerce/orders' },
  { name: 'OTI – Product updated', topic: 'product.updated', path: '/api/webhooks/shopping/woocommerce/products' },
] as const

export async function createWcWebhooks(): Promise<{
  success: boolean
  created: number
  existing: number
  errors: string[]
}> {
  await requireAdmin()

  const appUrl = await getPublicAppUrl()
  if (!appUrl) return { success: false, created: 0, existing: 0, errors: ['Public app URL is not configured'] }

  const secret = await getSettingValue('wc_webhook_secret')
  if (!secret) {
    return { success: false, created: 0, existing: 0, errors: ['Webhook secret not configured — generate one first'] }
  }

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

function toSerializableResult(result: unknown): unknown {
  if (result == null) return result
  return JSON.parse(JSON.stringify(result))
}

export async function probeFxHelperPluginAction(): Promise<{
  status: 'OK' | 'NOT_INSTALLED' | 'BAD_SECRET' | 'NOT_CONFIGURED' | 'UNREACHABLE'
  httpStatus?: number
  message: string
}> {
  await requireAdmin()
  const { probeFxHelperPlugin } = await import('@/lib/connectors/woocommerce/fx-rates')
  return probeFxHelperPlugin()
}

export async function pushFxRatesToWcNow(): Promise<{ success: boolean; pushed: number; supported: boolean; error?: string }> {
  await requireAdmin()
  try {
    const { pushCurrentFxRatesToWc } = await import('@/lib/connectors/woocommerce/fx-rates')
    const result = await pushCurrentFxRatesToWc()
    if (!result.supported) {
      return { success: false, pushed: 0, supported: false, error: result.errors[0] ?? 'FX rate push not enabled or WooCommerce not configured' }
    }
    if (result.errors.length) {
      await db.fxRatePushLog.create({
        data: {
          connector: 'woocommerce',
          ratesCount: result.pushed,
          status: 'FAILED',
          errorMessage: result.errors.join('; ').slice(0, 500),
        },
      })
      return { success: false, pushed: result.pushed, supported: true, error: result.errors.join('; ') }
    }
    await db.fxRatePushLog.create({
      data: { connector: 'woocommerce', ratesCount: result.pushed, status: 'OK' },
    })
    await db.setting.upsert({
      where: { key: 'last_wc_fx_push_at' },
      create: { key: 'last_wc_fx_push_at', value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    })
    await logActivity({ entityType: 'SYNC', tag: 'sync', action: 'fx_rates_pushed', description: `Manually pushed ${result.pushed} FX rate(s) to WooCommerce` })
    revalidatePath('/sync')
    return { success: true, pushed: result.pushed, supported: true }
  } catch (e) {
    return { success: false, pushed: 0, supported: true, error: String(e) }
  }
}

export async function triggerManualSync(type: 'orders' | 'products' | 'stock'): Promise<{ success: boolean; result?: unknown; error?: string }> {
  await requireAdmin()
  try {
    if (type === 'orders') {
      const { syncNewWcOrders } = await import('@/lib/connectors/woocommerce/sync/order-import')
      const result = await syncNewWcOrders({ mode: 'manual_reconcile' })
      return { success: true, result: toSerializableResult(result) }
    }
    if (type === 'products') {
      const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
      const result = await syncAllWcProducts({ mode: 'manual_reconcile' })
      return { success: true, result: toSerializableResult(result) }
    }
    if (type === 'stock') {
      const { pushStockToWc } = await import('@/lib/connectors/woocommerce/sync/stock-sync')
      const result = await pushStockToWc({ forceAll: true, source: 'MANUAL' })
      return { success: true, result: toSerializableResult(result) }
    }
    return { success: false, error: 'Unknown sync type' }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}
