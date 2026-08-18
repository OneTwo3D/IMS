'use server'

import { revalidatePath } from 'next/cache'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { getAccountingConnector } from '@/lib/connectors/accounting-registry'
import { accountMappingRuleKeys, validateAccountingAccountMapping } from '@/app/(dashboard)/sync/accounting-settings-fields'
import { db } from '@/lib/db'
import {
  lockIntegrationPluginSelection,
  readLockedPluginSelection,
  resolveActiveAccountingConnector,
  type PluginSelectionLockTx,
} from '@/lib/integration-plugin-selection-lock'
import type { IntegrationPluginState } from '@/lib/integration-plugins'
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
  if (!connector) return { connector: null, failedCount: 0 }
  const failedCount = await db.accountingSyncLog.count({
    where: { connector, status: 'FAILED' },
  })
  return { connector, failedCount }
}


/**
 * Thrown when the active accounting connector CHANGED while a cancel was deciding what to
 * discard. Never surfaces as an error to the operator — it exists to abort the transaction, and
 * the caller converts it into a refusal (o3d-osl8 round 5, finding 2).
 */
class AccountingConnectorChangedError extends Error {
  constructor(readonly before: string | null, readonly after: string | null) {
    super(`Active accounting connector changed from ${before ?? 'none'} to ${after ?? 'none'} mid-cancel`)
  }
}

/**
 * audit-H4: bulk-cancel orphaned live sync rows. Marks them CANCELLED (audit-46ry)
 * so neither processor will claim them AND reconciliation / event-backfill sweeps
 * and FAILED dashboards (which scan explicit PENDING/PROCESSING/SYNCED/FAILED lists)
 * don't treat them as unresolved failures or re-queue the underlying document.
 * Records a clear reason and an activity log. When `connector` is given, only that
 * connector's orphans are cancelled; otherwise every non-active connector's live
 * rows are cancelled.
 *
 * FENCED AGAINST A CONCURRENT CONNECTOR SWITCH (o3d-osl8 round 5, finding 2; round 6, finding 2).
 * Everything from "which connector is active" to the update itself runs in ONE transaction that
 * holds ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY — the same lock the plugin-state writers take —
 * AND row-locks the plugin setting rows themselves, via lockIntegrationPluginSelection.
 *
 * Why it needed more than the re-read that was already here. The action sampled the active
 * connector, derived a cancellation scope from it, and then ran an unfenced updateMany. If
 * another administrator switched Xero→QuickBooks in that window, the QuickBooks-scoped (or
 * unscoped) update marked QuickBooks PENDING rows CANCELLED *after* QuickBooks became the active
 * connector — discarding the live queue of the connector now in use. The later re-read only
 * corrected the survivor COUNT; nothing restores a cancelled row, and the activity log would
 * describe healthy work as abandoned.
 *
 * Three mechanisms, because they fail differently:
 *   • the ADVISORY LOCK serializes the switch against this sweep, for any writer that takes it
 *     (both app writers do — app/actions/settings.ts and app/actions/onboarding.ts);
 *   • the `FOR UPDATE` ROW LOCKS on the plugin setting rows (round 6, finding 2) fence the writers
 *     that DO NOT take the advisory lock, and those are real, not hypothetical: the full-chain
 *     quiesce harness writes plugin_xero_enabled with raw SQL over its own pg client, the e2e
 *     fixture scripts upsert it through Prisma, and resetDatabase deletes every settings row. None
 *     of them can commit a change to those rows while this transaction is open, which is what
 *     removes the post-check/pre-commit window the generation check alone left open;
 *   • the GENERATION CHECK re-reads the selection before commit and throws if it moved, which
 *     rolls the update back. With the row locks held it should be unreachable — it is kept as the
 *     loud failure if they are ever removed, not as the guarantee.
 *
 * Aborting DISCARDS NOTHING: the operator is told to look again, which is right, because the
 * scope they asked for was computed against a connector selection that no longer exists.
 */
export async function cancelOrphanedAccountingSyncRows(
  connector?: string,
): Promise<{ success: boolean; cancelled: number; error?: string; inFlightNotCancelled?: number }> {
  await requirePermission('settings')

  let outcome: {
    refusal?: string
    activeConnector: string | null
    cancelled: number
    inFlight: number
  }
  try {
    outcome = await db.$transaction(async (tx) => {
      // Taken FIRST, before anything is read: a lock acquired after the read it is meant to
      // protect protects nothing. lockIntegrationPluginSelection takes the advisory lock AND row-
      // locks the plugin setting rows `FOR UPDATE`, which is what fences the writers that never
      // take the advisory lock at all (round 6, finding 2).
      const selection = await lockIntegrationPluginSelection(tx)
      return cancelOrphanedRowsUnderLock(tx, selection, connector)
    })
  } catch (error) {
    if (error instanceof AccountingConnectorChangedError) {
      // Logged, because it is evidence: an operator saw a button do nothing, and the reason is a
      // second administrator switching connectors at the same moment.
      await logActivity({
        entityType: 'SYSTEM',
        action: 'accounting_sync_orphans_cancel_aborted',
        tag: 'sync',
        level: 'WARNING',
        description: `Aborted cancelling orphaned accounting sync rows for ${connector ?? 'non-active connector(s)'}: `
          + `the active accounting connector changed from ${error.before ?? 'none'} to ${error.after ?? 'none'} while the `
          + `request was running, so the rows targeted may belong to the connector that is now ACTIVE. Nothing was cancelled.`,
        metadata: { connector: connector ?? null, activeConnectorBefore: error.before, activeConnectorAfter: error.after },
      })
      return {
        success: false,
        cancelled: 0,
        error: 'The active accounting connector changed while this ran, so nothing was cancelled — '
          + 'the rows selected may now belong to the connector that is active. Reload and check before retrying.',
      }
    }
    throw error
  }

  if (outcome.refusal) return { success: false, cancelled: 0, error: outcome.refusal }
  const { activeConnector, cancelled, inFlight } = outcome

  if (cancelled > 0 || inFlight > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'accounting_sync_orphans_cancelled',
      tag: 'sync',
      level: 'WARNING',
      description: inFlight > 0
        ? `Cancelled ${cancelled} orphaned accounting sync row(s) for ${connector ?? 'non-active connector(s)'}${activeConnector ? ` (active connector: ${activeConnector})` : ''}. `
          + `${inFlight} row(s) were NOT cancelled: their claim had already been taken, so a request may `
          + `have reached the connector and been lost. Check ${connector ?? 'that connector'} for the `
          + `document(s); these rows stay in the orphan count and continue to block deleting their `
          + `orders until resolved (o3d-sref).`
        : `Cancelled ${cancelled} orphaned accounting sync row(s) for ${connector ?? 'non-active connector(s)'}${activeConnector ? ` (active connector: ${activeConnector})` : ''}.`,
      metadata: {
        cancelledCount: cancelled,
        connector: connector ?? null,
        activeConnector,
        // Separate because the remedy differs: these need a human to look at the connector.
        inFlightNotCancelled: inFlight,
      },
    })
  }

  revalidatePath('/sync')
  return { success: true, cancelled, inFlightNotCancelled: inFlight }
}

/**
 * The decide-and-update half, run inside the fenced transaction. Split out only so the lock, the
 * abort translation and the activity log stay legible above; it is not called from anywhere else.
 *
 * `selection` is the plugin state read by lockIntegrationPluginSelection — through the TRANSACTION
 * client, from rows this transaction holds `FOR UPDATE` (round 6, finding 2). It used to be read
 * through the ordinary pooled client via getActiveConnector, on the argument that a second
 * definition of "which connector is active" would be worse than the extra connection. That
 * argument was wrong in one specific way: a pooled read holds no lock, so nothing stopped a writer
 * that skips the advisory lock from committing a switch AFTER the verification below and BEFORE
 * this transaction committed. The single definition is preserved instead by
 * resolveActiveAccountingConnector, which is the same Xero-first rule getActiveConnector applies —
 * one rule, two sources, and the source used here is the one that can be locked.
 */
async function cancelOrphanedRowsUnderLock(
  tx: Pick<typeof db, 'accountingSyncLog'> & PluginSelectionLockTx,
  selection: IntegrationPluginState,
  connector?: string,
): Promise<{ refusal?: string; activeConnector: string | null; cancelled: number; inFlight: number }> {
  const activeConnector = resolveActiveAccountingConnector(selection)
  // Never cancel the active connector's own queue.
  if (connector && connector === activeConnector) {
    return { refusal: 'Cannot cancel sync rows for the active connector.', activeConnector, cancelled: 0, inFlight: 0 }
  }
  // With no active connector, an un-scoped cancel would wipe EVERY connector's
  // queue — require an explicit connector so a transient both-plugins-off state
  // can't silently destroy all pending work (audit-H4 review).
  if (!connector && !activeConnector) {
    return {
      refusal: 'No active accounting connector — specify which connector’s orphaned rows to cancel.',
      activeConnector,
      cancelled: 0,
      inFlight: 0,
    }
  }

  // o3d-sref: ONLY PENDING rows are cancelled. A PROCESSING row — stale claim or not — is left
  // exactly as it is.
  //
  // The two are not the same fact. A PENDING row is provably PRE-CALL: nothing was sent, so
  // "the ledger was never told" is true and retiring it asserts nothing that might be false.
  //
  // A PROCESSING row had its claim TAKEN, which means the processor may already have made its remote
  // call — they post BEFORE persisting SYNCED and the externalTransactionId — and then died without
  // recording the result. There is no external id to find, so nothing can settle it from here.
  // Retiring it as CANCELLED told the order delete guard the row was deliberately abandoned, the hard
  // delete was permitted, and a late remote success then wrote a document against an order that no
  // longer existed. Exactly what the o3d-5r8 claim protocol prevents, reached through this sweep
  // instead of a race on the claim.
  //
  // Leaving it PROCESSING is the whole fix: PROCESSING is already in LIVE_ACCOUNTING_SYNC_STATUSES,
  // so the delete guard blocks on it with no new state to introduce, propagate, retain, index or
  // surface. A previous attempt at this (PR #590) added a persisted ambiguity flag and needed a
  // coherent design across five subsystems to be correct; this needs none.
  //
  // THE COST, deliberately accepted: these rows stay in the live set, so the cross-connector orphan
  // count will not fall to zero for a connector that was switched off mid-flight. That is honest —
  // they ARE unresolved — and the sweep now reports them so an operator can see why. FAILED
  // dashboards are unaffected: they scan `status = 'FAILED'`, which this never produces.
  const scope = connector ? { connector } : { connector: { not: activeConnector ?? undefined } }

  const reason = `Cancelled: orphaned accounting sync row for ${connector ?? 'a non-active connector'} (no longer the active connector${activeConnector ? ` — now ${activeConnector}` : ''}).`
  const result = await tx.accountingSyncLog.updateMany({
    where: { AND: [scope, { status: 'PENDING' as const }] },
    // audit-46ry: CANCELLED (not FAILED) so these abandoned rows are excluded from
    // FAILED-scanning reconciliation/backfill sweeps and error dashboards.
    data: { status: 'CANCELLED', errorMessage: reason, processingStartedAt: null },
  })

  // Counted, not cancelled — so the activity log explains why the orphan count did not reach zero.
  //
  // EVERY surviving PROCESSING row is counted, not just the stale ones. The update above leaves them
  // all, so scoping this count to `stale` would omit a row claimed moments before the connector
  // switch, or one that won the PENDING->PROCESSING race against the update. The action would then
  // report zero, write no explanation, and clear the banner notice — while the orphan count visibly
  // stayed non-zero on refresh. That is the "button reads as broken" outcome this count exists to
  // prevent, so it must match what actually survived rather than what was targeted.
  //
  // The scope is RE-DERIVED here rather than reusing the one the update ran under. activeConnector
  // was sampled before the update, so if another administrator activates the target connector in
  // between, the stale scope would count rows that now belong to the ACTIVE connector — and the
  // response and the permanent activity log would describe live, healthy work as switched-off and
  // possibly lost, while the refreshed banner correctly excluded it. Contradictory accounting
  // evidence is worse than a slightly stale count, so this reads the current state.
  // Re-read THROUGH THE TRANSACTION, from the rows it holds `FOR UPDATE`. Under READ COMMITTED
  // each statement takes a fresh snapshot, so this sees any switch that managed to commit.
  const activeNow = resolveActiveAccountingConnector(await readLockedPluginSelection(tx))

  // THE FENCE (round 5, finding 2; strengthened round 6, finding 2). The update above ran against a
  // scope derived from `activeConnector`; if the selection has moved, that scope may name the
  // connector that is now ACTIVE, and the rows just marked CANCELLED are its live queue. Throwing
  // rolls the update back — the only outcome that is recoverable, since no later read can un-cancel
  // a row.
  //
  // WHAT CHANGED. This check on its own was never sufficient, and round 5 described it as if it
  // were: it verifies at one instant and then commits at another, so an unlocked writer committing
  // in between still produced the exact bug. It is the `FOR UPDATE` row locks taken at the top of
  // the transaction that close that window — nothing outside can commit a change to those rows
  // until this transaction ends, so there is no post-check/pre-commit gap left to exploit.
  //
  // The check is KEPT because it is the loud failure if that ever regresses (a removed row lock, a
  // caller that reaches this function without going through lockIntegrationPluginSelection). It is
  // a cheap assertion on an invariant, not the invariant itself.
  if (activeNow !== activeConnector) throw new AccountingConnectorChangedError(activeConnector, activeNow)

  const stillOrphaned = connector
    ? (connector === activeNow ? null : { connector })
    : { connector: { not: activeNow ?? undefined } }

  const inFlight = stillOrphaned === null
    ? 0
    : await tx.accountingSyncLog.count({
      where: { AND: [stillOrphaned, { status: 'PROCESSING' as const }] },
    })

  return { activeConnector, cancelled: result.count, inFlight }
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

export async function retryFailedAccountingSync(entryId?: string): Promise<{ success: boolean; reset: number; refused?: number; error?: string }> {
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).retryFailedSync(entryId)
}

export async function getAccountingSyncReadiness(): Promise<AccountingSyncReadiness> {
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).getSyncReadiness()
}
