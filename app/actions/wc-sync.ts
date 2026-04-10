'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { auth } from '@/lib/auth'

async function requireAdmin() {
  const session = await auth()
  if (!session?.user?.id || !['ADMIN', 'MANAGER'].includes(session.user.role)) throw new Error('Unauthorized')
  return session
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
  last_wc_order_sync_at: string
  last_wc_product_sync_at: string
  last_wc_stock_sync_at: string
}

const SYNC_SETTING_KEYS = [
  'wc_sync_enabled', 'wc_sync_order_statuses', 'wc_sync_interval_minutes',
  'wc_sync_product_enabled', 'wc_sync_product_direction', 'wc_stock_sync_enabled', 'wc_cogs_sync_enabled',
  'wc_webhook_secret', 'last_wc_order_sync_at', 'last_wc_product_sync_at', 'last_wc_stock_sync_at',
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
  last_wc_order_sync_at: '',
  last_wc_product_sync_at: '',
  last_wc_stock_sync_at: '',
}

export async function getWcSyncSettings(): Promise<WcSyncSettings> {
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
  logActivity({ entityType: 'SETTING', tag: 'settings', action: 'updated', description: 'Updated WooCommerce sync settings' })
  revalidatePath('/sync')
  return { success: true }
}

// ---------------------------------------------------------------------------
// WC connection credentials
// ---------------------------------------------------------------------------

export async function saveWcCredentials(url: string, key: string, secret: string): Promise<{ success: boolean }> {
  await requireAdmin()
  const ops = [
    db.setting.upsert({ where: { key: 'wc_url' }, create: { key: 'wc_url', value: url }, update: { value: url } }),
    db.setting.upsert({ where: { key: 'wc_consumer_key' }, create: { key: 'wc_consumer_key', value: key }, update: { value: key } }),
  ]
  // Only update secret if it's not the masked value (contains no asterisks)
  if (secret && !secret.includes('*')) {
    ops.push(db.setting.upsert({ where: { key: 'wc_consumer_secret' }, create: { key: 'wc_consumer_secret', value: secret }, update: { value: secret } }))
  }
  await db.$transaction(ops)
  logActivity({ entityType: 'SETTING', tag: 'settings', action: 'updated', description: 'Updated WooCommerce connection credentials' })
  revalidatePath('/sync')
  return { success: true }
}

export async function getWcCredentials(): Promise<{ url: string; key: string; secret: string; secretMasked: boolean }> {
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

    logActivity({
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
// Manual sync triggers
// ---------------------------------------------------------------------------

/**
 * Fetch active (enabled) WooCommerce payment gateways. Used to populate the
 * payment method dropdown in the accounting integration's payment account
 * mapping. Returns an empty list if WC is not connected or the call fails —
 * the UI will simply fall back to free-text entry or historical combos.
 */
export async function getWcActivePaymentGateways(): Promise<Array<{ id: string; title: string }>> {
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
