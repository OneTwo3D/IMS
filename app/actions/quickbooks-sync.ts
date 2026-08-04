'use server'

import { requireFreshPermission, requirePermission } from '@/lib/auth/server'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { effectiveTokenFor, planManualRetry } from '@/lib/domain/accounting/followup-retry-guard'
import {
  getAuthorizationUrl,
  disconnect,
  isConnected,
  syncChartOfAccounts,
  getQuickBooksTaxCodes,
  processPendingQuickBooksSync,
} from '@/lib/connectors/quickbooks'
import { getQuickBooksSettings, QUICKBOOKS_SETTING_KEYS, type QuickBooksSettings } from '@/lib/connectors/quickbooks/settings'
import { buildAccountingCallbackUri } from '@/lib/accounting/callback-url'
import { getPublicAppUrl } from '@/lib/public-app-url'
import { getSettingValue, serializeSettingValue } from '@/lib/settings-store'
import { isMaskedSecret, maskSecret, shouldFreshGateSecretWrite } from '@/lib/security/secret-mask'

export type { QuickBooksSettings } from '@/lib/connectors/quickbooks/settings'

async function requireAdmin() {
  return requirePermission('sync')
}

async function requireFreshAdmin() {
  return requireFreshPermission('sync')
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getQuickBooksSettingsMasked(): Promise<QuickBooksSettings & { secretMasked: boolean }> {
  const settings = await getQuickBooksSettings()
  const masked = maskSecret(settings.quickbooks_client_secret)
  return { ...settings, quickbooks_client_secret: masked, secretMasked: !!settings.quickbooks_client_secret }
}

export async function saveQuickBooksSettings(data: Partial<QuickBooksSettings>): Promise<{ success: boolean; error?: string }> {
  try {
    await requireAdmin()
    if (shouldFreshGateSecretWrite(data, 'quickbooks_client_secret')) {
      await requireFreshAdmin()
    }

    if (data.quickbooks_sync_enabled === 'true') {
      const currentEnabled = await getSettingValue('quickbooks_sync_enabled')
      const isTransitioningOn = currentEnabled !== 'true'
      if (isTransitioningOn) {
        const readiness = await getQuickBooksSyncReadiness()
        if (!readiness.ready) {
          const reasons: string[] = []
          if (readiness.notConnected) reasons.push('not connected to QuickBooks')
          if (readiness.missingAccounts.length > 0) {
            reasons.push(`missing account mappings (${readiness.missingAccounts.map(a => a.label).join(', ')})`)
          }
          if (readiness.missingTaxTypes.length > 0) {
            reasons.push(`missing accounting tax type on IMS VAT rates (${readiness.missingTaxTypes.map(t => t.name).join(', ')})`)
          }
          return { success: false, error: `Cannot enable QuickBooks sync — ${reasons.join('; ')}.` }
        }
      }
    }

    // Don't overwrite secret with masked value
    const entries = Object.entries(data).filter(([k, v]) => {
      if (!(QUICKBOOKS_SETTING_KEYS as readonly string[]).includes(k)) return false
      if (k === 'quickbooks_client_secret' && isMaskedSecret(v)) return false
      return true
    })

    const ops = entries.map(([k, v]) =>
      db.setting.upsert({
        where: { key: k },
        create: { key: k, value: serializeSettingValue(k, v ?? '') },
        update: { value: serializeSettingValue(k, v ?? '') },
      }),
    )
    await db.$transaction(ops)

    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_settings_updated',
      tag: 'sync',
      description: 'Updated QuickBooks sync settings',
      metadata: { keys: entries.map(([k]) => k) },
    })
    revalidatePath('/sync')
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export async function saveQuickBooksConnectionSettings(
  clientId: string,
  clientSecret: string,
): Promise<{ success: boolean; error?: string; message?: string }> {
  try {
    await requireFreshAdmin()

    const nextClientId = clientId.trim()
    const nextClientSecretInput = clientSecret.trim()
    const nextClientSecret = isMaskedSecret(nextClientSecretInput) ? '' : nextClientSecretInput
    const existingSettings = await getQuickBooksSettings()
    const resolvedSecret = nextClientSecret || existingSettings.quickbooks_client_secret.trim()

    if (!nextClientId) {
      return { success: false, error: 'QuickBooks Client ID is required.' }
    }

    if (!resolvedSecret) {
      return { success: false, error: 'QuickBooks Client Secret is required.' }
    }

    const publicAppUrl = await getPublicAppUrl()
    if (!publicAppUrl) {
      return { success: false, error: 'Public app URL is not configured.' }
    }

    const redirectUri = buildAccountingCallbackUri(publicAppUrl)
    if (!redirectUri) {
      return { success: false, error: 'QuickBooks redirect URL is invalid.' }
    }

    const ops = [
      db.setting.upsert({
        where: { key: 'quickbooks_client_id' },
        create: { key: 'quickbooks_client_id', value: serializeSettingValue('quickbooks_client_id', nextClientId) },
        update: { value: serializeSettingValue('quickbooks_client_id', nextClientId) },
      }),
    ]

    if (nextClientSecret) {
      ops.push(
        db.setting.upsert({
          where: { key: 'quickbooks_client_secret' },
          create: { key: 'quickbooks_client_secret', value: serializeSettingValue('quickbooks_client_secret', nextClientSecret) },
          update: { value: serializeSettingValue('quickbooks_client_secret', nextClientSecret) },
        }),
      )
    }

    await db.$transaction(ops)

    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_connection_settings_updated',
      tag: 'sync',
      description: 'Updated QuickBooks connection settings',
    })

    revalidatePath('/sync')
    revalidatePath('/onboarding')
    return { success: true, message: 'Connection settings saved. OAuth redirect is ready.' }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export async function getQuickBooksConnectionStatus(): Promise<{
  connected: boolean
  tenantName?: string
}> {
  return isConnected()
}

export async function connectQuickBooks(
  clientId: string,
  clientSecret: string,
  origin: string,
  returnPath?: string,
): Promise<{ success: boolean; redirectUrl?: string; error?: string }> {
  try {
    void origin
    const session = await requireFreshAdmin()

    // Save credentials
    const ops = [
      db.setting.upsert({ where: { key: 'quickbooks_client_id' }, create: { key: 'quickbooks_client_id', value: serializeSettingValue('quickbooks_client_id', clientId) }, update: { value: serializeSettingValue('quickbooks_client_id', clientId) } }),
    ]
    if (clientSecret && !isMaskedSecret(clientSecret)) {
      ops.push(db.setting.upsert({ where: { key: 'quickbooks_client_secret' }, create: { key: 'quickbooks_client_secret', value: serializeSettingValue('quickbooks_client_secret', clientSecret) }, update: { value: serializeSettingValue('quickbooks_client_secret', clientSecret) } }))
    }
    await db.$transaction(ops)

    const publicAppUrl = await getPublicAppUrl()
    if (!publicAppUrl) {
      return { success: false, error: 'Public app URL is not configured.' }
    }
    // Shared builder so the redirect_uri is byte-identical to the one the
    // callback sends at token exchange (qye3/Codex: OAuth requires exact match;
    // origin normalization strips case/port/path/query/fragment/user-info
    // consistently on both sides).
    const redirectUri = buildAccountingCallbackUri(publicAppUrl)
    if (!redirectUri) {
      return { success: false, error: 'Public app URL is not a valid http(s) URL.' }
    }
    const authUrl = await getAuthorizationUrl(clientId, redirectUri, session.user.id, returnPath)

    return { success: true, redirectUrl: authUrl }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export async function disconnectQuickBooks(): Promise<{ success: boolean; error?: string }> {
  try {
    // Fresh-at-start is the security boundary; connector revocation may outlive
    // the freshness window after the operator has already confirmed intent.
    await requireFreshAdmin()
    await disconnect()

    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_disconnected',
      tag: 'sync',
      description: 'Disconnected from QuickBooks',
    })

    revalidatePath('/sync')
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export async function syncQuickBooksAccounts(): Promise<{ synced: number; errors: string[] }> {
  await requireAdmin()
  const result = await syncChartOfAccounts()

  await logActivity({
    entityType: 'SYSTEM',
    action: 'accounting_accounts_synced',
    tag: 'sync',
    description: `Synced ${result.synced} accounts from QuickBooks`,
    metadata: result,
  })

  revalidatePath('/sync')
  return result
}

export async function getQuickBooksAccounts(): Promise<Array<{ id: string; externalAccountId: string; code: string | null; name: string; type: string }>> {
  return db.accountingAccount.findMany({
    where: { connector: 'quickbooks', active: true },
    select: { id: true, externalAccountId: true, code: true, name: true, type: true },
    orderBy: [{ code: 'asc' }],
  })
}

export async function fetchQuickBooksTaxCodes(): Promise<Array<{ taxType: string; name: string; rate: number }>> {
  const result = await getQuickBooksTaxCodes()
  return result.map((tc) => ({ taxType: tc.id, name: tc.name, rate: 0 }))
}

// ---------------------------------------------------------------------------
// Sync Logs
// ---------------------------------------------------------------------------

export type QuickBooksSyncLogRow = {
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

export async function getQuickBooksSyncLogs(limit = 50): Promise<QuickBooksSyncLogRow[]> {
  const rows = await db.accountingSyncLog.findMany({
    where: { connector: 'quickbooks' },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  return rows.map(r => ({
    id: r.id,
    type: r.type,
    status: r.status,
    referenceType: r.referenceType,
    referenceId: r.referenceId,
    externalTransactionId: r.externalTransactionId,
    errorMessage: r.errorMessage,
    retryCount: r.retryCount,
    syncedAt: r.syncedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }))
}

// ---------------------------------------------------------------------------
// Manual Sync
// ---------------------------------------------------------------------------

export async function triggerQuickBooksSync(): Promise<{ success: boolean; result?: unknown; error?: string }> {
  try {
    await requireAdmin()

    const enabled = await db.setting.findUnique({ where: { key: 'quickbooks_sync_enabled' } })
    if (enabled?.value !== 'true') {
      return { success: false, error: 'QuickBooks sync is not enabled' }
    }

    const result = await processPendingQuickBooksSync()

    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_manual_sync',
      tag: 'sync',
      description: `Manual QuickBooks sync: ${result.succeeded} synced, ${result.failed} failed`,
      metadata: result,
    })

    revalidatePath('/sync')
    return { success: true, result }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export async function retryFailedQuickBooksSync(entryId?: string): Promise<{ success: boolean; reset: number; refused?: number; error?: string }> {
  try {
    await requireAdmin()

    // o3d-0m56: refuse what the automatic enqueue refuses. Several FAILED rows for one
    // reference under DIFFERENT idempotency tokens mean any of them may have committed
    // remotely, so re-posting picks a token the ledger may never have seen and a second payment
    // lands. The bulk path is the worse one — without this it re-queues every ambiguous scope
    // at once, each row under its own token.
    const candidates = await db.accountingSyncLog.findMany({
      where: entryId
        ? { id: entryId, connector: 'quickbooks', status: 'FAILED' as const }
        : { connector: 'quickbooks', status: 'FAILED' as const },
      select: { id: true, type: true, referenceType: true, referenceId: true, payload: true },
    })
    if (candidates.length === 0) return { success: true, reset: 0 }

    const scopeKey = (row: { type: string; referenceType: string; referenceId: string }) =>
      `${row.type}\u0000${row.referenceType}\u0000${row.referenceId}`
    const scopes = [...new Set(candidates.map(scopeKey))]

    // Every FAILED row in each touched scope, not just the ones selected — a single-row retry
    // is only ambiguous relative to its SIBLINGS, which the id filter above excludes.
    const siblingRows = await db.accountingSyncLog.findMany({
      where: {
        connector: 'quickbooks',
        status: 'FAILED',
        OR: candidates.map((row) => ({
          type: row.type,
          referenceType: row.referenceType,
          referenceId: row.referenceId,
        })),
      },
      select: { id: true, type: true, referenceType: true, referenceId: true, payload: true },
    })
    const siblingsByScope = new Map<string, typeof siblingRows>()
    for (const row of siblingRows) {
      const key = scopeKey(row)
      siblingsByScope.set(key, [...(siblingsByScope.get(key) ?? []), row])
    }

    // Planned PER CANDIDATE, against that candidate's own siblings. An earlier revision
    // planned once per SCOPE from an arbitrary rows[0] and then refused every sibling id: with
    // one safe row targeting a replacement invoice and two ambiguous rows targeting the old
    // one, array order decided whether the ambiguous pair was allowed through or the safe row
    // was refused along with them (Codex review). A per-candidate decision cannot depend on
    // ordering, and refuses exactly the row it judged.
    const refusedIds = new Set<string>()
    const refusals: string[] = []
    for (const candidate of candidates) {
      const rows = siblingsByScope.get(scopeKey(candidate)) ?? []
      const plan = planManualRetry({
        type: candidate.type,
        reference: `${candidate.referenceType} ${candidate.referenceId}`,
        target: {
          id: candidate.id,
          payload: candidate.payload,
          effectiveToken: effectiveTokenFor('quickbooks', candidate),
        },
        siblings: rows.map((row) => ({
          id: row.id,
          payload: row.payload,
          effectiveToken: effectiveTokenFor('quickbooks', row),
        })),
      })
      if (plan.action === 'refuse') {
        refusedIds.add(candidate.id)
        if (!refusals.includes(plan.reason)) refusals.push(plan.reason)
        await logActivity({
          entityType: 'SYSTEM',
          action: 'quickbooks_manual_retry_refused',
          tag: 'sync',
          level: 'WARNING',
          description: plan.reason,
          metadata: { syncLogId: candidate.id, siblingIds: rows.map((row) => row.id), tokenCount: plan.tokenCount },
        })
      }
    }

    const allowedIds = candidates.map((row) => row.id).filter((id) => !refusedIds.has(id))
    if (allowedIds.length === 0) {
      // Nothing to do and a reason worth showing: the single-row path returns it as the error
      // so the existing surfaces render it inline.
      return { success: false, reset: 0, refused: refusedIds.size, error: refusals[0] ?? 'Nothing to retry' }
    }

    const result = await db.accountingSyncLog.updateMany({
      where: { id: { in: allowedIds }, connector: 'quickbooks', status: 'FAILED' },
      data: { status: 'PENDING', retryCount: 0, errorMessage: null, processingStartedAt: null },
    })
    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_retry_failed',
      tag: 'sync',
      description: `Reset ${result.count} failed QuickBooks sync entry/entries for retry`
        + (refusedIds.size > 0 ? `; refused ${refusedIds.size} needing manual reconciliation` : ''),
    })
    revalidatePath('/sync')
    return { success: true, reset: result.count, ...(refusedIds.size > 0 ? { refused: refusedIds.size } : {}) }
  } catch (e) {
    return { success: false, reset: 0, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export type QuickBooksSyncReadiness = {
  ready: boolean
  notConnected: boolean
  missingAccounts: Array<{ key: string; label: string }>
  missingTaxTypes: Array<{ id: string; name: string }>
  /** Always empty: QuickBooks does not record its granted scopes (o3d-g2i is Xero-only). */
  missingScopes: string[]
}

const REQUIRED_ACCOUNTS: Array<{ key: keyof QuickBooksSettings; label: string }> = [
  { key: 'quickbooks_sales_account', label: 'Sales Revenue' },
  { key: 'quickbooks_shipping_account', label: 'Shipping Income' },
  { key: 'quickbooks_discount_account', label: 'Discounts Given' },
  { key: 'quickbooks_transit_account', label: 'Stock in Transit' },
  { key: 'quickbooks_inventory_account', label: 'Inventory Asset' },
  { key: 'quickbooks_allocated_inventory_account', label: 'Allocated Inventory' },
  { key: 'quickbooks_cogs_account', label: 'Cost of Goods Sold' },
  { key: 'quickbooks_unearned_revenue_account', label: 'Unearned Revenue' },
  { key: 'quickbooks_accounts_receivable_account', label: 'Accounts Receivable' },
  { key: 'quickbooks_accounts_payable_account', label: 'Accounts Payable' },
  { key: 'quickbooks_realised_fx_gain_loss_account', label: 'Realised FX Gain/Loss' },
  { key: 'quickbooks_unrealised_fx_gain_loss_account', label: 'Unrealised FX Gain/Loss' },
]

export async function getQuickBooksSyncReadiness(): Promise<QuickBooksSyncReadiness> {
  const [settings, connStatus, taxRates] = await Promise.all([
    getQuickBooksSettings(),
    isConnected(),
    db.taxRate.findMany({
      where: { active: true },
      select: { id: true, name: true, accountingTaxType: true },
      orderBy: { name: 'asc' },
    }),
  ])

  const missingAccounts = REQUIRED_ACCOUNTS
    .filter(a => !settings[a.key])
    .map(a => ({ key: a.key as string, label: a.label }))

  const missingTaxTypes = taxRates
    .filter(r => !r.accountingTaxType)
    .map(r => ({ id: r.id, name: r.name }))

  return {
    ready: connStatus.connected && missingAccounts.length === 0 && missingTaxTypes.length === 0,
    notConnected: !connStatus.connected,
    missingAccounts,
    missingTaxTypes,
    // QuickBooks does not record its granted scopes (o3d-g2i covers Xero only). Empty means "nothing to
    // report", never "we checked and found none" — see AccountingSyncReadiness.
    missingScopes: [],
  }
}
