import type { IntegrationConnectionTestState } from '@/lib/integration-connection-test-gate'
import type { MissingTaxRatePreviewResult, MissingTaxRateGenerateResult } from '@/lib/tax/generate-missing-tax-rates'

/**
 * ONE ENTRY TODAY (o3d-remove-parked-connectors). QuickBooks was the second and is archived — see
 * archive/connectors/README.md and docs/archive/quickbooks-connector-removal.md. The union, the
 * definition list, the definition lookup and the factory below are all still driven by the registry
 * rather than by a Xero literal, so a second connector is a registration plus a factory entry.
 *
 * WHAT A UNION OF ONE COSTS, stated rather than implied: nothing drives the accounting seam with a
 * second id any more, because there is no second id. The genericity of everything keyed by
 * `AccountingConnectorId` is type-checked, not tested. The removal note's "What is no longer proven"
 * enumerates the specific losses; do not read a green suite as evidence that a second accounting
 * connector would work.
 */
export type AccountingConnectorId = 'xero'

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
  /**
   * o3d-anu8 — HOW this row reached its status. NULL is the connector's own writeback, i.e. a real
   * call was made and the ledger answered; `OPERATOR_ASSERTION` means a human typed the outcome and
   * the document id into the settlement dialog and IMS verified nothing.
   *
   * REQUIRED, not optional, and carried by the CONNECTOR-AGNOSTIC row rather than by each
   * connector's own: the sync page renders an external id beside a SYNCED badge, and without this
   * field no view built on this interface CAN distinguish the two — the display would keep
   * presenting an assertion as a confirmation however carefully each reader below it was fixed.
   * `errorMessage` is not a substitute: it carries the settlement note, but it is free text an
   * operator can edit and both connectors overwrite it with the remote system's own words.
   */
  settlementBasis: string | null
  syncedAt: string | null
  createdAt: string
}

export type AccountingConnectorSettings = Record<string, string>
export type AccountingConnectorSettingsMasked = AccountingConnectorSettings & { secretMasked: boolean }

export type AccountingConnectionStatus = {
  connected: boolean
  tenantName?: string
  /**
   * Why a stored connection is unusable, when it is (o3d-9tbz). Set together with `connected: false`
   * and `hasStoredToken: true` — an allow-list-blocked token is NOT a connection, but it is also not
   * the same thing as never having connected, and the operator has to be told which they are looking at.
   */
  blockedReason?: string
  /** A token row exists, so /sync must keep offering Disconnect — the refusal text tells them to use it. */
  hasStoredToken?: boolean
}

export type AccountingSyncReadiness = {
  ready: boolean
  notConnected: boolean
  missingAccounts: Array<{ key: string; label: string }>
  missingTaxTypes: Array<{ id: string; name: string }>
  /**
   * Scopes the connector asked for at consent but was NOT granted (o3d-g2i). Empty when the grant is
   * complete, and also when the connector does not record grants — never report unknown as missing.
   */
  missingScopes: string[]
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
  // o3d-r30: allowCache opts into the shared reference cache for PASSIVE display reads only. Omit it
  // (the default) for authoritative reads that feed mapping/write decisions or an explicit refresh.
  fetchTaxRates(opts?: { allowCache?: boolean }): Promise<AccountingTaxCodeRow[]>
  autoLinkTaxRates(): Promise<{
    success: boolean
    linked: number
    alreadyLinked: number
    unmatched: string[]
    externalRatesCount: number
    error?: string
  }>
  /** Preview which external tax rates would be created for active, unmapped IMS
   *  rates with no existing external name-match. Read-only — no writes. */
  previewMissingTaxRates(): Promise<MissingTaxRatePreviewResult>
  /** Create the confirmed missing tax rates in the connector and map each back
   *  onto its IMS rate. Only writes the passed (user-confirmed) IMS rate ids.
   *  `reportTypeOverrides` maps a taxRateId to a user-chosen report type from the
   *  preview's `reportTypeOptions`; omitted rates use the computed default. */
  generateMissingTaxRates(
    taxRateIds: string[],
    reportTypeOverrides?: Record<string, string>,
  ): Promise<MissingTaxRateGenerateResult>
  getSyncLogs(limit?: number): Promise<AccountingSyncLogRow[]>
  triggerSync(): Promise<{ success: boolean; result?: unknown; error?: string }>
  /**
   * `refused` is part of the contract, not an optional extra: the guard can allow SOME rows
   * and refuse others in one call, and a caller that drops it reports partial success as plain
   * success (o3d-0m56).
   *
   * o3d-e2mz: `expectedAttemptRevision` is the attempt the operator was looking at when they asked for
   * this ONE row to be retried. A connector whose processor stamps attempt revisions fences the retry on
   * it and refuses a request that names none; a connector that stamps none ignores it. Omitted for the
   * bulk ("Retry All") form, which is not a decision about any particular attempt.
   */
  retryFailedSync(
    entryId?: string,
    expectedAttemptRevision?: number,
  ): Promise<{ success: boolean; reset: number; refused?: number; error?: string }>
  getSyncReadiness(): Promise<AccountingSyncReadiness>
}

export const ACCOUNTING_CONNECTORS: readonly AccountingConnectorDef[] = [
  {
    id: 'xero',
    label: 'Xero',
    available: true,
  },
] as const

/**
 * Whether a value — typically a `connector` string read back off a stored row — names a connector
 * THIS BUILD registers (o3d-remove-parked-connectors).
 *
 * The `connector` columns on `AccountingSyncLog`, `AccountingToken`, `AccountingAccount` and
 * `AccountingAccountBalanceSnapshot` are plain `String @default("xero")`, so a row can name a
 * connector that has since been archived — development databases hold `quickbooks` rows right now.
 * Several call sites used to test that with a literal pair (`=== 'xero' || === 'quickbooks'`), which
 * both hard-codes the roster and, worse, would accept `quickbooks` after the code to service it was
 * gone. One predicate, keyed off the registry, is the answer to both.
 */
export function isRegisteredAccountingConnector(value: unknown): value is AccountingConnectorId {
  return typeof value === 'string' && ACCOUNTING_CONNECTORS.some((connector) => connector.id === value)
}

export function getAccountingConnectorDefinition(id: AccountingConnectorId): AccountingConnectorDef {
  const def = ACCOUNTING_CONNECTORS.find((connector) => connector.id === id)
  if (!def) throw new Error(`Unknown accounting connector: ${id}`)
  return def
}

/**
 * THE FACTORY, KEYED BY THE REGISTRY (o3d-remove-parked-connectors).
 *
 * This used to be `if (id === 'quickbooks') { ...45 methods... }` followed by a fall-through to
 * Xero — not a map, not even a switch, and one edit away from being deleted as an `if` with one arm.
 * Removing QuickBooks was the moment to take that back rather than leave a bare `return xero()`
 * behind, because a bare return is what a second connector would have to reverse-engineer.
 *
 * The record is TOTAL over `AccountingConnectorId`, so adding an id to the union is a `tsc` error
 * here until a builder is supplied, and the builder is typed per key (`(def) => AccountingConnector`
 * built from that key's own definition) rather than over the whole union. `getAccountingConnector`
 * resolves the definition first, so an unregistered id is refused by
 * `getAccountingConnectorDefinition` before any builder runs.
 */
const ACCOUNTING_CONNECTOR_FACTORIES: {
  [Id in AccountingConnectorId]: (def: AccountingConnectorDef & { id: Id }) => AccountingConnector
} = {
  xero: (def) => ({
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
    async fetchTaxRates(opts?: { allowCache?: boolean }) {
      const { fetchXeroTaxRates } = await import('@/app/actions/xero-sync')
      return fetchXeroTaxRates(opts)
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
    async previewMissingTaxRates() {
      const { previewMissingXeroTaxRates } = await import('@/app/actions/settings')
      return previewMissingXeroTaxRates()
    },
    async generateMissingTaxRates(taxRateIds, reportTypeOverrides) {
      const { generateMissingXeroTaxRates } = await import('@/app/actions/settings')
      return generateMissingXeroTaxRates(taxRateIds, reportTypeOverrides)
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
        attemptRevision: row.attemptRevision,
        settlementBasis: row.settlementBasis,
        syncedAt: row.syncedAt,
        createdAt: row.createdAt,
      }))
    },
    async triggerSync() {
      const { triggerXeroSync } = await import('@/app/actions/xero-sync')
      return triggerXeroSync()
    },
    async retryFailedSync(entryId, expectedAttemptRevision) {
      const { retryFailedXeroSync } = await import('@/app/actions/xero-sync')
      return retryFailedXeroSync(entryId, expectedAttemptRevision)
    },
    async getSyncReadiness() {
      const { getXeroSyncReadiness } = await import('@/app/actions/xero-sync')
      return getXeroSyncReadiness()
    },
  }),
}

export function getAccountingConnector(id: AccountingConnectorId): AccountingConnector {
  const def = getAccountingConnectorDefinition(id)
  const build = ACCOUNTING_CONNECTOR_FACTORIES[def.id]
  if (!build) throw new Error(`No accounting connector factory registered for: ${id}`)
  return build(def)
}
