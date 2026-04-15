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
import { getActiveShoppingConnectorInfo } from '@/lib/shopping'

export type ShoppingSyncSettings = WcSyncSettings
export type ShoppingTaxRateMappingRow = TaxRateMappingRow
export type ShoppingStatusMappingRow = StatusMappingRow
export type ShoppingSyncLogRow = SyncLogRow
export type ShoppingConnectorCredentials = {
  url: string
  key: string
  secret: string
  secretMasked: boolean
}

export async function getShoppingIntegrationConnector() {
  return getActiveShoppingConnectorInfo()
}

export async function getShoppingSyncSettings(): Promise<ShoppingSyncSettings> {
  return getWcSyncSettings()
}

export async function saveShoppingSyncSettings(data: Partial<ShoppingSyncSettings>): Promise<{ success: boolean }> {
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

export async function updateShoppingTaxRateMapping(externalTaxRateId: number, taxRateId: string) {
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
