'use server'

import { freshAuthFailureResult, requireFreshPermission, requirePermission, requireRole } from '@/lib/auth/server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getAuthorizationUrl, disconnect, isConnected, getGrantedScopes, missingScopes } from '@/lib/connectors/xero'
import { syncChartOfAccounts, getXeroTaxRates } from '@/lib/connectors/xero'
import { syncXeroAccountBalanceSnapshots } from '@/lib/connectors/xero/account-balances'
import { processPendingXeroSync } from '@/lib/connectors/xero'
import { getXeroSettings, XERO_SETTING_KEYS, type XeroSettings } from '@/lib/connectors/xero/settings'
import { buildAccountingCallbackUri } from '@/lib/accounting/callback-url'
import { getPublicAppUrl } from '@/lib/public-app-url'
import { getSettingValue, maskSettingSecret, serializeSettingValue } from '@/lib/settings-store'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { xeroGet } from '@/lib/connectors/xero/api'
import { isMaskedSecret, shouldFreshGateSecretWrite } from '@/lib/security/secret-mask'
import {
  assertIntegrationConnectionTestPassed,
  buildIntegrationConnectionFingerprint,
  getIntegrationConnectionTestState,
  integrationConnectionFingerprintSecret,
  recordIntegrationConnectionTest,
  type IntegrationConnectionTestState,
} from '@/lib/integration-connection-test-gate'

// Type re-export (allowed in 'use server' files)
export type { XeroSettings } from '@/lib/connectors/xero/settings'

/**
 * `sync` is the entitlement for every guarded export in this file, and ADMIN and MANAGER both
 * hold it.
 *
 * These helpers used to be named `requireAdmin`, which SHADOWED `requireAdmin` from
 * @/lib/auth/server (that one is requireRole('ADMIN')). The name misled two separate review
 * passes into reporting that MANAGER crashes on the Integrations page - the reader sees
 * `requireAdmin()` and reasonably concludes ADMIN-only. They are renamed rather than merely
 * commented, because a comment did not stop it happening the second time. The gate agreement
 * across the whole page is asserted, not assumed, in tests/accounting/dashboard-read-gates.test.ts.
 */
async function requireSyncPermission() {
  return requirePermission('sync')
}

async function requireFreshAdmin() {
  return requireFreshPermission('sync')
}

// ---------------------------------------------------------------------------
// Settings (UI-facing server actions)
// ---------------------------------------------------------------------------

export async function getXeroSettingsMasked(): Promise<XeroSettings & { secretMasked: boolean }> {
  // o3d-1fel: returns xero_client_id in clear plus every account-mapping code.
  // Only xero_client_secret is masked, so masking is not the access control.
  await requireSyncPermission()
  const settings = await getXeroSettings()
  const masked = maskSettingSecret('xero_client_secret', settings.xero_client_secret)
  return { ...settings, xero_client_secret: masked, secretMasked: !!settings.xero_client_secret }
}

async function buildXeroConnectionFingerprint(): Promise<string> {
  const [clientId, clientSecret, expectedTenantId, token] = await Promise.all([
    getSettingValue('xero_client_id'),
    getSettingValue('xero_client_secret'),
    getSettingValue('xero_expected_tenant_id'),
    db.accountingToken.findUnique({
      where: { connector: 'xero' },
      select: { tenantId: true, tenantName: true },
    }),
  ])
  return buildIntegrationConnectionFingerprint({
    clientId: clientId ?? '',
    clientSecret: integrationConnectionFingerprintSecret(clientSecret ?? ''),
    expectedTenantId: expectedTenantId ?? '',
    tenantId: token?.tenantId ?? '',
    tenantName: token?.tenantName ?? '',
  })
}

export async function saveXeroSettings(data: Partial<XeroSettings>): Promise<{ success: boolean; error?: string }> {
  try {
    await requireSyncPermission()
    if (shouldFreshGateSecretWrite(data, 'xero_client_secret')) {
      await requireFreshAdmin()
    }

    // Only run the readiness gate when the user is *transitioning* sync from
    // OFF → ON. If sync is already enabled, allow any save to go through so the
    // user can edit (or fix) their account mappings without being blocked.
    if (data.xero_sync_enabled === 'true') {
      const currentEnabled = await getSettingValue('xero_sync_enabled')
      const isTransitioningOn = currentEnabled !== 'true'
      if (isTransitioningOn) {
        const testGate = await assertIntegrationConnectionTestPassed('xero', await buildXeroConnectionFingerprint(), 'Xero')
        if (!testGate.ok) return { success: false, error: testGate.error }

        const [imsBaseCurrency, orgRes] = await Promise.all([
          getBaseCurrencyCode(),
          xeroGet<{ Organisations?: Array<{ BaseCurrency?: string }>; Organisation?: Array<{ BaseCurrency?: string }> }>('Organisation'),
        ])
        const organisations = orgRes.data?.Organisations ?? orgRes.data?.Organisation ?? []
        const xeroBaseCurrency = organisations[0]?.BaseCurrency?.toUpperCase() ?? null
        if (!orgRes.ok || !xeroBaseCurrency) {
          return { success: false, error: 'Cannot enable Xero sync because the connected organisation base currency could not be determined.' }
        }
        if (xeroBaseCurrency !== imsBaseCurrency) {
          return { success: false, error: `Cannot enable Xero sync because the Xero organisation base currency (${xeroBaseCurrency}) does not match the IMS base currency (${imsBaseCurrency}).` }
        }
        const readiness = await getXeroSyncReadiness()
        if (!readiness.ready) {
          const reasons: string[] = []
          if (readiness.notConnected) reasons.push('not connected to Xero')
          if (readiness.missingAccounts.length > 0) {
            reasons.push(`missing account mappings (${readiness.missingAccounts.map(a => a.label).join(', ')})`)
          }
          if (readiness.missingTaxTypes.length > 0) {
            reasons.push(`missing Xero tax type on IMS VAT rates (${readiness.missingTaxTypes.map(t => t.name).join(', ')})`)
          }
          return { success: false, error: `Cannot enable Xero sync — ${reasons.join('; ')}.` }
        }
      }
    }

    // Don't overwrite secret with masked value
    const entries = Object.entries(data).filter(([k, v]) => {
      if (!XERO_SETTING_KEYS.includes(k)) return false
      if (k === 'xero_client_secret' && isMaskedSecret(v)) return false
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
      action: 'xero_settings_updated',
      tag: 'sync',
      description: 'Updated Xero sync settings',
      metadata: { keys: entries.map(([k]) => k) },
    })
    revalidatePath('/sync')
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export async function getXeroConnectionTestState(): Promise<IntegrationConnectionTestState> {
  await requireSyncPermission()
  return getIntegrationConnectionTestState('xero')
}

export async function testXeroConnection(): Promise<{ success: boolean; error?: string; message?: string }> {
  await requireSyncPermission()

  const fingerprint = await buildXeroConnectionFingerprint()
  const [imsBaseCurrency, orgRes] = await Promise.all([
    getBaseCurrencyCode(),
    xeroGet<{ Organisations?: Array<{ Name?: string; BaseCurrency?: string }>; Organisation?: Array<{ Name?: string; BaseCurrency?: string }> }>('Organisation'),
  ])
  const organisations = orgRes.data?.Organisations ?? orgRes.data?.Organisation ?? []
  const organisation = organisations[0]
  const xeroBaseCurrency = organisation?.BaseCurrency?.toUpperCase() ?? null
  let message: string
  let success = false

  if (!orgRes.ok || !xeroBaseCurrency) {
    message = 'Cannot verify Xero because the connected organisation base currency could not be determined.'
  } else if (xeroBaseCurrency !== imsBaseCurrency) {
    message = `Xero organisation base currency (${xeroBaseCurrency}) does not match the IMS base currency (${imsBaseCurrency}).`
  } else {
    success = true
    message = `Connection verified against Xero${organisation?.Name ? ` (${organisation.Name})` : ''}.`
  }

  await recordIntegrationConnectionTest('xero', { success, fingerprint, message })
  revalidatePath('/sync')
  return success ? { success, message } : { success, error: message }
}

export async function saveXeroConnectionSettings(
  clientId: string,
  clientSecret: string,
): Promise<{ success: boolean; error?: string; message?: string }> {
  try {
    await requireFreshAdmin()

    const nextClientId = clientId.trim()
    const nextClientSecretInput = clientSecret.trim()
    const nextClientSecret = isMaskedSecret(nextClientSecretInput) ? '' : nextClientSecretInput
    const existingSettings = await getXeroSettings()
    const resolvedSecret = nextClientSecret || existingSettings.xero_client_secret.trim()

    if (!nextClientId) {
      return { success: false, error: 'Xero Client ID is required.' }
    }

    if (!resolvedSecret) {
      return { success: false, error: 'Xero Client Secret is required.' }
    }

    const publicAppUrl = await getPublicAppUrl()
    if (!publicAppUrl) {
      return { success: false, error: 'Public app URL is not configured.' }
    }

    const redirectUri = buildAccountingCallbackUri(publicAppUrl)
    if (!redirectUri) {
      return { success: false, error: 'Xero redirect URL is invalid.' }
    }

    const ops = [
      db.setting.upsert({
        where: { key: 'xero_client_id' },
        create: { key: 'xero_client_id', value: serializeSettingValue('xero_client_id', nextClientId) },
        update: { value: serializeSettingValue('xero_client_id', nextClientId) },
      }),
    ]

    if (nextClientSecret) {
      ops.push(
        db.setting.upsert({
          where: { key: 'xero_client_secret' },
          create: { key: 'xero_client_secret', value: serializeSettingValue('xero_client_secret', nextClientSecret) },
          update: { value: serializeSettingValue('xero_client_secret', nextClientSecret) },
        }),
      )
    }

    await db.$transaction(ops)

    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_connection_settings_updated',
      tag: 'sync',
      description: 'Updated Xero connection settings',
    })

    revalidatePath('/sync')
    revalidatePath('/onboarding')
    return { success: true, message: 'Connection settings saved. OAuth redirect is ready.' }
  } catch (error) {
    // audit-ohou: surface the fresh-auth gate as a structured failure so the
    // accounting delegator + client can step-up re-auth and retry.
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    return { success: false, error: String(error) }
  }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export async function getXeroConnectionStatus(): Promise<{
  connected: boolean
  tenantName?: string
  blockedReason?: string
  hasStoredToken?: boolean
}> {
  // o3d-1fel: leaks the connected tenant NAME, not just a boolean.
  await requireSyncPermission()
  return isConnected()
}

export async function connectXero(
  clientId: string,
  clientSecret: string,
  origin: string,
  returnPath?: string,
): Promise<{ success: boolean; redirectUrl?: string; error?: string }> {
  try {
    void origin
    const session = await requireFreshAdmin()

    // Save credentials (never overwrite secret with masked value)
    const ops = [
      db.setting.upsert({ where: { key: 'xero_client_id' }, create: { key: 'xero_client_id', value: serializeSettingValue('xero_client_id', clientId) }, update: { value: serializeSettingValue('xero_client_id', clientId) } }),
    ]
    if (clientSecret && !isMaskedSecret(clientSecret)) {
      ops.push(db.setting.upsert({ where: { key: 'xero_client_secret' }, create: { key: 'xero_client_secret', value: serializeSettingValue('xero_client_secret', clientSecret) }, update: { value: serializeSettingValue('xero_client_secret', clientSecret) } }))
    }
    await db.$transaction(ops)

    // Build Xero authorization URL — user's browser will redirect here.
    // `state` is persisted server-side bound to the initiating user and
    // validated in the callback (CSRF / mix-up protection).
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
    const freshAuthFailure = freshAuthFailureResult(e)
    if (freshAuthFailure) return freshAuthFailure
    return { success: false, error: String(e) }
  }
}

export async function disconnectXero(): Promise<{ success: boolean; error?: string }> {
  try {
    await requireFreshAdmin()
    await disconnect()

    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_disconnected',
      tag: 'sync',
      description: 'Disconnected from Xero',
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

export async function syncAccountingAccounts(): Promise<{ synced: number; errors: string[] }> {
  await requireSyncPermission()
  const result = await syncChartOfAccounts()

  await logActivity({
    entityType: 'SYSTEM',
    action: 'accounting_accounts_synced',
    tag: 'sync',
    description: `Synced ${result.synced} accounts from Xero`,
    metadata: result,
  })

  revalidatePath('/sync')
  return result
}

export async function syncAccountingAccountBalanceSnapshots(balanceDate?: string): Promise<{ fetched: number; persisted: number; skipped: number; errors: string[] }> {
  await requireRole('ADMIN', 'FINANCE')
  const result = await syncXeroAccountBalanceSnapshots({ balanceDate })
  const hasErrors = result.errors.length > 0
  const hasSkipped = result.skipped > 0

  await logActivity({
    entityType: 'SYSTEM',
    action: 'accounting_account_balance_snapshots_synced',
    tag: 'sync',
    level: hasErrors ? 'ERROR' : hasSkipped ? 'WARNING' : 'INFO',
    description: hasErrors
      ? `Synced ${result.persisted} account balance snapshots from Xero with ${result.errors.length} error(s)`
      : `Synced ${result.persisted} account balance snapshots from Xero`,
    metadata: { balanceDate: balanceDate ?? null, ...result },
  })

  revalidatePath('/sync')
  revalidatePath('/analytics/inventory-valuation')
  revalidatePath('/analytics/cogs')
  return result
}

export async function getAccountingAccounts(): Promise<Array<{ id: string; externalAccountId: string; code: string | null; name: string; type: string }>> {
  // o3d-1fel: this reads the chart of accounts straight out of the database. A
  // single-statement `return db.<model>.findMany(...)` is NOT a delegating
  // facade — there is no downstream guard to inherit.
  await requireSyncPermission()
  return db.accountingAccount.findMany({
    where: { connector: 'xero', active: true },
    select: { id: true, externalAccountId: true, code: true, name: true, type: true },
    orderBy: [{ code: 'asc' }],
  })
}

export async function fetchXeroTaxRates(
  opts?: { allowCache?: boolean },
): Promise<Array<{ taxType: string; name: string; rate: number }>> {
  // o3d-1fel: makes a LIVE outbound call to the tenant's Xero org, so leaving
  // it open is request amplification as well as a data leak.
  await requireSyncPermission()
  const result = await getXeroTaxRates(opts)
  return result?.taxRates ?? []
}

// ---------------------------------------------------------------------------
// Sync Logs
// ---------------------------------------------------------------------------

export type XeroSyncLogRow = {
  id: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  errorMessage: string | null
  retryCount: number
  /**
   * o3d-e2mz: which attempt this row is currently on. Any operator decision taken about what this
   * row shows must carry this value back, so the decision can be refused when the row has moved on
   * to a different attempt since it was read. 0 means no fence-aware processor has ever claimed it.
   */
  attemptRevision: number
  syncedAt: string | null
  createdAt: string
}

export async function getXeroSyncLogs(limit = 50): Promise<XeroSyncLogRow[]> {
  // o3d-1fel: sync-log rows carry referenceId / externalTransactionId / errorMessage.
  await requireSyncPermission()
  const rows = await db.accountingSyncLog.findMany({
    where: { connector: 'xero' },
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
    attemptRevision: r.attemptRevision,
    syncedAt: r.syncedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }))
}

// ---------------------------------------------------------------------------
// Manual Sync
// ---------------------------------------------------------------------------

export async function triggerXeroSync(): Promise<{ success: boolean; result?: unknown; error?: string }> {
  try {
    await requireSyncPermission()

    const enabled = await db.setting.findUnique({ where: { key: 'xero_sync_enabled' } })
    if (enabled?.value !== 'true') {
      return { success: false, error: 'Xero sync is not enabled' }
    }

    const result = await processPendingXeroSync()
    // audit-H3: also repair any documents missing their back-reference.
    // audit-w77e: and enqueue allocations for credit notes whose bill synced late.
    let backReferenceRepair: unknown
    let creditNoteAllocationReenqueue: unknown
    try {
      const { repairXeroBackReferences, reenqueueMissingCreditNoteAllocations } = await import('@/lib/connectors/xero/sync-processor')
      backReferenceRepair = await repairXeroBackReferences()
      // Codex review (w77e): surface the sweep result so per-item failures aren't
      // silently swallowed by the manual path (the cron already returns it).
      creditNoteAllocationReenqueue = await reenqueueMissingCreditNoteAllocations()
    } catch (repairError) {
      console.error('Manual Xero sync: back-reference repair / allocation re-enqueue failed', repairError)
    }

    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_manual_sync',
      tag: 'sync',
      description: `Manual Xero sync: ${result.succeeded} synced, ${result.failed} failed`,
      metadata: { ...result, backReferenceRepair, creditNoteAllocationReenqueue },
    })

    revalidatePath('/sync')
    return { success: true, result }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export async function retryFailedXeroSync(entryId?: string): Promise<{ success: boolean; reset: number; error?: string }> {
  try {
    await requireSyncPermission()
    const where = entryId
      ? { id: entryId, connector: 'xero', status: 'FAILED' as const }
      : { connector: 'xero', status: 'FAILED' as const }
    const result = await db.accountingSyncLog.updateMany({
      where,
      data: { status: 'PENDING', retryCount: 0, errorMessage: null, processingStartedAt: null },
    })
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_retry_failed',
      tag: 'sync',
      description: `Reset ${result.count} failed Xero sync entry/entries for retry`,
    })
    revalidatePath('/sync')
    return { success: true, reset: result.count }
  } catch (e) {
    return { success: false, reset: 0, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Readiness check — validate before allowing Xero sync to be enabled
// ---------------------------------------------------------------------------

export type XeroSyncReadiness = {
  ready: boolean
  notConnected: boolean
  missingAccounts: Array<{ key: string; label: string }>
  missingTaxTypes: Array<{ id: string; name: string }>
  /**
   * Scopes this connection was asked for but NOT granted (o3d-g2i). Empty when the grant is complete —
   * and also when it was never recorded, because unknown must never be reported as missing.
   */
  missingScopes: string[]
}

const REQUIRED_ACCOUNTS: Array<{ key: keyof XeroSettings; label: string }> = [
  { key: 'xero_sales_account', label: 'Sales Revenue' },
  { key: 'xero_shipping_account', label: 'Shipping Income' },
  { key: 'xero_discount_account', label: 'Discounts Given' },
  { key: 'xero_transit_account', label: 'Stock in Transit' },
  { key: 'xero_inventory_account', label: 'Inventory Asset' },
  { key: 'xero_allocated_inventory_account', label: 'Allocated Inventory' },
  { key: 'xero_cogs_account', label: 'Cost of Goods Sold' },
  { key: 'xero_unearned_revenue_account', label: 'Unearned Revenue' },
  { key: 'xero_accounts_receivable_account', label: 'Accounts Receivable' },
  { key: 'xero_accounts_payable_account', label: 'Accounts Payable' },
  { key: 'xero_realised_fx_gain_loss_account', label: 'Realised FX Gain/Loss' },
  { key: 'xero_unrealised_fx_gain_loss_account', label: 'Unrealised FX Gain/Loss' },
]

export async function getXeroSyncReadiness(): Promise<XeroSyncReadiness> {
  // o3d-1fel: reads settings + tax rates + the granted OAuth scopes.
  await requireSyncPermission()
  const [settings, connStatus, taxRates, granted] = await Promise.all([
    getXeroSettings(),
    isConnected(),
    db.taxRate.findMany({
      where: { active: true },
      select: { id: true, name: true, accountingTaxType: true },
      orderBy: { name: 'asc' },
    }),
    getGrantedScopes(),
  ])

  const missingAccounts = REQUIRED_ACCOUNTS
    .filter(a => !settings[a.key])
    .map(a => ({ key: a.key as string, label: a.label }))

  const missingTaxTypes = taxRates
    .filter(r => !r.accountingTaxType)
    .map(r => ({ id: r.id, name: r.name }))

  // Deliberately NOT part of `ready`: an incomplete grant does not stop invoices or bills posting, it
  // stops the specific syncs that need the missing scope. Blocking the whole connector over it would be a
  // worse outage than the fault. It is surfaced as its own warning with the one action that fixes it.
  const missing = missingScopes(granted)

  return {
    ready: connStatus.connected && missingAccounts.length === 0 && missingTaxTypes.length === 0,
    notConnected: !connStatus.connected,
    missingAccounts,
    missingTaxTypes,
    missingScopes: missing,
  }
}
