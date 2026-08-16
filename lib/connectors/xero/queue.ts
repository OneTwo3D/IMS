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
import {
  findStaleOrderLevelDiscount,
  lockOrderForAccountingEnqueue,
  logStaleOrderDiscountEnqueue,
} from '@/lib/domain/accounting/enqueue-order-guard'

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
  type: 'SALES_INVOICE' | 'SALES_INVOICE_UPDATE' | 'CREDIT_NOTE' | 'PURCHASE_CREDIT_NOTE' | 'PURCHASE_CREDIT_NOTE_ALLOCATION' | 'COGS_REVERSAL' | 'STOCK_IN_TRANSIT' | 'STOCK_RECEIPT' | 'PURCHASE_INVOICE' | 'PURCHASE_INVOICE_UPDATE' | 'COGS_JOURNAL' | 'INVENTORY_ADJUSTMENT' | 'STOCK_ALLOCATION' | 'DAILY_BATCH_REVENUE_DEFERRAL' | 'DAILY_BATCH_INVENTORY_ALLOC' | 'DAILY_BATCH_GROUP_B' | 'DAILY_BATCH_INVENTORY_RECONCILIATION' | 'DAILY_BATCH_COGS_RECONCILIATION' | 'DAILY_BATCH_TRANSIT_RECONCILIATION' | 'UNEARNED_REV_REVERSAL' | 'BILL_PAYMENT' | 'INVOICE_PAYMENT' | 'BILL_ATTACHMENT' | 'INVOICE_PDF' | 'INVOICE_EMAIL' | 'WC_INVOICE_NOTE' | 'REALISED_FX_JOURNAL' | 'UNREALISED_FX_JOURNAL' | 'MANUFACTURING_JOURNAL' | 'MANUFACTURING_RECLASS' | 'TAX_RATE_SYNC'
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
    let staleDiscount: { payloadDiscount: number; liveDiscount: number } | null = null
    await db.$transaction(async (tx) => {
      // o3d-hrak: join the sales-order delete protocol. The hard delete locks the order and
      // checks for live accounting work; without taking the SAME lock here, a poster holding a
      // pre-delete snapshot can insert its PENDING row after that check and commit after the
      // order is gone — and the worker then posts a real document for an order that no longer
      // exists. AccountingSyncLog has no FK to SalesOrder, so nothing else objects.
      const lockedOrderId = await lockOrderForAccountingEnqueue(tx, {
        referenceType: params.referenceType,
        referenceId: params.referenceId,
      })
      if (lockedOrderId === null) {
        console.warn(
          `[accounting-queue] skipping ${params.type} for deleted ${params.referenceType} ${params.referenceId}`,
        )
        return
      }

      // o3d-y14: the lock above serialises the INSERT, not the CONSTRUCTION of `payload`. A
      // producer can read the order's discount, be overtaken here by the coupon backfill (which
      // corrects the column under this same lock, having correctly counted zero queue rows), and
      // then insert a payload built from the superseded amount. Refusing a stale snapshot is what
      // makes the backfill's locked count mean what it claims. A missing invoice is recoverable by
      // re-queueing; a posted one that disagrees with the order is not.
      if (typeof lockedOrderId === 'string') {
        staleDiscount = await findStaleOrderLevelDiscount(tx, {
          type: params.type,
          referenceType: params.referenceType,
          orderId: lockedOrderId,
          payload,
        })
        if (staleDiscount) return
      }

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
    if (staleDiscount) await logStaleOrderDiscountEnqueue('xero', params, staleDiscount)
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
