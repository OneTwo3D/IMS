'use server'

import { revalidatePath } from 'next/cache'
import {
  createWcWebhooks,
  deleteShoppingTaxRateMapping as deleteShoppingTaxRateMappingImpl,
  getWcActivePaymentGateways,
  getWcCredentials,
  getShoppingStatusMappings as getShoppingStatusMappingsImpl,
  getShoppingSyncLogs as getShoppingSyncLogsImpl,
  getWcSyncSettings,
  getShoppingTaxRateMappings as getShoppingTaxRateMappingsImpl,
  importWcTaxRatesFromApi,
  resetWcProductIdCache,
  probeFxHelperPluginAction,
  pushFxRatesToWcNow,
  saveWcCredentials,
  saveWcSyncSettings,
  triggerManualSync,
  updateShoppingTaxRateMapping as updateShoppingTaxRateMappingImpl,
  upsertShoppingStatusMapping as upsertShoppingStatusMappingImpl,
  type SyncLogRow,
  type StatusMappingRow,
  type TaxRateMappingRow,
  type WcSyncSettings,
} from '@/app/actions/wc-sync'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requirePermission } from '@/lib/auth/server'
import { shopifyGraphql } from '@/lib/connectors/shopify/api'
import {
  getActiveSettingEnvOverrides,
  getSettingValue,
  getSettingValues,
  serializeSettingValue,
} from '@/lib/settings-store'
import { getActiveShoppingConnectorInfo, syncShoppingConnectorStock } from '@/lib/shopping'
import type { ShoppingConnectorId } from '@/lib/connectors/shopping-registry'

export type ShoppingSyncSettings = WcSyncSettings
export type ShoppingTaxRateMappingRow = TaxRateMappingRow
export type ShoppingStatusMappingRow = StatusMappingRow
export type ShoppingSyncLogRow = SyncLogRow
export type ShoppingConnectorCredentials = {
  url: string
  key: string
  secret: string
  secretMasked: boolean
  envOverrides: Record<string, string>
}
export type ShopifySyncSettings = {
  shopify_sync_enabled: string
}
export type ShopifyConnectorCredentials = {
  storeDomain: string
  adminApiAccessToken: string
  accessTokenMasked: boolean
  webhookSecret: string
  webhookSecretMasked: boolean
  envOverrides: Record<string, string>
}

const SHOPIFY_SYNC_SETTING_KEYS = ['shopify_sync_enabled'] as const
const SHOPIFY_SYNC_DEFAULTS: ShopifySyncSettings = {
  shopify_sync_enabled: 'false',
}

type ShopifyConnectionTestResponse = {
  shop: {
    name: string
    myshopifyDomain: string
  } | null
}

function normalizeShopifyStoreDomain(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  try {
    const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    const url = new URL(withProtocol)
    return url.hostname.toLowerCase() || null
  } catch {
    return null
  }
}

async function requireShoppingAdmin() {
  return requirePermission('sync')
}

function maskSecret(value: string, visibleChars = 7): string {
  if (!value) return ''
  if (value.length <= visibleChars) return '*'.repeat(value.length)
  return `${value.slice(0, visibleChars)}${'*'.repeat(Math.max(0, value.length - visibleChars))}`
}

function mapSyncLogRows(
  rows: Array<{
    id: string
    direction: string
    status: string
    entityType: string
    entityId: string | null
    externalId: string | null
    errorMessage: string | null
    syncedAt: Date | null
    createdAt: Date
  }>,
): ShoppingSyncLogRow[] {
  return rows.map((row) => ({
    id: row.id,
    direction: row.direction,
    status: row.status,
    entityType: row.entityType,
    entityId: row.entityId,
    externalId: row.externalId,
    errorMessage: row.errorMessage,
    syncedAt: row.syncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }))
}

export async function getShoppingIntegrationConnector() {
  return getActiveShoppingConnectorInfo()
}

export async function getShoppingSyncSettings(): Promise<ShoppingSyncSettings> {
  return getWcSyncSettings()
}

export async function saveShoppingSyncSettings(data: Partial<ShoppingSyncSettings>): Promise<{ success: boolean; error?: string }> {
  return saveWcSyncSettings(data)
}

export async function getShoppingConnectorCredentials(): Promise<ShoppingConnectorCredentials> {
  return getWcCredentials()
}

export async function saveShoppingConnectorCredentials(url: string, key: string, secret: string) {
  return saveWcCredentials(url, key, secret)
}

export async function resetShoppingProductIdCache() {
  return resetWcProductIdCache()
}

export async function getShoppingTaxRateMappings(): Promise<ShoppingTaxRateMappingRow[]> {
  return getShoppingTaxRateMappingsImpl()
}

export async function updateShoppingTaxRateMapping(externalTaxRateId: string, taxRateId: string) {
  return updateShoppingTaxRateMappingImpl(externalTaxRateId, taxRateId)
}

export async function deleteShoppingTaxRateMapping(id: string) {
  return deleteShoppingTaxRateMappingImpl(id)
}

export async function importShoppingTaxRatesFromApi() {
  return importWcTaxRatesFromApi()
}

export async function getShoppingStatusMappings(): Promise<ShoppingStatusMappingRow[]> {
  return getShoppingStatusMappingsImpl()
}

export async function upsertShoppingStatusMapping(externalStatus: string, imsStatus: string) {
  return upsertShoppingStatusMappingImpl(externalStatus, imsStatus)
}

export async function getShoppingSyncLogs(limit = 50): Promise<ShoppingSyncLogRow[]> {
  return getShoppingSyncLogsImpl(limit)
}

export async function createShoppingWebhooks() {
  return createWcWebhooks()
}

export async function getShoppingConnectorPaymentMethods(): Promise<Array<{ id: string; title: string }>> {
  return getWcActivePaymentGateways()
}

export async function triggerShoppingManualSync(type: 'orders' | 'products' | 'stock') {
  return triggerManualSync(type)
}

export async function pushShoppingFxRatesNow() {
  return pushFxRatesToWcNow()
}

export async function probeShoppingFxHelperPlugin() {
  return probeFxHelperPluginAction()
}

export async function getShopifySyncSettings(): Promise<ShopifySyncSettings> {
  await requireShoppingAdmin()
  const map = await getSettingValues([...SHOPIFY_SYNC_SETTING_KEYS])
  const result = { ...SHOPIFY_SYNC_DEFAULTS }
  for (const key of Object.keys(result) as (keyof ShopifySyncSettings)[]) {
    const value = map.get(key)
    if (value) result[key] = value
  }
  return result
}

export async function saveShopifySyncSettings(data: Partial<ShopifySyncSettings>): Promise<{ success: boolean; error?: string }> {
  await requireShoppingAdmin()
  const operations = Object.entries(data)
    .filter(([key]) => SHOPIFY_SYNC_SETTING_KEYS.includes(key as (typeof SHOPIFY_SYNC_SETTING_KEYS)[number]))
    .map(([key, value]) => (
      db.setting.upsert({
        where: { key },
        create: { key, value: serializeSettingValue(key, value ?? '') },
        update: { value: serializeSettingValue(key, value ?? '') },
      })
    ))

  if (operations.length > 0) {
    await db.$transaction(operations)
    await logActivity({
      entityType: 'SETTING',
      tag: 'settings',
      action: 'updated',
      description: 'Updated Shopify sync settings',
      metadata: { keys: Object.keys(data) },
    })
    revalidatePath('/sync')
  }

  return { success: true }
}

export async function getShopifyConnectorCredentials(): Promise<ShopifyConnectorCredentials> {
  await requireShoppingAdmin()
  const map = await getSettingValues([
    'shopify_store_domain',
    'shopify_admin_api_access_token',
    'shopify_webhook_secret',
  ])

  const adminApiAccessToken = map.get('shopify_admin_api_access_token') ?? ''
  const webhookSecret = map.get('shopify_webhook_secret') ?? ''

  return {
    storeDomain: map.get('shopify_store_domain') ?? '',
    adminApiAccessToken: maskSecret(adminApiAccessToken),
    accessTokenMasked: !!adminApiAccessToken,
    webhookSecret: maskSecret(webhookSecret),
    webhookSecretMasked: !!webhookSecret,
    envOverrides: getActiveSettingEnvOverrides([
      'shopify_admin_api_access_token',
      'shopify_webhook_secret',
    ]),
  }
}

export async function saveShopifyConnectorCredentials(
  storeDomain: string,
  adminApiAccessToken: string,
  webhookSecret: string,
): Promise<{ success: boolean; error?: string; message?: string }> {
  await requireShoppingAdmin()

  const normalizedDomain = normalizeShopifyStoreDomain(storeDomain)
  if (!normalizedDomain) {
    return { success: false, error: 'Store domain is required' }
  }

  const incomingTokenIsMasked = !!adminApiAccessToken && adminApiAccessToken.includes('*')
  const incomingWebhookSecretIsMasked = !!webhookSecret && webhookSecret.includes('*')

  const [currentToken, currentWebhookSecret] = await Promise.all([
    incomingTokenIsMasked ? getSettingValue('shopify_admin_api_access_token') : Promise.resolve(adminApiAccessToken),
    incomingWebhookSecretIsMasked ? getSettingValue('shopify_webhook_secret') : Promise.resolve(webhookSecret),
  ])

  const nextToken = (currentToken ?? '').trim()
  if (!nextToken) {
    return { success: false, error: 'Admin API access token is required' }
  }

  const connectionTest = await shopifyGraphql<ShopifyConnectionTestResponse>(
    'query ShopifyConnectionTest { shop { name myshopifyDomain } }',
    undefined,
    {
      url: `https://${normalizedDomain}`,
      key: nextToken,
      secret: (currentWebhookSecret ?? '').trim(),
      storeDomain: normalizedDomain,
      adminApiAccessToken: nextToken,
      webhookSecret: (currentWebhookSecret ?? '').trim(),
    },
  )

  if (connectionTest.error) {
    return { success: false, error: connectionTest.error }
  }

  if (!connectionTest.data?.shop) {
    return { success: false, error: 'Shopify did not return shop details for these credentials.' }
  }

  await db.$transaction([
    db.setting.upsert({
      where: { key: 'shopify_store_domain' },
      create: { key: 'shopify_store_domain', value: normalizedDomain },
      update: { value: normalizedDomain },
    }),
    db.setting.upsert({
      where: { key: 'shopify_admin_api_access_token' },
      create: {
        key: 'shopify_admin_api_access_token',
        value: serializeSettingValue('shopify_admin_api_access_token', nextToken),
      },
      update: {
        value: serializeSettingValue('shopify_admin_api_access_token', nextToken),
      },
    }),
    db.setting.upsert({
      where: { key: 'shopify_webhook_secret' },
      create: {
        key: 'shopify_webhook_secret',
        value: serializeSettingValue('shopify_webhook_secret', (currentWebhookSecret ?? '').trim()),
      },
      update: {
        value: serializeSettingValue('shopify_webhook_secret', (currentWebhookSecret ?? '').trim()),
      },
    }),
  ])

  await logActivity({
    entityType: 'SETTING',
    tag: 'settings',
    action: 'updated',
    description: 'Updated Shopify connector credentials',
    metadata: { storeDomain: normalizedDomain },
  })

  revalidatePath('/sync')
  return {
    success: true,
    message: `Connection verified for ${connectionTest.data.shop.name || connectionTest.data.shop.myshopifyDomain}.`,
  }
}

export async function getShopifySyncLogs(limit = 50): Promise<ShoppingSyncLogRow[]> {
  await requireShoppingAdmin()
  const rows = await db.shoppingSyncLog.findMany({
    where: { connector: 'shopify' },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  return mapSyncLogRows(rows)
}

export async function triggerShopifyManualSync(
  type: 'orders' | 'products' | 'stock',
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  await requireShoppingAdmin()

  if (type !== 'stock') {
    return {
      success: false,
      error: 'Shopify manual order and product sync are not wired yet',
    }
  }

  try {
    const result = await syncShoppingConnectorStock('shopify')
    return { success: true, result }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function getShoppingSyncLogsForConnector(
  connector: ShoppingConnectorId,
  limit = 50,
): Promise<ShoppingSyncLogRow[]> {
  if (connector === 'shopify') return getShopifySyncLogs(limit)
  return getShoppingSyncLogs(limit)
}
