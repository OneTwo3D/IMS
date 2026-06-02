'use server'

import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { getAccountingConnector } from '@/lib/connectors/accounting-registry'

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

export type AccountingConnectorId = 'xero' | 'quickbooks'

export type AccountingSyncReadiness = {
  ready: boolean
  notConnected: boolean
  missingAccounts: Array<{ key: string; label: string }>
  missingTaxTypes: Array<{ id: string; name: string }>
}

async function getActiveConnector(preferredConnector?: AccountingConnectorId): Promise<AccountingConnectorId | null> {
  if (preferredConnector === 'xero' && await isIntegrationPluginEnabled('xero')) return 'xero'
  if (preferredConnector === 'quickbooks' && await isIntegrationPluginEnabled('quickbooks')) return 'quickbooks'
  if (await isIntegrationPluginEnabled('xero')) return 'xero'
  if (await isIntegrationPluginEnabled('quickbooks')) return 'quickbooks'
  return null
}

async function getActiveAccountingConnector(preferredConnector?: AccountingConnectorId) {
  const connectorId = await getActiveConnector(preferredConnector)
  return connectorId ? getAccountingConnector(connectorId) : null
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
  const connector = await getActiveAccountingConnector()
  return connector
    ? connector.getSettingsMasked()
    : getAccountingConnector('xero').getSettingsMasked()
}

export async function saveAccountingSettings(data: Record<string, string>): Promise<{ success: boolean; error?: string }> {
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).saveSettings(data)
}

export async function saveAccountingConnectionSettings(
  clientId: string,
  clientSecret: string,
  preferredConnector?: AccountingConnectorId,
): Promise<{ success: boolean; error?: string; message?: string }> {
  const connector = await getActiveAccountingConnector(preferredConnector)
  if (!connector) {
    return { success: false, error: 'Enable Xero or QuickBooks first.' }
  }
  return connector.saveConnectionSettings(clientId, clientSecret)
}

export async function getAccountingConnectionStatus(): Promise<AccountingConnectionStatus> {
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).getConnectionStatus()
}

export async function connectAccountingConnector(
  clientId: string,
  clientSecret: string,
  origin: string,
  returnPath?: string,
  preferredConnector?: AccountingConnectorId,
): Promise<{ success: boolean; redirectUrl?: string; error?: string }> {
  const connector = await getActiveAccountingConnector(preferredConnector)
  if (!connector) {
    return { success: false, error: 'Enable Xero or QuickBooks first.' }
  }
  return connector.connect(clientId, clientSecret, origin, returnPath)
}

export async function disconnectAccountingConnector(): Promise<{ success: boolean; error?: string }> {
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).disconnect()
}

export async function syncAccountingAccounts(): Promise<{ synced: number; errors: string[] }> {
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).syncAccounts()
}

export async function syncAccountingAccountBalanceSnapshots(balanceDate?: string): Promise<{ fetched: number; persisted: number; skipped: number; errors: string[] }> {
  const connectorId = await getActiveConnector()
  if (connectorId === 'xero') {
    // Keep this dynamic to avoid making the generic accounting facade eagerly
    // load Xero server-action code in every accounting connector path.
    const { syncAccountingAccountBalanceSnapshots: syncXeroBalances } = await import('@/app/actions/xero-sync')
    return syncXeroBalances(balanceDate)
  }
  if (connectorId === 'quickbooks') {
    return { fetched: 0, persisted: 0, skipped: 0, errors: ['QuickBooks account-balance snapshot ingestion is not implemented yet.'] }
  }
  return { fetched: 0, persisted: 0, skipped: 0, errors: ['Enable Xero before syncing account-balance snapshots.'] }
}

export async function getAccountingAccounts(): Promise<AccountingAccountRow[]> {
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).getAccounts()
}

export async function fetchAccountingTaxRates(): Promise<AccountingTaxCodeRow[]> {
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).fetchTaxRates()
}

export async function autoLinkAccountingTaxRates(): Promise<{
  success: boolean
  linked: number
  alreadyLinked: number
  unmatched: string[]
  externalRatesCount: number
  error?: string
}> {
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).autoLinkTaxRates()
}

export async function getAccountingSyncLogs(limit = 50): Promise<AccountingSyncLogRow[]> {
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).getSyncLogs(limit)
}

export async function triggerAccountingSync(): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).triggerSync()
}

export async function retryFailedAccountingSync(entryId?: string): Promise<{ success: boolean; reset: number; error?: string }> {
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).retryFailedSync(entryId)
}

export async function getAccountingSyncReadiness(): Promise<AccountingSyncReadiness> {
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).getSyncReadiness()
}
