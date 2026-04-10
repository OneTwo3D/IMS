'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { auth } from '@/lib/auth'
import { getAuthorizationUrl, disconnect, isConnected } from '@/lib/connectors/xero'
import { syncChartOfAccounts, getXeroTaxRates } from '@/lib/connectors/xero'
import { processPendingXeroSync } from '@/lib/connectors/xero'
import { getXeroSettings, XERO_SETTING_KEYS, type XeroSettings } from '@/lib/connectors/xero/settings'

// Type re-export (allowed in 'use server' files)
export type { XeroSettings } from '@/lib/connectors/xero/settings'

async function requireAdmin() {
  const session = await auth()
  if (!session?.user?.id || !['ADMIN', 'MANAGER'].includes(session.user.role)) throw new Error('Unauthorized')
  return session
}

// ---------------------------------------------------------------------------
// Settings (UI-facing server actions)
// ---------------------------------------------------------------------------

export async function getXeroSettingsMasked(): Promise<XeroSettings & { secretMasked: boolean }> {
  const settings = await getXeroSettings()
  const masked = settings.xero_client_secret
    ? settings.xero_client_secret.substring(0, 4) + '****'
    : ''
  return { ...settings, xero_client_secret: masked, secretMasked: !!settings.xero_client_secret }
}

export async function saveXeroSettings(data: Partial<XeroSettings>): Promise<{ success: boolean; error?: string }> {
  try {
    await requireAdmin()

    // If attempting to enable sync, verify readiness first
    if (data.xero_sync_enabled === 'true') {
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

    // Don't overwrite secret with masked value
    const entries = Object.entries(data).filter(([k, v]) => {
      if (!XERO_SETTING_KEYS.includes(k)) return false
      if (k === 'xero_client_secret' && typeof v === 'string' && v.includes('****')) return false
      return true
    })

    const ops = entries.map(([k, v]) =>
      db.setting.upsert({
        where: { key: k },
        create: { key: k, value: v ?? '' },
        update: { value: v ?? '' },
      }),
    )
    await db.$transaction(ops)

    logActivity({
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

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export async function getXeroConnectionStatus(): Promise<{
  connected: boolean
  tenantName?: string
}> {
  return isConnected()
}

export async function connectXero(
  clientId: string,
  clientSecret: string,
  origin: string,
): Promise<{ success: boolean; redirectUrl?: string; error?: string }> {
  try {
    await requireAdmin()

    // Save credentials (never overwrite secret with masked value)
    const ops = [
      db.setting.upsert({ where: { key: 'xero_client_id' }, create: { key: 'xero_client_id', value: clientId }, update: { value: clientId } }),
    ]
    if (clientSecret && !clientSecret.includes('****')) {
      ops.push(db.setting.upsert({ where: { key: 'xero_client_secret' }, create: { key: 'xero_client_secret', value: clientSecret }, update: { value: clientSecret } }))
    }
    await db.$transaction(ops)

    // Build Xero authorization URL — user's browser will redirect here
    const redirectUri = `${origin}/api/xero/callback`
    const authUrl = getAuthorizationUrl(clientId, redirectUri)

    return { success: true, redirectUrl: authUrl }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export async function disconnectXero(): Promise<{ success: boolean; error?: string }> {
  try {
    await requireAdmin()
    await disconnect()

    logActivity({
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

export async function syncXeroAccounts(): Promise<{ synced: number; errors: string[] }> {
  await requireAdmin()
  const result = await syncChartOfAccounts()

  logActivity({
    entityType: 'SYSTEM',
    action: 'xero_accounts_synced',
    tag: 'sync',
    description: `Synced ${result.synced} accounts from Xero`,
    metadata: result,
  })

  revalidatePath('/sync')
  return result
}

export async function getXeroAccounts(): Promise<Array<{ id: string; code: string | null; name: string; type: string }>> {
  return db.xeroAccount.findMany({
    where: { active: true },
    select: { id: true, code: true, name: true, type: true },
    orderBy: [{ code: 'asc' }],
  })
}

export async function fetchXeroTaxRates(): Promise<Array<{ taxType: string; name: string; rate: number }>> {
  const result = await getXeroTaxRates()
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
  xeroTransactionId: string | null
  errorMessage: string | null
  retryCount: number
  syncedAt: string | null
  createdAt: string
}

export async function getXeroSyncLogs(limit = 50): Promise<XeroSyncLogRow[]> {
  const rows = await db.accountingSyncLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  return rows.map(r => ({
    id: r.id,
    type: r.type,
    status: r.status,
    referenceType: r.referenceType,
    referenceId: r.referenceId,
    xeroTransactionId: r.xeroTransactionId,
    errorMessage: r.errorMessage,
    retryCount: r.retryCount,
    syncedAt: r.syncedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }))
}

// ---------------------------------------------------------------------------
// Manual Sync
// ---------------------------------------------------------------------------

export async function triggerXeroSync(): Promise<{ success: boolean; result?: unknown; error?: string }> {
  try {
    await requireAdmin()

    const enabled = await db.setting.findUnique({ where: { key: 'xero_sync_enabled' } })
    if (enabled?.value !== 'true') {
      return { success: false, error: 'Xero sync is not enabled' }
    }

    const result = await processPendingXeroSync()

    logActivity({
      entityType: 'SYSTEM',
      action: 'xero_manual_sync',
      tag: 'sync',
      description: `Manual Xero sync: ${result.succeeded} synced, ${result.failed} failed`,
      metadata: result,
    })

    revalidatePath('/sync')
    return { success: true, result }
  } catch (e) {
    return { success: false, error: String(e) }
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
]

export async function getXeroSyncReadiness(): Promise<XeroSyncReadiness> {
  const [settings, connStatus, taxRates] = await Promise.all([
    getXeroSettings(),
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

// ---------------------------------------------------------------------------
// Payment account map helpers
// ---------------------------------------------------------------------------

/** Get distinct payment method + currency combos from existing orders (for UI pre-population) */
export async function getPaymentMethodCombos(): Promise<Array<{ paymentMethod: string; currency: string }>> {
  const rows = await db.salesOrder.findMany({
    where: { paymentMethod: { not: null } },
    select: { paymentMethod: true, currency: true },
    distinct: ['paymentMethod', 'currency'],
    orderBy: [{ paymentMethod: 'asc' }, { currency: 'asc' }],
  })
  return rows
    .filter((r): r is { paymentMethod: string; currency: string } => !!r.paymentMethod)
    .map((r) => ({ paymentMethod: r.paymentMethod, currency: r.currency }))
}
