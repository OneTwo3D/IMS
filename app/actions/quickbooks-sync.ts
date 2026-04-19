'use server'

import { requirePermission } from '@/lib/auth/server'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import {
  getAuthorizationUrl,
  disconnect,
  isConnected,
  syncChartOfAccounts,
  getQuickBooksTaxCodes,
  processPendingQuickBooksSync,
} from '@/lib/connectors/quickbooks'
import { getQuickBooksSettings, QUICKBOOKS_SETTING_KEYS, type QuickBooksSettings } from '@/lib/connectors/quickbooks/settings'
import { getPublicAppUrl } from '@/lib/public-app-url'
import { getSettingValue, serializeSettingValue } from '@/lib/settings-store'

export type { QuickBooksSettings } from '@/lib/connectors/quickbooks/settings'

async function requireAdmin() {
  return requirePermission('sync')
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getQuickBooksSettingsMasked(): Promise<QuickBooksSettings & { secretMasked: boolean }> {
  const settings = await getQuickBooksSettings()
  const masked = settings.quickbooks_client_secret
    ? settings.quickbooks_client_secret.substring(0, 4) + '****'
    : ''
  return { ...settings, quickbooks_client_secret: masked, secretMasked: !!settings.quickbooks_client_secret }
}

export async function saveQuickBooksSettings(data: Partial<QuickBooksSettings>): Promise<{ success: boolean; error?: string }> {
  try {
    await requireAdmin()

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
      if (k === 'quickbooks_client_secret' && typeof v === 'string' && v.includes('****')) return false
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
): Promise<{ success: boolean; redirectUrl?: string; error?: string }> {
  try {
    void origin
    const session = await requireAdmin()

    // Save credentials
    const ops = [
      db.setting.upsert({ where: { key: 'quickbooks_client_id' }, create: { key: 'quickbooks_client_id', value: serializeSettingValue('quickbooks_client_id', clientId) }, update: { value: serializeSettingValue('quickbooks_client_id', clientId) } }),
    ]
    if (clientSecret && !clientSecret.includes('****')) {
      ops.push(db.setting.upsert({ where: { key: 'quickbooks_client_secret' }, create: { key: 'quickbooks_client_secret', value: serializeSettingValue('quickbooks_client_secret', clientSecret) }, update: { value: serializeSettingValue('quickbooks_client_secret', clientSecret) } }))
    }
    await db.$transaction(ops)

    const publicAppUrl = await getPublicAppUrl()
    if (!publicAppUrl) {
      return { success: false, error: 'Public app URL is not configured.' }
    }
    const redirectUri = `${publicAppUrl}/api/accounting/callback`
    const authUrl = await getAuthorizationUrl(clientId, redirectUri, session.user.id)

    return { success: true, redirectUrl: authUrl }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export async function disconnectQuickBooks(): Promise<{ success: boolean; error?: string }> {
  try {
    await requireAdmin()
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

export async function retryFailedQuickBooksSync(entryId?: string): Promise<{ success: boolean; reset: number; error?: string }> {
  try {
    await requireAdmin()
    const where = entryId
      ? { id: entryId, connector: 'quickbooks', status: 'FAILED' as const }
      : { connector: 'quickbooks', status: 'FAILED' as const }
    const result = await db.accountingSyncLog.updateMany({
      where,
      data: { status: 'PENDING', retryCount: 0, errorMessage: null, processingStartedAt: null },
    })
    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_retry_failed',
      tag: 'sync',
      description: `Reset ${result.count} failed QuickBooks sync entry/entries for retry`,
    })
    revalidatePath('/sync')
    return { success: true, reset: result.count }
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
  }
}
