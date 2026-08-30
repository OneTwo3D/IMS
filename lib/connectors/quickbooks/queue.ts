/**
 * QuickBooks sync queue — creates AccountingSyncLog entries for pending sync.
 * Mirrors lib/connectors/xero/queue.ts with per-type enable/disable gating.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { mirrorAccountingSyncLogToEvent } from '@/lib/domain/accounting/accounting-event-mirror'
import { getQuickBooksSettings, type QuickBooksSettings } from './settings'
import {
  findStaleOrderLevelDiscount,
  lockOrderForAccountingEnqueue,
  logStaleOrderDiscountEnqueue,
} from '@/lib/domain/accounting/enqueue-order-guard'
import { lockFollowUpScope } from '@/lib/domain/accounting/followup-scope-lock'
import { stampingCustodyOnCreate } from '@/lib/domain/accounting/money-attempt-provenance'
import {
  classifyPriorAttempts,
  describeUnresolvedPriorAttempt,
  PRIOR_ATTEMPT_SELECT,
  priorAttemptsWhere,
} from '@/lib/domain/accounting/prior-posting-evidence'
// Type-only, so the facade's dynamic import of this module stays the only runtime edge between them.
import type { ConnectorEnqueueOutcome } from '@/lib/accounting'

/** Map sync type enum → setting key for per-type enable/disable */
const SYNC_TYPE_SETTING: Record<string, keyof QuickBooksSettings> = {
  SALES_INVOICE: 'quickbooks_sync_sales_invoice',
  SALES_INVOICE_UPDATE: 'quickbooks_sync_sales_invoice',
  CREDIT_NOTE: 'quickbooks_sync_credit_note',
  PURCHASE_INVOICE: 'quickbooks_sync_purchase_invoice',
  PURCHASE_INVOICE_UPDATE: 'quickbooks_sync_purchase_invoice',
  COGS_JOURNAL: 'quickbooks_sync_cogs_journal',
  COGS_REVERSAL: 'quickbooks_sync_cogs_reversal',
  STOCK_RECEIPT: 'quickbooks_sync_stock_receipt',
  INVENTORY_ADJUSTMENT: 'quickbooks_sync_inventory_adjustment',
  STOCK_ALLOCATION: 'quickbooks_sync_stock_allocation',
  REALISED_FX_JOURNAL: 'quickbooks_sync_realised_fx_journal',
  UNREALISED_FX_JOURNAL: 'quickbooks_sync_unrealised_fx_journal',
  MANUFACTURING_JOURNAL: 'quickbooks_sync_manufacturing_journal',
  MANUFACTURING_RECLASS: 'quickbooks_sync_manufacturing_journal',
}

export async function queueQuickBooksSync(params: {
  type: 'SALES_INVOICE' | 'SALES_INVOICE_UPDATE' | 'CREDIT_NOTE' | 'PURCHASE_CREDIT_NOTE' | 'PURCHASE_CREDIT_NOTE_ALLOCATION' | 'COGS_REVERSAL' | 'STOCK_IN_TRANSIT' | 'STOCK_RECEIPT' | 'PURCHASE_INVOICE' | 'PURCHASE_INVOICE_UPDATE' | 'COGS_JOURNAL' | 'INVENTORY_ADJUSTMENT' | 'STOCK_ALLOCATION' | 'DAILY_BATCH_REVENUE_DEFERRAL' | 'DAILY_BATCH_INVENTORY_ALLOC' | 'DAILY_BATCH_GROUP_B' | 'DAILY_BATCH_INVENTORY_RECONCILIATION' | 'DAILY_BATCH_COGS_RECONCILIATION' | 'DAILY_BATCH_TRANSIT_RECONCILIATION' | 'UNEARNED_REV_REVERSAL' | 'ALLOCATION_REVERSAL' | 'BILL_PAYMENT' | 'INVOICE_PAYMENT' | 'BILL_ATTACHMENT' | 'INVOICE_PDF' | 'INVOICE_EMAIL' | 'WC_INVOICE_NOTE' | 'REALISED_FX_JOURNAL' | 'UNREALISED_FX_JOURNAL' | 'MANUFACTURING_JOURNAL' | 'MANUFACTURING_RECLASS' | 'TAX_RATE_SYNC'
  referenceType: string
  referenceId: string
  payload: Record<string, unknown>
  idempotencyKey?: string
  // o3d-2sm1 r7: and it SAYS what it did — the twin of the Xero queue's contract, for the same
  // reason. See ConnectorEnqueueOutcome.
}): Promise<ConnectorEnqueueOutcome> {
  const settings = await getQuickBooksSettings()
  if (settings.quickbooks_sync_enabled !== 'true') return { queued: false, reason: 'not-configured' }

  const settingKey = SYNC_TYPE_SETTING[params.type]
  const postingMode = settingKey ? settings[settingKey] : 'submitted'
  if (!postingMode || postingMode === 'off') return { queued: false, reason: 'not-configured' }

  const payload = {
    ...params.payload,
    _postingMode: postingMode,
    ...(params.idempotencyKey ? { _idempotencyKey: params.idempotencyKey } : {}),
  }

  if (params.idempotencyKey) {
    // o3d-d0pd: the twin of the Xero queue's check, for the same reason and through the same one
    // definition — a FAILED prior attempt is invisible to a three-status predicate and to the partial
    // unique index that shares it. See prior-posting-evidence.ts.
    const priorAttempts = await db.accountingSyncLog.findMany({
      where: priorAttemptsWhere({ ...params, connector: 'quickbooks', idempotencyKey: params.idempotencyKey }),
      select: PRIOR_ATTEMPT_SELECT,
    })
    const verdict = classifyPriorAttempts(priorAttempts)
    // ALREADY PRESENT IS QUEUED: a row for this posting is standing, so the GL counterpart exists.
    if (verdict.kind === 'live') return { queued: true }
    // A document with an id EXISTS. Nothing is written, and nothing needs to be.
    if (verdict.kind === 'posted') return { queued: true, reason: 'already-queued' }
    // REFUSED, not decided: a failed attempt that may have landed. The posting is still owed.
    if (verdict.kind === 'unresolved') {
      const description = describeUnresolvedPriorAttempt({ ...params, syncLogId: verdict.syncLogId })
      await logActivity({
        entityType: 'SYSTEM',
        action: 'accounting_enqueue_refused_unresolved_attempt',
        tag: 'accounting',
        level: 'WARNING',
        description,
        metadata: {
          connector: 'quickbooks', type: params.type, referenceType: params.referenceType,
          referenceId: params.referenceId, blockingSyncLogId: verdict.syncLogId,
        },
      }).catch(() => { /* logging must never turn a refusal into a throw */ })
      return { queued: false, reason: 'refused' }
    }
  }

  try {
    let mirrorErrorMessage: string | null = null
    let deletedOrder = false
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
      // o3d-0m56: and the accounting scope lock, so this enqueue cannot land between the manual
      // retry's sibling snapshot and its reset. Taken AFTER the order lock, the same order every
      // other enqueue writer takes them in, so the pair cannot deadlock.
      await lockFollowUpScope(tx, {
        connector: 'quickbooks',
        type: params.type,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
      })
      if (lockedOrderId === null) {
        console.warn(
          `[accounting-queue] skipping ${params.type} for deleted ${params.referenceType} ${params.referenceId}`,
        )
        deletedOrder = true
        return
      }

      // o3d-y14: the lock serialises the INSERT, not the CONSTRUCTION of `payload`. See the twin
      // comment in lib/connectors/xero/queue.ts — a producer that read the order's discount before
      // the coupon backfill corrected it must not be allowed to queue the superseded figure.
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
          connector: 'quickbooks',
          type: params.type,
          status: 'PENDING',
          referenceType: params.referenceType,
          referenceId: params.referenceId,
          payload: payload as never,
          // o3d-0m56 r10: created INSIDE attempt-stamping custody. That is what later lets a revival
          // read this row's unset `remoteAttemptedAt` as proof no remote call ever left it — see
          // money-attempt-provenance.ts. A row created without it is never recycled again.
          ...stampingCustodyOnCreate(),
        },
      })
      try {
        const baseCurrency = await getBaseCurrencyCode()
        await mirrorAccountingSyncLogToEvent(tx, {
          syncLogId: log.id,
          connector: 'quickbooks',
          type: params.type,
          referenceType: params.referenceType,
          referenceId: params.referenceId,
          payload,
          currency: baseCurrency,
          status: 'PENDING',
        })
      } catch (mirrorError) {
        mirrorErrorMessage = `QuickBooks sync entry ${log.id} was queued but accounting event mirroring failed: ${String(mirrorError)}`
      }
    })
    if (staleDiscount) await logStaleOrderDiscountEnqueue('quickbooks', params, staleDiscount)
    if (mirrorErrorMessage) {
      await logActivity({
        entityType: 'SYSTEM',
        action: 'accounting_event_mirror_error',
        tag: 'sync',
        level: 'WARNING',
        description: mirrorErrorMessage,
      })
    }
    // NEITHER of these is a decision that nothing will post: the order went away under this enqueue,
    // or the payload it was built from had been superseded. The posting is still owed.
    if (deletedOrder || staleDiscount) return { queued: false, reason: 'refused' }
    return { queued: true }
  } catch (error) {
    // A concurrent insert already queued this posting, so the counterpart exists — already present.
    if (params.idempotencyKey && String(error).includes('accounting_sync_logs_idempotency_key_uq')) {
      return { queued: true }
    }
    throw error
  }
}
