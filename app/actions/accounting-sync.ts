'use server'

import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

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

export type AccountingConnectorSettings = Record<string, string>
export type AccountingConnectorSettingsMasked = AccountingConnectorSettings & { secretMasked: boolean }

export type AccountingConnectionStatus = {
  connected: boolean
  tenantName?: string
}

export type AccountingSyncReadiness = {
  ready: boolean
  notConnected: boolean
  missingAccounts: Array<{ key: string; label: string }>
  missingTaxTypes: Array<{ id: string; name: string }>
}

async function getActiveConnector(): Promise<'xero' | 'quickbooks' | null> {
  if (await isIntegrationPluginEnabled('xero')) return 'xero'
  if (await isIntegrationPluginEnabled('quickbooks')) return 'quickbooks'
  return null
}

export async function getAccountingIntegrationConnector() {
  const connector = await getActiveConnector()
  if (!connector) return null
  return {
    id: connector,
    name: connector === 'xero' ? 'Xero' : 'QuickBooks',
    category: 'accounting' as const,
  }
}

export async function getAccountingSettingsMasked(): Promise<AccountingConnectorSettingsMasked> {
  const connector = await getActiveConnector()
  switch (connector) {
    case 'quickbooks': {
      const { getQuickBooksSettingsMasked } = await import('@/app/actions/quickbooks-sync')
      const s = await getQuickBooksSettingsMasked()
      return s as unknown as AccountingConnectorSettingsMasked
    }
    default: {
      const { getXeroSettingsMasked } = await import('@/app/actions/xero-sync')
      const s = await getXeroSettingsMasked()
      return s as unknown as AccountingConnectorSettingsMasked
    }
  }
}

export async function saveAccountingSettings(data: Record<string, string>): Promise<{ success: boolean; error?: string }> {
  const connector = await getActiveConnector()
  switch (connector) {
    case 'quickbooks': {
      const { saveQuickBooksSettings } = await import('@/app/actions/quickbooks-sync')
      return saveQuickBooksSettings(data)
    }
    default: {
      const { saveXeroSettings } = await import('@/app/actions/xero-sync')
      return saveXeroSettings(data)
    }
  }
}

export async function getAccountingConnectionStatus(): Promise<AccountingConnectionStatus> {
  const connector = await getActiveConnector()
  switch (connector) {
    case 'quickbooks': {
      const { getQuickBooksConnectionStatus } = await import('@/app/actions/quickbooks-sync')
      return getQuickBooksConnectionStatus()
    }
    default: {
      const { getXeroConnectionStatus } = await import('@/app/actions/xero-sync')
      return getXeroConnectionStatus()
    }
  }
}

export async function connectAccountingConnector(
  clientId: string,
  clientSecret: string,
  origin: string,
  returnPath?: string,
): Promise<{ success: boolean; redirectUrl?: string; error?: string }> {
  const connector = await getActiveConnector()
  switch (connector) {
    case 'quickbooks': {
      const { connectQuickBooks } = await import('@/app/actions/quickbooks-sync')
      return connectQuickBooks(clientId, clientSecret, origin, returnPath)
    }
    default: {
      const { connectXero } = await import('@/app/actions/xero-sync')
      return connectXero(clientId, clientSecret, origin, returnPath)
    }
  }
}

export async function disconnectAccountingConnector(): Promise<{ success: boolean; error?: string }> {
  const connector = await getActiveConnector()
  switch (connector) {
    case 'quickbooks': {
      const { disconnectQuickBooks } = await import('@/app/actions/quickbooks-sync')
      return disconnectQuickBooks()
    }
    default: {
      const { disconnectXero } = await import('@/app/actions/xero-sync')
      return disconnectXero()
    }
  }
}

export async function syncAccountingAccounts(): Promise<{ synced: number; errors: string[] }> {
  const connector = await getActiveConnector()
  switch (connector) {
    case 'quickbooks': {
      const { syncQuickBooksAccounts } = await import('@/app/actions/quickbooks-sync')
      return syncQuickBooksAccounts()
    }
    default: {
      const { syncAccountingAccounts: impl } = await import('@/app/actions/xero-sync')
      return impl()
    }
  }
}

export async function getAccountingAccounts(): Promise<AccountingAccountRow[]> {
  const connector = await getActiveConnector()
  switch (connector) {
    case 'quickbooks': {
      const { getQuickBooksAccounts } = await import('@/app/actions/quickbooks-sync')
      return getQuickBooksAccounts()
    }
    default: {
      const { getAccountingAccounts: impl } = await import('@/app/actions/xero-sync')
      const rows = await impl()
      return rows.map((row) => ({
        id: row.id,
        externalAccountId: row.externalAccountId,
        code: row.code,
        name: row.name,
        type: row.type,
      }))
    }
  }
}

export async function fetchAccountingTaxRates(): Promise<AccountingTaxCodeRow[]> {
  const connector = await getActiveConnector()
  switch (connector) {
    case 'quickbooks': {
      const { fetchQuickBooksTaxCodes } = await import('@/app/actions/quickbooks-sync')
      return fetchQuickBooksTaxCodes()
    }
    default: {
      const { fetchXeroTaxRates } = await import('@/app/actions/xero-sync')
      return fetchXeroTaxRates()
    }
  }
}

export async function autoLinkAccountingTaxRates(): Promise<{
  success: boolean
  linked: number
  alreadyLinked: number
  unmatched: string[]
  externalRatesCount: number
  error?: string
}> {
  // Tax auto-linking currently only implemented for Xero
  const { autoLinkXeroTaxRates } = await import('@/app/actions/settings')
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
  const connector = await getActiveConnector()
  switch (connector) {
    case 'quickbooks': {
      const { getQuickBooksSyncLogs } = await import('@/app/actions/quickbooks-sync')
      return getQuickBooksSyncLogs(limit)
    }
    default: {
      const { getXeroSyncLogs } = await import('@/app/actions/xero-sync')
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
  }
}

export async function triggerAccountingSync(): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const connector = await getActiveConnector()
  switch (connector) {
    case 'quickbooks': {
      const { triggerQuickBooksSync } = await import('@/app/actions/quickbooks-sync')
      return triggerQuickBooksSync()
    }
    default: {
      const { triggerXeroSync } = await import('@/app/actions/xero-sync')
      return triggerXeroSync()
    }
  }
}

export async function retryFailedAccountingSync(entryId?: string): Promise<{ success: boolean; reset: number; error?: string }> {
  const connector = await getActiveConnector()
  switch (connector) {
    case 'quickbooks': {
      const { retryFailedQuickBooksSync } = await import('@/app/actions/quickbooks-sync')
      return retryFailedQuickBooksSync(entryId)
    }
    default: {
      const { retryFailedXeroSync } = await import('@/app/actions/xero-sync')
      return retryFailedXeroSync(entryId)
    }
  }
}

export async function getAccountingSyncReadiness(): Promise<AccountingSyncReadiness> {
  const connector = await getActiveConnector()
  switch (connector) {
    case 'quickbooks': {
      const { getQuickBooksSyncReadiness } = await import('@/app/actions/quickbooks-sync')
      return getQuickBooksSyncReadiness()
    }
    default: {
      const { getXeroSyncReadiness } = await import('@/app/actions/xero-sync')
      return getXeroSyncReadiness()
    }
  }
}
