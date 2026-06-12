/**
 * Xero sync queue — creates AccountingSyncLog entries for pending Xero sync.
 * Moved from app/actions/xero-sync.ts — this is an internal utility, not a server action.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { mirrorAccountingSyncLogToEvent } from '@/lib/domain/accounting/accounting-event-mirror'
import { getXeroSettings, type XeroSettings } from './settings'
import { scheduleXeroAccountingOutbox } from './outbox'

/** Map sync type enum → setting key for per-type enable/disable */
const SYNC_TYPE_SETTING: Record<string, keyof XeroSettings> = {
  SALES_INVOICE: 'xero_sync_sales_invoice',
  SALES_INVOICE_UPDATE: 'xero_sync_sales_invoice',
  CREDIT_NOTE: 'xero_sync_credit_note',
  PURCHASE_INVOICE: 'xero_sync_purchase_invoice',
  PURCHASE_INVOICE_UPDATE: 'xero_sync_purchase_invoice',
  COGS_JOURNAL: 'xero_sync_cogs_journal',
  COGS_REVERSAL: 'xero_sync_cogs_reversal',
  STOCK_RECEIPT: 'xero_sync_stock_receipt',
  INVENTORY_ADJUSTMENT: 'xero_sync_inventory_adjustment',
  STOCK_ALLOCATION: 'xero_sync_stock_allocation',
  REALISED_FX_JOURNAL: 'xero_sync_realised_fx_journal',
  UNREALISED_FX_JOURNAL: 'xero_sync_unrealised_fx_journal',
  MANUFACTURING_JOURNAL: 'xero_sync_manufacturing_journal',
  MANUFACTURING_RECLASS: 'xero_sync_manufacturing_journal',
  TAX_RATE_SYNC: 'xero_sync_tax_rate',
}

export async function queueXeroSync(params: {
  type: 'SALES_INVOICE' | 'SALES_INVOICE_UPDATE' | 'CREDIT_NOTE' | 'COGS_REVERSAL' | 'STOCK_IN_TRANSIT' | 'STOCK_RECEIPT' | 'PURCHASE_INVOICE' | 'PURCHASE_INVOICE_UPDATE' | 'COGS_JOURNAL' | 'INVENTORY_ADJUSTMENT' | 'STOCK_ALLOCATION' | 'DAILY_BATCH_REVENUE_DEFERRAL' | 'DAILY_BATCH_INVENTORY_ALLOC' | 'DAILY_BATCH_GROUP_B' | 'UNEARNED_REV_REVERSAL' | 'BILL_PAYMENT' | 'INVOICE_PAYMENT' | 'BILL_ATTACHMENT' | 'INVOICE_PDF' | 'INVOICE_EMAIL' | 'WC_INVOICE_NOTE' | 'REALISED_FX_JOURNAL' | 'UNREALISED_FX_JOURNAL' | 'MANUFACTURING_JOURNAL' | 'MANUFACTURING_RECLASS' | 'TAX_RATE_SYNC'
  referenceType: string
  referenceId: string
  payload: Record<string, unknown>
  idempotencyKey?: string
}): Promise<void> {
  const settings = await getXeroSettings()
  if (settings.xero_sync_enabled !== 'true') return

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
        connector: 'xero',
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
    let mirrorErrorMessage: string | null = null
    await db.$transaction(async (tx) => {
      const log = await tx.accountingSyncLog.create({
        data: {
          connector: 'xero',
          type: params.type,
          status: 'PENDING',
          referenceType: params.referenceType,
          referenceId: params.referenceId,
          payload: payload as never,
        },
      })
      await scheduleXeroAccountingOutbox(tx, {
        accountingSyncLogId: log.id,
      })
      try {
        const baseCurrency = await getBaseCurrencyCode()
        await mirrorAccountingSyncLogToEvent(tx, {
          syncLogId: log.id,
          connector: 'xero',
          type: params.type,
          referenceType: params.referenceType,
          referenceId: params.referenceId,
          payload,
          currency: baseCurrency,
          status: 'PENDING',
        })
      } catch (mirrorError) {
        mirrorErrorMessage = `Xero sync entry ${log.id} was queued but accounting event mirroring failed: ${String(mirrorError)}`
      }
    })
    if (mirrorErrorMessage) {
      await logActivity({
        entityType: 'SYSTEM',
        action: 'accounting_event_mirror_error',
        tag: 'sync',
        level: 'WARNING',
        description: mirrorErrorMessage,
      })
    }
  } catch (error) {
    if (params.idempotencyKey && String(error).includes('accounting_sync_logs_idempotency_key_uq')) return
    throw error
  }
}
