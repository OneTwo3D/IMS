'use server'

import { revalidatePath } from 'next/cache'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { getAccountingConnector } from '@/lib/connectors/accounting-registry'
import { accountMappingRuleKeys, validateAccountingAccountMapping } from '@/app/(dashboard)/sync/accounting-settings-fields'
import { db } from '@/lib/db'
import { freshAuthFailureResult, requireAuth, requirePermission } from '@/lib/auth/server'
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
import type { MissingTaxRatePreviewResult, MissingTaxRateGenerateResult } from '@/lib/tax/generate-missing-tax-rates'

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
  /**
   * Scopes the connector asked for at consent but was NOT granted (o3d-g2i). Deliberately NOT part of
   * `ready`: an incomplete grant does not stop the connector, it stops the specific syncs that need the
   * missing scope, so blocking everything over it would be a worse outage than the fault. Empty when the
   * grant is complete AND when the connector does not record grants — unknown is never reported missing.
   */
  missingScopes: string[]
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

export type FailedAccountingSyncSummary = {
  /** The active accounting connector (null when none is enabled). */
  connector: string | null
  /** Terminally-FAILED rows (retries exhausted) on the active connector. */
  failedCount: number
  /**
   * o3d-sref: rows retired while their claim was already taken, so a remote call may have landed and
   * nobody has accounted for it. Counted SEPARATELY from failedCount because the remedy differs — a
   * FAILED row can simply be retried, whereas these need someone to look at the ledger first — and
   * counted at all because without it these rows are invisible: they are CANCELLED, so every
   * FAILED-scanning dashboard and reconciliation sweep correctly skips them, and an order blocked
   * behind one would give no clue where to look.
   */
  unverifiedCount: number
}

/**
 * audit-6vq0: count terminally-FAILED accounting sync rows for the active
 * connector so the sync dashboard can raise a prominent admin alert (the
 * per-row + Retry-All UI already exists, but only inside the sync log table).
 * CANCELLED rows (audit-46ry: cross-connector orphans deliberately abandoned)
 * are NOT FAILED, so they are correctly excluded — these are real failures.
 */
export async function getFailedAccountingSyncSummary(): Promise<FailedAccountingSyncSummary> {
  await requireAuth()
  const connector = await getActiveConnector()
  if (!connector) return { connector: null, failedCount: 0, unverifiedCount: 0 }
  const [failedCount, unverifiedCount] = await Promise.all([
    db.accountingSyncLog.count({ where: { connector, status: 'FAILED' } }),
    db.accountingSyncLog.count({ where: { connector, remoteEffectUnverified: true } }),
  ])
  return { connector, failedCount, unverifiedCount }
}

// Match the processor's stale-claim window so an actively-processing row is not
// clobbered mid-flight by a cancel (audit-H4 review).
const ORPHAN_CANCEL_STALE_PROCESSING_MS = 15 * 60 * 1000

/**
 * audit-H4: bulk-cancel orphaned live sync rows. Marks them CANCELLED (audit-46ry)
 * so neither processor will claim them AND reconciliation / event-backfill sweeps
 * and FAILED dashboards (which scan explicit PENDING/PROCESSING/SYNCED/FAILED lists)
 * don't treat them as unresolved failures or re-queue the underlying document.
 * Records a clear reason and an activity log. When `connector` is given, only that
 * connector's orphans are cancelled; otherwise every non-active connector's live
 * rows are cancelled.
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
  const scope = connector ? { connector } : { connector: { not: activeConnector ?? undefined } }

  const reason = `Cancelled: orphaned accounting sync row for ${connector ?? 'a non-active connector'} (no longer the active connector${activeConnector ? ` — now ${activeConnector}` : ''}).`

  // o3d-sref: PENDING and PROCESSING are NOT the same thing to retire, and treating them alike is
  // what stranded external documents.
  //
  // A PENDING row is provably PRE-CALL: nothing has been sent, so CANCELLED is the truth and the
  // delete guard may safely ignore it.
  //
  // A stale PROCESSING row is AMBIGUOUS. The claim was taken, which means the processor may already
  // have made its remote call — the processors post BEFORE persisting SYNCED and the
  // externalTransactionId — and then died before recording the result. There is no external id to
  // find, so no amount of evidence-hunting can settle it. Retiring it as plain CANCELLED told the
  // delete guard the row was deliberately abandoned, the hard delete was permitted, and a late
  // remote success then wrote a document against an order that no longer existed.
  //
  // So it becomes CANCELLED_UNVERIFIED: still out of FAILED dashboards and reconciliation sweeps
  // (they scan explicit status lists), but the delete guard blocks on it until the connector outcome
  // is known.
  const cancelledPending = await db.accountingSyncLog.updateMany({
    where: { AND: [scope, { status: 'PENDING' as const }] },
    // audit-46ry: CANCELLED (not FAILED) so these abandoned rows are excluded from
    // FAILED-scanning reconciliation/backfill sweeps and error dashboards.
    // remoteEffectUnverified: false explicitly — a PENDING row is provably pre-call, and a row that
    // had been flagged and returned to PENDING must not carry the old doubt forward.
    data: { status: 'CANCELLED', errorMessage: reason, processingStartedAt: null, remoteEffectUnverified: false },
  })

  const unverifiedReason =
    `${reason} The claim was already taken, so a remote call may have been sent and its result never ` +
    `recorded — held as unverified rather than retired, so the order cannot be deleted while an ` +
    `external document might exist (o3d-sref).`
  const cancelledProcessing = await db.accountingSyncLog.updateMany({
    where: {
      AND: [
        scope,
        {
          OR: [
            { status: 'PROCESSING' as const, processingStartedAt: null },
            { status: 'PROCESSING' as const, processingStartedAt: { lt: staleProcessingCutoff } },
          ],
        },
      ],
    },
    // Status stays CANCELLED so every existing consumer behaves exactly as before; the ambiguity
    // rides on remoteEffectUnverified, which only the paths that deliberately opt in will read.
    // processingStartedAt is deliberately KEPT: it is the only record of when the possibly-sent call
    // was made, which is what reconciliation needs to search the connector for the document.
    data: { status: 'CANCELLED', errorMessage: unverifiedReason, remoteEffectUnverified: true },
  })

  const result = { count: cancelledPending.count + cancelledProcessing.count }

  if (result.count > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'accounting_sync_orphans_cancelled',
      tag: 'sync',
      level: 'WARNING',
      description: `Cancelled ${result.count} orphaned accounting sync row(s) for ${connector ?? 'non-active connector(s)'}${activeConnector ? ` (active connector: ${activeConnector})` : ''}.`,
      metadata: {
        cancelledCount: result.count,
        connector: connector ?? null,
        activeConnector,
        // Split out because they mean different things to an operator: the unverified ones may have
        // reached the connector and need checking there (o3d-sref).
        cancelledPending: cancelledPending.count,
        cancelledUnverified: cancelledProcessing.count,
      },
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
  const resolved = connector ?? getAccountingConnector('xero')

  // Refuse to INTRODUCE a mapping collision that would silently corrupt a reconciliation.
  // Stage ran for months with allocated_inventory_account == transit_account and nothing
  // complained (o3d-f82); the damage surfaces later as a reconciliation "gap" that reads
  // like a data problem rather than the settings mistake it is. Fail here, where it is
  // fixable.
  //
  // Read the CURRENT values straight from the settings rows rather than via the connector,
  // for the same reason the validator no longer takes a connector id: resolution is
  // xero-first and ignores which connector the payload is actually for. Passing `current`
  // is what keeps this from locking an admin out of an unrelated save when a collision
  // already exists and the UI is not even showing the account selectors.
  const currentRows = await db.setting.findMany({ where: { key: { in: accountMappingRuleKeys() } } })
  const current = Object.fromEntries(currentRows.map((r) => [r.key, r.value ?? '']))
  const errors = validateAccountingAccountMapping(data, current)
  if (errors.length) return { success: false, error: errors.map((e) => e.message).join(' ') }

  return resolved.saveSettings(data)
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
  // audit-ohou: surface the fresh-auth gate (thrown deep in the connector) as a
  // structured result so the client can step-up re-auth and retry.
  try {
    return await connector.saveConnectionSettings(clientId, clientSecret)
  } catch (e) {
    const freshAuthFailure = freshAuthFailureResult(e)
    if (freshAuthFailure) return freshAuthFailure
    throw e
  }
}

export async function getAccountingConnectionTestState(): Promise<IntegrationConnectionTestState> {
  const connector = await getActiveAccountingConnector()
  if (!connector) {
    return { status: 'never', testedAt: null, message: '', fingerprint: null }
  }
  return connector.getConnectionTestState()
}

export async function testAccountingConnection(): Promise<{ success: boolean; error?: string; message?: string }> {
  const connector = await getActiveAccountingConnector()
  if (!connector) {
    return { success: false, error: 'Enable Xero or QuickBooks first.' }
  }
  return connector.testConnection()
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
  // audit-ohou: same step-up passthrough for the OAuth connect path.
  try {
    return await connector.connect(clientId, clientSecret, origin, returnPath)
  } catch (e) {
    const freshAuthFailure = freshAuthFailureResult(e)
    if (freshAuthFailure) return freshAuthFailure
    throw e
  }
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
  const connector = await getActiveAccountingConnector()
  if (!connector) {
    return { fetched: 0, persisted: 0, skipped: 0, errors: ['Enable Xero or QuickBooks first.'] }
  }
  return connector.syncAccountBalanceSnapshots(balanceDate)
}

export async function getAccountingAccounts(): Promise<AccountingAccountRow[]> {
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).getAccounts()
}

export async function fetchAccountingTaxRates(
  opts?: { allowCache?: boolean },
): Promise<AccountingTaxCodeRow[]> {
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).fetchTaxRates(opts)
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

/**
 * Preview which tax rates would be created in the active accounting connector
 * for active, unmapped IMS rates with no existing external name-match.
 * Read-only — nothing is written to the accounting system. Connector-agnostic.
 */
export async function previewMissingAccountingTaxRates(): Promise<MissingTaxRatePreviewResult> {
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).previewMissingTaxRates()
}

/**
 * Create the confirmed missing tax rates in the active accounting connector and
 * map each back onto its IMS rate. Only writes the user-confirmed IMS rate ids.
 * Connector-agnostic.
 */
export async function generateMissingAccountingTaxRates(
  taxRateIds: string[],
  reportTypeOverrides?: Record<string, string>,
): Promise<MissingTaxRateGenerateResult> {
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).generateMissingTaxRates(taxRateIds, reportTypeOverrides)
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
