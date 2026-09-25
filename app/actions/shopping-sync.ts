'use server'

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
  testWcCredentials,
  triggerManualSync,
  updateShoppingTaxRateMapping as updateShoppingTaxRateMappingImpl,
  upsertShoppingStatusMapping as upsertShoppingStatusMappingImpl,
  type SyncLogRow,
  type StatusMappingRow,
  type TaxRateMappingRow,
  type WcSyncSettings,
} from '@/app/actions/wc-sync'
import { requirePermission } from '@/lib/auth/server'
import { getActiveShoppingConnectorInfo } from '@/lib/shopping'
import type { ShoppingConnectorId } from '@/lib/connectors/shopping-registry'
import type { IntegrationConnectionTestState } from '@/lib/integration-connection-test-gate'

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
  connectionTest: IntegrationConnectionTestState
}
export async function getShoppingIntegrationConnector() {
  // o3d-1fel: the delegate (getActiveShoppingConnectorInfo) is a lib helper with
  // no guard of its own, so the gate has to live here.
  await requirePermission('sync')
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

export async function testShoppingConnectorCredentials(url: string, key: string, secret: string) {
  return testWcCredentials(url, key, secret)
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

/**
 * The connector-keyed sync-log reader.
 *
 * ONE CONNECTOR TODAY (o3d-remove-parked-connectors): Shopify was the other arm and is archived.
 * The parameter is kept rather than dropped because every caller passes the connector it resolved,
 * and a second connector adds an arm here instead of a new exported action at every call site.
 */
export async function getShoppingSyncLogsForConnector(
  connector: ShoppingConnectorId,
  limit = 50,
): Promise<ShoppingSyncLogRow[]> {
  // GUARDED HERE, not only by the delegate. Every arm below delegates to an action that takes
  // `sync` itself, but the switch means this export is no longer a plain tail call to one of them,
  // so the server-action guard detector cannot see through it — and an arm added later that reads
  // rows directly would be unguarded with nothing to say so. Cheap, and it fails closed.
  await requirePermission('sync')

  switch (connector) {
    case 'woocommerce':
      return getShoppingSyncLogs(limit)
  }
}
