/**
 * Xero sync queue — creates AccountingSyncLog entries for pending Xero sync.
 * Moved from app/actions/xero-sync.ts — this is an internal utility, not a server action.
 */

import { db } from '@/lib/db'
import { getXeroSettings, type XeroSettings } from './settings'

/** Map sync type enum → setting key for per-type enable/disable */
const SYNC_TYPE_SETTING: Record<string, keyof XeroSettings> = {
  SALES_INVOICE: 'xero_sync_sales_invoice',
  CREDIT_NOTE: 'xero_sync_credit_note',
  PURCHASE_INVOICE: 'xero_sync_purchase_invoice',
  COGS_JOURNAL: 'xero_sync_cogs_journal',
  COGS_REVERSAL: 'xero_sync_cogs_reversal',
  STOCK_RECEIPT: 'xero_sync_stock_receipt',
  INVENTORY_ADJUSTMENT: 'xero_sync_inventory_adjustment',
  STOCK_ALLOCATION: 'xero_sync_stock_allocation',
}

export async function queueXeroSync(params: {
  type: 'SALES_INVOICE' | 'CREDIT_NOTE' | 'COGS_REVERSAL' | 'STOCK_IN_TRANSIT' | 'STOCK_RECEIPT' | 'PURCHASE_INVOICE' | 'COGS_JOURNAL' | 'INVENTORY_ADJUSTMENT' | 'STOCK_ALLOCATION' | 'DAILY_BATCH_REVENUE_DEFERRAL' | 'DAILY_BATCH_INVENTORY_ALLOC' | 'DAILY_BATCH_GROUP_B' | 'UNEARNED_REV_REVERSAL'
  referenceType: string
  referenceId: string
  payload: Record<string, unknown>
}): Promise<void> {
  const settings = await getXeroSettings()
  if (settings.xero_sync_enabled !== 'true') return

  const settingKey = SYNC_TYPE_SETTING[params.type]
  const postingMode = settingKey ? settings[settingKey] : 'submitted'
  if (!postingMode || postingMode === 'off') return

  const payload = { ...params.payload, _postingMode: postingMode }

  await db.accountingSyncLog.create({
    data: {
      type: params.type,
      status: 'PENDING',
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      payload: payload as never,
    },
  })
}
