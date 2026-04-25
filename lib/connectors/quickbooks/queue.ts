/**
 * QuickBooks sync queue — creates AccountingSyncLog entries for pending sync.
 * Mirrors lib/connectors/xero/queue.ts with per-type enable/disable gating.
 */

import { db } from '@/lib/db'
import { getQuickBooksSettings, type QuickBooksSettings } from './settings'

/** Map sync type enum → setting key for per-type enable/disable */
const SYNC_TYPE_SETTING: Record<string, keyof QuickBooksSettings> = {
  SALES_INVOICE: 'quickbooks_sync_sales_invoice',
  CREDIT_NOTE: 'quickbooks_sync_credit_note',
  PURCHASE_INVOICE: 'quickbooks_sync_purchase_invoice',
  COGS_JOURNAL: 'quickbooks_sync_cogs_journal',
  COGS_REVERSAL: 'quickbooks_sync_cogs_reversal',
  STOCK_RECEIPT: 'quickbooks_sync_stock_receipt',
  INVENTORY_ADJUSTMENT: 'quickbooks_sync_inventory_adjustment',
  STOCK_ALLOCATION: 'quickbooks_sync_stock_allocation',
  REALISED_FX_JOURNAL: 'quickbooks_sync_realised_fx_journal',
  MANUFACTURING_JOURNAL: 'quickbooks_sync_manufacturing_journal',
  MANUFACTURING_RECLASS: 'quickbooks_sync_manufacturing_journal',
}

export async function queueQuickBooksSync(params: {
  type: 'SALES_INVOICE' | 'CREDIT_NOTE' | 'COGS_REVERSAL' | 'STOCK_IN_TRANSIT' | 'STOCK_RECEIPT' | 'PURCHASE_INVOICE' | 'COGS_JOURNAL' | 'INVENTORY_ADJUSTMENT' | 'STOCK_ALLOCATION' | 'DAILY_BATCH_REVENUE_DEFERRAL' | 'DAILY_BATCH_INVENTORY_ALLOC' | 'DAILY_BATCH_GROUP_B' | 'UNEARNED_REV_REVERSAL' | 'BILL_PAYMENT' | 'INVOICE_PAYMENT' | 'BILL_ATTACHMENT' | 'INVOICE_PDF' | 'INVOICE_EMAIL' | 'WC_INVOICE_NOTE' | 'REALISED_FX_JOURNAL' | 'MANUFACTURING_JOURNAL' | 'MANUFACTURING_RECLASS'
  referenceType: string
  referenceId: string
  payload: Record<string, unknown>
  idempotencyKey?: string
}): Promise<void> {
  const settings = await getQuickBooksSettings()
  if (settings.quickbooks_sync_enabled !== 'true') return

  const settingKey = SYNC_TYPE_SETTING[params.type]
  const postingMode = settingKey ? settings[settingKey] : 'submitted'
  if (!postingMode || postingMode === 'off') return

  const payload = {
    ...params.payload,
    _postingMode: postingMode,
    ...(params.idempotencyKey ? { _idempotencyKey: params.idempotencyKey } : {}),
  }

  if (params.idempotencyKey) {
    const existing = await db.accountingSyncLog.findFirst({
      where: {
        connector: 'quickbooks',
        type: params.type,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
        status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
        payload: { path: ['_idempotencyKey'], equals: params.idempotencyKey },
      },
      select: { id: true },
    })
    if (existing) return
  }

  try {
    await db.accountingSyncLog.create({
      data: {
        connector: 'quickbooks',
        type: params.type,
        status: 'PENDING',
        referenceType: params.referenceType,
        referenceId: params.referenceId,
        payload: payload as never,
      },
    })
  } catch (error) {
    if (params.idempotencyKey && String(error).includes('accounting_sync_logs_idempotency_key_uq')) return
    throw error
  }
}
