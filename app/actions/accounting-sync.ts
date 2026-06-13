'use server'

import { revalidatePath } from 'next/cache'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { getAccountingConnector } from '@/lib/connectors/accounting-registry'
import { db } from '@/lib/db'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import { logActivity } from '@/lib/activity-log'
import {
  summarizeCrossConnectorOrphans,
  type ConnectorOrphanSummary,
} from '@/lib/domain/accounting/connector-orphans'
import {
  collectRejectedAccountingDocumentUpdateWarnings,
  type AccountingDocumentUpdateReference,
  type RejectedAccountingDocumentUpdateWarning,
} from '@/lib/domain/accounting/rejected-sync-warnings'
import type { IntegrationConnectionTestState } from '@/lib/integration-connection-test-gate'

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

// audit-H4: live sync rows are claimable only by their own connector's processor.
const LIVE_ACCOUNTING_SYNC_STATUSES = ['PENDING', 'PROCESSING'] as const

/**
 * audit-H4: count PENDING/PROCESSING accounting sync rows whose connector is not
 * the active one — they will never be processed (each processor claims only its
 * own connector's rows), so switching connectors strands them silently.
 */
export async function getCrossConnectorOrphanSummary(): Promise<ConnectorOrphanSummary> {
  await requireAuth()
  const activeConnector = await getActiveConnector()
  const groups = await db.accountingSyncLog.groupBy({
    by: ['connector'],
    where: { status: { in: [...LIVE_ACCOUNTING_SYNC_STATUSES] } },
    _count: { id: true },
  })
  return summarizeCrossConnectorOrphans(
    groups.map((group) => ({ connector: group.connector, count: group._count.id })),
    activeConnector,
  )
}

// Match the processor's stale-claim window so an actively-processing row is not
// clobbered mid-flight by a cancel (audit-H4 review).
const ORPHAN_CANCEL_STALE_PROCESSING_MS = 15 * 60 * 1000

/**
 * audit-H4: bulk-cancel orphaned live sync rows. Marks them FAILED (so neither
 * processor will claim them) with a clear reason and an activity log. When
 * `connector` is given, only that connector's orphans are cancelled; otherwise
 * every non-active connector's live rows are cancelled.
 */
export async function cancelOrphanedAccountingSyncRows(
  connector?: string,
): Promise<{ success: boolean; cancelled: number; error?: string }> {
  await requirePermission('settings')
  const activeConnector = await getActiveConnector()
  // Never cancel the active connector's own queue.
  if (connector && connector === activeConnector) {
    return { success: false, cancelled: 0, error: 'Cannot cancel sync rows for the active connector.' }
  }
  // With no active connector, an un-scoped cancel would wipe EVERY connector's
  // queue — require an explicit connector so a transient both-plugins-off state
  // can't silently destroy all pending work (audit-H4 review).
  if (!connector && !activeConnector) {
    return { success: false, cancelled: 0, error: 'No active accounting connector — specify which connector’s orphaned rows to cancel.' }
  }

  // Don't clobber a row a processor is actively working: only PENDING rows and
  // PROCESSING rows whose claim has gone stale (audit-H4 review). A mid-flight
  // row is left to finish; it then leaves the live set on its own.
  const staleProcessingCutoff = new Date(Date.now() - ORPHAN_CANCEL_STALE_PROCESSING_MS)
  const where = {
    AND: [
      connector ? { connector } : { connector: { not: activeConnector ?? undefined } },
      {
        OR: [
          { status: 'PENDING' as const },
          { status: 'PROCESSING' as const, processingStartedAt: null },
          { status: 'PROCESSING' as const, processingStartedAt: { lt: staleProcessingCutoff } },
        ],
      },
    ],
  }

  const reason = `Cancelled: orphaned accounting sync row for ${connector ?? 'a non-active connector'} (no longer the active connector${activeConnector ? ` — now ${activeConnector}` : ''}).`
  const result = await db.accountingSyncLog.updateMany({
    where,
    data: { status: 'FAILED', errorMessage: reason, processingStartedAt: null },
  })

  if (result.count > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'accounting_sync_orphans_cancelled',
      tag: 'sync',
      level: 'WARNING',
      description: `Cancelled ${result.count} orphaned accounting sync row(s) for ${connector ?? 'non-active connector(s)'}${activeConnector ? ` (active connector: ${activeConnector})` : ''}.`,
      metadata: { cancelledCount: result.count, connector: connector ?? null, activeConnector },
    })
  }

  revalidatePath('/sync')
  return { success: true, cancelled: result.count }
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

export async function getAccountingConnectionTestState(): Promise<IntegrationConnectionTestState> {
  const connectorId = await getActiveConnector()
  if (connectorId !== 'xero') {
    return { status: 'never', testedAt: null, message: '', fingerprint: null }
  }
  const { getXeroConnectionTestState } = await import('@/app/actions/xero-sync')
  return getXeroConnectionTestState()
}

export async function testAccountingConnection(): Promise<{ success: boolean; error?: string; message?: string }> {
  const connectorId = await getActiveConnector()
  if (connectorId !== 'xero') {
    return { success: false, error: 'Enable Xero before testing the accounting connection.' }
  }
  const { testXeroConnection } = await import('@/app/actions/xero-sync')
  return testXeroConnection()
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

export async function getRejectedAccountingDocumentUpdateWarnings(
  references: AccountingDocumentUpdateReference[],
  limit = 10,
): Promise<RejectedAccountingDocumentUpdateWarning[]> {
  await requireAuth()
  return collectRejectedAccountingDocumentUpdateWarnings(db, references, limit)
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
