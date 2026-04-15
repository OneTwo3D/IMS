'use server'

import {
  connectXero,
  disconnectXero,
  fetchXeroTaxRates,
  getAccountingAccounts as getConnectorAccountsImpl,
  getXeroConnectionStatus,
  getXeroSettingsMasked,
  getXeroSyncLogs,
  getXeroSyncReadiness,
  retryFailedXeroSync,
  saveXeroSettings,
  syncAccountingAccounts as syncConnectorAccountsImpl,
  triggerXeroSync,
  type XeroSettings,
  type XeroSyncReadiness,
} from '@/app/actions/xero-sync'
import { autoLinkXeroTaxRates } from '@/app/actions/settings'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

export type AccountingConnectorSettings = XeroSettings
export type AccountingConnectorSettingsMasked = AccountingConnectorSettings & { secretMasked: boolean }
export type AccountingConnectionStatus = Awaited<ReturnType<typeof getXeroConnectionStatus>>
export type AccountingSyncReadiness = XeroSyncReadiness

export type AccountingAccountRow = {
  id: string
  externalAccountId: string
  code: string | null
  name: string
  type: string
}

export type AccountingTaxCodeRow = {
  taxType: string
  name: string
  rate: number
}

export type AccountingSyncLogRow = {
  id: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  errorMessage: string | null
  retryCount: number
  syncedAt: string | null
  createdAt: string
}

export async function getAccountingIntegrationConnector() {
  if (!(await isIntegrationPluginEnabled('xero'))) return null
  return { id: 'xero', name: 'Xero', category: 'accounting' as const }
}

export async function getAccountingSettingsMasked(): Promise<AccountingConnectorSettingsMasked> {
  return getXeroSettingsMasked()
}

export async function saveAccountingSettings(data: Partial<AccountingConnectorSettings>): Promise<{ success: boolean; error?: string }> {
  return saveXeroSettings(data)
}

export async function getAccountingConnectionStatus(): Promise<AccountingConnectionStatus> {
  return getXeroConnectionStatus()
}

export async function connectAccountingConnector(
  clientId: string,
  clientSecret: string,
  origin: string,
): Promise<{ success: boolean; redirectUrl?: string; error?: string }> {
  return connectXero(clientId, clientSecret, origin)
}

export async function disconnectAccountingConnector(): Promise<{ success: boolean; error?: string }> {
  return disconnectXero()
}

export async function syncAccountingAccounts(): Promise<{ synced: number; errors: string[] }> {
  return syncConnectorAccountsImpl()
}

export async function getAccountingAccounts(): Promise<AccountingAccountRow[]> {
  const rows = await getConnectorAccountsImpl()
  return rows.map((row) => ({
    id: row.id,
    externalAccountId: row.externalAccountId,
    code: row.code,
    name: row.name,
    type: row.type,
  }))
}

export async function fetchAccountingTaxRates(): Promise<AccountingTaxCodeRow[]> {
  return fetchXeroTaxRates()
}

export async function autoLinkAccountingTaxRates(): Promise<{
  success: boolean
  linked: number
  alreadyLinked: number
  unmatched: string[]
  externalRatesCount: number
  error?: string
}> {
  const result = await autoLinkXeroTaxRates()
  return {
    success: result.success,
    linked: result.linked,
    alreadyLinked: result.alreadyLinked,
    unmatched: result.unmatched,
    externalRatesCount: result.xeroRatesCount,
    error: result.error,
  }
}

export async function getAccountingSyncLogs(limit = 50): Promise<AccountingSyncLogRow[]> {
  const rows = await getXeroSyncLogs(limit)
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    status: row.status,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    externalTransactionId: row.externalTransactionId,
    errorMessage: row.errorMessage,
    retryCount: row.retryCount,
    syncedAt: row.syncedAt,
    createdAt: row.createdAt,
  }))
}

export async function triggerAccountingSync(): Promise<{ success: boolean; result?: unknown; error?: string }> {
  return triggerXeroSync()
}

export async function retryFailedAccountingSync(entryId?: string): Promise<{ success: boolean; reset: number; error?: string }> {
  return retryFailedXeroSync(entryId)
}

export async function getAccountingSyncReadiness(): Promise<AccountingSyncReadiness> {
  return getXeroSyncReadiness()
}
