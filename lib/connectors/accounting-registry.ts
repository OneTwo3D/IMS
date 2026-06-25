import type { IntegrationConnectionTestState } from '@/lib/integration-connection-test-gate'

export type AccountingConnectorId = 'xero' | 'quickbooks'

export type AccountingAccountBalanceSnapshotResult = {
  fetched: number
  persisted: number
  skipped: number
  errors: string[]
}

export type AccountingConnectorDef = {
  id: AccountingConnectorId
  label: string
  available: boolean
}

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

export type AccountingConnector = AccountingConnectorDef & {
  getSettingsMasked(): Promise<AccountingConnectorSettingsMasked>
  saveSettings(data: Record<string, string>): Promise<{ success: boolean; error?: string }>
  saveConnectionSettings(clientId: string, clientSecret: string): Promise<{ success: boolean; error?: string; message?: string }>
  getConnectionStatus(): Promise<AccountingConnectionStatus>
  getConnectionTestState(): Promise<IntegrationConnectionTestState>
  testConnection(): Promise<{ success: boolean; error?: string; message?: string }>
  connect(clientId: string, clientSecret: string, origin: string, returnPath?: string): Promise<{ success: boolean; redirectUrl?: string; error?: string }>
  disconnect(): Promise<{ success: boolean; error?: string }>
  syncAccounts(): Promise<{ synced: number; errors: string[] }>
  syncAccountBalanceSnapshots(balanceDate?: string): Promise<AccountingAccountBalanceSnapshotResult>
  getAccounts(): Promise<AccountingAccountRow[]>
  fetchTaxRates(): Promise<AccountingTaxCodeRow[]>
  autoLinkTaxRates(): Promise<{
    success: boolean
    linked: number
    alreadyLinked: number
    unmatched: string[]
    externalRatesCount: number
    error?: string
  }>
  getSyncLogs(limit?: number): Promise<AccountingSyncLogRow[]>
  triggerSync(): Promise<{ success: boolean; result?: unknown; error?: string }>
  retryFailedSync(entryId?: string): Promise<{ success: boolean; reset: number; error?: string }>
  getSyncReadiness(): Promise<AccountingSyncReadiness>
}

export const ACCOUNTING_CONNECTORS: readonly AccountingConnectorDef[] = [
  {
    id: 'xero',
    label: 'Xero',
    available: true,
  },
  {
    id: 'quickbooks',
    label: 'QuickBooks',
    available: true,
  },
] as const

export function getAccountingConnectorDefinition(id: AccountingConnectorId): AccountingConnectorDef {
  const def = ACCOUNTING_CONNECTORS.find((connector) => connector.id === id)
  if (!def) throw new Error(`Unknown accounting connector: ${id}`)
  return def
}

export function getAccountingConnector(id: AccountingConnectorId): AccountingConnector {
  const def = getAccountingConnectorDefinition(id)

  if (id === 'quickbooks') {
    return {
      ...def,
      async getSettingsMasked() {
        const { getQuickBooksSettingsMasked } = await import('@/app/actions/quickbooks-sync')
        return getQuickBooksSettingsMasked() as unknown as Promise<AccountingConnectorSettingsMasked>
      },
      async saveSettings(data) {
        const { saveQuickBooksSettings } = await import('@/app/actions/quickbooks-sync')
        return saveQuickBooksSettings(data)
      },
      async saveConnectionSettings(clientId, clientSecret) {
        const { saveQuickBooksConnectionSettings } = await import('@/app/actions/quickbooks-sync')
        return saveQuickBooksConnectionSettings(clientId, clientSecret)
      },
      async getConnectionStatus() {
        const { getQuickBooksConnectionStatus } = await import('@/app/actions/quickbooks-sync')
        return getQuickBooksConnectionStatus()
      },
      async getConnectionTestState() {
        // QuickBooks does not yet run a fresh-secret connection-test gate.
        return { status: 'never', testedAt: null, message: '', fingerprint: null }
      },
      async testConnection() {
        return { success: false, error: 'QuickBooks connection testing is not available yet.' }
      },
      async connect(clientId, clientSecret, origin, returnPath) {
        const { connectQuickBooks } = await import('@/app/actions/quickbooks-sync')
        return connectQuickBooks(clientId, clientSecret, origin, returnPath)
      },
      async disconnect() {
        const { disconnectQuickBooks } = await import('@/app/actions/quickbooks-sync')
        return disconnectQuickBooks()
      },
      async syncAccounts() {
        const { syncQuickBooksAccounts } = await import('@/app/actions/quickbooks-sync')
        return syncQuickBooksAccounts()
      },
      async syncAccountBalanceSnapshots() {
        return { fetched: 0, persisted: 0, skipped: 0, errors: ['QuickBooks account-balance snapshot ingestion is not implemented yet.'] }
      },
      async getAccounts() {
        const { getQuickBooksAccounts } = await import('@/app/actions/quickbooks-sync')
        return getQuickBooksAccounts()
      },
      async fetchTaxRates() {
        const { fetchQuickBooksTaxCodes } = await import('@/app/actions/quickbooks-sync')
        return fetchQuickBooksTaxCodes()
      },
      async autoLinkTaxRates() {
        const { autoLinkQuickBooksTaxRates } = await import('@/app/actions/settings')
        const result = await autoLinkQuickBooksTaxRates()
        return {
          success: result.success,
          linked: result.linked,
          alreadyLinked: result.alreadyLinked,
          unmatched: result.unmatched,
          externalRatesCount: result.quickBooksRatesCount,
          error: result.error,
        }
      },
      async getSyncLogs(limit = 50) {
        const { getQuickBooksSyncLogs } = await import('@/app/actions/quickbooks-sync')
        return getQuickBooksSyncLogs(limit)
      },
      async triggerSync() {
        const { triggerQuickBooksSync } = await import('@/app/actions/quickbooks-sync')
        return triggerQuickBooksSync()
      },
      async retryFailedSync(entryId) {
        const { retryFailedQuickBooksSync } = await import('@/app/actions/quickbooks-sync')
        return retryFailedQuickBooksSync(entryId)
      },
      async getSyncReadiness() {
        const { getQuickBooksSyncReadiness } = await import('@/app/actions/quickbooks-sync')
        return getQuickBooksSyncReadiness()
      },
    }
  }

  return {
    ...def,
    async getSettingsMasked() {
      const { getXeroSettingsMasked } = await import('@/app/actions/xero-sync')
      return getXeroSettingsMasked() as unknown as Promise<AccountingConnectorSettingsMasked>
    },
    async saveSettings(data) {
      const { saveXeroSettings } = await import('@/app/actions/xero-sync')
      return saveXeroSettings(data)
    },
    async saveConnectionSettings(clientId, clientSecret) {
      const { saveXeroConnectionSettings } = await import('@/app/actions/xero-sync')
      return saveXeroConnectionSettings(clientId, clientSecret)
    },
    async getConnectionStatus() {
      const { getXeroConnectionStatus } = await import('@/app/actions/xero-sync')
      return getXeroConnectionStatus()
    },
    async getConnectionTestState() {
      const { getXeroConnectionTestState } = await import('@/app/actions/xero-sync')
      return getXeroConnectionTestState()
    },
    async testConnection() {
      const { testXeroConnection } = await import('@/app/actions/xero-sync')
      return testXeroConnection()
    },
    async connect(clientId, clientSecret, origin, returnPath) {
      const { connectXero } = await import('@/app/actions/xero-sync')
      return connectXero(clientId, clientSecret, origin, returnPath)
    },
    async disconnect() {
      const { disconnectXero } = await import('@/app/actions/xero-sync')
      return disconnectXero()
    },
    async syncAccounts() {
      const { syncAccountingAccounts } = await import('@/app/actions/xero-sync')
      return syncAccountingAccounts()
    },
    async syncAccountBalanceSnapshots(balanceDate) {
      const { syncAccountingAccountBalanceSnapshots } = await import('@/app/actions/xero-sync')
      return syncAccountingAccountBalanceSnapshots(balanceDate)
    },
    async getAccounts() {
      const { getAccountingAccounts } = await import('@/app/actions/xero-sync')
      const rows = await getAccountingAccounts()
      return rows.map((row) => ({
        id: row.id,
        externalAccountId: row.externalAccountId,
        code: row.code,
        name: row.name,
        type: row.type,
      }))
    },
    async fetchTaxRates() {
      const { fetchXeroTaxRates } = await import('@/app/actions/xero-sync')
      return fetchXeroTaxRates()
    },
    async autoLinkTaxRates() {
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
    },
    async getSyncLogs(limit = 50) {
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
    },
    async triggerSync() {
      const { triggerXeroSync } = await import('@/app/actions/xero-sync')
      return triggerXeroSync()
    },
    async retryFailedSync(entryId) {
      const { retryFailedXeroSync } = await import('@/app/actions/xero-sync')
      return retryFailedXeroSync(entryId)
    },
    async getSyncReadiness() {
      const { getXeroSyncReadiness } = await import('@/app/actions/xero-sync')
      return getXeroSyncReadiness()
    },
  }
}
