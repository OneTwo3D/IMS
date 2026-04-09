'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { auth } from '@/lib/auth'
import { getAuthorizationUrl, disconnect, isConnected } from '@/lib/connectors/xero'
import { syncChartOfAccounts, getXeroTaxRates } from '@/lib/connectors/xero'
import { processPendingXeroSync } from '@/lib/connectors/xero'

async function requireAdmin() {
  const session = await auth()
  if (!session?.user?.id || !['ADMIN', 'MANAGER'].includes(session.user.role)) throw new Error('Unauthorized')
  return session
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type XeroSettings = {
  xero_client_id: string
  xero_client_secret: string
  xero_sync_enabled: string
  // Per-transaction-type sync toggles
  xero_sync_sales_invoice: string
  xero_sync_credit_note: string
  xero_sync_purchase_invoice: string
  xero_sync_cogs_journal: string
  xero_sync_cogs_reversal: string
  xero_sync_stock_receipt: string
  xero_sync_inventory_adjustment: string
  xero_sync_attach_pdf: string
  // Account mappings
  xero_sales_account: string
  xero_shipping_account: string
  xero_discount_account: string
  xero_cogs_account: string
  xero_inventory_account: string
  xero_transit_account: string
  xero_purchase_account: string
}

const XERO_SETTING_KEYS = [
  'xero_client_id', 'xero_client_secret', 'xero_sync_enabled',
  'xero_sync_sales_invoice', 'xero_sync_credit_note', 'xero_sync_purchase_invoice',
  'xero_sync_cogs_journal', 'xero_sync_cogs_reversal',
  'xero_sync_stock_receipt', 'xero_sync_inventory_adjustment', 'xero_sync_attach_pdf',
  'xero_sales_account', 'xero_shipping_account', 'xero_discount_account',
  'xero_cogs_account', 'xero_inventory_account', 'xero_transit_account',
  'xero_purchase_account',
]

const XERO_DEFAULTS: XeroSettings = {
  xero_client_id: '',
  xero_client_secret: '',
  xero_sync_enabled: 'false',
  xero_sync_sales_invoice: 'true',
  xero_sync_credit_note: 'true',
  xero_sync_purchase_invoice: 'true',
  xero_sync_cogs_journal: 'true',
  xero_sync_cogs_reversal: 'true',
  xero_sync_stock_receipt: 'true',
  xero_sync_inventory_adjustment: 'true',
  xero_sync_attach_pdf: 'true',
  xero_sales_account: '',
  xero_shipping_account: '',
  xero_discount_account: '',
  xero_cogs_account: '',
  xero_inventory_account: '',
  xero_transit_account: '',
  xero_purchase_account: '',
}

/** Map sync type enum → setting key for per-type enable/disable */
const SYNC_TYPE_SETTING: Record<string, keyof XeroSettings> = {
  SALES_INVOICE: 'xero_sync_sales_invoice',
  CREDIT_NOTE: 'xero_sync_credit_note',
  PURCHASE_INVOICE: 'xero_sync_purchase_invoice',
  COGS_JOURNAL: 'xero_sync_cogs_journal',
  COGS_REVERSAL: 'xero_sync_cogs_reversal',
  STOCK_RECEIPT: 'xero_sync_stock_receipt',
  INVENTORY_ADJUSTMENT: 'xero_sync_inventory_adjustment',
}

export async function getXeroSettings(): Promise<XeroSettings> {
  const rows = await db.setting.findMany({ where: { key: { in: XERO_SETTING_KEYS } } })
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const result = { ...XERO_DEFAULTS }
  for (const k of Object.keys(result) as (keyof XeroSettings)[]) {
    const v = map.get(k)
    if (v) result[k] = v
  }
  return result
}

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
  const rows = await db.xeroSyncLog.findMany({
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
// Helper: Queue a Xero sync entry (used by other actions)
// ---------------------------------------------------------------------------

export async function queueXeroSync(params: {
  type: 'SALES_INVOICE' | 'CREDIT_NOTE' | 'COGS_REVERSAL' | 'STOCK_IN_TRANSIT' | 'STOCK_RECEIPT' | 'PURCHASE_INVOICE' | 'COGS_JOURNAL' | 'INVENTORY_ADJUSTMENT'
  referenceType: string
  referenceId: string
  payload: Record<string, unknown>
}): Promise<void> {
  // Check if Xero sync is globally enabled
  const settings = await getXeroSettings()
  if (settings.xero_sync_enabled !== 'true') return

  // Check if this specific sync type is enabled
  const settingKey = SYNC_TYPE_SETTING[params.type]
  if (settingKey && settings[settingKey] !== 'true') return

  await db.xeroSyncLog.create({
    data: {
      type: params.type,
      status: 'PENDING',
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      payload: params.payload as never,
    },
  })
}
